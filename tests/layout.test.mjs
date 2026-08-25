import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as L from '../js/layout.js';

/* ------------------------------------------------------------- buildings -- */

test('height scales with line count', () => {
  assert.equal(L.heightForLines(120), 10);   // 120 / 12
  assert.equal(L.heightForLines(600), 50);
});

test('height is clamped so nothing vanishes or scrapes orbit', () => {
  assert.equal(L.heightForLines(0), L.HEIGHT_MIN);
  assert.equal(L.heightForLines(1), L.HEIGHT_MIN);
  assert.equal(L.heightForLines(1e9), L.HEIGHT_MAX);
});

test('a missing or nonsense line count still yields a building', () => {
  // A dataset can carry a null; a building of height 0 would be invisible and
  // read as a file that is not there.
  for (const bad of [null, undefined, NaN, Infinity, -50, 'x']) {
    assert.equal(L.heightForLines(bad), L.HEIGHT_MIN, `for ${String(bad)}`);
  }
});

/* ------------------------------------------------------------- districts -- */

test('a file belongs to its folder', () => {
  assert.equal(L.districtOf('src/core/app.js'), 'src/core');
  assert.equal(L.districtOf('lib/index.js'), 'lib');
});

test('root-level files share one synthetic district', () => {
  assert.equal(L.districtOf('README.md'), L.ROOT_DISTRICT);
  assert.equal(L.districtOf('package.json'), L.ROOT_DISTRICT);
});

test('the bank is decided by the top-level folder', () => {
  assert.equal(L.topLevelOf('src/core/deep'), 'src');
  assert.equal(L.topLevelOf('lib'), 'lib');
  assert.equal(L.topLevelOf(L.ROOT_DISTRICT), L.ROOT_DISTRICT);
});

/* ---------------------------------------------------------------- layout -- */

const paths = (n, dir = 'src') =>
  Array.from({ length: n }, (_, i) => `${dir}/file${String(i).padStart(3, '0')}.js`);

test('every path gets a position', () => {
  const list = [...paths(20, 'src'), ...paths(9, 'lib'), 'README.md'];
  const { positions } = L.layout(list);
  assert.equal(positions.size, list.length);
  for (const p of list) assert.ok(positions.has(p), `${p} placed`);
});

test('an empty repo lays out without throwing', () => {
  const plan = L.layout([]);
  assert.equal(plan.positions.size, 0);
  assert.deepEqual(plan.districts, []);
  assert.equal(plan.channel, null);
});

test('the layout is deterministic', () => {
  // The city is recomputed from scratch as history replays; if this drifted,
  // buildings would jump between frames.
  const list = [...paths(30, 'src'), ...paths(12, 'test'), 'index.html'];
  const a = L.layout(list);
  const b = L.layout([...list].reverse());
  for (const p of list) {
    assert.deepEqual(a.positions.get(p), b.positions.get(p), `${p} stable`);
  }
});

test('no two buildings occupy the same spot', () => {
  const list = [...paths(40, 'src'), ...paths(25, 'lib'), ...paths(7, 'docs'), 'LICENSE'];
  const { positions } = L.layout(list);
  const seen = new Set();
  for (const { x, z } of positions.values()) {
    const key = `${x.toFixed(3)},${z.toFixed(3)}`;
    assert.ok(!seen.has(key), `duplicate position at ${key}`);
    seen.add(key);
  }
});

test('buildings inside a district are one pitch apart', () => {
  const { positions } = L.layout(paths(4, 'src'));
  const pts = [...positions.values()].sort((a, b) => a.z - b.z || a.x - b.x);
  assert.equal(pts[1].x - pts[0].x, L.PITCH);
});

test('nothing is built in the river', () => {
  // The channel is the one place a building must never land — a tower standing
  // in the water is the most obvious way this can look broken.
  const list = [...paths(30, 'src'), ...paths(30, 'lib'), ...paths(10, 'docs')];
  const { positions } = L.layout(list);
  const half = L.FOOTPRINT / 2;
  for (const [p, { z }] of positions) {
    assert.ok(Math.abs(z) - half >= L.CHANNEL_HALF - 1e-9, `${p} sits in the channel at z=${z}`);
  }
});

test('top-level folders are split across both banks', () => {
  const list = [...paths(20, 'src'), ...paths(18, 'lib'), ...paths(9, 'docs'), ...paths(4, 'bin')];
  const { districts } = L.layout(list);
  const banks = new Set(districts.map((d) => d.bank));
  assert.deepEqual([...banks].sort(), [0, 1]);
});

test('a district is a contiguous block, not scattered', () => {
  const list = [...paths(16, 'src'), ...paths(16, 'lib')];
  const { positions, districts } = L.layout(list);
  for (const d of districts) {
    for (const f of d.files) {
      const { x, z } = positions.get(f);
      assert.ok(x >= d.x0 && x <= d.x1, `${f} inside its district on x`);
      assert.ok(z >= d.z0 && z <= d.z1, `${f} inside its district on z`);
    }
  }
});

test('districts are ordered largest first', () => {
  const list = [...paths(5, 'small'), ...paths(30, 'big'), ...paths(12, 'mid')];
  const counts = L.layout(list).districts.map((d) => d.files.length);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('a single file still produces a city', () => {
  const { positions, districts, channel } = L.layout(['main.js']);
  assert.equal(positions.size, 1);
  assert.equal(districts.length, 1);
  assert.ok(channel);
});
