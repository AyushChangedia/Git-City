/**
 * haze.test.mjs — the fog density solve.
 *
 * The whole point of deriving the density rather than picking one is that the
 * veil over the city stays constant while the camera standoff does not. That
 * is an invariant, and an invariant with no test is a comment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HAZE_AT_SUBJECT,
  HAZE_DENSITY_MAX,
  HAZE_DENSITY_MIN,
  MIN_FRAME_DISTANCE,
  hazeDensityFor,
  veilAt,
} from '../js/layout.js';

test('the veil over the city is the same at every framing distance', () => {
  // The reason the density is solved per city instead of chosen. A fixed
  // 0.0018 gives a 15% veil at 220 units and a 63% one at 560 — atmosphere
  // versus a pink screen.
  for (const distance of [220, 300, 400, 560, 800]) {
    const veil = veilAt(hazeDensityFor(distance), distance);
    assert.ok(
      Math.abs(veil - HAZE_AT_SUBJECT) < 1e-9,
      `at ${distance} units the veil was ${(veil * 100).toFixed(1)}%`,
    );
  }
});

test('the minimum framing distance reproduces the documented density', () => {
  // The README and the old hardcoded constant both say ≈0.0018.
  const density = hazeDensityFor(MIN_FRAME_DISTANCE);
  assert.ok(Math.abs(density - 0.0018) < 0.0001, `got ${density}`);
});

test('a city framed from further back gets thinner haze', () => {
  // Otherwise a sprawling repo is looking through soup.
  const near = hazeDensityFor(MIN_FRAME_DISTANCE);
  const far = hazeDensityFor(MIN_FRAME_DISTANCE * 3);
  assert.ok(far < near, `${far} should be thinner than ${near}`);
});

test('density falls monotonically as the camera pulls back', () => {
  let previous = Infinity;
  for (let d = 220; d <= 2000; d += 40) {
    const density = hazeDensityFor(d);
    assert.ok(density <= previous, `density rose between ${d - 40} and ${d}`);
    previous = density;
  }
});

test('the result is clamped at both ends', () => {
  // No atmosphere at all gives the horizon a hard edge; too much drowns a
  // small city.
  assert.equal(hazeDensityFor(1e9), HAZE_DENSITY_MIN);
  assert.equal(hazeDensityFor(1), HAZE_DENSITY_MAX);
  for (const d of [1, 50, 220, 5000, 1e9]) {
    const density = hazeDensityFor(d);
    assert.ok(density >= HAZE_DENSITY_MIN && density <= HAZE_DENSITY_MAX, `${d} -> ${density}`);
  }
});

test('a nonsense distance still produces a usable density', () => {
  // scene.fog.density = NaN renders the whole scene as flat fog colour, which
  // looks like the renderer died.
  for (const bad of [0, -100, NaN, undefined, null, 'far']) {
    const density = hazeDensityFor(bad);
    assert.ok(Number.isFinite(density), `${String(bad)} produced ${density}`);
    assert.ok(density >= HAZE_DENSITY_MIN && density <= HAZE_DENSITY_MAX);
  }
});

test('veilAt agrees with the fog model at its endpoints', () => {
  assert.equal(veilAt(0, 500), 0, 'no fog hides nothing');
  assert.ok(veilAt(0.01, 100000) > 0.999, 'thick fog at distance hides everything');
});
