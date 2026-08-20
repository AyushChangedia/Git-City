/**
 * city.js — turns a commit stream into three.js meshes.
 *
 * One file = one building. One folder = one district. A building's height
 * tracks its file's line count; its colour tracks how recently it was touched.
 *
 * All the geometry maths lives in layout.js so it can be verified in Node
 * without a renderer. This module is only responsible for meshes, materials,
 * tweens and the lifecycle of a building.
 */

import * as THREE from 'three';
import {
  FOOTPRINT, HEIGHT_MIN, heightForLines, layout, cityBounds, boxSize, boxCenter,
} from './layout.js';
import { makeWindowTexture, WINDOW_TILE_UNITS } from './textures.js';

export * from './layout.js';

const TWEEN_MS = 300;
const HEAT_COMMITS = 20;

const COLOR_HOT = new THREE.Color('#ff6b35');
const COLOR_BASE = new THREE.Color('#4a5568');

/**
 * How far towards the hot colour a just-touched building goes. The heat is a
 * tint on a building, not a repaint of one: at 1.0 the city stops looking like
 * a city every time a commit lands on it.
 */
const HEAT_TINT = 0.45;

const FOUNDATION_HEIGHT = 0.12;

const EMISSIVE_WINDOW = new THREE.Color('#ffd9a0');

/**
 * Bright enough for the bloom pass to catch.
 *
 * Bloom thresholds on linear radiance, before tone mapping. #ffd9a0 has a
 * linear luminance of 0.734, so at the obvious intensity of 0.9 the windows
 * peak at 0.66 — under the 0.82 bloom threshold, meaning they would never glow
 * at all, which is the entire point of putting them there. 1.6 puts the peak at
 * 1.18, comfortably over the line, and lit windows read as light sources
 * instead of pale dots.
 */
const WINDOW_EMISSIVE_INTENSITY = 1.6;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Stable per-path jitter, so a facade is not the exact shade of its neighbour. */
function shadeJitter(path) {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 0.92 + ((h >>> 0) % 1000) / 1000 * 0.16;   // 0.92 .. 1.08
}

