/**
 * timeline.test.mjs — the playback state machine.
 *
 * It is the only stateful thing in the project and it drives everything the
 * viewer sees, but it has no renderer in it, so it can be driven at whatever
 * speed a test likes. Its failures are all silent: playback that quietly
 * stops, a commit applied twice, or a scrubber that disagrees with the city.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Timeline, msPerCommit } from '../js/timeline.js';

const COMMITS = Array.from({ length: 10 }, (_, i) => ({ sha: `c${i}`, files: [] }));

/** A timeline with every callback recorded. */
function make(commits = COMMITS) {
  const applied = [];
  const seeks = [];
  let changes = 0;
  const timeline = new Timeline({
    onCommit: (commit, index) => applied.push(index),
    onSeek: (index) => seeks.push(index),
    onChange: () => { changes += 1; },
  });
  timeline.load(commits);
  return { timeline, applied, seeks, changes: () => changes };
}

/* ------------------------------------------------------------------ pace -- */

test('the whole history plays in roughly the target duration', () => {
  // The promise the README makes: ~45 seconds regardless of repo size.
  for (const count of [100, 300, 562]) {
    const total = msPerCommit(count) * count;
    assert.ok(total >= 44_000 && total <= 46_000, `${count} commits took ${total}ms`);
  }
});

test('a short history is slowed to a floor rather than flickering past', () => {
  // 45s / 10 commits would be 4.5s each, which is above the floor; 45s / 1000
  // would be 45ms, which is below it and would strobe.
  assert.equal(msPerCommit(1000), 80);
  assert.ok(msPerCommit(10) > 80);
});

test('an empty history still has a pace rather than dividing by zero', () => {
  assert.equal(msPerCommit(0), 80);
  assert.ok(Number.isFinite(msPerCommit(0)));
});

/* ----------------------------------------------------------------- load -- */

test('loading resets to before the first commit', () => {
  const { timeline, seeks } = make();
  assert.equal(timeline.index, -1);
  assert.equal(timeline.current, null);
  assert.equal(timeline.playing, false);
  assert.deepEqual(seeks, [-1], 'the city has to be cleared');
});

test('loading a second dataset does not leave the first one playing', () => {
  const { timeline } = make();
  timeline.play();
  timeline.load(COMMITS.slice(0, 3));
  assert.equal(timeline.playing, false);
  assert.equal(timeline.index, -1);
  assert.equal(timeline.count, 3);
});

/* ------------------------------------------------------------ playback -- */

test('ticking applies commits in order, one per step', () => {
  const { timeline, applied } = make();
  timeline.play();
  timeline.tick(timeline.msPerCommit * 3);
  assert.deepEqual(applied, [0, 1, 2]);
  assert.equal(timeline.index, 2);
});

test('time shorter than a step applies nothing but is not lost', () => {
  const { timeline, applied } = make();
  timeline.play();
  const step = timeline.msPerCommit;
  timeline.tick(step * 0.4);
  timeline.tick(step * 0.4);
  assert.deepEqual(applied, [], 'not a full step yet');
  timeline.tick(step * 0.4);
  assert.deepEqual(applied, [0], 'the remainder accumulated rather than being dropped');
});

test('a paused timeline ignores time entirely', () => {
  const { timeline, applied } = make();
  timeline.play();
  timeline.pause();
  timeline.tick(timeline.msPerCommit * 5);
  assert.deepEqual(applied, []);
});

test('an empty timeline cannot be played', () => {
  const { timeline } = make([]);
  timeline.play();
  assert.equal(timeline.playing, false, 'nothing to play');
  timeline.tick(10_000);
  assert.equal(timeline.index, -1);
});

