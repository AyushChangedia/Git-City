/**
 * cli.test.mjs — the argument parsing and small helpers in fetch-history.js.
 *
 * This is the script that writes the datasets the whole app replays, and its
 * arguments were parsed by taking whatever came next in argv. Every way that
 * went wrong was silent: the run finished, wrote nothing or the wrong thing,
 * and blamed something else.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs, firstLine, defaultOut } = require('../scripts/fetch-history.js');

/* ------------------------------------------------------------ parseArgs -- */

test('no arguments still carries the commit cap', () => {
  // The default is the safety limit. Losing it is how a run fetches nothing,
  // or everything.
  assert.equal(parseArgs([]).limit, 300);
});

test('the flags that take a value are read', () => {
  assert.deepEqual(parseArgs(['--git', '/tmp/repo']), { limit: 300, git: '/tmp/repo' });
  assert.deepEqual(parseArgs(['--repo', 'axios/axios']), { limit: 300, repo: 'axios/axios' });
  assert.deepEqual(parseArgs(['--out', 'data/x.json']), { limit: 300, out: 'data/x.json' });
});

test('the boolean flags are read', () => {
  assert.equal(parseArgs(['--synthetic']).synthetic, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('flags combine in any order', () => {
  const args = parseArgs(['--limit', '25', '--git', '/tmp/repo', '--out', 'o.json']);
  assert.deepEqual(args, { limit: 25, git: '/tmp/repo', out: 'o.json' });
  const reversed = parseArgs(['--out', 'o.json', '--git', '/tmp/repo', '--limit', '25']);
  assert.deepEqual(reversed, args);
});

test('an explicit limit overrides the default', () => {
  assert.equal(parseArgs(['--limit', '50']).limit, 50);
  assert.equal(parseArgs(['--limit', '1']).limit, 1);
});

test('a flag with no value is refused rather than swallowing the default', () => {
  // The regression. `--limit` alone set the key to undefined, which both
  // skipped the Number() conversion and wiped the cap. Downstream,
  // Math.min(undefined, HARD_CAP) is NaN, `n < NaN` is false, and the fetch
  // loop never ran — zero commits, reported as "No commits found".
  assert.throws(() => parseArgs(['--limit']), /--limit needs a value/);
  assert.throws(() => parseArgs(['--git']), /--git needs a value/);
  assert.throws(() => parseArgs(['--repo']), /--repo needs a value/);
});

test('a flag cannot swallow the next flag as its value', () => {
  // `--repo --synthetic` set repo to the string "--synthetic", and --synthetic
  // then never took effect. Both halves of the command were wrong and neither
  // said so.
  assert.throws(() => parseArgs(['--repo', '--synthetic']), /--repo needs a value/);
  assert.throws(() => parseArgs(['--out', '--limit', '5']), /--out needs a value/);
});

test('a limit that is not a whole number of commits is refused', () => {
  for (const bad of ['abc', '0', '-5', '2.5', '', 'NaN', 'Infinity']) {
    assert.throws(
      () => parseArgs(['--limit', bad]),
      /--limit needs a whole number/,
      `--limit ${JSON.stringify(bad)} should be refused`,
    );
  }
});

test('an unknown option is named rather than quietly stored', () => {
  // It used to be accepted and set as a property nothing reads, so a typo like
  // --limt ran with the default and looked like the flag had been ignored.
  assert.throws(() => parseArgs(['--limt', '50']), /Unknown option: --limt/);
  assert.throws(() => parseArgs(['--bogus', 'x']), /Unknown option/);
});

test('a bare word is still an error', () => {
  assert.throws(() => parseArgs(['axios/axios']), /Unexpected argument/);
  assert.throws(() => parseArgs(['--synthetic', 'extra']), /Unexpected argument/);
});

test('the returned limit is a number, not the string from argv', () => {
  // fromApi does Math.min(limit, HARD_CAP) with it, and "50" would compare as
  // a string somewhere downstream.
  assert.equal(typeof parseArgs(['--limit', '50']).limit, 'number');
});

/* ------------------------------------------------------------ firstLine -- */

test('a commit message is reduced to its subject line', () => {
  assert.equal(firstLine('Add the thing\n\nWith a body explaining why.'), 'Add the thing');
});

test('surrounding whitespace goes', () => {
  assert.equal(firstLine('   Add the thing   \nbody'), 'Add the thing');
});

test('a long subject is truncated with an ellipsis, within the limit', () => {
  const long = 'x'.repeat(200);
  const out = firstLine(long, 80);
  assert.equal(out.length, 80, 'the ellipsis has to fit inside the budget');
  assert.ok(out.endsWith('…'));
});

test('a subject exactly at the limit is not truncated', () => {
  const exact = 'x'.repeat(80);
  assert.equal(firstLine(exact, 80), exact);
});

test('an empty or missing message is an empty string, not "undefined"', () => {
  // It is rendered into the commit ticker, where the literal word undefined
  // would be visible.
  for (const value of ['', null, undefined]) {
    assert.equal(firstLine(value), '');
  }
});

/* ----------------------------------------------------------- defaultOut -- */

test('a repo name becomes a predictable dataset path', () => {
  assert.equal(defaultOut('axios/axios'), 'data/axios-axios.json');
  assert.equal(defaultOut('AyushChangedia/Git-City'), 'data/ayushchangedia-git-city.json');
});

test('runs of punctuation collapse to a single dash', () => {
  assert.equal(defaultOut('a//b'), 'data/a-b.json');
  assert.equal(defaultOut('some.repo_name'), 'data/some-repo-name.json');
});

test('the path is always inside data/ and always .json', () => {
  for (const repo of ['a/b', 'UPPER/CASE', 'x', 'a..b']) {
    const out = defaultOut(repo);
    assert.ok(out.startsWith('data/'), out);
    assert.ok(out.endsWith('.json'), out);
  }
});

test('a name that is all punctuation does not escape the data directory', () => {
  // "../.." would be a path traversal if the sanitiser let separators through.
  const out = defaultOut('../../etc/passwd');
  assert.ok(!out.includes('..'), out);
  assert.ok(out.startsWith('data/'), out);
});
