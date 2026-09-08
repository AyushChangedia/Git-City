import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseRawStatus, applyDeltas } = require('../scripts/fetch-history.cjs');

/* ------------------------------------------------- git log --raw parsing -- */

test('parses an ordinary change', () => {
  const r = parseRawStatus(':100644 100644 abc1234 def5678 M\tsrc/app.js');
  assert.deepEqual(r, { letter: 'M', path: 'src/app.js' });
});

test('parses an addition and a deletion', () => {
  assert.equal(parseRawStatus(':000000 100644 0000000 abc M\tnew.js').letter, 'M');
  assert.equal(parseRawStatus(':100644 000000 abc 0000000 D\tgone.js').path, 'gone.js');
});

test('a rename yields the destination and remembers the source', () => {
  // git writes source and destination in separate columns. Taking everything
  // after the first tab produced a path containing a literal tab, so the real
  // destination never appeared and the source was never demolished.
  const r = parseRawStatus(':100644 100644 de98044 de98044 R100\told.txt\tnew.txt');
  assert.deepEqual(r, { letter: 'R', path: 'new.txt', previousPath: 'old.txt' });
});

test('a copy is read the same way as a rename', () => {
  const r = parseRawStatus(':100644 100644 abc abc C075\tsrc/a.js\tsrc/b.js');
  assert.equal(r.path, 'src/b.js');
  assert.equal(r.previousPath, 'src/a.js');
});

test('no recorded path ever contains a tab', () => {
  const lines = [
    ':100644 100644 abc def M\tsrc/app.js',
    ':100644 100644 abc def R100\told.txt\tnew.txt',
    ':100644 100644 abc abc C075\ta.js\tb.js',
  ];
  for (const line of lines) {
    const r = parseRawStatus(line);
    assert.ok(!r.path.includes('\t'), `path from ${line}`);
  }
});

test('a malformed line is skipped rather than crashing the run', () => {
  assert.equal(parseRawStatus(':100644 100644 abc def M'), null);
});

/* --------------------------------------------------------- applying them -- */

test('a rename demolishes the old building', () => {
  const totals = new Map([['src/old.js', 120]]);
  const files = applyDeltas(totals, [
    { path: 'src/new.js', previousPath: 'src/old.js', status: 'modified', additions: 0, deletions: 0 },
  ]);
  assert.ok(files.some((f) => f.path === 'src/old.js' && f.status === 'removed'));
  assert.ok(!totals.has('src/old.js'), 'the old path should not linger in the totals');
});

test('a rename carries the line count across', () => {
  // The file did not get smaller because it moved; restarting the new building
  // from nothing would make every rename look like a rewrite.
  const totals = new Map([['src/old.js', 480]]);
  const files = applyDeltas(totals, [
    { path: 'src/new.js', previousPath: 'src/old.js', status: 'modified', additions: 0, deletions: 0 },
  ]);
  assert.equal(files.find((f) => f.path === 'src/new.js').lines, 480);
});

test('a rename with edits applies them to the carried count', () => {
  const totals = new Map([['a.js', 100]]);
  const files = applyDeltas(totals, [
    { path: 'b.js', previousPath: 'a.js', status: 'modified', additions: 30, deletions: 10 },
  ]);
  assert.equal(files.find((f) => f.path === 'b.js').lines, 120);
});

test('an ordinary change is unaffected', () => {
  const totals = new Map([['a.js', 50]]);
  const files = applyDeltas(totals, [
    { path: 'a.js', status: 'modified', additions: 10, deletions: 0 },
  ]);
  assert.deepEqual(files, [{ path: 'a.js', status: 'modified', lines: 60 }]);
});

test('a deletion is unaffected', () => {
  const totals = new Map([['a.js', 50]]);
  const files = applyDeltas(totals, [
    { path: 'a.js', status: 'removed', additions: 0, deletions: 50 },
  ]);
  assert.deepEqual(files, [{ path: 'a.js', status: 'removed', lines: 1 }]);
  assert.equal(totals.size, 0);
});

test('replaying a rename leaves exactly one building standing', () => {
  // The whole point: replay the file records the way City.applyCommit does and
  // check the city does not accumulate a ghost.
  const totals = new Map();
  const standing = new Map();
  const replay = (changes) => {
    for (const f of applyDeltas(totals, changes)) {
      if (f.status === 'removed') standing.delete(f.path);
      else standing.set(f.path, f.lines);
    }
  };

  replay([{ path: 'src/old.js', status: 'added', additions: 120, deletions: 0 }]);
  assert.deepEqual([...standing.keys()], ['src/old.js']);

  replay([{ path: 'src/new.js', previousPath: 'src/old.js', status: 'modified', additions: 0, deletions: 0 }]);
  assert.deepEqual([...standing.keys()], ['src/new.js']);
});

/* --------------------------------------------------------- line counting -- */

test('a running total accumulates across commits', () => {
  const totals = new Map();
  applyDeltas(totals, [{ path: 'a.js', additions: 100, deletions: 0 }]);
  applyDeltas(totals, [{ path: 'a.js', additions: 50, deletions: 20 }]);
  assert.equal(totals.get('a.js'), 130);
});

test('a file cannot shrink below one line', () => {
  // Zero would be a building of no height, which reads as a hole in the city.
  const totals = new Map([['a.js', 50]]);
  const [file] = applyDeltas(totals, [{ path: 'a.js', additions: 0, deletions: 9999 }]);
  assert.equal(file.lines, 1);
});

test('a missing count is treated as no change rather than poisoning the total', () => {
  // Math.max(1, NaN) is NaN, not 1 — the floor does not floor. One absent
  // count used to write "lines": null into the dataset, and the browser read
  // that back as a minimum-height building with nothing to say why.
  for (const change of [
    { path: 'a.js', additions: undefined, deletions: 0 },
    { path: 'a.js', additions: 10, deletions: undefined },
    { path: 'a.js', additions: null, deletions: null },
    { path: 'a.js', additions: '-', deletions: '-' },
    { path: 'a.js' },
  ]) {
    const [file] = applyDeltas(new Map(), [change]);
    assert.ok(Number.isFinite(file.lines), `${JSON.stringify(change)} gave ${file.lines}`);
    assert.ok(file.lines >= 1);
  }
});

test('every line count survives a JSON round trip as a number', () => {
  // The dataset is written with JSON.stringify, which turns NaN into null.
  const files = applyDeltas(new Map(), [
    { path: 'a.js', additions: 10, deletions: 0 },
    { path: 'b.js', additions: undefined, deletions: 0 },
  ]);
  for (const file of JSON.parse(JSON.stringify(files))) {
    assert.equal(typeof file.lines, 'number', `${file.path} serialised as ${file.lines}`);
  }
});

test('a file removed and then re-added starts over', () => {
  const totals = new Map([['a.js', 500]]);
  const files = applyDeltas(totals, [
    { path: 'a.js', status: 'removed' },
    { path: 'a.js', additions: 20, deletions: 0 },
  ]);
  assert.deepEqual(files.map((f) => f.status), ['removed', 'added']);
  assert.equal(files[1].lines, 20, 'the old total should not carry over');
});

test('the first sighting of a file is added, later ones are modified', () => {
  const totals = new Map();
  assert.equal(applyDeltas(totals, [{ path: 'a.js', additions: 5, deletions: 0 }])[0].status, 'added');
  assert.equal(applyDeltas(totals, [{ path: 'a.js', additions: 5, deletions: 0 }])[0].status, 'modified');
});
