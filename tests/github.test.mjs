import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRepoInput, validateDataset, fetchRepo, COMMIT_CAP, GitHubError } from '../js/github.js';

/* ----------------------------------------------------------------- input -- */

test('accepts what people actually paste', () => {
  for (const input of [
    'https://github.com/axios/axios',
    'http://github.com/axios/axios',
    'https://www.github.com/axios/axios',
    'https://github.com/axios/axios.git',
    'https://github.com/axios/axios/',
    'git@github.com:axios/axios.git',
    'axios/axios',
    '  axios/axios  ',
  ]) {
    assert.equal(parseRepoInput(input), 'axios/axios', input);
  }
});

test('ignores the rest of a deep link', () => {
  assert.equal(parseRepoInput('https://github.com/axios/axios/tree/main/lib'), 'axios/axios');
  assert.equal(parseRepoInput('https://github.com/axios/axios/pull/42'), 'axios/axios');
});

test('rejects what is not a repository, with something a human can read', () => {
  for (const bad of ['', '   ', 'not a url', 'https://gitlab.com/a/b', 'https://github.com/axios']) {
    assert.throws(() => parseRepoInput(bad), (err) => {
      assert.ok(err instanceof GitHubError);
      assert.ok(err.message.length > 0);
      return true;
    }, `should reject ${JSON.stringify(bad)}`);
  }
});

/* ------------------------------------------------------------- datasets -- */

test('accepts a well-formed dataset', () => {
  const out = validateDataset({ repo: 'a/b', commits: [{ files: [{ path: 'a.js', lines: 10 }] }] });
  assert.equal(out.repo, 'a/b');
  assert.equal(out.commits.length, 1);
});

test('a malformed dataset fails loudly rather than rendering blank', () => {
  const cases = [
    [null, 'not an object'],
    [{}, 'missing commits'],
    [{ commits: [] }, 'no commits'],
    [{ commits: [{}] }, 'commit without files'],
  ];
  for (const [input, why] of cases) {
    assert.throws(() => validateDataset(input), GitHubError, why);
  }
});

test('a dataset without a repo name still loads', () => {
  const data = { commits: [{ files: [{ path: 'a.js', lines: 10 }] }] };
  assert.equal(validateDataset(data).repo, 'unknown/unknown');
});

/* ------------------------------------------------------------ pagination -- */

/** A fake GitHub serving `total` commits, recording every URL requested. */
function stubGitHub(total) {
  const calls = [];
  const shas = Array.from({ length: total }, (_, i) => `sha${String(i).padStart(4, '0')}`);

  globalThis.fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const json = () => {
      if (u.pathname.endsWith('/commits')) {
        const perPage = Number(u.searchParams.get('per_page'));
        const page = Number(u.searchParams.get('page'));
        const from = (page - 1) * perPage;
        return shas.slice(from, from + perPage).map((sha) => ({ sha }));
      }
      const sha = u.pathname.split('/').pop();
      return { sha, commit: { message: 'x', author: { date: '2026-01-01T00:00:00Z', name: 'a' } }, files: [] };
    };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => json() };
  };

  return { calls, shas };
}

test('every page is requested at the same size, so none is re-read', async () => {
  const original = globalThis.fetch;
  try {
    const { calls } = stubGitHub(250);
    await fetchRepo('a/b');
    const sizes = new Set(
      calls.filter((u) => u.includes('per_page')).map((u) => new URL(u).searchParams.get('per_page')),
    );
    // Shrinking per_page on the last request shifts the offset and re-reads
    // commits already fetched.
    assert.deepEqual([...sizes], ['100']);
  } finally {
    globalThis.fetch = original;
  }
});

test('no commit is fetched twice', async () => {
  const original = globalThis.fetch;
  try {
    stubGitHub(250);
    const out = await fetchRepo('a/b');
    const shas = out.commits.map((c) => c.sha);
    assert.equal(new Set(shas).size, shas.length, 'duplicate commits in the result');
  } finally {
    globalThis.fetch = original;
  }
});

test('stops at the cap', async () => {
  const original = globalThis.fetch;
  try {
    stubGitHub(1000);
    const out = await fetchRepo('a/b');
    assert.equal(out.commits.length, COMMIT_CAP);
  } finally {
    globalThis.fetch = original;
  }
});

test('a repo smaller than one page is fetched whole', async () => {
  const original = globalThis.fetch;
  try {
    stubGitHub(7);
    const out = await fetchRepo('a/b');
    assert.equal(out.commits.length, 7);
  } finally {
    globalThis.fetch = original;
  }
});

test('commits come back oldest first, so the city builds up', async () => {
  const original = globalThis.fetch;
  try {
    const { shas } = stubGitHub(30);
    const out = await fetchRepo('a/b');
    // The API lists newest first; replay needs the reverse.
    assert.equal(out.commits[0].sha, shas[29].slice(0, 7));
    assert.equal(out.commits.at(-1).sha, shas[0].slice(0, 7));
  } finally {
    globalThis.fetch = original;
  }
});

/* ------------------------------------------------- dataset file records -- */

test('a file record with no path is refused', () => {
  // Both the renderer and the verifier skip these silently, so a dataset of
  // them renders an empty city and says nothing — which is the exact failure
  // validateDataset exists to prevent.
  assert.throws(
    () => validateDataset({ commits: [{ files: [{ lines: 10 }] }] }, 'x'),
    /has no "path"/,
  );
});

test('a path that is not a usable string is refused', () => {
  for (const path of [42, null, '', '   ', {}]) {
    assert.throws(
      () => validateDataset({ commits: [{ files: [{ path, lines: 10 }] }] }, 'x'),
      /has no "path"/,
      `path ${JSON.stringify(path)} should be refused`,
    );
  }
});

test('a non-numeric line count is refused and quoted back', () => {
  // "lines": null is what a NaN count serialises to. The renderer turns it
  // into a minimum-height building without complaint.
  assert.throws(
    () => validateDataset({ commits: [{ files: [{ path: 'a.js', lines: null }] }] }, 'x'),
    /non-numeric "lines": null/,
  );
  assert.throws(
    () => validateDataset({ commits: [{ files: [{ path: 'a.js', lines: '100' }] }] }, 'x'),
    /non-numeric "lines"/,
  );
});

test('a removal needs no line count, because it has none', () => {
  const data = { commits: [{ files: [{ path: 'a.js', status: 'removed' }] }] };
  assert.equal(validateDataset(data, 'x').commits.length, 1);
});

test('a dataset where nothing touches a file is refused', () => {
  // Renders as a blank screen indistinguishable from a failed load.
  assert.throws(
    () => validateDataset({ commits: [{ files: [] }, { files: [] }] }, 'x'),
    /nothing to build/,
  );
});

test('an empty commit among real ones is fine', () => {
  // Merges and tags legitimately touch nothing.
  const data = {
    commits: [{ files: [] }, { files: [{ path: 'a.js', lines: 10 }] }, { files: [] }],
  };
  assert.equal(validateDataset(data, 'x').commits.length, 3);
});

test('the error names the commit and file it found', () => {
  assert.throws(
    () =>
      validateDataset(
        { commits: [{ files: [{ path: 'a.js', lines: 1 }] }, { files: [{ lines: 2 }] }] },
        'demo.json',
      ),
    /demo\.json: commit 1, file 0/,
  );
});
