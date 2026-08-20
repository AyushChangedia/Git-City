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

async function main() {
  const L = await import(
    require('url').pathToFileURL(path.join(__dirname, '..', 'js', 'layout.js')).href
  );

  const targets = process.argv.slice(2).length
    ? process.argv.slice(2)
    : JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'manifest.json'), 'utf8'))
        .map((e) => e.file);

  let failures = 0;

  for (const rel of targets) {
    const file = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

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
    if (!inBand) failures++;

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
  }

  console.log('');
  if (failures) {
    console.error(`${failures} dataset(s) outside the sane scale band.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`verify failed: ${err.message}`);
  process.exit(1);
});
