/**
 * variation.js — how one building differs from its neighbour.
 *
 * A block of identical boxes on a regular grid reads as a bar chart however it
 * is textured. Real streets have buildings of different widths, with different
 * facades, meeting the ground and the sky in different ways. All of that is
 * derived from the file's path, which has two consequences worth stating:
 *
 *   a file always looks like itself, on every reload and in every dataset
 *   nothing has to be stored, and no two runs can disagree
 *
 * Separate bit ranges of one hash feed the separate decisions, so a building's
 * width and its facade are independent rather than moving together.
 */

import { FOOTPRINT, TAPER_HEIGHT } from './layout.js';

/** How much of its plot the narrowest building fills, and the spread above it. */
export const WIDTH_MIN = 0.74;
export const WIDTH_RANGE = 0.26;

/** Above this a building gets a podium: a wider two-or-three storey base. */
export const PODIUM_HEIGHT = 12;

/** A podium is this much wider than the shaft, within the plot. */
const PODIUM_WIDEN = 1.22;

/** A tall building is three boxes; this is how the height divides between them. */
export const SEGMENT_SPLIT = [0.46, 0.32, 0.22];

/** Shade varies a little so neighbours are not literally the same colour. */
const SHADE_MIN = 0.9;
const SHADE_RANGE = 0.2;

/** How many commits a building stays warm for after being touched. */
export const HEAT_COMMITS = 20;

/** FNV-1a. Stable across reloads, engines and platforms. */
export function hashOf(path) {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A fraction in [0, 1) from ten bits of the hash, starting at `shift`. */
const fractionAt = (hash, shift) => ((hash >>> shift) % 1000) / 1000;

/** How wide the building is, in world units. The plot itself never changes. */
export function widthFor(hash) {
  return FOOTPRINT * (WIDTH_MIN + fractionAt(hash, 4) * WIDTH_RANGE);
}

/** The podium's width, which may not overflow the plot. */
export function podiumWidthFor(width) {
  return Math.min(FOOTPRINT, width * PODIUM_WIDEN);
}

/** Which facade style, as an index into FACADE_STYLES. */
export function styleFor(hash, styleCount) {
  return styleCount > 0 ? hash % styleCount : 0;
}

/** A per-building multiplier on the base colour. */
export function shadeFor(hash) {
  return SHADE_MIN + fractionAt(hash, 14) * SHADE_RANGE;
}

/**
 * How many boxes this building is made of, and whether it has a podium.
 *
 * Anything worth calling a building meets the ground differently from the way
 * it meets the sky. A single extruded box is a bar; a setback taper is a tower.
 */
export function shapeFor(height) {
  const tiers = height > TAPER_HEIGHT ? SEGMENT_SPLIT.length : 1;
  const hasPodium = height > PODIUM_HEIGHT;
  return { tiers, hasPodium, parts: tiers + (hasPodium ? 1 : 0) };
}

/**
 * How cool a building has gone, from 0 the commit it was touched to 1 once it
 * has been left alone for HEAT_COMMITS.
 */
export function coolnessAt(commitIndex, lastTouched, over = HEAT_COMMITS) {
  if (!(over > 0)) return 1;
  const age = (commitIndex - lastTouched) / over;
  return age < 0 ? 0 : age > 1 ? 1 : age;
}
