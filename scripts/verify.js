#!/usr/bin/env node
/**
 * verify.js — check a dataset's geometry without rendering anything.
 *
 * Imports js/layout.js, the same module the browser uses, so these numbers are
 * the numbers the renderer will produce. If the city is the wrong scale or the
 * camera would end up inside a building, it shows up here instead of as a black
 * screen.
 *
 *   node scripts/verify.js data/axios-axios.json
 *   node scripts/verify.js            # every dataset in data/manifest.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Sanity band for the city footprint. Below this the buildings are specks;
// above it the camera is so far out that everything aliases into mush.
const MIN_FOOTPRINT = 20;
const MAX_FOOTPRINT = 5000;

// Reference viewport for the camera figures. The real fit is recomputed live
// from the window's aspect ratio; 16:9 is a representative landscape window.
const REFERENCE_ASPECT = 16 / 9;

const f1 = (n) => n.toFixed(1);

function median(sorted) {
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Read and structurally check one dataset.
 *
 * Every throw here names the file and says what is wrong with it. The bare
 * `JSON.parse(readFileSync(...))` this replaces reported a missing dataset as
 * a raw ENOENT and a dataset without a `commits` array as
 * "data.commits is not iterable" — true, and useless to whoever has to fix it.
 */
function readDataset(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(
      err.code === 'ENOENT' ? 'no such file' : `could not be read — ${err.message}`
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`is not valid JSON — ${err.message}`);
  }

  return data;
}

/**
 * Check a dataset the way the browser will.
 *
 * This used to be a second, looser set of structural checks written out here —
 * an object, a commits array, not empty. It let through everything
 * validateDataset catches inside a file record, so a dataset could pass verify
 * and then fail to load in the app, which is the one thing this script exists
 * to rule out. Same function, same errors, no drift.
 */
function validate(data, label, validateDataset) {
  try {
    validateDataset(data, label);
  } catch (err) {
    // GitHubError's message is already "<label>: what is wrong", and the
    // caller prefixes the label itself, so hand back just the reason.
    throw new Error(String(err.message).replace(`${label}: `, ''));
  }
}

/** One dataset: replay it, measure it, print it. Throws with a plain message. */
function checkDataset(L, file, data) {
  // Replay the history exactly as City.applyCommit does: a removal deletes
  // the building, anything else sets its target height.
  const heights = new Map();
  let peak = 0;
  let touches = 0;

  for (const commit of data.commits) {
    for (const fileRec of commit.files || []) {
      if (!fileRec.path) continue;
      touches++;
      if (fileRec.status === 'removed') heights.delete(fileRec.path);
      else heights.set(fileRec.path, L.heightForLines(fileRec.lines));
    }
    peak = Math.max(peak, heights.size);
  }

  // A history whose last commits delete everything leaves nothing standing,
  // and every measurement below is then taken of a city that does not exist:
  // cityBounds returns null and boxSize(null) throws a TypeError naming a
  // property rather than the dataset. It is a legitimate history — a repo
  // emptied before its final commit — so say so and move on to the next file.
  if (heights.size === 0) {
    throw new Error(
      `ends with no files standing (${touches} file touches across ` +
        `${data.commits.length} commits, peak ${peak}) — there is no city to measure`
    );
  }

  const plan = L.layout([...heights.keys()]);
  const { positions, districts, banks } = plan;
  const buildings = [...heights.entries()].map(([p, height]) => ({
    x: positions.get(p).x,
    z: positions.get(p).z,
    height,
  }));

  const box = L.cityBounds(buildings);
  const size = L.boxSize(box);
  const fit = L.framing(box, REFERENCE_ASPECT);
  const sortedHeights = buildings.map((b) => b.height).sort((a, b) => a - b);

  const footprint = Math.max(size.x, size.z);
  const inBand = footprint >= MIN_FOOTPRINT && footprint <= MAX_FOOTPRINT;

  console.log(`
${data.repo}   (${path.relative(process.cwd(), file)})
${'─'.repeat(62)}
  commits            ${data.commits.length}
  file touches       ${touches}
  buildings (final)  ${buildings.length}
  buildings (peak)   ${peak}
  districts          ${districts.length}
  banks              ${banks.map((b, i) => `bank ${i}: ${districts.filter((d) => d.bank === i).length} districts, ${f1(b.width)} x ${f1(b.depth)}`).join('\n                     ')}
  river channel      ${plan.channel.width} units wide

  building height    min ${f1(sortedHeights[0])}   median ${f1(median(sortedHeights))}   max ${f1(sortedHeights[sortedHeights.length - 1])}
  largest district   ${districts[0].name} (${districts[0].files.length} files, ${districts[0].cols}x${districts[0].rows})

  city bbox          ${f1(size.x)} wide x ${f1(size.y)} tall x ${f1(size.z)} deep
  bbox centre        ${f1(L.boxCenter(box).x)}, ${f1(L.boxCenter(box).y)}, ${f1(L.boxCenter(box).z)}
  bounding radius    ${f1(L.boundingRadius(box))}

  camera position    ${f1(fit.position.x)}, ${f1(fit.position.y)}, ${f1(fit.position.z)}
  camera target      ${f1(fit.target.x)}, ${f1(fit.target.y)}, ${f1(fit.target.z)}
  camera distance    ${f1(fit.distance)}  (fov ${L.FOV}, ${Math.round((L.ELEVATION * 180) / Math.PI)}° elevation, ${Math.round((L.MARGIN - 1) * 100)}% margin, aspect ${REFERENCE_ASPECT.toFixed(2)})${fit.distance <= L.MIN_FRAME_DISTANCE + 0.01 ? ` — clamped to the ${L.MIN_FRAME_DISTANCE} minimum` : ''}

  scale check        footprint ${f1(footprint)} units — ${inBand ? 'OK' : `OUT OF BAND (expected ${MIN_FOOTPRINT}–${MAX_FOOTPRINT})`}`);

  return inBand;
}

async function main() {
  const toUrl = (file) => require('url').pathToFileURL(path.join(__dirname, '..', 'js', file)).href;
  const L = await import(toUrl('layout.js'));
  const { validateDataset } = await import(toUrl('github.js'));

  const targets = process.argv.slice(2).length
    ? process.argv.slice(2)
    : JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'manifest.json'), 'utf8'))
        .map((e) => e.file);

  const failures = [];

  for (const rel of targets) {
    const file = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
    const label = path.relative(process.cwd(), file);

    // Each dataset is checked in isolation. Letting one throw out of the loop
    // meant the first broken file ended the run, so the datasets after it were
    // never looked at and a green line was never proof that they were fine.
    try {
      const data = readDataset(file);
      validate(data, label, validateDataset);
      if (!checkDataset(L, file, data)) {
        failures.push(`${label}: footprint outside the ${MIN_FOOTPRINT}–${MAX_FOOTPRINT} band`);
      }
    } catch (err) {
      console.log(`\n${label}\n${'─'.repeat(62)}\n  FAILED             ${err.message}`);
      failures.push(`${label}: ${err.message}`);
    }
  }

  console.log('');
  if (failures.length) {
    console.error(`${failures.length} of ${targets.length} dataset(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${targets.length} dataset(s) OK.`);
}

main().catch((err) => {
  console.error(`verify failed: ${err.message}`);
  process.exit(1);
});
