/**
 * stack.js — how a building's height divides between its boxes, and how it
 * gets there.
 *
 * A building is one to four stacked boxes: an optional podium, then one shaft
 * or three setback tiers. Deciding each box's height is the arithmetic that
 * makes a tower a tower, and it has one invariant that matters — the boxes
 * must add up to exactly the height asked for. A rounding slip there is a
 * floating roof or a gap above the podium, visible on every building at once.
 *
 * Lifted out of City._shapeTo, which needs a WebGL context, so the invariant
 * could never be asserted.
 */

import { SEGMENT_SPLIT } from './variation.js';

/** Nothing is given a scale of zero: three.js normals degenerate at zero. */
export const MIN_SCALE = 1e-4;

/** A podium is a fifth of the building, up to three and a half units. */
const PODIUM_FRACTION = 0.2;
const PODIUM_MAX = 3.5;

/** Each tier is this fraction of the width of the one below it. */
export const TAPER_RATIO = 0.85;

/** A spire is this much of the building's height again, above the roof. */
export const SPIRE_FRACTION = 0.22;

export const podiumHeightFor = (height) =>
  Math.max(Math.min(height * PODIUM_FRACTION, PODIUM_MAX), MIN_SCALE);

/**
 * The boxes a building of this height and shape is made of, bottom to top.
 *
 * @param {number} height the building's full height
 * @param {{tiers: number, hasPodium: boolean}} shape from variation.shapeFor
 * @param {number} width the shaft's width
 * @param {number} podiumWidth the podium's width
 * @returns {Array<{width: number, height: number, y: number}>}
 */
export function boxesFor(height, shape, width, podiumWidth) {
  const h = Math.max(height, MIN_SCALE);
  const boxes = [];
  let y = 0;

  if (shape.hasPodium) {
    const podiumHeight = podiumHeightFor(h);
    boxes.push({ width: podiumWidth, height: podiumHeight, y });
    y += podiumHeight;
  }

  const shaft = Math.max(h - y, MIN_SCALE);
  for (let t = 0; t < shape.tiers; t++) {
    const fraction = shape.tiers === 1 ? 1 : SEGMENT_SPLIT[t];
    const segment = Math.max(shaft * fraction, MIN_SCALE);
    boxes.push({ width: width * Math.pow(TAPER_RATIO, t), height: segment, y });
    y += segment;
  }

  return boxes;
}

/** Where the top of the stack lands — the roof, and the foot of any spire. */
export const topOf = (boxes) =>
  boxes.length === 0 ? 0 : boxes[boxes.length - 1].y + boxes[boxes.length - 1].height;

/* ------------------------------------------------------------- the tween -- */

export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Fast at first, settling at the end — a building rising, not a bar growing. */
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/**
 * How far through a tween we are, eased.
 *
 * A duration of zero means "already there" rather than a division by it, which
 * would reach the easing as a NaN and leave the building at no height at all.
 */
export function progress(now, start, durationMs) {
  if (!(durationMs > 0)) return 1;
  return easeOutCubic(clamp01((now - start) / durationMs));
}

/** Interpolate one value along that progress. */
export const at = (from, to, t) => from + (to - from) * t;
