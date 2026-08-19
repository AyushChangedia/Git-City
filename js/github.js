/**
 * github.js — getting commit data into the browser.
 *
 * Two paths, and the distinction matters:
 *
 *   Path A  loadDataset()  — a pre-generated JSON file from data/. Zero API
 *           calls, always works, used for the bundled demos.
 *
 *   Path B  fetchRepo()    — live GitHub REST. The changed-file list costs one
 *           request PER COMMIT, so an unauthenticated visitor gets 60 an hour
 *           and will hit the wall fast. Hard-capped at 300 commits; every
 *           failure mode throws a message meant to be shown to a human.
 */

export const COMMIT_CAP = 300;

/** Errors carrying a message that is safe and useful to render in the DOM. */
export class GitHubError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'GitHubError';
    this.hint = hint || '';
  }
}

/* --------------------------------------------------------------- input -- */

/**
 * Accepts what people actually paste: full URLs, ssh remotes, `owner/name`.
 * @returns {string} "owner/name"
 */
export function parseRepoInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new GitHubError('Enter a repository URL first.');

  const cleaned = raw
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

  const url = cleaned.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/i);
  if (url) return `${url[1]}/${url[2]}`;

  const short = cleaned.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return `${short[1]}/${short[2]}`;

  throw new GitHubError(
    `Could not read "${raw}" as a GitHub repository.`,
    'Try a URL like https://github.com/axios/axios, or just owner/name.'
  );
}

/* -------------------------------------------------------------- path A -- */

export async function loadDataset(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    throw new GitHubError(
      `Could not load ${url} — ${err.message}`,
      'If you opened index.html straight off disk, the browser blocks fetch(). Serve the folder over HTTP instead.'
    );
  }
  if (!res.ok) throw new GitHubError(`Could not load ${url} (HTTP ${res.status}).`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new GitHubError(`${url} is not valid JSON.`);
  }
  return validateDataset(data, url);
}

/** Fail loudly and specifically — a malformed dataset should not render blank. */
export function validateDataset(data, label = 'dataset') {
  if (!data || typeof data !== 'object') throw new GitHubError(`${label}: not an object.`);
  if (!Array.isArray(data.commits)) throw new GitHubError(`${label}: missing a "commits" array.`);
  if (data.commits.length === 0) throw new GitHubError(`${label}: contains no commits.`);

  data.commits.forEach((c, i) => {
    if (!Array.isArray(c.files)) throw new GitHubError(`${label}: commit ${i} has no "files" array.`);
  });

  return {
    repo: data.repo || 'unknown/unknown',
    generatedAt: data.generatedAt || null,
    commits: data.commits,
  };
}

/* -------------------------------------------------------------- path B -- */

async function ghFetch(url, token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new GitHubError(
      `Network request to GitHub failed — ${err.message}`,
      'Check your connection, or pick one of the bundled demos which need no network at all.'
    );
  }

  const remaining = Number(res.headers.get('x-ratelimit-remaining'));

  if (res.status === 401) {
    throw new GitHubError('GitHub rejected that token (401).', 'Check it, or clear the field to browse anonymously.');
  }
  if (res.status === 404) {
    throw new GitHubError('Repository not found (404).', 'Private repositories need a token with repo access.');
  }
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const when = reset ? new Date(reset * 1000).toLocaleTimeString() : null;
    if (remaining === 0) {
      throw new GitHubError(
        `GitHub rate limit reached${when ? ` — resets at ${when}` : ''}.`,
        token
          ? 'Even with a token the ceiling is 5000 requests/hour. Try a bundled demo in the meantime.'
          : 'Anonymous access allows 60 requests/hour, and each commit costs one. Add a personal access token, or pick a bundled demo.'
      );
    }
    throw new GitHubError('GitHub refused the request (403).', 'The repository may be blocked or require a token.');
  }
  if (!res.ok) throw new GitHubError(`GitHub returned HTTP ${res.status}.`);

  return { body: await res.json(), remaining };
}

/**
 * Build a dataset live from the REST API.
 *
 * @param {string} repo  "owner/name"
 * @param {string} token optional PAT
 * @param {(msg: string) => void} onProgress
 */
export async function fetchRepo(repo, token, onProgress = () => {}) {
  onProgress(`Listing commits for ${repo}…`);

  const list = [];
  for (let page = 1; list.length < COMMIT_CAP; page++) {
    const perPage = Math.min(100, COMMIT_CAP - list.length);
    const { body } = await ghFetch(
      `https://api.github.com/repos/${repo}/commits?per_page=${perPage}&page=${page}`,
      token
    );
    if (!Array.isArray(body) || body.length === 0) break;
    list.push(...body);
    if (body.length < perPage) break;
    onProgress(`Listing commits for ${repo}… ${list.length}`);
  }

  if (list.length === 0) throw new GitHubError(`${repo} has no commits to show.`);

  const ordered = list.slice(0, COMMIT_CAP).reverse(); // oldest first
  const totals = new Map();
  const commits = [];

  for (let i = 0; i < ordered.length; i++) {
    const { body: detail, remaining } = await ghFetch(
      `https://api.github.com/repos/${repo}/commits/${ordered[i].sha}`,
      token
    );
    onProgress(
      `Fetching changed files… ${i + 1} / ${ordered.length}` +
        (Number.isFinite(remaining) ? `  ·  ${remaining} API requests left this hour` : '')
    );

    const files = [];
    for (const f of detail.files || []) {
      const path = f.filename;
      if (!path) continue;

      if (f.status === 'removed') {
        totals.delete(path);
        files.push({ path, status: 'removed', lines: 1 });
        continue;
      }
      const known = totals.has(path);
      const next = Math.max(1, (totals.get(path) || 0) + (f.additions || 0) - (f.deletions || 0));
      totals.set(path, next);
      files.push({ path, status: known ? 'modified' : 'added', lines: next });
    }

    const message = String(detail.commit?.message || '').split('\n')[0].trim();
    commits.push({
      sha: (detail.sha || '').slice(0, 7),
      date: detail.commit?.author?.date || detail.commit?.committer?.date || null,
      message: message.length > 80 ? message.slice(0, 79) + '…' : message,
      author: detail.commit?.author?.name || detail.author?.login || 'unknown',
      files,
    });
  }

  return { repo, generatedAt: new Date().toISOString(), commits };
}