export class City {
  constructor() {
    this.group = new THREE.Group();

    // A unit box translated so its base sits on y=0 — buildings stand on the
    // ground rather than being buried halfway into it. scale.y is the height,
    // which also makes growing from nothing a single number.
    this.geometry = new THREE.BoxGeometry(FOOTPRINT, 1, FOOTPRINT);
    this.geometry.translate(0, 0.5, 0);
    this._markRoofFaces(this.geometry);

    this.windowTexture = makeWindowTexture();

    /** @type {Map<string, object>} path -> building record */
    this.buildings = new Map();
    this.districtCount = 0;
    this.commitIndex = -1;

    /** Layout over every path the dataset will ever contain. */
    this.plan = null;
    this.foundations = null;
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
   * Playback used to open on an empty plane with three towers on it, which
   * reads as a chart with missing data rather than as a city before dawn.
   * Laying the whole street plan down at frame 0 means buildings rise out of a
   * place instead of appearing in a void — and it fixes the problem for every
   * dataset rather than for the ones that happen to start busy.
   *
   * It also pins each building to one plot for the whole run: plots are
   * assigned from the full path set rather than from whichever files happen to
   * exist right now, so the camera framing and the street grid stay put.
   */
  planFor(commits) {
    const all = new Set();
    for (const commit of commits) {
      for (const file of commit.files || []) if (file.path) all.add(file.path);
    }

    this.plan = layout([...all]);
    this.districtCount = this.plan.districts.length;
    this._buildFoundations();
    return this.plan;
  }

  _buildFoundations() {
    this._disposeFoundations();
    const positions = this.plan?.positions;
    if (!positions || positions.size === 0) return;

    const geometry = new THREE.BoxGeometry(FOOTPRINT, FOUNDATION_HEIGHT, FOOTPRINT);
    geometry.translate(0, FOUNDATION_HEIGHT / 2, 0);
    // Deliberately a shade lighter than the island: the plates are the street
    // plan, and if they match the ground they may as well not be there.
    const material = new THREE.MeshStandardMaterial({
      color: 0x2e323d,
      roughness: 0.95,
      metalness: 0.0,
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
    mesh.castShadow = false;
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
   * @param {object} commit    dataset commit record
   * @param {number} index     its position in the timeline
   * @param {boolean} instant  skip tweens (used when scrubbing or rebuilding)
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
   * Advance every tween. `now` is performance.now().
   * @returns {boolean} whether anything is still moving.
   */
  update(now) {
    let animating = false;

    for (const [path, b] of this.buildings) {
      let settled = true;

      if (b.hStart !== null) {
        const e = easeOutCubic(clamp01((now - b.hStart) / TWEEN_MS));
        b.height = b.h0 + (b.h1 - b.h0) * e;
        // Never let scale reach exactly zero: three.js warns on degenerate matrices.
        b.mesh.scale.y = Math.max(b.height, 1e-4);
        this._fitWindows(b);
        if (e >= 1) b.hStart = null; else settled = false;
      }

      if (b.pStart !== null) {
        const e = easeOutCubic(clamp01((now - b.pStart) / TWEEN_MS));
        b.mesh.position.x = b.px0 + (b.px1 - b.px0) * e;
        b.mesh.position.z = b.pz0 + (b.pz1 - b.pz0) * e;
        if (e >= 1) b.pStart = null; else settled = false;
      }

      if (!settled) animating = true;
      if (b.dying && settled) this._dispose(path);
    }

    return animating;
  }

  /**
   * Bounds over the *whole plan*, at target heights.
   *
   * Using the planned footprint rather than the buildings that exist right now
   * keeps the framing and the island still while the city fills in — the camera
   * frames the place, not the current construction site.
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

  _create(path) {
    const emissiveMap = this.windowTexture.clone();
    emissiveMap.needsUpdate = true;

    const material = new THREE.MeshStandardMaterial({
      color: COLOR_BASE.clone(),
      roughness: 0.75,
      metalness: 0.15,
      emissive: EMISSIVE_WINDOW,
      emissiveMap,
      emissiveIntensity: WINDOW_EMISSIVE_INTENSITY,
    });

    // Suppress emission on the roof faces only. Patching one shader beats
    // splitting every building across two materials, which would double the
    // draw calls for a city that already has hundreds of them. The cache key is
    // shared so all buildings still compile to a single program.
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

    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.scale.y = 1e-4;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.path = path;

    const b = {
      path, mesh, material, emissiveMap,
      shade: shadeJitter(path),
      height: 0, h0: 0, h1: 0, hStart: null,
      px0: 0, px1: 0, pz0: 0, pz1: 0, pStart: null,
      lastTouched: this.commitIndex,
      dying: false,
      placed: false,
    };

    this.buildings.set(path, b);
    this.group.add(mesh);
    this._fitWindows(b);
    return b;
  }

  /**
   * Keep window rows the same physical size on a two-storey file and a
   * forty-unit tower. Without this the texture stretches with the box and tall
   * buildings get tall windows, which is what makes them read as bars.
   */
  _fitWindows(b) {
    b.emissiveMap.repeat.set(1, Math.max(0.25, b.mesh.scale.y / WINDOW_TILE_UNITS));
  }

  _dispose(path) {
    const b = this.buildings.get(path);
    if (!b) return;
    this.group.remove(b.mesh);
    b.emissiveMap.dispose();
    b.material.dispose();
    this.buildings.delete(path);
  }

  _tweenHeight(b, target, instant, from) {
    b.h0 = from !== undefined ? from : b.height;
    b.h1 = target;
    if (instant) {
      b.height = target;
      b.mesh.scale.y = Math.max(target, 1e-4);
      this._fitWindows(b);
      b.hStart = null;
    } else {
      b.hStart = performance.now();
    }
  }

  /**
   * Place buildings on their planned plots. Plots come from the full path set,
   * so they do not move once assigned; the tween is kept for the case where a
   * dataset is loaded without a plan.
   */
  _relayout(instant) {
    const positions = this.plan
      ? this.plan.positions
      : layout([...this.buildings.keys()].filter((p) => !this.buildings.get(p).dying)).positions;
    const now = performance.now();

    for (const [path, b] of this.buildings) {
      const pos = positions.get(path);
      if (!pos) continue;

      if (!b.placed || instant) {
        b.mesh.position.set(pos.x, 0, pos.z);
        b.px0 = b.px1 = pos.x;
        b.pz0 = b.pz1 = pos.z;
        b.pStart = null;
        b.placed = true;
      } else if (pos.x !== b.px1 || pos.z !== b.pz1) {
        b.px0 = b.mesh.position.x;
        b.pz0 = b.mesh.position.z;
        b.px1 = pos.x;
        b.pz1 = pos.z;
        b.pStart = now;
      }
    }
  }

  /**
   * Just-touched buildings warm towards orange and cool back to slate over the
   * following 20 commits — a tint over the building's own shade, so the city
   * keeps its material identity while the edit is legible.
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
