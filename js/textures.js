/**
 * textures.js — canvas-generated textures, built once at startup.
 *
 * Nothing here is fetched. A window pattern is a grid of small bright
 * rectangles, which is cheaper to draw than to download, and generating it
 * means the lit/unlit pattern can be seeded rather than shipped.
 */

import * as THREE from 'three';

/** One texture tile spans this many world units, on every axis. */
export const WINDOW_TILE_UNITS = 4;

const WINDOW_COLS = 4;
const WINDOW_ROWS = 4;
const LIT_FRACTION = 0.45;

/** Deterministic PRNG, so every reload lights the same windows. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The emissive map for building walls: a dark tile with a grid of windows,
 * roughly 45% of them lit.
 *
 * This is the single change that stops the buildings reading as bars on a
 * chart. A flat-shaded box is a box at any size; a box with rows of lit windows
 * has a storey height, and a storey height is what tells you it is a building.
 *
 * The tile wraps, so it is drawn to be seamless: windows sit fully inside the
 * cell with a margin, and no window straddles an edge.
 */
export function makeWindowTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Unlit walls are near-black: this map only drives emission, so anything
  // non-zero here glows in the dark.
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, size, size);

  const rand = mulberry32(0x5eed1a);
  const cellW = size / WINDOW_COLS;
  const cellH = size / WINDOW_ROWS;
  // Generous windows: at the default framing a window is only a pixel or two
  // across, and thin ones alias into a stipple rather than reading as light.
  const winW = cellW * 0.52;
  const winH = cellH * 0.36;

  for (let row = 0; row < WINDOW_ROWS; row++) {
    for (let col = 0; col < WINDOW_COLS; col++) {
      if (rand() > LIT_FRACTION) continue;

      // Vary brightness a little so the facade is not a uniform stipple.
      const warmth = 0.72 + rand() * 0.28;
      const v = Math.round(255 * warmth);
      ctx.fillStyle = `rgb(${v},${Math.round(v * 0.88)},${Math.round(v * 0.68)})`;

      const x = col * cellW + (cellW - winW) / 2;
      const y = row * cellH + (cellH - winH) / 2;
      ctx.fillRect(x, y, winW, winH);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Fallback tiling normal map, used only if assets/waternormals.jpg cannot be
 * loaded. Summing a few sine waves at integer frequencies keeps it seamless
 * across the wrap, which a noise field would not be.
 */
export function makeWaterNormalsFallback(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
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

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}
