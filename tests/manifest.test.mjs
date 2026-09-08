/**
 * manifest.test.mjs — the dropdown and the files on disk have to agree.
 *
 * data/manifest.json is the only thing standing between the demo picker and a
 * fetch for a file that is not there. Nothing else checks it: verify.js reads
 * the manifest to find datasets, so a dataset missing *from* the manifest is
 * invisible to it, and a manifest entry pointing at a deleted file fails as a
 * 404 in the browser and a blank screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDataset } from '../js/github.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));

const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

test('the manifest is a non-empty array', () => {
  assert.ok(Array.isArray(manifest));
  assert.ok(manifest.length > 0, 'an empty dropdown is a broken landing page');
});

test('every entry has the three fields the picker renders', () => {
  for (const entry of manifest) {
    for (const field of ['file', 'repo', 'label']) {
      assert.equal(typeof entry[field], 'string', `${JSON.stringify(entry)} is missing ${field}`);
      assert.ok(entry[field].trim(), `${field} is empty in ${JSON.stringify(entry)}`);
    }
  }
});

test('every file named in the manifest exists', () => {
  // A missing one is a 404 and a blank screen, and only for whoever picks
  // that entry from the dropdown.
  for (const entry of manifest) {
    assert.ok(fs.existsSync(path.join(ROOT, entry.file)), `${entry.file} is not in the repo`);
  }
});

test('every dataset on disk is offered in the dropdown', () => {
  // The other direction: a dataset nobody can pick, and one verify.js never
  // looks at, because it reads the manifest to find its targets.
  const onDisk = fs
    .readdirSync(DATA)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .map((name) => `data/${name}`);
  const listed = new Set(manifest.map((entry) => entry.file));
  for (const file of onDisk) {
    assert.ok(listed.has(file), `${file} exists but is in no manifest entry`);
  }
});

test('file paths and repo names are unique', () => {
  const files = manifest.map((e) => e.file);
  const repos = manifest.map((e) => e.repo);
  assert.equal(new Set(files).size, files.length, 'a dataset is listed twice');
  assert.equal(new Set(repos).size, repos.length, 'two entries claim the same repo');
});

test('every file path stays inside data/ and is JSON', () => {
  for (const entry of manifest) {
    assert.ok(entry.file.startsWith('data/'), entry.file);
    assert.ok(entry.file.endsWith('.json'), entry.file);
    assert.ok(!entry.file.includes('..'), entry.file);
  }
});

test('every listed dataset loads through the browser validator', () => {
  // The same call the app makes on the demo path. If this fails, picking that
  // entry shows an error instead of a city.
  for (const entry of manifest) {
    assert.doesNotThrow(() => validateDataset(read(entry.file), entry.file), entry.file);
  }
});

test('the repo name in the manifest matches the one inside the dataset', () => {
  // The dropdown label and the caption over the city come from different
  // places; disagreeing means the picker says axios and the city says express.
  for (const entry of manifest) {
    assert.equal(read(entry.file).repo, entry.repo, `${entry.file} disagrees with the manifest`);
  }
});

test('the commit count in each label is honest', () => {
  // "300 commits" in the dropdown should be 300 commits in the file.
  for (const entry of manifest) {
    const claimed = entry.label.match(/(\d+)\s+commits/);
    if (!claimed) continue;
    const actual = read(entry.file).commits.length;
    assert.equal(actual, Number(claimed[1]), `${entry.file} claims ${claimed[1]}, has ${actual}`);
  }
});
