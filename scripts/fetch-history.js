#!/usr/bin/env node
/**
 * fetch-history.js — generate Git City datasets.
 *
 * Emits the schema documented in README.md:
 *
 *   { repo, generatedAt, commits: [ { sha, date, message, author,
 *                                     files: [ { path, status, lines } ] } ] }
 *
 * "lines" is the running total line count of that file AFTER the commit
 * (additions - deletions, accumulated). Never negative; floored at 1.
 *
 * Usage
 *   node scripts/fetch-history.js --repo owner/name              # GitHub REST API
 *   node scripts/fetch-history.js --git https://github.com/o/n   # clone + git log
 *   node scripts/fetch-history.js --git ../some/local/checkout   # existing checkout
 *   node scripts/fetch-history.js --synthetic                    # sample/demo-repo
 *
 * Options
 *   --out <path>     output file (default data/<owner>-<name>.json)
 *   --limit <n>      most recent commits to emit (default 300, hard cap 300 for --repo)
 *   --token <tok>    GitHub personal access token (or set GITHUB_TOKEN)
 *
 * Why two sources?
 *   --repo is the portable path: it only needs the public REST API, but the
 *   changed-file list costs one request PER COMMIT, so 300 commits burns 300+
 *   of your hourly budget (60 unauthenticated, 5000 with a token).
 *   --git clones once and reads the full history locally, so running totals are
 *   exact from the repository's first commit instead of only within the window.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HARD_CAP = 300;
const MESSAGE_MAX = 80;

/* ------------------------------------------------------------------ utils */

function parseArgs(argv) {
  const args = { limit: HARD_CAP };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--synthetic') args.synthetic = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else throw new Error(`Unexpected argument: ${a}`);
  }
  if (args.limit !== undefined) args.limit = Number(args.limit);
  return args;
}

