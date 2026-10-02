/**
 * modules.test.mjs — every module in js/ parses, and its imports resolve.
 *
 * Three of the five files in js/ import three.js from a CDN through an import
 * map in index.html. Node cannot load them, so no test imports them, so
 * nothing at all checked them — and the way that fails is total: a stray
 * bracket in world.js is a blank page with one line in the console, found by
 * opening the browser, which is exactly the step this suite exists to avoid.
 *
 * Parsing is not running. It will not catch a wrong matrix or a mis-set
 * uniform. It does catch the class of mistake that editing these files
 * actually produces: a syntax error, a duplicate declaration, a local that
 * shadows an import, an import of a file that is not there.
 *
 * `node --check` is the whole mechanism. package.json declares the module
 * type, so it parses these as ES modules and resolves nothing — three.js
 * never has to be fetched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'js');

const modules = fs.readdirSync(JS).filter((f) => f.endsWith('.js')).sort();

test('js/ holds the modules the page loads', () => {
  // A guard on the guard: if this directory is ever emptied or renamed, the
  // loop below would pass by testing nothing.
  assert.ok(modules.length >= 5, `only found ${modules.length} modules in js/`);
  for (const expected of ['city.js', 'layout.js', 'main.js', 'world.js']) {
    assert.ok(modules.includes(expected), `${expected} is missing`);
  }
});

for (const file of modules) {
  test(`js/${file} parses`, () => {
    const checked = spawnSync(process.execPath, ['--check', path.join(JS, file)], {
      encoding: 'utf8',
    });
    assert.equal(checked.status, 0, checked.stderr);
  });
}

test('every relative import points at a file that exists', () => {
  const missing = [];

  for (const file of modules) {
    const source = fs.readFileSync(path.join(JS, file), 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = path.resolve(JS, match[1]);
      if (!fs.existsSync(target)) missing.push(`${file} imports ${match[1]}`);
    }
  }

  assert.deepEqual(missing, []);
});

test('nothing imports three.js except through the import map', () => {
  // The bare specifiers 'three' and 'three/addons/' are resolved by the map in
  // index.html. A relative or http import would work in one browser and fail
  // in another, and would pull in a second copy of the library.
  const offenders = [];

  for (const file of modules) {
    const source = fs.readFileSync(path.join(JS, file), 'utf8');
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1];
      const ok =
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier === 'three' ||
        specifier.startsWith('three/addons/');
      if (!ok) offenders.push(`${file} imports ${specifier}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test('index.html loads the entry module and maps three', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /type="importmap"/);
  assert.match(html, /"three":\s*"https:\/\//);
  assert.match(html, /js\/main\.js/);
});