test('playback stops itself at the last commit', () => {
  // Frame by frame, because one tick is capped at eight commits by the
  // catch-up budget — see the stalled-tab tests below.
  const { timeline, applied } = make();
  timeline.play();
  for (let i = 0; i < 50 && timeline.playing; i += 1) timeline.tick(timeline.msPerCommit);
  assert.equal(timeline.playing, false);
  assert.equal(timeline.index, COMMITS.length - 1);
  assert.deepEqual(applied, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('every commit is applied exactly once across a whole run', () => {
  // Applying one twice double-counts its line changes, and the building ends
  // up the wrong height for the rest of the replay.
  const { timeline, applied } = make();
  timeline.play();
  for (let i = 0; i < 200; i += 1) timeline.tick(timeline.msPerCommit);
  assert.deepEqual(applied, [...new Set(applied)], 'a commit was applied twice');
  assert.equal(applied.length, COMMITS.length);
});

test('pressing play at the end starts over rather than sitting there', () => {
  const { timeline, seeks } = make();
  timeline.seek(COMMITS.length - 1);
  timeline.play();
  assert.equal(timeline.index, -1, 'rewound');
  assert.equal(timeline.playing, true);
  assert.equal(seeks.at(-1), -1);
});

test('toggle flips whichever way it is currently pointing', () => {
  const { timeline } = make();
  timeline.toggle();
  assert.equal(timeline.playing, true);
  timeline.toggle();
  assert.equal(timeline.playing, false);
});

/* --------------------------------------------------------------- speed -- */

test('speed scales how much history a frame covers', () => {
  const { timeline, applied } = make();
  timeline.play();
  timeline.setSpeed(2);
  timeline.tick(timeline.msPerCommit);
  assert.deepEqual(applied, [0, 1], 'double speed covers two commits of time');
});

test('half speed takes two frames to advance one commit', () => {
  const { timeline, applied } = make();
  timeline.play();
  timeline.setSpeed(0.5);
  timeline.tick(timeline.msPerCommit);
  assert.deepEqual(applied, []);
  timeline.tick(timeline.msPerCommit);
  assert.deepEqual(applied, [0]);
});

/* ---------------------------------------------------------------- seek -- */

test('seeking anywhere rebuilds from that index', () => {
  const { timeline, seeks } = make();
  timeline.seek(4);
  assert.equal(timeline.index, 4);
  assert.equal(timeline.current.sha, 'c4');
  assert.equal(seeks.at(-1), 4);
});

test('seeking past either end clamps instead of going out of bounds', () => {
  const { timeline } = make();
  timeline.seek(999);
  assert.equal(timeline.index, COMMITS.length - 1);
  timeline.seek(-50);
  assert.equal(timeline.index, -1, '-1 is the empty city, not an error');
});

test('seeking to where it already is does no work', () => {
  // The seek handler tears the city down and rebuilds it, so a scrubber
  // dragged within one commit must not fire it on every mouse move.
  const { timeline, seeks } = make();
  timeline.seek(4);
  const before = seeks.length;
  timeline.seek(4);
  assert.equal(seeks.length, before);
});

test('seeking mid-playback continues from the new position', () => {
  const { timeline, applied } = make();
  timeline.play();
  timeline.tick(timeline.msPerCommit * 2);
  timeline.seek(6);
  timeline.tick(timeline.msPerCommit);
  assert.deepEqual(applied, [0, 1, 7], 'resumed after the seek target');
});

test('a seek drops the part-accumulated step', () => {
  // Otherwise a jump would apply the next commit sooner than a full step.
  const { timeline, applied } = make();
  timeline.play();
  timeline.tick(timeline.msPerCommit * 0.9);
  timeline.seek(3);
  timeline.tick(timeline.msPerCommit * 0.5);
  assert.deepEqual(applied, [], 'the leftover 0.9 should not have carried over');
});

/* --------------------------------------------------------- catching up -- */

test('a stalled tab does not replay the whole repo in one frame', () => {
  // A backgrounded tab returns with a delta of minutes. Applying six hundred
  // commits in one frame locks the browser and skips the animation entirely.
  const many = Array.from({ length: 600 }, (_, i) => ({ sha: `c${i}`, files: [] }));
  const { timeline, applied } = make(many);
  timeline.play();
  timeline.tick(10 * 60 * 1000);
  assert.ok(applied.length <= 8, `applied ${applied.length} commits in one frame`);
});

test('the accumulator does not carry a stall over into the next frame', () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ sha: `c${i}`, files: [] }));
  const { timeline, applied } = make(many);
  timeline.play();
  timeline.tick(10 * 60 * 1000);
  const afterStall = applied.length;
  timeline.tick(1);
  assert.equal(applied.length, afterStall, 'the discarded backlog leaked into the next frame');
});

/* --------------------------------------------------------------- reads -- */

test('current follows the index', () => {
  const { timeline } = make();
  assert.equal(timeline.current, null);
  timeline.seek(0);
  assert.equal(timeline.current.sha, 'c0');
  timeline.seek(9);
  assert.equal(timeline.current.sha, 'c9');
});

test('atEnd is true only on the last commit', () => {
  const { timeline } = make();
  timeline.seek(8);
  assert.equal(timeline.atEnd, false);
  timeline.seek(9);
  assert.equal(timeline.atEnd, true);
});

test('count reports the loaded history', () => {
  assert.equal(make().timeline.count, 10);
  assert.equal(make([]).timeline.count, 0);
});
