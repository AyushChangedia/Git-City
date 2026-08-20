/**
 * city.js — turns a commit stream into three.js meshes.
 *
 * One file = one building. One folder = one district. A building's height
 * tracks its file's line count; its colour tracks how recently it was touched.
 *
 * All the geometry maths lives in layout.js so it can be verified in Node
 * without a renderer. This module is only responsible for meshes, materials,
 * silhouettes, tweens and the lifecycle of a building.
 */

import * as THREE from 'three';
import {
  FOOTPRINT, HEIGHT_MIN, TAPER_HEIGHT, heightForLines, layout,
  cityBounds, boxSize, boxCenter,
} from './layout.js';
import { makeFacade, makeRoofTexture, FACADE_STYLES, WINDOW_TILE_UNITS } from './textures.js';

export * from './layout.js';

const TWEEN_MS = 300;
const HEAT_COMMITS = 20;

const COLOR_HOT = new THREE.Color('#ff6b35');
const COLOR_BASE = new THREE.Color('#4a5568');

/** A tint on a building, not a repaint of one. */
const HEAT_TINT = 0.45;

const FOUNDATION_HEIGHT = 0.12;

const EMISSIVE_WINDOW = new THREE.Color('#ffd9a0');
const WINDOW_EMISSIVE_INTENSITY = 1.0;

/**
 * Buildings vary in width within their plot. A block of identical squares on a
 * regular grid reads as a chart however it is textured; real streets have gaps
 * of different sizes. The plot itself never changes — this only decides how
 * much of it the building fills.
 */
const WIDTH_MIN = 0.74;
const WIDTH_RANGE = 0.26;

/** Above this a building gets a podium: a wider two-or-three storey base. */
const PODIUM_HEIGHT = 12;

/**
 * A tall building is three boxes, each 85% the width of the one below.
 * A single extruded box is a bar; a setback taper is a tower.
 */
const TAPER_RATIO = 0.85;
const SEGMENT_SPLIT = [0.46, 0.32, 0.22];

const SPIRE_COUNT = 3;   // spires go on the tallest few, as landmarks

