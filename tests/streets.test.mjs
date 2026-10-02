/**
 * streets.test.mjs — the roads, which are what the districts leave behind.
 *
 * Nothing places a street. The districts are packed first and the gaps between
 * them become the roads, so the two can never disagree about where the
 * buildings are. The arithmetic for that lived inside world.js, which imports
 * three.js, and so had never been run outside a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_STREET_WIDTH, collapseGaps, fillerReach, lampSpots } from '../js/streets.js';

/* ------------------------------------------------------- collapseGaps -- */

test('the space between two districts is a street', () => {
  assert.deepEqual(collapseGaps([[0, 10], [20, 30]]), [[10, 20]]);
});

test('districts that touch leave no street between them', () => {
  assert.deepEqual(collapseGaps([[0, 10], [10, 20]]), []);
});

test('a hairline gap is a seam, not a road', () => {
  // Otherwise every boundary between neighbouring plots gets tarmac and a
  // pair of lamp posts in it.
  assert.deepEqual(collapseGaps([[0, 10], [10.4, 20]]), []);
  assert.deepEqual(collapseGaps([[0, 10], [10 + MIN_STREET_WIDTH + 0.5, 20]]), [
    [10, 11.5],
  ]);
});

test('overlapping districts merge into one run', () => {
  assert.deepEqual(collapseGaps([[0, 15], [10, 30], [40, 50]]), [[30, 40]]);
});

test('a district entirely inside another does not split the run', () => {
  // The shorter interval ends first, so taking its end as the new boundary
  // would invent a street inside a block.
  assert.deepEqual(collapseGaps([[0, 100], [20, 30]]), []);
});

test('input order does not matter', () => {
  const shuffled = [[40, 50], [0, 10], [20, 30]];
  assert.deepEqual(collapseGaps(shuffled), [[10, 20], [30, 40]]);
});

test("the caller's intervals are not written to", () => {
  // It merges by mutating the run it is building; that must not be the array
  // it was handed, or laying the roads would move the districts.
  const districts = [[0, 15], [10, 30]];
  const before = JSON.parse(JSON.stringify(districts));
  collapseGaps(districts);
  assert.deepEqual(districts, before);
});

test('one district leaves no streets at all', () => {
  assert.deepEqual(collapseGaps([[0, 10]]), []);
});

test('no districts leaves no streets', () => {
  assert.deepEqual(collapseGaps([]), []);
});

test('negative coordinates work, since one bank of the river is negative', () => {
  assert.deepEqual(collapseGaps([[-50, -40], [-10, 0]]), [[-40, -10]]);
});

test('several streets come back left to right', () => {
  const gaps = collapseGaps([[0, 10], [20, 30], [45, 50], [70, 80]]);
  assert.deepEqual(gaps, [[10, 20], [30, 45], [50, 70]]);
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i][0] >= gaps[i - 1][1], 'gaps are out of order');
  }
});

/* -------------------------------------------------------- fillerReach -- */

test('the horizon is pushed well past the city', () => {
  // Far enough that the real city never looks like it stands at the edge of
  // the world.
  assert.ok(fillerReach({ x: 100, z: 100 }) > 650);
});

test('the horizon scales with the larger side of the city', () => {
  assert.equal(fillerReach({ x: 200, z: 50 }), fillerReach({ x: 50, z: 200 }));
  assert.ok(fillerReach({ x: 800, z: 20 }) > fillerReach({ x: 200, z: 20 }));
});

test('an empty city still gets a horizon', () => {
  assert.ok(fillerReach({ x: 0, z: 0 }) >= 650);
});

/* ----------------------------------------------------------- lampSpots -- */

const straddle = (t) => [[t, 0], [t, 1]];

test('lamps are spaced along the run', () => {
  const spots = lampSpots(0, 100, 25, straddle);
  assert.deepEqual(spots.map(([t]) => t), [12.5, 12.5, 37.5, 37.5, 62.5, 62.5, 87.5, 87.5]);
});

test('the first lamp stands half a span in, not in the junction', () => {
  assert.equal(lampSpots(0, 100, 25, straddle)[0][0], 12.5);
});

test('both sides of the street get one', () => {
  const spots = lampSpots(0, 50, 25, straddle);
  assert.equal(spots.length, 4);
});

test('no lamp is placed past the end of the run', () => {
  for (const [t] of lampSpots(10, 40, 7, straddle)) {
    assert.ok(t < 40, `${t} is past the end`);
  }
});

test('a run shorter than half a span gets no lamps', () => {
  assert.deepEqual(lampSpots(0, 5, 25, straddle), []);
});

test('a spacing of zero returns nothing rather than looping forever', () => {
  // `for (t = from; t < to; t += 0)` never ends, and the page just stops.
  assert.deepEqual(lampSpots(0, 100, 0, straddle), []);
  assert.deepEqual(lampSpots(0, 100, -5, straddle), []);
});
