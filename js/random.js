/**
 * random.js — a seeded pseudo-random generator, written once.
 *
 * Nothing here is random in the sense that matters for security; it is random
 * in the sense that matters for a city. Window lights, roof clutter, the
 * filler skyline on the horizon and the lamp spacing all need variation that
 * is *the same on every reload*, because a city that reshuffles itself every
 * time the page loads reads as noise rather than as a place.
 *
 * mulberry32 was copied into both world.js and textures.js. Two copies of a
 * generator is two chances for one of them to be tweaked and the city to come
 * apart along that seam — and neither copy was reachable from a test, since
 * both files import three.js.
 */

/**
 * @param {number} seed any 32-bit integer; the same seed gives the same run
 * @returns {() => number} successive values in [0, 1)
 */
export function mulberry32(seed) {
  let state = seed | 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
