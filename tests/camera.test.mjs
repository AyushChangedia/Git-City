import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as L from '../js/layout.js';

/**
 * requiredDistance calls itself the most load-bearing function in the project:
 * get it wrong and you ship a black screen or a cropped city. These check the
 * property that matters — every corner of the city projects inside the frustum
 * — rather than pinning numbers that would just re-state the implementation.
 */

const boxOf = (x, y, z) => ({
  min: { x: -x / 2, y: 0, z: -z / 2 },
  max: { x: x / 2, y, z: z / 2 },
});

/** Does the whole box land inside the frame from this distance and aspect? */
function framed(box, aspect, distance) {
  const s = L.boxSize(box);
  const radius = 0.5 * Math.hypot(s.x, s.z);
  const halfH = s.y / 2;

  const vFov = (L.FOV * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const tanV = Math.tan(vFov / 2) / L.MARGIN;
  const tanH = Math.tan(hFov / 2) / L.MARGIN;

  const pitch = Math.max(L.ELEVATION - L.SKY_TILT, 0.01);
  const fwd = [-Math.cos(pitch), -Math.sin(pitch), 0];
  const right = [0, 0, -1];
  const up = [-Math.sin(pitch), Math.cos(pitch), 0];
  const cx = Math.cos(L.ELEVATION) * distance;
  const cy = Math.sin(L.ELEVATION) * distance;

  for (let i = 0; i < 64; i++) {
    const t = (i / 64) * Math.PI * 2;
    for (const y of [halfH, -halfH]) {
      const vx = radius * Math.cos(t) - cx;
      const vy = y - cy;
      const vz = radius * Math.sin(t);
      const zc = vx * fwd[0] + vy * fwd[1] + vz * fwd[2];
      if (zc <= 0) return false;
      const xc = vx * right[0] + vy * right[1] + vz * right[2];
      const yc = vx * up[0] + vy * up[1] + vz * up[2];
      if (Math.abs(xc) > zc * tanH || Math.abs(yc) > zc * tanV) return false;
    }
  }
  return true;
}

const SHAPES = [
  ['small square', boxOf(60, 20, 60)],
  ['sprawling', boxOf(900, 40, 700)],
  ['one tower', boxOf(10, 70, 10)],
  ['long and thin', boxOf(1200, 30, 40)],
  ['deep', boxOf(40, 30, 1200)],
];

const ASPECTS = [
  ['ultrawide', 21 / 9],
  ['landscape', 16 / 9],
  ['square', 1],
  ['portrait', 9 / 16],
];

for (const [shapeName, box] of SHAPES) {
  for (const [aspectName, aspect] of ASPECTS) {
    test(`${shapeName} city fits on a ${aspectName} window`, () => {
      const d = L.requiredDistance(box, aspect);
      assert.ok(framed(box, aspect, d), 'city is cropped at the computed distance');
    });
  }
}

test('a portrait window needs at least as much room as a landscape one', () => {
  // The horizontal field binds on a tall window; ignoring that crops the city.
  const box = boxOf(900, 40, 700);
  assert.ok(L.requiredDistance(box, 9 / 16) >= L.requiredDistance(box, 16 / 9));
});

test('a bigger city needs a longer lens', () => {
  const a = L.requiredDistance(boxOf(200, 30, 200), 16 / 9);
  const b = L.requiredDistance(boxOf(2000, 30, 2000), 16 / 9);
  assert.ok(b > a, 'distance should grow with the city');
});

test('never frames closer than the minimum, however sparse', () => {
  assert.equal(L.requiredDistance(boxOf(1, 2, 1), 16 / 9), L.MIN_FRAME_DISTANCE);
  assert.equal(L.requiredDistance(boxOf(0, 0, 0), 16 / 9), L.MIN_FRAME_DISTANCE);
});

test('the distance is finite for every shape and aspect', () => {
  for (const [, box] of SHAPES) {
    for (const [, aspect] of ASPECTS) {
      const d = L.requiredDistance(box, aspect);
      assert.ok(Number.isFinite(d) && d > 0, 'distance must be a usable number');
    }
  }
});

/* --------------------------------------------------------------- framing -- */

test('the camera sits above the city, looking down at it', () => {
  const box = boxOf(400, 40, 300);
  const { position, target } = L.framing(box, 16 / 9);
  assert.ok(position.y > target.y, 'camera should be above what it aims at');
  assert.ok(position.y > 0, 'camera should be above ground');
});

test('the camera is outside the city, not inside a building', () => {
  const box = boxOf(400, 40, 300);
  const { position } = L.framing(box, 16 / 9);
  const centre = L.boxCenter(box);
  const horizontal = Math.hypot(position.x - centre.x, position.z - centre.z);
  assert.ok(horizontal > L.boundingRadius(box), 'camera must clear the city footprint');
});

test('the aim is lifted so the horizon is not at the frame edge', () => {
  const box = boxOf(400, 40, 300);
  const { target } = L.framing(box, 16 / 9);
  assert.ok(target.y > L.boxCenter(box).y, 'target should sit above the city centre');
});

test('orbiting keeps the same distance at every azimuth', () => {
  // The fit models the city as a cylinder precisely so it holds all the way
  // round; if it did not, the auto-orbit would crop the city at some angles.
  const box = boxOf(600, 40, 300);
  const centre = L.boxCenter(box);
  const distances = [];
  for (let i = 0; i < 8; i++) {
    const { position } = L.framing(box, 16 / 9, (i / 8) * Math.PI * 2);
    distances.push(Math.hypot(position.x - centre.x, position.y - centre.y, position.z - centre.z));
  }
  for (const d of distances) assert.ok(Math.abs(d - distances[0]) < 1e-6);
});

/* ---------------------------------------------------------------- bounds -- */

test('bounds cover every building footprint, not just its centre', () => {
  const box = L.cityBounds([{ x: 0, z: 0, height: 10 }]);
  assert.equal(L.boxSize(box).x, L.FOOTPRINT);
  assert.equal(L.boxSize(box).z, L.FOOTPRINT);
});

test('bounds rise to the tallest building', () => {
  const box = L.cityBounds([
    { x: 0, z: 0, height: 5 },
    { x: 40, z: 40, height: 61 },
  ]);
  assert.equal(box.max.y, 61);
});

test('an empty city has no bounds to frame', () => {
  assert.equal(L.cityBounds([]), null);
});
