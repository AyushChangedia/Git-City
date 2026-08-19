/**
 * city.js — turns a commit stream into three.js meshes.
 *
 * One file = one building. One folder = one district. A building's height
 * tracks its file's line count; its colour tracks how recently it was touched.
 *
 * All the geometry maths lives in layout.js so it can be verified in Node
 * without a renderer. This module is only responsible for meshes, tweens and
 * the lifecycle of a building.
 */

import * as THREE from 'three';
import {
  FOOTPRINT, HEIGHT_MIN, heightForLines, layout,
  cityBounds, boxSize, boxCenter,
} from './layout.js';

export * from './layout.js';

const TWEEN_MS = 300;
const HEAT_COMMITS = 20;

const COLOR_HOT = new THREE.Color('#ff6b35');
const COLOR_BASE = new THREE.Color('#4a5568');

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

export class City {
  constructor() {
    this.group = new THREE.Group();

    // A unit box translated so its base sits on y=0 — buildings stand on the
    // ground rather than being buried halfway into it. scale.y is the height,
    // which also makes the grow-from-nothing animation a single number.
    this.geometry = new THREE.BoxGeometry(FOOTPRINT, 1, FOOTPRINT);
    this.geometry.translate(0, 0.5, 0);

    /** @type {Map<string, object>} path -> building record */
    this.buildings = new Map();
    this.districtCount = 0;
    this.commitIndex = -1;
  }

  get buildingCount() {
    let n = 0;
    for (const b of this.buildings.values()) if (!b.dying) n++;
    return n;
  }

  /** Live buildings only — dying ones are already on their way out. */
  livePaths() {
    const paths = [];
    for (const [p, b] of this.buildings) if (!b.dying) paths.push(p);
    return paths;
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
    this.districtCount = 0;
    this.commitIndex = -1;
  }

  /* -------------------------------------------------------------- frame -- */

  /** Advance every tween. `now` is performance.now(). */
  update(now) {
    for (const [path, b] of this.buildings) {
      let settled = true;

      if (b.hStart !== null) {
        const e = easeOutCubic(clamp01((now - b.hStart) / TWEEN_MS));
        b.height = b.h0 + (b.h1 - b.h0) * e;
        // Never let scale reach exactly zero: three.js warns on degenerate matrices.
        b.mesh.scale.y = Math.max(b.height, 1e-4);
        if (e >= 1) b.hStart = null; else settled = false;
      }

      if (b.pStart !== null) {
        const e = easeOutCubic(clamp01((now - b.pStart) / TWEEN_MS));
        b.mesh.position.x = b.px0 + (b.px1 - b.px0) * e;
        b.mesh.position.z = b.pz0 + (b.pz1 - b.pz0) * e;
        if (e >= 1) b.pStart = null; else settled = false;
      }

      if (b.dying && settled) this._dispose(path);
    }
  }

  /**
   * Bounds at *target* heights and positions, so the camera frames where the
   * city is going instead of chasing it up mid-tween.
   */
  bounds() {
    const list = [];
    for (const b of this.buildings.values()) {
      if (!b.dying) list.push({ x: b.px1, z: b.pz1, height: Math.max(b.h1, HEIGHT_MIN) });
    }
    return cityBounds(list);
  }

  dispose() {
    this.clear();
    this.geometry.dispose();
  }

  /* ---------------------------------------------------------- internals -- */

  _create(path) {
    const material = new THREE.MeshLambertMaterial({ color: COLOR_HOT.clone() });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.scale.y = 1e-4;
    mesh.userData.path = path;

    const b = {
      path, mesh, material,
      height: 0, h0: 0, h1: 0, hStart: null,
      px0: 0, px1: 0, pz0: 0, pz1: 0, pStart: null,
      lastTouched: this.commitIndex,
      dying: false,
      placed: false,
    };

    this.buildings.set(path, b);
    this.group.add(mesh);
    return b;
  }

  _dispose(path) {
    const b = this.buildings.get(path);
    if (!b) return;
    this.group.remove(b.mesh);
    b.material.dispose();
    this.buildings.delete(path);
  }

  _tweenHeight(b, target, instant, from) {
    b.h0 = from !== undefined ? from : b.height;
    b.h1 = target;
    if (instant) {
      b.height = target;
      b.mesh.scale.y = Math.max(target, 1e-4);
      b.hStart = null;
    } else {
      b.hStart = performance.now();
    }
  }

  /**
   * Recompute every position. Districts resize as files come and go, so
   * neighbours shift; sliding them over 300ms reads as the city rearranging
   * itself rather than teleporting.
   */
  _relayout(instant) {
    const { positions, districts } = layout(this.livePaths());
    this.districtCount = districts.length;
    const now = performance.now();

    for (const [path, b] of this.buildings) {
      const pos = positions.get(path);
      if (!pos) continue; // dying buildings keep their last spot

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
   * Just-touched buildings glow orange and cool to the base slate over the
   * following 20 commits.
   */
  _refreshHeat() {
    for (const b of this.buildings.values()) {
      const mix = clamp01((this.commitIndex - b.lastTouched) / HEAT_COMMITS);
      b.material.color.copy(COLOR_HOT).lerp(COLOR_BASE, mix);
    }
  }
}

export { boxSize, boxCenter };
