/**
 * random.test.mjs — the seeded generator the city's variation rests on.
 *
 * The property that matters is not the quality of the randomness. It is that
 * the same seed gives the same sequence, every reload, forever: the window
 * lights, the roof clutter and the horizon skyline are all drawn from this,
 * and a city that reshuffles itself on every page load reads as noise instead
 * of as a place.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32 } from '../js/random.js';

test('the same seed gives the same sequence', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('different seeds give different sequences', () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  const first = Array.from({ length: 10 }, a);
  const second = Array.from({ length: 10 }, b);
  assert.notDeepEqual(first, second);
});

test('every value is in [0, 1)', () => {
  const rand = mulberry32(0xc17ded);
  for (let i = 0; i < 20000; i++) {
    const v = rand();
    assert.ok(v >= 0 && v < 1, `${v} is outside [0, 1)`);
  }
});

test('the sequence does not stall on one value', () => {
  // A generator that stops advancing would leave every building identical,
  // which looks like a layout bug rather than a random one.
  const rand = mulberry32(7);
  const seen = new Set(Array.from({ length: 1000 }, rand));
  assert.ok(seen.size > 990, `only ${seen.size} distinct values in 1000`);
});

test('a seed of zero still produces a sequence', () => {
  // The additive constant is what saves this: without it a zero state would
  // stay zero and every draw would be the same number.
  const rand = mulberry32(0);
  const values = Array.from({ length: 5 }, rand);
  assert.equal(new Set(values).size, 5);
});

test('seeds are taken as 32-bit integers, not silently rounded', () => {
  // textures.js seeds with `seed * 2654435761`, which is far past 2^32 — the
  // truncation has to be the generator's own and consistent.
  const big = mulberry32(2654435761);
  const wrapped = mulberry32(2654435761 | 0);
  assert.equal(big(), wrapped());
});

test('spreads roughly evenly across the unit interval', () => {
  const rand = mulberry32(99);
  const buckets = new Array(10).fill(0);
  const n = 100000;
  for (let i = 0; i < n; i++) buckets[Math.floor(rand() * 10)] += 1;
  for (const [i, count] of buckets.entries()) {
    assert.ok(
      Math.abs(count - n / 10) < n / 40,
      `bucket ${i} holds ${count} of ${n}, which is lopsided`,
    );
  }
});
