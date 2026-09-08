/**
 * verify.test.mjs — scripts/verify.cjs as a CI gate.
 *
 * verify.cjs is a command-line tool, so it is tested the way CI runs it: as a
 * subprocess, checking the exit code and what it printed. The exit code is the
 * part that matters — a gate that exits 0 on a broken dataset is not a gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY = path.join(ROOT, 'scripts', 'verify.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-city-verify-'));

/** Write a dataset to a scratch file and return its path. */
function dataset(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

function run(...args) {
  const res = spawnSync(process.execPath, [VERIFY, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

/**
 * A valid history, deliberately large enough to clear the scale band.
 *
 * Two top-level folders, so both banks of the river are used and the city has
 * the shape a real one has. A three-file city measures 17 units across and
 * verify.js rightly calls that out of band, which makes it useless as the
 * fixture for everything that is *not* about scale.
 */
const HEALTHY = {
  repo: 'demo/healthy',
  commits: [
    {
      sha: 'a',
      files: Array.from({ length: 9 }, (_, i) => ({
        path: `src/mod-${i}.js`,
        status: 'added',
        lines: 120 + i * 90,
      })),
    },
    {
      sha: 'b',
      files: Array.from({ length: 6 }, (_, i) => ({
        path: `lib/helper-${i}.js`,
        status: 'added',
        lines: 60 + i * 40,
      })),
    },
    { sha: 'c', files: [{ path: 'src/mod-0.js', status: 'modified', lines: 650 }] },
  ],
};

/* ------------------------------------------------------------- happy path -- */

test('the bundled datasets in the manifest all pass', () => {
  const { code, out } = run();
  assert.equal(code, 0, out);
  assert.match(out, /dataset\(s\) OK\./);
});

test('a healthy dataset passes and reports its measurements', () => {
  const { code, out } = run(dataset('healthy.json', HEALTHY));
  assert.equal(code, 0, out);
  assert.match(out, /demo\/healthy/);
  assert.match(out, /buildings \(final\)\s+15/);
  assert.match(out, /footprint .* OK/);
});

/* ----------------------------------------------------------- broken input -- */

test('a history that deletes every file fails with a readable message', () => {
  // Not a malformed dataset — a real history of a repo emptied before its last
  // commit. cityBounds returns null for it, and the measurements below used to
  // crash on that with "Cannot read properties of null (reading 'max')".
  const { code, out } = run(
    dataset('emptied.json', {
      repo: 'demo/emptied',
      commits: [
        { sha: 'a', files: [{ path: 'src/gone.js', status: 'added', lines: 40 }] },
        { sha: 'b', files: [{ path: 'src/gone.js', status: 'removed', lines: 1 }] },
      ],
    })
  );
  assert.equal(code, 1);
  assert.match(out, /no files standing/);
  assert.match(out, /no city to measure/);
  assert.doesNotMatch(out, /Cannot read properties/);
});

test('a missing file is reported as a missing file, not a raw ENOENT', () => {
  const { code, out } = run(path.join(tmp, 'does-not-exist.json'));
  assert.equal(code, 1);
  assert.match(out, /no such file/);
  assert.doesNotMatch(out, /ENOENT/);
});

test('a file that is not JSON says so', () => {
  const { code, out } = run(dataset('garbage.json', 'this is not json'));
  assert.equal(code, 1);
  assert.match(out, /is not valid JSON/);
});

test('a dataset with no commits array says so', () => {
  const { code, out } = run(dataset('nocommits.json', { repo: 'demo/x' }));
  assert.equal(code, 1);
  // The wording is validateDataset's, because that is now the one check.
  assert.match(out, /missing a "commits" array/);
  assert.doesNotMatch(out, /is not iterable/);
});

test('a dataset with an empty commits array says so', () => {
  const { code, out } = run(dataset('zero.json', { repo: 'demo/x', commits: [] }));
  assert.equal(code, 1);
  assert.match(out, /contains no commits/);
});

test('a JSON file holding an array rather than an object says so', () => {
  const { code, out } = run(dataset('array.json', [1, 2, 3]));
  assert.equal(code, 1);
  assert.match(out, /missing a "commits" array/);
});

/* ------------------------------------------------------ one bad, many good -- */

test('a broken dataset does not stop the ones after it being checked', () => {
  // The regression this pins: verify.js threw straight out of the loop, so the
  // first bad file ended the run. Everything after it went unchecked while the
  // failure looked like a single, complete answer.
  const broken = dataset('broken-first.json', { repo: 'demo/x' });
  const good = dataset('good-second.json', HEALTHY);

  const { code, out } = run(broken, good);
  assert.equal(code, 1);
  assert.match(out, /missing a "commits" array/);
  assert.match(out, /demo\/healthy/, 'the second dataset was never measured');
  assert.match(out, /1 of 2 dataset\(s\) failed/);
});

test('every failure is listed in the summary, not just the first', () => {
  const { code, out } = run(
    dataset('bad-a.json', { repo: 'a' }),
    dataset('bad-b.json', 'nope'),
    dataset('ok.json', HEALTHY)
  );
  assert.equal(code, 1);
  assert.match(out, /2 of 3 dataset\(s\) failed/);
  assert.match(out, /bad-a\.json/);
  assert.match(out, /bad-b\.json/);
});

test('the failing dataset is named, so it can be found', () => {
  const { code, out } = run(dataset('named-badly.json', { repo: 'demo/x' }));
  assert.equal(code, 1);
  assert.match(out, /named-badly\.json/);
});

/* -------------------------------------------- agreement with the browser -- */

test('a dataset the browser would reject is rejected here too', () => {
  // The point of this script is that a dataset which passes it will load. It
  // had its own looser structural checks, so anything validateDataset catches
  // inside a file record passed verify and then failed in the app.
  const cases = [
    ['no path', { path: undefined, lines: 10 }, /has no "path"/],
    ['null lines', { path: 'a.js', lines: null }, /non-numeric "lines"/],
    ['string lines', { path: 'a.js', lines: '10' }, /non-numeric "lines"/],
  ];
  for (const [name, file, expected] of cases) {
    const { code, out } = run(
      dataset(`browser-${name.replace(/\s/g, '-')}.json`, {
        repo: 'demo/x',
        commits: [{ files: [file] }],
      }),
    );
    assert.equal(code, 1, `${name} was accepted`);
    assert.match(out, expected, name);
  }
});

test('the failure names the commit and file, not just the dataset', () => {
  const { out } = run(
    dataset('located.json', {
      repo: 'demo/x',
      commits: [{ files: [{ path: 'good.js', lines: 1 }] }, { files: [{ lines: 2 }] }],
    }),
  );
  assert.match(out, /commit 1, file 0/);
});

test('the bundled datasets pass the browser check as well as the geometry one', () => {
  // Which is the claim the whole script rests on.
  const { code, out } = run();
  assert.equal(code, 0, out);
});