function firstLine(message, max = MESSAGE_MAX) {
  const line = String(message || '').split('\n')[0].trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/**
 * Parse one `git log --raw` status line.
 *
 *   :100644 100644 abc def M\tsrc/app.js
 *   :100644 100644 abc def R100\told.js\tnew.js
 *
 * A rename carries two tab-separated paths, and taking everything after the
 * first tab as "the path" produced a building whose path contained a literal
 * tab — the real destination never appeared and the source was never removed.
 * diff.renames has defaulted to on since Git 2.9, so this is the common case,
 * not an exotic one.
 */
function parseRawStatus(line) {
  const tab = line.indexOf('\t');
  if (tab === -1) return null;

  const letter = line.slice(0, tab).trim().split(/\s+/).pop()[0];
  const rest = line.slice(tab + 1).split('\t');

  // R and C report source then destination; everything else reports one path.
  if ((letter === 'R' || letter === 'C') && rest.length >= 2) {
    return { letter, path: rest[1], previousPath: rest[0] };
  }
  return { letter, path: rest[0] };
}

/** Apply one commit's per-file deltas to the running totals, return file records. */
function applyDeltas(totals, changes) {
  const files = [];
  for (const c of changes) {
    if (c.status === 'removed') {
      totals.delete(c.path);
      files.push({ path: c.path, status: 'removed', lines: 1 });
      continue;
    }

    // A rename is a demolition and a construction. Without the removal the old
    // building is never torn down and stands empty for the rest of the replay.
    if (c.previousPath && c.previousPath !== c.path) {
      const carried = totals.get(c.previousPath) || 0;
      totals.delete(c.previousPath);
      files.push({ path: c.previousPath, status: 'removed', lines: 1 });
      // The file's size did not change because it moved, so carry it across
      // rather than restarting the new building from nothing.
      if (carried && !totals.has(c.path)) totals.set(c.path, carried);
    }
    const known = totals.has(c.path);
    const next = Math.max(1, (totals.get(c.path) || 0) + c.additions - c.deletions);
    totals.set(c.path, next);
    files.push({
      path: c.path,
      status: known ? 'modified' : 'added',
      lines: next,
    });
  }
  return files;
}

function writeDataset(outPath, repo, commits) {
  const dataset = {
    repo,
    generatedAt: new Date().toISOString(),
    commits,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(dataset) + '\n');

  const touched = new Set();
  for (const c of commits) for (const f of c.files) touched.add(f.path);
  const bytes = fs.statSync(outPath).size;
  console.log(
    `wrote ${outPath}\n` +
      `  repo    ${repo}\n` +
      `  commits ${commits.length}\n` +
      `  paths   ${touched.size}\n` +
      `  size    ${(bytes / 1024).toFixed(1)} KB`
  );
}

function defaultOut(repo) {
  return path.join('data', repo.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json');
}

/* -------------------------------------------------------------- git source */

function git(cwd, args, maxBuffer = 512 * 1024 * 1024) {
  return execFileSync('git', args, { cwd, maxBuffer, encoding: 'utf8' });
}

/**
 * Walk the FULL history oldest-first so running totals are exact, then emit
 * only the most recent `limit` commits.
 *
 * Merges are skipped (--no-merges): every content change lives in exactly one
 * non-merge commit, so totals stay accurate while the timeline stays readable.
 * Rename detection is off (--no-renames) so a rename reads as a demolition plus
 * a new building rather than a silently relabelled one.
 */
function fromGit(source, limit) {
  let repoDir = source;
  let tmp = null;

  if (/^(https?:|git@|ssh:)/.test(source)) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcity-'));
    repoDir = path.join(tmp, 'repo');
    console.log(`cloning ${source} ...`);
    // A full clone on purpose: `git log --numstat` diffs every commit, and a
    // blobless clone would lazily refetch each blob over the network instead.
    execFileSync('git', ['clone', '--quiet', source, repoDir], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }

  try {
    const raw = git(repoDir, [
      'log',
      '--no-merges',
      '--reverse',
      '--date-order',
      '--no-renames',
      '--numstat',
      '--raw',
      '--format=%x00%H%x1f%aI%x1f%an%x1f%s',
    ]);

    const totals = new Map();
    const commits = [];

    for (const record of raw.split('\0')) {
      if (!record.trim()) continue;
      const lines = record.split('\n');
      const [sha, date, author, ...subjectParts] = lines[0].split('\x1f');
      if (!sha) continue;

      // Status letters come from the --raw section, counts from --numstat.
      const statuses = new Map();
      const counts = new Map();
      const renames = new Map();

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (line[0] === ':') {
          const parsed = parseRawStatus(line);
          if (!parsed) continue;
          statuses.set(parsed.path, parsed.letter);
          if (parsed.previousPath) renames.set(parsed.path, parsed.previousPath);
        } else {
          const parts = line.split('\t');
          if (parts.length < 3) continue;
          const [add, del, ...rest] = parts;
          counts.set(rest.join('\t'), {
            // "-" marks a binary file: no meaningful line count, treat as no delta.
            additions: add === '-' ? 0 : Number(add),
            deletions: del === '-' ? 0 : Number(del),
          });
        }
      }

      const changes = [];
      for (const [filePath, letter] of statuses) {
        const previousPath = renames.get(filePath);
        // --numstat writes a rename as "old => new"; --raw writes the two paths
        // in separate columns. Look under both so the counts are not lost.
        const c =
          counts.get(filePath) ||
          (previousPath && counts.get(`${previousPath} => ${filePath}`)) ||
          { additions: 0, deletions: 0 };
        changes.push({
          path: filePath,
          previousPath,
          status: letter === 'D' ? 'removed' : letter === 'A' ? 'added' : 'modified',
          additions: c.additions,
          deletions: c.deletions,
        });
      }

      commits.push({
        sha: sha.slice(0, 7),
        date,
        message: firstLine(subjectParts.join('\x1f')),
        author: author || 'unknown',
        files: applyDeltas(totals, changes),
      });
    }

    const name = repoNameFromSource(source, repoDir);
    return { repo: name, commits: commits.slice(-limit) };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function repoNameFromSource(source, repoDir) {
  const m = String(source).match(/([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  return path.basename(path.resolve(repoDir));
}

/* -------------------------------------------------------------- api source */

async function ghJson(url, token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'git-city' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
    throw new Error(
      `GitHub rate limit hit (remaining=${remaining}). ` +
        (reset ? `Resets at ${new Date(reset).toLocaleTimeString()}. ` : '') +
        'Pass --token, or use --git to clone instead.'
    );
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}: ${await res.text()}`);
  return { body: await res.json(), remaining };
}

/**
 * REST path. Costs ceil(limit/100) list requests + one request per commit for
 * the changed-file list, which is exactly why the demo datasets are committed.
 * Running totals start at zero within the window: commits older than the window
 * are not fetched, so a pre-existing file's baseline is unknown.
 */
async function fromApi(repo, limit, token) {
  const capped = Math.min(limit, HARD_CAP);
  const list = [];
  for (let page = 1; list.length < capped; page++) {
    const perPage = Math.min(100, capped - list.length);
    const { body } = await ghJson(
      `https://api.github.com/repos/${repo}/commits?per_page=${perPage}&page=${page}`,
      token
    );
    if (!Array.isArray(body) || body.length === 0) break;
    list.push(...body);
    if (body.length < perPage) break;
  }

  const ordered = list.slice(0, capped).reverse(); // oldest first
  const totals = new Map();
  const commits = [];

  for (let i = 0; i < ordered.length; i++) {
    const { body: detail, remaining } = await ghJson(
      `https://api.github.com/repos/${repo}/commits/${ordered[i].sha}`,
      token
    );
    process.stdout.write(
      `\r  commit ${i + 1}/${ordered.length}  (rate limit remaining: ${remaining})   `
    );

    const changes = (detail.files || []).map((f) => ({
      path: f.filename,
      previousPath: f.status === 'renamed' ? f.previous_filename : undefined,
      status: f.status === 'removed' ? 'removed' : f.status === 'added' ? 'added' : 'modified',
      additions: f.additions || 0,
      deletions: f.deletions || 0,
    }));

    commits.push({
      sha: detail.sha.slice(0, 7),
      date: detail.commit.author?.date || detail.commit.committer?.date,
      message: firstLine(detail.commit.message),
      author: detail.commit.author?.name || detail.author?.login || 'unknown',
      files: applyDeltas(totals, changes),
    });
  }
  process.stdout.write('\n');

  return { repo, commits };
}

/* --------------------------------------------------------------- synthetic */

/** Deterministic PRNG so the synthetic dataset is reproducible. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A fallback dataset for when api.github.com is unreachable: ~120 commits over
 * ~60 files in 6 folders, so the renderer always has real input to chew on.
 */
function synthetic() {
  const rand = mulberry32(20240517);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const folders = {
    'src/core': ['engine', 'scheduler', 'registry', 'context', 'events', 'lifecycle', 'store',
      'router', 'diff', 'patch', 'reconciler', 'signals', 'batch'],
    'src/ui': ['button', 'modal', 'tooltip', 'table', 'form', 'layout', 'theme', 'icons', 'menu',
      'toast', 'tabs', 'drawer', 'select', 'pagination'],
    'src/utils': ['array', 'string', 'date', 'math', 'assert', 'clone', 'debounce', 'uuid',
      'invariant', 'memoize'],
    'lib/adapters': ['http', 'websocket', 'memory', 'sqlite', 'redis', 'fs', 'postgres'],
    'test/unit': ['engine.test', 'store.test', 'router.test', 'utils.test', 'form.test',
      'table.test', 'http.test', 'signals.test', 'clone.test'],
    docs: ['getting-started', 'api-reference', 'configuration', 'deployment', 'faq', 'changelog',
      'migration', 'recipes'],
  };
  const ext = { docs: '.md', 'test/unit': '.js' };

  const allPaths = [];
  for (const [dir, names] of Object.entries(folders)) {
    for (const n of names) allPaths.push(`${dir}/${n}${ext[dir] || '.js'}`);
  }

  const verbs = ['Add', 'Fix', 'Refactor', 'Simplify', 'Document', 'Speed up', 'Harden', 'Rework', 'Drop', 'Polish'];
  const nouns = ['the scheduler', 'modal focus trapping', 'date parsing', 'the redis adapter', 'router matching',
    'form validation', 'the toast queue', 'clone() for maps', 'websocket reconnect', 'table virtualisation',
    'the deploy docs', 'uuid collisions', 'debounce timing', 'the memory adapter', 'theme tokens'];
  const authors = ['Ada Okafor', 'Bea Lindqvist', 'Chen Wei', 'Dmitri Volkov', 'Elena Rossi', 'Farid Haddad'];

  const totals = new Map();
  const live = new Set();
  const commits = [];
  let t = Date.UTC(2024, 0, 8, 9, 15, 0);
  let nextToCreate = 0;

  for (let i = 0; i < 120; i++) {
    t += Math.floor((3 + rand() * 40) * 3600 * 1000);
    const changes = [];

    // Front-load creation so the city rises quickly, then settles into edits.
    const creations = i < 40 ? 1 + Math.floor(rand() * 2) : rand() < 0.25 ? 1 : 0;
    for (let c = 0; c < creations && nextToCreate < allPaths.length; c++) {
      const p = allPaths[nextToCreate++];
      live.add(p);
      changes.push({ path: p, status: 'added', additions: 20 + Math.floor(rand() * 380), deletions: 0 });
    }

    const pool = [...live];
    const edits = Math.min(pool.length, 1 + Math.floor(rand() * 4));
    const seen = new Set(changes.map((c) => c.path));
    for (let e = 0; e < edits && pool.length; e++) {
      const p = pick(pool);
      if (seen.has(p)) continue;
      seen.add(p);
      changes.push({
        path: p,
        status: 'modified',
        additions: Math.floor(rand() * 120),
        deletions: Math.floor(rand() * 60),
      });
    }

    // Occasional demolition, but never before the city has something to lose.
    if (i > 45 && rand() < 0.07 && live.size > 12) {
      const doomed = pick([...live].filter((p) => !seen.has(p)));
      if (doomed) {
        live.delete(doomed);
        changes.push({ path: doomed, status: 'removed', additions: 0, deletions: 0 });
      }
    }

    commits.push({
      sha: Math.floor(rand() * 0xfffffff).toString(16).padStart(7, '0').slice(0, 7),
      date: new Date(t).toISOString(),
      message: firstLine(`${pick(verbs)} ${pick(nouns)}`),
      author: pick(authors),
      files: applyDeltas(totals, changes),
    });
  }

  return { repo: 'sample/demo-repo', commits };
}

/* -------------------------------------------------------------------- main */

const USAGE = `
Git City — dataset generator

  node scripts/fetch-history.js --git <url|path> [--out f.json] [--limit 300]
  node scripts/fetch-history.js --repo owner/name [--token TOKEN] [--limit 300]
  node scripts/fetch-history.js --synthetic

  --git        clone (or read) a repository and walk its full history locally.
               Exact running totals, no API budget spent. Recommended.
  --repo       GitHub REST API. Costs ~1 request per commit; 60/hour without a
               token, 5000/hour with one. Capped at ${HARD_CAP} commits.
  --synthetic  write the bundled sample/demo-repo dataset.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.git && !args.repo && !args.synthetic)) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  let result;
  if (args.synthetic) result = synthetic();
  else if (args.git) result = fromGit(args.git, args.limit);
  else result = await fromApi(args.repo, args.limit, args.token || process.env.GITHUB_TOKEN);

  if (result.commits.length === 0) throw new Error('No commits found — nothing to write.');
  writeDataset(args.out || defaultOut(result.repo), result.repo, result.commits);
}

// Only run when invoked directly. Without this the CLI fires on require and
// the parsing below cannot be exercised from a test.
if (require.main === module) {
  main().catch((err) => {
    console.error(`\nfetch-history failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseRawStatus, applyDeltas };
