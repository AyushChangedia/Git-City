/**
 * streets.js — where the roads go, and how far the horizon reaches.
 *
 * A road is not placed; it is what is left over. The districts are packed
 * first, and the streets are the gaps between them, which means the two can
 * never disagree about where the buildings are.
 *
 * Pure arithmetic over intervals, kept out of world.js so it can be run
 * without a renderer. All of this was previously module-private inside a file
 * that imports three.js, and so was unreachable from a test.
 */

/** A gap narrower than this is a seam between neighbours, not a street. */
export const MIN_STREET_WIDTH = 1;

/** Two runs closer than this are touching, as far as floating point goes. */
const TOUCHING = 0.001;

/**
 * Merge overlapping or touching intervals, then return the gaps between them.
 *
 * Turns "where the districts are" into "where the roads go".
 *
 * @param {Array<[number, number]>} intervals in any order; not modified
 * @returns {Array<[number, number]>} the gaps, left to right
 */
export function collapseGaps(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    // A new pair every time, so the caller's intervals are never written to.
    if (last && a <= last[1] + TOUCHING) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }

  const gaps = [];
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1][1];
    const b = merged[i][0];
    if (b - a > MIN_STREET_WIDTH) gaps.push([a, b]);
  }
  return gaps;
}

/**
 * How far the filler skyline spreads from the city centre.
 *
 * Far enough that the real city never appears to stand at the edge of the
 * world, and scaled to the city so a large one is not ringed too tightly.
 */
export function fillerReach(size) {
  return Math.max(size.x, size.z) * 1.5 + 650;
}

/**
 * Lamp positions along a run, at a fixed spacing, offset half a span so the
 * first lamp is not standing in the junction.
 *
 * @param {number} from start of the run
 * @param {number} to end of it
 * @param {number} spacing distance between lamps
 * @param {(t: number) => Array<[number, number]>} place one position to the
 *   pair of spots that straddle the street there
 */
export function lampSpots(from, to, spacing, place) {
  const out = [];
  if (!(spacing > 0)) return out;
  for (let t = from + spacing / 2; t < to; t += spacing) {
    for (const spot of place(t)) out.push(spot);
  }
  return out;
}
