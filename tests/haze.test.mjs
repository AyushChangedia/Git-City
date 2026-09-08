/**
 * haze.test.mjs — the fog density solve and the sun direction.
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
  SUN_AZIMUTH_DEG,
  SUN_ELEVATION_DEG,
  hazeDensityFor,
  sunDirection,
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

/* ----------------------------------------------------------------- sun -- */

test('the sun direction is a unit vector', () => {
  // three.js takes it as a direction; a non-unit one scales the light.
  const v = sunDirection();
  assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-12);
});

test('the sun sits at the documented elevation', () => {
  // Two degrees. The whole look — long shadows, lit windows, the haze — is
  // built on the sun being barely above the horizon.
  const v = sunDirection();
  const elevation = (Math.asin(v.y) * 180) / Math.PI;
  assert.ok(Math.abs(elevation - SUN_ELEVATION_DEG) < 1e-9, `got ${elevation}`);
});

test('it matches three.js setFromSphericalCoords, which is what world.js used', () => {
  // The formula three.js uses: x = sin(phi)sin(theta), y = cos(phi),
  // z = sin(phi)cos(theta). Extracting this out of world.js must not have
  // changed where the sun is by so much as a rounding error.
  const phi = ((90 - SUN_ELEVATION_DEG) * Math.PI) / 180;
  const theta = (SUN_AZIMUTH_DEG * Math.PI) / 180;
  const expected = {
    x: Math.sin(phi) * Math.sin(theta),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.cos(theta),
  };
  const v = sunDirection();
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(v[axis] - expected[axis]) < 1e-15, `${axis}: ${v[axis]} vs ${expected[axis]}`);
  }
});

test('the sun is low and behind the city, not overhead', () => {
  // Overhead would flatten every shadow and the whole scene with them.
  const v = sunDirection();
  assert.ok(v.y > 0, 'above the horizon, or it is night');
  assert.ok(v.y < 0.1, 'barely above it');
  assert.ok(Math.abs(v.z) > 0.9, 'roughly along the river axis');
});

test('elevation and azimuth can be varied for a test without moving the default', () => {
  assert.ok(Math.abs(sunDirection(90, 0).y - 1) < 1e-12, 'straight up');
  assert.ok(Math.abs(sunDirection(0, 0).z - 1) < 1e-12, 'on the horizon towards +Z');
  assert.deepEqual(sunDirection(), sunDirection(SUN_ELEVATION_DEG, SUN_AZIMUTH_DEG));
});
