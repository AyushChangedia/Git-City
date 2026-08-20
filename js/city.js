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
import { makeWindowTexture, WINDOW_TILE_UNITS } from './textures.js';

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
 * A tall building is three boxes, each 85% the width of the one below.
 * A single extruded box is a bar; a setback taper is a tower.
 */
const TAPER_RATIO = 0.85;
const SEGMENT_SPLIT = [0.46, 0.32, 0.22];

const SPIRE_COUNT = 3;   // spires go on the tallest few, as landmarks

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

    this.windowTexture = makeWindowTexture();

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
    this.windowTexture.dispose();
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

  _makeWallMaterial() {
    const emissiveMap = this.windowTexture.clone();
    emissiveMap.needsUpdate = true;

    const material = new THREE.MeshStandardMaterial({
      color: COLOR_BASE.clone(),
      roughness: 0.7,
      metalness: 0.2,
      emissive: EMISSIVE_WINDOW,
      emissiveMap,
      emissiveIntensity: WINDOW_EMISSIVE_INTENSITY,
    });

    // Suppress emission on the roof faces only. Patching one shader beats
    // splitting every building across two materials, which would double the
    // draw calls for a city that already has thousands. The cache key is
    // shared so every building still compiles to a single program.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aRoof;\nvarying float vRoof;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvRoof = aRoof;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vRoof;')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= 1.0 - vRoof;'
        );
    };
    material.customProgramCacheKey = () => 'gitcity-building';
    return { material, emissiveMap };
  }

  _create(path) {
    const group = new THREE.Group();
    const hash = hashOf(path);
    const { material, emissiveMap } = this._makeWallMaterial();

    const b = {
      path, group, material, emissiveMap,
      hash,
      shade: 0.92 + ((hash >>> 8) % 1000) / 1000 * 0.16,
      segments: [],
      roofBoxes: [],
      spire: null,
      tip: null,
      tiers: 0,
      height: 0, h0: 0, h1: 0, hStart: null,
      px0: 0, px1: 0, pz0: 0, pz1: 0, pStart: null,
      lastTouched: this.commitIndex,
      dying: false,
      placed: false,
    };

    this.buildings.set(path, b);
    this.group.add(group);
    return b;
  }

  /**
   * Give the building the right number of parts for the height it is heading
   * for. Rebuilt only when it crosses the taper threshold, not every frame.
   */
  _buildParts(b, targetHeight) {
    const tiers = targetHeight > TAPER_HEIGHT ? SEGMENT_SPLIT.length : 1;
    if (tiers === b.tiers) return;

    for (const m of b.segments) { b.group.remove(m); }
    for (const m of b.roofBoxes) { b.group.remove(m); m.geometry.dispose(); }
    b.segments = [];
    b.roofBoxes = [];

    for (let i = 0; i < tiers; i++) {
      const mesh = new THREE.Mesh(this.geometry, b.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.path = b.path;
      b.group.add(mesh);
      b.segments.push(mesh);
    }

    // Clutter on the mid-rise roofs: plant, lift housing, whatever. Cheap, and
    // it breaks up the flat tops that make a skyline look extruded.
    if (tiers === 1 && targetHeight > 8) {
      const count = 1 + (b.hash % 3);
      for (let i = 0; i < count; i++) {
        const r = ((b.hash >>> (i * 5 + 3)) % 100) / 100;
        const r2 = ((b.hash >>> (i * 7 + 11)) % 100) / 100;
        const w = FOOTPRINT * (0.16 + r * 0.2);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, w * (0.7 + r2), w), b.material);
        mesh.castShadow = true;
        mesh.userData.roofBox = true;
        mesh.position.x = (r - 0.5) * (FOOTPRINT - w);
        mesh.position.z = (r2 - 0.5) * (FOOTPRINT - w);
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
  }

  /**
   * Position and scale every part for a given current height.
   *
   * Called each frame of the growth tween rather than scaling the group as a
   * whole, so the setbacks keep their proportions and the window rows keep
   * their physical size the entire way up.
   */
  _shapeTo(b, height) {
    const h = Math.max(height, 1e-4);
    const tiers = b.segments.length;
    let y = 0;

    for (let i = 0; i < tiers; i++) {
      const fraction = tiers === 1 ? 1 : SEGMENT_SPLIT[i];
      const segHeight = Math.max(h * fraction, 1e-4);
      const width = FOOTPRINT * Math.pow(TAPER_RATIO, i);

      const mesh = b.segments[i];
      mesh.scale.set(width, segHeight, width);
      mesh.position.y = y;
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

    // Keep window rows the same physical size on a two-storey file and a
    // seventy-unit tower. Without this the texture stretches with the box and
    // tall buildings get tall windows, which is what makes them read as bars.
    b.emissiveMap.repeat.set(FOOTPRINT / WINDOW_TILE_UNITS, h / WINDOW_TILE_UNITS);
  }

  _dispose(path) {
    const b = this.buildings.get(path);
    if (!b) return;
    for (const m of b.roofBoxes) m.geometry.dispose();
    this.group.remove(b.group);
    b.emissiveMap.dispose();
    b.material.dispose();
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
      b.material.color
        .copy(COLOR_BASE)
        .lerp(COLOR_HOT, HEAT_TINT * (1 - cool))
        .multiplyScalar(b.shade);
    }
  }
}

export { boxSize, boxCenter };
