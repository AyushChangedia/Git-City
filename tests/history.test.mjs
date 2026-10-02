/**
 * history.test.mjs — what the dataset says before anything is drawn.
 *
 * Everything here runs once, at load, and decides the shape of the whole
 * playback: which plots exist, which buildings get a spire, and how far back
 * the camera starts. Getting any of it wrong is not an error — it is a city
 * that looks slightly wrong for the entire run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LANDMARK_COUNT, allPaths, peakLines, landmarks, peakOfAll } from '../js/history.js';

const commit = (...files) => ({ files });
const added = (path, lines) => ({ path, status: 'added', lines });
const modified = (path, lines) => ({ path, status: 'modified', lines });
const removed = (path, lines = 1) => ({ path, status: 'removed', lines });

/* ------------------------------------------------------------ allPaths -- */

test('collects every path the dataset mentions', () => {
  const history = [commit(added('a.js', 10), added('b.js', 20)), commit(added('c.js', 5))];
  assert.deepEqual(allPaths(history), ['a.js', 'b.js', 'c.js']);
});

test('a path touched many times appears once', () => {
  const history = [commit(added('a.js', 10)), commit(modified('a.js', 40)), commit(modified('a.js', 80))];
  assert.deepEqual(allPaths(history), ['a.js']);
});

test('keeps a file that is only ever deleted', () => {
  // The fetch window can open after a file was added, so its removal is the
  // only record of it. Dropping it would shift the street grid when that
  // commit lands, because the plan would not have reserved its plot.
  assert.deepEqual(allPaths([commit(removed('gone.js'))]), ['gone.js']);
});

test('ignores a file record with no path', () => {
  assert.deepEqual(allPaths([commit({ status: 'added', lines: 10 }, added('real.js', 1))]), ['real.js']);
});

test('survives a commit with no files, and no commits at all', () => {
  assert.deepEqual(allPaths([{ sha: 'a' }, commit()]), []);
  assert.deepEqual(allPaths([]), []);
  assert.deepEqual(allPaths(undefined), []);
});

test('returns paths in the order they are first seen', () => {
  // layout() packs districts in the order it is handed, so this ordering is
  // the street grid. It must not depend on a Map's iteration luck.
  const history = [commit(added('z.js', 1)), commit(added('a.js', 1)), commit(added('m.js', 1))];
  assert.deepEqual(allPaths(history), ['z.js', 'a.js', 'm.js']);
});

/* ----------------------------------------------------------- peakLines -- */

test('takes the largest size a file ever reached', () => {
  const history = [commit(added('a.js', 100)), commit(modified('a.js', 400)), commit(modified('a.js', 50))];
  assert.equal(peakLines(history).get('a.js'), 400);
});

test('a removal is not a size', () => {
  // A removed record reports the lines it deleted. Treating that as a peak
  // would give a deleted file a height it never had.
  const history = [commit(added('a.js', 20)), commit(removed('a.js', 9999))];
  assert.equal(peakLines(history).get('a.js'), 20);
});

test('a file that is only ever removed has no peak at all', () => {
  assert.equal(peakLines([commit(removed('gone.js', 500))]).has('gone.js'), false);
});

test('a missing or non-numeric line count counts as zero', () => {
  const history = [commit({ path: 'a.js', status: 'added' }), commit({ path: 'b.js', status: 'added', lines: null })];
  const peak = peakLines(history);
  assert.equal(peak.get('a.js'), 0);
  assert.equal(peak.get('b.js'), 0);
});

/* ----------------------------------------------------------- landmarks -- */

test('the tallest few get the spires', () => {
  const history = [
    commit(added('small.js', 10), added('big.js', 900), added('mid.js', 300), added('tiny.js', 2)),
  ];
  assert.deepEqual([...landmarks(history, 2)], ['big.js', 'mid.js']);
});

test('ties break on the path, so the same dataset picks the same spires', () => {
  // Otherwise which building carries a spire depends on whichever the sort
  // happened to leave first, and it can differ between engines.
  const history = [commit(added('b.js', 100), added('a.js', 100), added('c.js', 100))];
  assert.deepEqual([...landmarks(history, 2)], ['a.js', 'b.js']);
});

test('measures over the whole history, not the last commit', () => {
  // A spire that appears and vanishes as a file is edited reads as a glitch.
  const history = [commit(added('once-huge.js', 5000)), commit(modified('once-huge.js', 3))];
  assert.ok(landmarks(history, 1).has('once-huge.js'));
});

test('a deleted file never carries a spire', () => {
  const history = [commit(added('a.js', 10)), commit(removed('a.js', 9999))];
  assert.deepEqual([...landmarks(history, 1)], ['a.js']);
});

test('asks for fewer landmarks than the city has files without complaint', () => {
  const history = [commit(added('a.js', 10))];
  assert.equal(landmarks(history, 3).size, 1);
  assert.equal(landmarks([], 3).size, 0);
});

test('a count of zero or less means no landmarks', () => {
  const history = [commit(added('a.js', 10))];
  assert.equal(landmarks(history, 0).size, 0);
  assert.equal(landmarks(history, -1).size, 0);
});

test('defaults to three, which is what city.js asks for', () => {
  const history = [commit(...['a', 'b', 'c', 'd', 'e'].map((n, i) => added(`${n}.js`, 100 - i)))];
  assert.equal(landmarks(history).size, LANDMARK_COUNT);
  assert.equal(LANDMARK_COUNT, 3);
});

/* ----------------------------------------------------------- peakOfAll -- */

test('finds the largest file in the dataset', () => {
  const history = [commit(added('a.js', 100)), commit(added('b.js', 2400)), commit(modified('a.js', 300))];
  assert.equal(peakOfAll(history), 2400);
});

test('an empty dataset peaks at zero rather than at nothing', () => {
  // It is fed to heightForLines and then to the camera distance; undefined
  // there is a NaN that frames the city nowhere.
  assert.equal(peakOfAll([]), 0);
  assert.equal(peakOfAll([commit()]), 0);
});

test('a history that only deletes peaks at zero', () => {
  assert.equal(peakOfAll([commit(removed('a.js', 9999))]), 0);
});

test('agrees with the largest value in peakLines', () => {
  const history = [
    commit(added('a.js', 120), added('b.js', 90)),
    commit(modified('b.js', 700), removed('a.js', 120)),
  ];
  assert.equal(peakOfAll(history), Math.max(...peakLines(history).values()));
});
