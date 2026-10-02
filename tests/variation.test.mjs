/**
 * variation.test.mjs — what makes one building look unlike its neighbour.
 *
 * All of it is derived from the path, which is the point: a file looks like
 * itself on every reload, in every dataset, on every machine, and nothing has
 * to be stored for that to hold. These tests mostly pin that stability, since
 * it is the property that silently stops being true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FOOTPRINT, TAPER_HEIGHT } from '../js/layout.js';
import {
  HEAT_COMMITS, PODIUM_HEIGHT, SEGMENT_SPLIT, WIDTH_MIN, WIDTH_RANGE,
  coolnessAt, hashOf, podiumWidthFor, shadeFor, shapeFor, styleFor, widthFor,
} from '../js/variation.js';

const PATHS = [
  'js/main.js', 'js/city.js', 'README.md', 'src/a.ts', 'src/b.ts',
  'a', '', 'deeply/nested/path/to/a/file.json', 'spaced name.txt', 'π.js',
];

/* -------------------------------------------------------------- hashOf -- */

test('the same path always hashes the same', () => {
  for (const path of PATHS) assert.equal(hashOf(path), hashOf(path));
});

test('different paths hash differently', () => {
  const seen = new Map();
  for (const path of PATHS) {
    const h = hashOf(path);
    assert.ok(!seen.has(h), `${path} collides with ${seen.get(h)}`);
    seen.set(h, path);
  }
});

test('the hash is an unsigned 32-bit integer', () => {
  // It is shifted right with >>> and taken modulo; a negative would wrap and
  // the derived width would jump.
  for (const path of PATHS) {
    const h = hashOf(path);
    assert.ok(Number.isInteger(h), `${path} hashed to ${h}`);
    assert.ok(h >= 0 && h <= 0xffffffff, `${path} hashed to ${h}`);
  }
});

test('one character apart is not one bit apart', () => {
  // src/a.ts and src/b.ts sit next to each other in the same district, so a
  // hash that barely moved would give them the same width and facade.
  const a = hashOf('src/a.ts');
  const b = hashOf('src/b.ts');
  assert.notEqual(widthFor(a), widthFor(b));
});

test('an empty path still hashes', () => {
  assert.equal(typeof hashOf(''), 'number');
  assert.ok(Number.isInteger(hashOf('')));
});

/* ------------------------------------------------------------ widthFor -- */

test('a building fits inside its plot and is not a sliver', () => {
  for (const path of PATHS) {
    const width = widthFor(hashOf(path));
    assert.ok(width <= FOOTPRINT, `${path} is ${width}, wider than its plot`);
    assert.ok(width >= FOOTPRINT * WIDTH_MIN, `${path} is only ${width}`);
  }
});

test('the full spread is reachable, so the street is not uniform', () => {
  const widths = new Set();
  for (let i = 0; i < 4000; i++) widths.add(widthFor(hashOf(`file-${i}.js`)));
  const min = Math.min(...widths);
  const max = Math.max(...widths);
  assert.ok(min < FOOTPRINT * (WIDTH_MIN + 0.05 * WIDTH_RANGE), `narrowest was ${min}`);
  assert.ok(max > FOOTPRINT * (WIDTH_MIN + 0.95 * WIDTH_RANGE), `widest was ${max}`);
});

/* ------------------------------------------------------ podiumWidthFor -- */

test('a podium is wider than its shaft', () => {
  assert.ok(podiumWidthFor(2) > 2);
});

test('a podium never overflows the plot', () => {
  // A podium wider than the plot overlaps the pavement and the next building.
  for (let w = FOOTPRINT * WIDTH_MIN; w <= FOOTPRINT; w += 0.01) {
    assert.ok(podiumWidthFor(w) <= FOOTPRINT, `a ${w}-wide shaft gave ${podiumWidthFor(w)}`);
  }
  assert.equal(podiumWidthFor(FOOTPRINT), FOOTPRINT);
});

/* ------------------------------------------------------------ styleFor -- */

test('the style is a usable index', () => {
  for (const path of PATHS) {
    const i = styleFor(hashOf(path), 3);
    assert.ok(Number.isInteger(i) && i >= 0 && i < 3, `${path} gave ${i}`);
  }
});

