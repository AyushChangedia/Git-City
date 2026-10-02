/**
 * textures.js — canvas-generated facades, built once at startup.
 *
 * Nothing here is fetched. A facade is cheaper to draw than to download, and
 * generating it means the lit/unlit pattern comes from a seed rather than an
 * image.
 *
 * The important idea: a building needs structure in its **albedo**, not just in
 * its emission. A flat-coloured box with a few glowing dots on it is a box with
 * glowing dots on it — at any distance, in any light. What reads as a building
 * is the curtain wall itself: panes of dark glass held in a grid of mullions
 * and floor slabs that catch the light. So every facade here produces two maps
 * from one grid — a colour map that is visible all the time, and an emissive
 * map for the windows that happen to be lit.
 */

import * as THREE from 'three';

import { mulberry32 } from './random.js';

/**
 * One facade tile spans this many world units. It matches the building
 * footprint, so a tile wraps exactly once around a face and the window columns
 * never land at a fraction.
 */
export const WINDOW_TILE_UNITS = 3;

const TILE_PX = 384;
const COLS = 6;
const ROWS = 6;
/**
 * Only a minority of panes are lit. Half a facade alight reads as a wall of
 * yellow squares; a real tower at dusk is mostly dark glass with the lit
 * offices scattered through it, and that contrast is what gives it depth.
 */
const LIT_FRACTION = 0.28;
const COOL_FRACTION = 0.15;

/**
 * Three kinds of building, because a skyline of one material is a render of one
 * building repeated. Picked per building from a hash of its path, so a file
 * always looks like itself.
 */
export const FACADE_STYLES = ['glass', 'concrete', 'brick'];

const STYLE = {
  // Curtain-wall tower: bright metal mullions, near-black glass, wide panes.
  glass: {
    frame: '#434b58',
    slab: '#2d3441',
    glass: ['#0e131c', '#101722', '#0c1119'],
    mullion: 0.07,
    slabDepth: 0.11,
    pierEvery: 3,
    roughness: 0.32,
    metalness: 0.55,
  },
  // Punched-window office: pale stone piers, deeper reveals, smaller openings.
  concrete: {
    frame: '#5d5850',
    slab: '#433e37',
    glass: ['#14161c', '#171a20', '#121419'],
    mullion: 0.13,
    slabDepth: 0.15,
    pierEvery: 2,
    roughness: 0.85,
    metalness: 0.04,
  },
  // Residential block: warm masonry, small regular openings, strong floors.
  brick: {
    frame: '#483832',
    slab: '#342722',
    glass: ['#16171c', '#191a1f', '#131418'],
    mullion: 0.17,
    slabDepth: 0.19,
    pierEvery: 2,
    roughness: 0.92,
    metalness: 0.03,
  },
};

/** Deterministic PRNG, so every reload lights the same windows. */
function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c.getContext('2d');
}

function finish(canvas, { srgb = true } = {}) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Build the colour and emissive maps for one facade style.
 *
 * Both come off the same grid, so a lit window sits exactly inside its own
 * pane rather than floating on the wall. The grid itself — mullions between
 * panes, a deeper slab band at every floor line, and a thicker pier every few
 * columns — is what survives at distance once the individual windows blur out.
 * That blur is the point: a real building seen from a kilometre away is a
 * texture, not a set of dots.
 */
export function makeFacade(style = 'glass', seed = 1) {
  const s = STYLE[style] || STYLE.glass;
  const rand = mulberry32(seed * 2654435761);

  const map = canvas2d(TILE_PX);
  const emis = canvas2d(TILE_PX);

  // Mullion grid is the background; panes are cut out of it.
  map.fillStyle = s.frame;
  map.fillRect(0, 0, TILE_PX, TILE_PX);
  emis.fillStyle = '#000000';
  emis.fillRect(0, 0, TILE_PX, TILE_PX);

  const cw = TILE_PX / COLS;
  const ch = TILE_PX / ROWS;
  const mx = Math.max(1, cw * s.mullion);
  const my = Math.max(1, ch * s.mullion);
  const slabH = Math.max(2, ch * s.slabDepth);

  // Floor slabs: the horizontal banding that makes a facade read as storeys.
  map.fillStyle = s.slab;
  for (let r = 0; r < ROWS; r++) map.fillRect(0, r * ch, TILE_PX, slabH);

  // Vertical piers: structure between bays, slightly proud of the mullions.
  map.fillStyle = s.slab;
  for (let c = 0; c < COLS; c += s.pierEvery) map.fillRect(c * cw, 0, mx * 1.6, TILE_PX);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * cw + mx;
      const y = r * ch + slabH + my * 0.5;
      const w = cw - mx * 2;
      const h = ch - slabH - my * 1.5;
      if (w <= 0 || h <= 0) continue;

      // Dark glass, always visible: this is what the wall is made of.
      map.fillStyle = s.glass[Math.floor(rand() * s.glass.length)];
      map.fillRect(x, y, w, h);

      if (rand() > LIT_FRACTION) continue;

      // A lit pane. Brightness varies so the facade is not a uniform stipple,
      // and a minority run cool — a wholly warm skyline looks tinted, not lit.
      const level = 0.68 + rand() * 0.32;
      const v = Math.round(255 * level);
      emis.fillStyle = rand() < COOL_FRACTION
        ? `rgb(${Math.round(v * 0.66)},${Math.round(v * 0.78)},${v})`
        : `rgb(${v},${Math.round(v * 0.85)},${Math.round(v * 0.63)})`;
      emis.fillRect(x, y, w, h);
    }
  }

  return {
    map: finish(map.canvas),
    emissiveMap: finish(emis.canvas),
    roughness: s.roughness,
    metalness: s.metalness,
  };
}

/** Flat dark cap for roofs — gravel, plant, membrane. Never windows. */
export function makeRoofTexture() {
  const ctx = canvas2d(64);
  ctx.fillStyle = '#1b1e24';
  ctx.fillRect(0, 0, 64, 64);
  const rand = mulberry32(99);
  for (let i = 0; i < 260; i++) {
    const v = 24 + Math.floor(rand() * 22);
    ctx.fillStyle = `rgb(${v},${v + 2},${v + 6})`;
    ctx.fillRect(rand() * 64, rand() * 64, 2, 2);
  }
  return finish(ctx.canvas);
}

/**
 * Fallback tiling normal map, used only if assets/waternormals.jpg cannot be
 * loaded. Summing a few sine waves at integer frequencies keeps it seamless
 * across the wrap, which a noise field would not be.
 */
export function makeWaterNormalsFallback(size = 256) {
  const ctx = canvas2d(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  const waves = [
    { fx: 2, fy: 1, amp: 1.0, phase: 0.0 },
    { fx: -1, fy: 3, amp: 0.6, phase: 1.7 },
    { fx: 4, fy: -2, amp: 0.35, phase: 3.1 },
    { fx: 3, fy: 5, amp: 0.2, phase: 0.6 },
  ];
  const TAU = Math.PI * 2;

  // Height field, then its analytic gradient — no finite differences, so the
  // normals stay smooth and tile exactly.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let dx = 0;
      let dy = 0;
      for (const w of waves) {
        const a = TAU * (w.fx * u + w.fy * v) + w.phase;
        const c = Math.cos(a) * w.amp * TAU;
        dx += c * w.fx;
        dy += c * w.fy;
      }
      const scale = 0.06;
      const nx = -dx * scale;
      const ny = -dy * scale;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return finish(ctx.canvas, { srgb: false });
}
