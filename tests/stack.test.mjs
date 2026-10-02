/**
 * stack.test.mjs — the boxes a building is made of, and how it rises.
 *
 * One invariant carries most of the weight: the boxes have to add up to exactly
 * the height asked for. Everything above a building's podium is positioned by
 * stacking, so a rounding slip is a floating roof or a visible gap, on every
 * building in the city at once, for the whole run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shapeFor, podiumWidthFor, widthFor, hashOf } from '../js/variation.js';
import {
  MIN_SCALE, SPIRE_FRACTION, TAPER_RATIO,
  at, boxesFor, clamp01, easeOutCubic, podiumHeightFor, progress, topOf,
} from '../js/stack.js';

const WIDTH = 2.3;
const PODIUM_WIDTH = podiumWidthFor(WIDTH);
const stack = (height) => boxesFor(height, shapeFor(height), WIDTH, PODIUM_WIDTH);

/* ------------------------------------------------------------- boxesFor -- */

test('a low-rise is a single box standing on the ground', () => {
  const boxes = stack(5);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].y, 0);
  assert.equal(boxes[0].height, 5);
  assert.equal(boxes[0].width, WIDTH);
});

test('a mid-rise is a podium with a shaft on it', () => {
  const boxes = stack(20);
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].width, PODIUM_WIDTH);
  assert.equal(boxes[1].width, WIDTH);
  assert.equal(boxes[1].y, boxes[0].height, 'the shaft does not sit on the podium');
});

test('a tower is a podium and three narrowing tiers', () => {
  const boxes = stack(50);
  assert.equal(boxes.length, 4);
  const [, first, second, third] = boxes;
  assert.ok(Math.abs(second.width - first.width * TAPER_RATIO) < 1e-9);
  assert.ok(Math.abs(third.width - first.width * TAPER_RATIO ** 2) < 1e-9);
});

test('the boxes add up to the height asked for, at every height', () => {
  // The invariant. Checked at every quarter unit across both thresholds.
  for (let h = 0.25; h <= 80; h += 0.25) {
    assert.ok(Math.abs(topOf(stack(h)) - h) < 1e-9, `at height ${h} the stack reached ${topOf(stack(h))}`);
  }
});

test('every box sits exactly on the one below, with no gap and no overlap', () => {
  for (const h of [3, 12.5, 20, 31, 45, 70]) {
    const boxes = stack(h);
    for (let i = 1; i < boxes.length; i++) {
      assert.equal(
        boxes[i].y,
        boxes[i - 1].y + boxes[i - 1].height,
        `box ${i} of a ${h}-unit building is not on box ${i - 1}`,
      );
    }
  }
});

test('nothing is ever given a scale of zero', () => {
  // three.js normals degenerate at a zero scale, and a building is at zero
  // height for the frame it is created in and the frame it dies on.
  for (const h of [0, -1, MIN_SCALE / 2]) {
    for (const box of boxesFor(h, shapeFor(h), WIDTH, PODIUM_WIDTH)) {
      assert.ok(box.height >= MIN_SCALE, `height ${h} gave a box of ${box.height}`);
      assert.ok(box.width > 0);
    }
  }
});

test('a podium stops growing once it is three and a half units', () => {
  // Otherwise a seventy-unit tower has a fourteen-unit plinth.
  assert.equal(podiumHeightFor(70), 3.5);
  assert.equal(podiumHeightFor(10), 2);
});

test('the podium is never taller than the building it is under', () => {
  for (let h = 0.5; h <= 80; h += 0.5) {
    assert.ok(podiumHeightFor(h) <= h || h < MIN_SCALE, `at ${h} the podium was ${podiumHeightFor(h)}`);
  }
});

test('the podium is the widest box, so the building meets the ground', () => {
  const boxes = stack(50);
  assert.equal(Math.max(...boxes.map((b) => b.width)), boxes[0].width);
});

test('the shape it is given decides the stack, not the height twice over', () => {
  // _buildParts keeps a shrinking building's tiers, so boxesFor is called with
  // a tall shape and a short height. It must still produce that many boxes.
  const boxes = boxesFor(4, { tiers: 3, hasPodium: true }, WIDTH, PODIUM_WIDTH);
  assert.equal(boxes.length, 4);
  assert.ok(Math.abs(topOf(boxes) - 4) < 1e-9);
});

test('real paths all produce well-formed stacks', () => {
  for (const path of ['js/main.js', 'README.md', 'a']) {
    const width = widthFor(hashOf(path));
    for (const h of [1, 13, 35, 70]) {
      const boxes = boxesFor(h, shapeFor(h), width, podiumWidthFor(width));
      assert.ok(boxes.length >= 1);
      assert.ok(Math.abs(topOf(boxes) - h) < 1e-9, `${path} at ${h}`);
    }
  }
});

test('an empty stack has a top of zero rather than undefined', () => {
  assert.equal(topOf([]), 0);
});

/* ------------------------------------------------------------ the tween -- */

test('a tween runs from nothing to all of it', () => {
  assert.equal(progress(0, 0, 300), 0);
  assert.equal(progress(300, 0, 300), 1);
});

test('a tween is past halfway at halfway, since it eases out', () => {
  const half = progress(150, 0, 300);
  assert.ok(half > 0.5 && half < 1, `halfway gave ${half}`);
});

test('a tween never overshoots or runs backwards', () => {
  for (let t = -500; t <= 1000; t += 10) {
    const e = progress(t, 0, 300);
    assert.ok(e >= 0 && e <= 1, `t=${t} gave ${e}`);
  }
});

test('a tween only ever moves forward', () => {
  let previous = -1;
  for (let t = 0; t <= 300; t += 5) {
    const e = progress(t, 0, 300);
    assert.ok(e >= previous, `went backwards at t=${t}`);
    previous = e;
  }
});

test('a duration of zero means already arrived, not a division by it', () => {
  // The NaN that produced reached the easing and left the building at no
  // height at all, which looks like a building that failed to appear.
  assert.equal(progress(0, 0, 0), 1);
  assert.equal(progress(100, 0, -5), 1);
});

test('the easing starts fast and settles', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.25) > 0.5, 'the first quarter should cover more than a quarter');
  assert.ok(easeOutCubic(0.9) > 0.99, 'the last tenth should barely move');
});

test('clamp01 holds the ends', () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(0.4), 0.4);
  assert.equal(clamp01(7), 1);
});

test('interpolation hits both ends exactly', () => {
  assert.equal(at(10, 50, 0), 10);
  assert.equal(at(10, 50, 1), 50);
  assert.equal(at(10, 50, 0.5), 30);
});

test('interpolation works downward, which is how a building is demolished', () => {
  assert.equal(at(40, 0, 1), 0);
  assert.equal(at(40, 0, 0.5), 20);
});

test('a spire is a fraction of the building, not a fixed mast', () => {
  assert.ok(SPIRE_FRACTION > 0 && SPIRE_FRACTION < 1);
  assert.ok(70 * SPIRE_FRACTION > 5 * SPIRE_FRACTION);
});