test('all three styles appear across a city', () => {
  const styles = new Set();
  for (let i = 0; i < 300; i++) styles.add(styleFor(hashOf(`f${i}.js`), 3));
  assert.deepEqual([...styles].sort(), [0, 1, 2]);
});

test('no styles at all gives index zero, not NaN', () => {
  // A NaN index makes every material undefined and the whole city invisible.
  assert.equal(styleFor(hashOf('a.js'), 0), 0);
});

/* ------------------------------------------------------------ shadeFor -- */

test('shade is a gentle multiplier, not a repaint', () => {
  for (const path of PATHS) {
    const shade = shadeFor(hashOf(path));
    assert.ok(shade >= 0.9 && shade < 1.1, `${path} gave ${shade}`);
  }
});

test('width and shade move independently', () => {
  // They read different bit ranges. If they shared any, wide buildings would
  // all be pale and the city would have a visible pattern in it.
  const pairs = [];
  for (let i = 0; i < 500; i++) {
    const h = hashOf(`f${i}.js`);
    pairs.push([widthFor(h), shadeFor(h)]);
  }
  const widest = pairs.filter(([w]) => w > FOOTPRINT * (WIDTH_MIN + 0.8 * WIDTH_RANGE));
  const shades = new Set(widest.map(([, s]) => s));
  assert.ok(shades.size > widest.length * 0.5, 'the widest buildings share too few shades');
});

/* ------------------------------------------------------------ shapeFor -- */

test('a low-rise is one box with no podium', () => {
  assert.deepEqual(shapeFor(4), { tiers: 1, hasPodium: false, parts: 1 });
});

test('a mid-rise gains a podium', () => {
  const shape = shapeFor(PODIUM_HEIGHT + 1);
  assert.equal(shape.tiers, 1);
  assert.equal(shape.hasPodium, true);
  assert.equal(shape.parts, 2);
});

test('a tower gains setback tiers on top of the podium', () => {
  const shape = shapeFor(TAPER_HEIGHT + 1);
  assert.equal(shape.tiers, SEGMENT_SPLIT.length);
  assert.equal(shape.hasPodium, true);
  assert.equal(shape.parts, SEGMENT_SPLIT.length + 1);
});

test('the thresholds are exclusive, so a building exactly at one does not flicker', () => {
  assert.equal(shapeFor(PODIUM_HEIGHT).hasPodium, false);
  assert.equal(shapeFor(TAPER_HEIGHT).tiers, 1);
});

test('parts always agrees with tiers and podium', () => {
  for (let h = 0; h <= 80; h += 0.5) {
    const { tiers, hasPodium, parts } = shapeFor(h);
    assert.equal(parts, tiers + (hasPodium ? 1 : 0), `at height ${h}`);
    assert.ok(parts >= 1, `height ${h} gave ${parts} parts`);
  }
});

test('the tier split accounts for the whole height', () => {
  const total = SEGMENT_SPLIT.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `the tiers add to ${total}`);
});

/* ---------------------------------------------------------- coolnessAt -- */

test('a building just touched is fully hot', () => {
  assert.equal(coolnessAt(10, 10), 0);
});

test('a building cools over the heat window', () => {
  assert.equal(coolnessAt(10 + HEAT_COMMITS / 2, 10), 0.5);
  assert.equal(coolnessAt(10 + HEAT_COMMITS, 10), 1);
});

test('an old building does not cool past cold', () => {
  assert.equal(coolnessAt(5_000, 0), 1);
});

test('a building touched by a commit still ahead is hot, not negative', () => {
  // seek() replays from the start, so lastTouched can briefly exceed the index.
  // A negative here would lerp the colour out past the hot end.
  assert.equal(coolnessAt(0, 10), 0);
});

test('a heat window of zero reads as cooled rather than dividing by it', () => {
  assert.equal(coolnessAt(5, 5, 0), 1);
  assert.equal(coolnessAt(5, 5, -1), 1);
});

test('coolness is always between 0 and 1', () => {
  for (let index = -5; index <= 60; index++) {
    for (const touched of [-3, 0, 20, 59]) {
      const cool = coolnessAt(index, touched);
      assert.ok(cool >= 0 && cool <= 1, `index ${index}, touched ${touched} gave ${cool}`);
    }
  }
});