const _tint = new THREE.Color();

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Stable per-path hash, so a building looks the same on every reload. */
function hashOf(path) {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class City {
  constructor() {
    this.group = new THREE.Group();

    // A unit box translated so its base sits on y=0 — segments stack by simply
    // setting position.y, and a building grows by scaling in y from nothing.
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.geometry.translate(0, 0.5, 0);
    this._markRoofFaces(this.geometry);

    this.spireGeometry = new THREE.CylinderGeometry(0.12, 0.3, 1, 6);
    this.spireGeometry.translate(0, 0.5, 0);
    this.tipGeometry = new THREE.SphereGeometry(0.55, 8, 6);

    this.spireMaterial = new THREE.MeshStandardMaterial({
      color: 0x2b3040, roughness: 0.6, metalness: 0.4,
    });
    this.tipMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a0d08, emissive: new THREE.Color('#ff2a1a'), emissiveIntensity: 3.2,
      roughness: 1, metalness: 0,
    });

    this._initFacades();

    /** @type {Map<string, object>} path -> building record */
    this.buildings = new Map();
    this.districtCount = 0;
    this.commitIndex = -1;

    this.plan = null;
    this.foundations = null;
    this._landmarks = new Set();
  }

  get buildingCount() {
    let n = 0;
    for (const b of this.buildings.values()) if (!b.dying) n++;
    return n;
  }

  /* --------------------------------------------------------------- plan -- */

  /**
   * Lay out every file the dataset will ever contain and plate each plot.
   *
   * Playback used to open on an empty plane with a few towers on it, which
   * reads as a chart with missing data rather than as a city before dawn.
   * Laying the whole street plan down at frame 0 means buildings rise out of a
   * place instead of a void — and it pins each building to one plot for the
   * whole run, so the framing and the street grid stay still.
   */
  planFor(commits) {
    const all = new Set();
    const peak = new Map();

    for (const commit of commits) {
      for (const file of commit.files || []) {
        if (!file.path) continue;
        all.add(file.path);
        if (file.status !== 'removed') {
          peak.set(file.path, Math.max(peak.get(file.path) || 0, file.lines || 0));
        }
      }
    }

    this.plan = layout([...all]);
    this.districtCount = this.plan.districts.length;

    // Landmarks are chosen from the whole history, not from the current frame,
    // so a spire does not sprout and vanish as files are edited.
    this._landmarks = new Set(
      [...peak.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, SPIRE_COUNT)
        .map(([path]) => path)
    );

    this._buildFoundations();
    return this.plan;
  }

  /** The tallest building this dataset will ever produce. */
  plannedHeight(commits) {
    let lines = 0;
    for (const commit of commits) {
      for (const file of commit.files || []) {
        if (file.status !== 'removed' && file.lines > lines) lines = file.lines;
      }
    }
    return heightForLines(lines);
  }

  _buildFoundations() {
    this._disposeFoundations();
    const positions = this.plan?.positions;
    if (!positions || positions.size === 0) return;

    const geometry = new THREE.BoxGeometry(FOOTPRINT, FOUNDATION_HEIGHT, FOOTPRINT);
    geometry.translate(0, FOUNDATION_HEIGHT / 2, 0);
    // Deliberately a shade lighter than the ground: the plates are the street
    // plan, and if they match the land they may as well not be there.
    const material = new THREE.MeshStandardMaterial({
      color: 0x2e323d, roughness: 0.95, metalness: 0.0,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, positions.size);
    const m = new THREE.Matrix4();
    let i = 0;
    for (const pos of positions.values()) {
      m.makeTranslation(pos.x, 0, pos.z);
      mesh.setMatrixAt(i++, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    this.group.add(mesh);
    this.foundations = mesh;
  }

  _disposeFoundations() {
    if (!this.foundations) return;
    this.group.remove(this.foundations);
    this.foundations.geometry.dispose();
    this.foundations.material.dispose();
    this.foundations = null;
  }

  /* ------------------------------------------------------------ commits -- */

  /**
   * Apply one commit.
   * @returns {boolean} whether any building was added or removed.
   */
  applyCommit(commit, index, instant = false) {
    this.commitIndex = index;
    let membershipChanged = false;

    for (const file of commit.files || []) {
      const path = file.path;
      if (!path) continue;

      if (file.status === 'removed') {
        const b = this.buildings.get(path);
        if (b && !b.dying) {
          b.dying = true;
          this._tweenHeight(b, 0, instant);
          if (instant) this._dispose(path);
          membershipChanged = true;
        }
        continue;
      }

      const target = heightForLines(file.lines);
      let b = this.buildings.get(path);

      // A file can arrive as "modified" if it predates the fetched window, so
      // any unknown path becomes a new building rather than being dropped.
      if (!b || b.dying) {
        if (b) this._dispose(path);
        b = this._create(path);
        membershipChanged = true;
        this._tweenHeight(b, target, instant, 0);
      } else {
        this._tweenHeight(b, target, instant);
      }
      b.lastTouched = index;
    }

    if (membershipChanged) this._relayout(instant);
    this._refreshHeat();
    return membershipChanged;
  }

  /** Rebuild from scratch up to and including `index`, with no animation. */
  seek(commits, index) {
    this.clear();
    for (let i = 0; i <= index && i < commits.length; i++) {
      this.applyCommit(commits[i], i, true);
    }
  }

  clear() {
    for (const path of [...this.buildings.keys()]) this._dispose(path);
    this.buildings.clear();
    this.commitIndex = -1;
  }

  /* -------------------------------------------------------------- frame -- */

  /**
   * Advance every tween.
   * @returns {boolean} whether anything is still moving.
   */
  update(now) {
    let animating = false;

    for (const [path, b] of this.buildings) {
      let settled = true;

      if (b.hStart !== null) {
        const e = easeOutCubic(clamp01((now - b.hStart) / TWEEN_MS));
        b.height = b.h0 + (b.h1 - b.h0) * e;
        this._shapeTo(b, b.height);
        if (e >= 1) b.hStart = null; else settled = false;
      }

      if (b.pStart !== null) {
        const e = easeOutCubic(clamp01((now - b.pStart) / TWEEN_MS));
        b.group.position.x = b.px0 + (b.px1 - b.px0) * e;
        b.group.position.z = b.pz0 + (b.pz1 - b.pz0) * e;
        if (e >= 1) b.pStart = null; else settled = false;
      }

      if (!settled) animating = true;
      if (b.dying && settled) this._dispose(path);
    }

    return animating;
  }

  /**
   * Bounds over the whole plan, at target heights, so the framing and the
   * island stay still while the city fills in.
   */
  bounds() {
    if (!this.plan || this.plan.positions.size === 0) return null;

    const list = [];
    for (const [path, pos] of this.plan.positions) {
      const b = this.buildings.get(path);
      list.push({ x: pos.x, z: pos.z, height: b && !b.dying ? Math.max(b.h1, HEIGHT_MIN) : 0 });
    }
    return cityBounds(list);
  }

  dispose() {
    this.clear();
    this._disposeFoundations();
    this.geometry.dispose();
    this.spireGeometry.dispose();
    this.tipGeometry.dispose();
    this.spireMaterial.dispose();
    this.tipMaterial.dispose();
    this.roofMaterial.dispose();
    this.roofTexture.dispose();
    for (const f of this.facades) { f.map.dispose(); f.emissiveMap.dispose(); }
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * Flag the top and bottom faces of the box so the shader can keep windows off
   * the roofs. BoxGeometry lays its faces out px, nx, py, ny, pz, nz with four
   * vertices each, so the roof and floor are vertices 8 through 15.
   */
  _markRoofFaces(geometry) {
    const count = geometry.attributes.position.count;
    const roof = new Float32Array(count);
    for (let i = 8; i < 16 && i < count; i++) roof[i] = 1;
    geometry.setAttribute('aRoof', new THREE.BufferAttribute(roof, 1));
  }

  /**
   * Facade sources, built once and shared. Each building clones the textures it
   * needs so it can set its own repeat, but the underlying canvases — and so
   * the GPU uploads — are shared across the whole city.
   */
  _initFacades() {
    this.facades = FACADE_STYLES.map((style, i) => makeFacade(style, i + 1));
    this.roofTexture = makeRoofTexture();
    this.roofMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a2e36, map: this.roofTexture, roughness: 0.95, metalness: 0.05,
    });
  }

  /**
   * One material per segment, because the repeat has to match that segment's
   * own width and height — a tapered tier is narrower than the one below it,
   * and stretching the same UVs over both would give the tower two different
   * window sizes.
   */
  _makeFacadeMaterial(styleIndex) {
    const facade = this.facades[styleIndex];
    const map = facade.map.clone();
    const emissiveMap = facade.emissiveMap.clone();
    map.needsUpdate = true;
    emissiveMap.needsUpdate = true;

    const material = new THREE.MeshStandardMaterial({
      color: COLOR_BASE.clone(),
      map,
      roughness: facade.roughness,
      metalness: facade.metalness,
      emissive: EMISSIVE_WINDOW,
      emissiveMap,
      emissiveIntensity: WINDOW_EMISSIVE_INTENSITY,
    });

    // Roofs get a flat dark cap instead of the facade, and no lit windows.
    // Patching one shader beats splitting every segment across two materials,
    // which would double the draw calls for a city that already has thousands.
    // The cache key is shared so every building still compiles one program.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aRoof;\nvarying float vRoof;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvRoof = aRoof;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vRoof;')
        .replace('#include <map_fragment>',
          '#include <map_fragment>\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.055, 0.060, 0.070), vRoof);')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= 1.0 - vRoof;');
    };
    material.customProgramCacheKey = () => 'gitcity-building';

    return { material, map, emissiveMap };
  }

  _create(path) {
    const group = new THREE.Group();
    const hash = hashOf(path);

    const b = {
      path, group, hash,
      style: hash % FACADE_STYLES.length,
      // How much of its 3x3 plot this building fills, and how much wider its
      // podium is. Both fixed per path, so a file always looks like itself.
      width: FOOTPRINT * (WIDTH_MIN + ((hash >>> 4) % 1000) / 1000 * WIDTH_RANGE),
      shade: 0.9 + ((hash >>> 14) % 1000) / 1000 * 0.2,
      parts: [],          // { mesh, material, map, emissiveMap }
      roofBoxes: [],
      spire: null,
      tip: null,
      tiers: 0,
      hasPodium: false,
      height: 0, h0: 0, h1: 0, hStart: null,
      px0: 0, px1: 0, pz0: 0, pz1: 0, pStart: null,
      lastTouched: this.commitIndex,
      dying: false,
      placed: false,
    };
    b.podiumWidth = Math.min(FOOTPRINT, b.width * 1.22);

    this.buildings.set(path, b);
    this.group.add(group);
    return b;
  }

  _addPart(b) {
    const { material, map, emissiveMap } = this._makeFacadeMaterial(b.style);
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.path = b.path;
    b.group.add(mesh);
    b.parts.push({ mesh, material, map, emissiveMap });
    return mesh;
  }

  /**
   * Give the building the right number of parts for the height it is heading
   * for. Rebuilt only when it crosses a threshold, not every frame.
   *
   * Anything worth calling a building has a base that meets the ground
   * differently from the way its shaft meets the sky, so above a low-rise
   * height it gets a wider podium; above the taper height it gets three
   * setback tiers on top of that.
   */
  _buildParts(b, targetHeight) {
    const tiers = targetHeight > TAPER_HEIGHT ? SEGMENT_SPLIT.length : 1;
    const hasPodium = targetHeight > PODIUM_HEIGHT;
    if (tiers === b.tiers && hasPodium === b.hasPodium && b.parts.length) return;

    for (const p of b.parts) {
      b.group.remove(p.mesh);
      p.map.dispose();
      p.emissiveMap.dispose();
      p.material.dispose();
    }
    for (const m of b.roofBoxes) { b.group.remove(m); m.geometry.dispose(); }
    b.parts = [];
    b.roofBoxes = [];

    const count = tiers + (hasPodium ? 1 : 0);
    for (let i = 0; i < count; i++) this._addPart(b);

    // Clutter on the low-rise roofs: plant, lift housing, water tanks. Cheap,
    // and it breaks up the flat tops that make a skyline look extruded.
    if (tiers === 1 && targetHeight > 6) {
      const n = 1 + (b.hash % 2);
      for (let i = 0; i < n; i++) {
        const r = ((b.hash >>> (i * 5 + 3)) % 100) / 100;
        const r2 = ((b.hash >>> (i * 7 + 11)) % 100) / 100;
        const w = b.width * (0.18 + r * 0.22);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, w * (0.6 + r2 * 0.8), w), this.roofMaterial);
        mesh.castShadow = true;
        mesh.position.x = (r - 0.5) * (b.width - w);
        mesh.position.z = (r2 - 0.5) * (b.width - w);
        b.group.add(mesh);
        b.roofBoxes.push(mesh);
      }
    }

    if (this._landmarks.has(b.path) && !b.spire) {
      b.spire = new THREE.Mesh(this.spireGeometry, this.spireMaterial);
      b.tip = new THREE.Mesh(this.tipGeometry, this.tipMaterial);
      b.group.add(b.spire, b.tip);
    }

    b.tiers = tiers;
    b.hasPodium = hasPodium;
  }

  /**
   * Position and scale every part for a given current height.
   *
   * Called each frame of the growth tween rather than scaling the group as a
   * whole, so the setbacks keep their proportions and — more importantly — the
   * window rows keep their physical size the entire way up. A facade whose
   * storeys stretch as the building grows is the thing that reads as a bar.
   */
  _shapeTo(b, height) {
    const h = Math.max(height, 1e-4);
    let i = 0;
    let y = 0;

    if (b.hasPodium) {
      const podiumHeight = Math.max(Math.min(h * 0.2, 3.5), 1e-4);
      this._shapePart(b.parts[i++], b.podiumWidth, podiumHeight, y);
      y += podiumHeight;
    }

    const shaft = Math.max(h - y, 1e-4);
    const tiers = b.tiers;
    for (let t = 0; t < tiers; t++) {
      const fraction = tiers === 1 ? 1 : SEGMENT_SPLIT[t];
      const segHeight = Math.max(shaft * fraction, 1e-4);
      const width = b.width * Math.pow(TAPER_RATIO, t);
      this._shapePart(b.parts[i++], width, segHeight, y);
      y += segHeight;
    }

    for (const mesh of b.roofBoxes) mesh.position.y = h;

    if (b.spire) {
      const spireHeight = Math.max(h * 0.22, 0.001);
      b.spire.scale.set(1, spireHeight, 1);
      b.spire.position.y = h;
      b.tip.position.y = h + spireHeight;
      b.tip.scale.setScalar(Math.min(1, h / 20));
    }
  }

  /** Size one segment and match its facade repeat to its real dimensions. */
  _shapePart(part, width, height, y) {
    if (!part) return;
    part.mesh.scale.set(width, height, width);
    part.mesh.position.y = y;
    const rx = width / WINDOW_TILE_UNITS;
    const ry = height / WINDOW_TILE_UNITS;
    part.map.repeat.set(rx, ry);
    part.emissiveMap.repeat.set(rx, ry);
  }

  _dispose(path) {
    const b = this.buildings.get(path);
    if (!b) return;
    for (const m of b.roofBoxes) m.geometry.dispose();
    for (const p of b.parts) {
      p.map.dispose();
      p.emissiveMap.dispose();
      p.material.dispose();
    }
    this.group.remove(b.group);
    this.buildings.delete(path);
  }

  _tweenHeight(b, target, instant, from) {
    this._buildParts(b, Math.max(target, b.h1));
    b.h0 = from !== undefined ? from : b.height;
    b.h1 = target;
    if (instant) {
      b.height = target;
      this._shapeTo(b, target);
      b.hStart = null;
    } else {
      b.hStart = performance.now();
    }
  }

  /** Place buildings on their planned plots. Plots do not move once assigned. */
  _relayout(instant) {
    const positions = this.plan
      ? this.plan.positions
      : layout([...this.buildings.keys()].filter((p) => !this.buildings.get(p).dying)).positions;
    const now = performance.now();

    for (const [path, b] of this.buildings) {
      const pos = positions.get(path);
      if (!pos) continue;

      if (!b.placed || instant) {
        b.group.position.set(pos.x, 0, pos.z);
        b.px0 = b.px1 = pos.x;
        b.pz0 = b.pz1 = pos.z;
        b.pStart = null;
        b.placed = true;
      } else if (pos.x !== b.px1 || pos.z !== b.pz1) {
        b.px0 = b.group.position.x;
        b.pz0 = b.group.position.z;
        b.px1 = pos.x;
        b.pz1 = pos.z;
        b.pStart = now;
      }
    }
  }

  /**
   * Just-touched buildings warm towards orange and cool back to slate over the
   * following 20 commits — a tint over the building's own shade, so the city
   * keeps its material identity while the edit stays legible.
   */
  _refreshHeat() {
    for (const b of this.buildings.values()) {
      const cool = clamp01((this.commitIndex - b.lastTouched) / HEAT_COMMITS);
      _tint.copy(COLOR_BASE).lerp(COLOR_HOT, HEAT_TINT * (1 - cool)).multiplyScalar(b.shade);
      for (const p of b.parts) p.material.color.copy(_tint);
    }
  }
}

export { boxSize, boxCenter };
