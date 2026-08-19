/**
 * main.js — bootstrap and wiring.
 *
 * Owns the three.js scene, the camera framing rules, and every DOM listener.
 * City geometry lives in city.js, playback in timeline.js, data in github.js.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { City } from './city.js';
import {
  PITCH, FOV, ELEVATION, DEFAULT_AZIMUTH,
  requiredDistance as fitDistance, framing, boxSize,
} from './layout.js';
import { Timeline } from './timeline.js';
import {
  loadDataset, fetchRepo, parseRepoInput, validateDataset, GitHubError, COMMIT_CAP,
} from './github.js';

/* ----------------------------------------------------------- constants -- */

const BACKGROUND = 0x0d1117;
const ORBIT_RAD_PER_SEC = 0.15;
const FRAME_LERP = 0.06;                   // how fast the camera eases to a new fit
const MANIFEST_URL = 'data/manifest.json';

/* ------------------------------------------------------------------ dom -- */

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'),
  preset: $('preset'),
  repoUrl: $('repo-url'),
  token: $('token'),
  load: $('load'),
  hud: $('hud'),
  hudDate: $('hud-date'),
  hudCount: $('hud-count'),
  hudMessage: $('hud-message'),
  hudAuthor: $('hud-author'),
  hudRepo: $('hud-repo'),
  transport: $('transport'),
  play: $('play'),
  scrub: $('scrub'),
  debug: $('debug'),
  dbgFps: $('dbg-fps'),
  dbgBuildings: $('dbg-buildings'),
  dbgDistricts: $('dbg-districts'),
  dbgCamera: $('dbg-camera'),
  dbgBbox: $('dbg-bbox'),
  dbgRate: $('dbg-rate'),
  status: $('status'),
};

/**
 * The single place anything user-facing gets said. A blank screen is a bug, so
 * every failure path ends up here.
 */
function showStatus(message, { error = false, hint = '', transparent = false } = {}) {
  const inner = document.createElement('div');
  inner.className = 'status-inner';

  const p = document.createElement('p');
  if (error) {
    const strong = document.createElement('strong');
    strong.textContent = 'Something went wrong. ';
    p.appendChild(strong);
  }
  p.appendChild(document.createTextNode(message));
  inner.appendChild(p);

  if (hint) {
    const h = document.createElement('p');
    h.className = 'hint';
    h.textContent = hint;
    inner.appendChild(h);
  }

  el.status.replaceChildren(inner);
  el.status.classList.toggle('error', error);
  el.status.classList.toggle('transparent', transparent && !error);
  el.status.hidden = false;
}

const hideStatus = () => { el.status.hidden = true; };

/* ---------------------------------------------------------------- three -- */

const renderer = new THREE.WebGLRenderer({
  canvas: el.stage,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(BACKGROUND);

const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 20000);
camera.position.set(60, 60, 60);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.02;   // never dip below the ground
controls.minDistance = 5;
controls.maxDistance = 12000;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x1a1f27, 0.75));

const sun = new THREE.DirectionalLight(0xffffff, 1.15);
sun.position.set(1, 2, 1);
scene.add(sun);

const city = new City();
scene.add(city.group);

// Ground: a dark slab plus a GridHelper. The grid is a diagnostic — grid but no
// buildings means the data is wrong; nothing at all means the camera is wrong.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ color: 0x11161d })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02;
scene.add(ground);

let grid = null;
let gridSize = 0;

/** Grid divisions land on the building pitch, so cells line up with the blocks. */
function ensureGround(size) {
  const wanted = Math.max(60, Math.ceil((size * 1.25) / PITCH) * PITCH);
  if (grid && wanted <= gridSize) return;
  gridSize = wanted;

  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(gridSize, Math.round(gridSize / PITCH), 0x2b3440, 0x1d242e);
  grid.position.y = 0;
  scene.add(grid);

  ground.scale.set(gridSize, gridSize, 1);
}
ensureGround(60);

/* --------------------------------------------------------------- camera -- */

const frameTarget = new THREE.Vector3();
let frameDistance = 120;
let userInteracting = false;
let lastInteraction = -Infinity;

const _vec = new THREE.Vector3();

/** Fit distance for the city as it stands, at the window's current aspect. */
function distanceFor(box) {
  return fitDistance(box, camera.aspect);
}

/**
 * Snap the camera to fit the city right now.
 *
 * Nothing here is hardcoded: the position falls out of the bounding box, a
 * 45-degree elevation and the fov. An empty city gets a sane default so the
 * ground grid is still visible — if you can see the grid but no buildings the
 * problem is the data, not the camera.
 */
function frameCity({ azimuth = DEFAULT_AZIMUTH } = {}) {
  const box = city.bounds();

  if (!box) {
    frameTarget.set(0, 0, 0);
    frameDistance = 120;
    controls.target.copy(frameTarget);
    camera.position.set(
      Math.cos(azimuth) * Math.cos(ELEVATION) * frameDistance,
      Math.sin(ELEVATION) * frameDistance,
      Math.sin(azimuth) * Math.cos(ELEVATION) * frameDistance
    );
  } else {
    const fit = framing(box, camera.aspect, azimuth);
    frameTarget.set(fit.target.x, fit.target.y, fit.target.z);
    frameDistance = fit.distance;
    controls.target.copy(frameTarget);
    camera.position.set(fit.position.x, fit.position.y, fit.position.z);
  }

  applyClipPlanes();
  controls.update();
  ensureGroundFor(box);
}

function applyClipPlanes() {
  // Tie the clip planes to the fit distance: a fixed far plane wrecks depth
  // precision on a small city and clips a large one.
  camera.near = Math.max(0.1, frameDistance / 1000);
  camera.far = Math.max(1000, frameDistance * 12);
  camera.updateProjectionMatrix();
}

function ensureGroundFor(box) {
  const size = box ? boxSize(box) : { x: 60, z: 60 };
  ensureGround(Math.max(size.x, size.z, 60));
}

/**
 * Called as the city grows: widen the framing only once the city has outgrown
 * the current view, and follow the drifting centre. It never pulls the camera
 * in, so a deliberate zoom is not undone a frame later.
 */
function refitIfOutgrown() {
  const box = city.bounds();
  if (!box) return;

  const center = framing(box, camera.aspect).target;
  frameTarget.set(center.x, center.y, center.z);

  const need = distanceFor(box);
  if (need > frameDistance) frameDistance = need;

  applyClipPlanes();
  ensureGroundFor(box);
}

function updateCamera(dtSeconds) {
  const recentlyTouched = performance.now() - lastInteraction < 400;

  // Slow auto-orbit while playing, suspended while the user is driving.
  if (timeline.playing && !userInteracting && !recentlyTouched) {
    const a = ORBIT_RAD_PER_SEC * dtSeconds;
    _vec.copy(camera.position).sub(controls.target);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const x = _vec.x * cos - _vec.z * sin;
    const z = _vec.x * sin + _vec.z * cos;
    _vec.x = x;
    _vec.z = z;
    camera.position.copy(controls.target).add(_vec);
  }

  if (!userInteracting) {
    controls.target.lerp(frameTarget, FRAME_LERP);

    _vec.copy(camera.position).sub(controls.target);
    const current = _vec.length();
    if (current < frameDistance - 0.05) {
      _vec.setLength(current + (frameDistance - current) * FRAME_LERP);
      camera.position.copy(controls.target).add(_vec);
    }
  }

  controls.update();
}

controls.addEventListener('start', () => { userInteracting = true; });
controls.addEventListener('end', () => {
  userInteracting = false;
  lastInteraction = performance.now();
  // Adopt wherever the user left the camera as the new baseline, so auto-fit
  // only ever pushes out from there.
  frameDistance = Math.min(frameDistance, camera.position.distanceTo(controls.target));
});

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // A narrower window needs more distance for the same city.
  refitIfOutgrown();
}
window.addEventListener('resize', resize);
resize();

/* -------------------------------------------------------------- playback -- */

let dataset = null;

const timeline = new Timeline({
  onCommit: (commit, index) => {
    city.applyCommit(commit, index, false);
    refitIfOutgrown();
  },
  onSeek: (index) => {
    if (!dataset) return;
    city.seek(dataset.commits, index);
    if (index < 0) frameCity();
    else refitIfOutgrown();
  },
  onChange: updateUI,
});

function updateUI() {
  const total = timeline.count;
  const commit = timeline.current;

  el.scrub.max = String(total);
  el.scrub.value = String(timeline.index + 1);
  el.play.textContent = timeline.playing ? '❚❚' : '▶';

  el.hudCount.textContent = `commit ${timeline.index + 1} of ${total}`;
  el.hudRepo.textContent = dataset ? dataset.repo : '—';

  if (commit) {
    el.hudDate.textContent = formatDate(commit.date);
    el.hudMessage.textContent = commit.message || '(no message)';
    el.hudAuthor.textContent = commit.author || 'unknown';
  } else {
    el.hudDate.textContent = '—';
    el.hudMessage.textContent = 'Press play to build the city.';
    el.hudAuthor.textContent = '—';
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------ data loading -- */

async function useDataset(next) {
  dataset = next;
  city.clear();
  timeline.load(next.commits);

  el.hud.hidden = false;
  el.transport.hidden = false;

  timeline.seek(0);
  frameCity();
  hideStatus();
  timeline.play();
}

async function loadPreset(url) {
  if (!url) return;
  showStatus('Loading dataset…', { transparent: true });
  try {
    await useDataset(await loadDataset(url));
  } catch (err) {
    reportError(err);
  }
}

async function loadFromInput() {
  const raw = el.repoUrl.value.trim();
  if (!raw) {
    showStatus('Paste a GitHub repository URL, or pick one of the bundled demos.', { error: true });
    return;
  }

  el.load.disabled = true;
  try {
    const repo = parseRepoInput(raw);
    showStatus(`Listing commits for ${repo}…`, {
      hint: `Only the ${COMMIT_CAP} most recent commits are fetched — each one costs a GitHub API request.`,
    });

    const live = await fetchRepo(repo, el.token.value.trim(), (msg) => {
      showStatus(msg, { hint: 'This is one API request per commit. A token raises the ceiling from 60/hour to 5000/hour.' });
    });

    await useDataset(validateDataset(live, repo));
  } catch (err) {
    reportError(err);
  } finally {
    el.load.disabled = false;
  }
}

function reportError(err) {
  console.error(err);
  const message = err instanceof GitHubError ? err.message : `${err.message || err}`;
  const hint = err instanceof GitHubError && err.hint
    ? err.hint
    : 'Pick a bundled demo from the dropdown — those need no network access.';
  showStatus(message, { error: true, hint });
}

/**
 * Demo datasets are listed in data/manifest.json so adding one is a data change,
 * not a code change.
 */
async function loadManifest() {
  let entries = [];
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (res.ok) entries = await res.json();
  } catch {
    /* falls through to the empty-manifest message below */
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    showStatus('No bundled datasets found.', {
      error: true,
      hint: 'Generate one with: node scripts/fetch-history.js --git https://github.com/axios/axios',
    });
    return null;
  }

  el.preset.replaceChildren();
  for (const entry of entries) {
    const opt = document.createElement('option');
    opt.value = entry.file;
    opt.textContent = entry.label || entry.repo || entry.file;
    el.preset.appendChild(opt);
  }
  return entries;
}

/* ------------------------------------------------------------------- ui -- */

el.load.addEventListener('click', loadFromInput);
el.repoUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFromInput(); });
el.token.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFromInput(); });
el.preset.addEventListener('change', () => loadPreset(el.preset.value));
el.play.addEventListener('click', () => timeline.toggle());

el.scrub.addEventListener('input', () => {
  // Read the slider before pausing: pause() triggers a UI refresh that writes
  // the current commit back into the slider, which would clobber the drag.
  const target = Number(el.scrub.value) - 1;
  timeline.pause();
  timeline.seek(target);
});

for (const button of document.querySelectorAll('.speeds button')) {
  button.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.speeds button')) b.classList.remove('on');
    button.classList.add('on');
    timeline.setSpeed(Number(button.dataset.speed));
  });
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'd' || e.key === 'D') {
    el.debug.hidden = !el.debug.hidden;
  } else if (e.key === ' ') {
    e.preventDefault();
    timeline.toggle();
  }
});

/* ----------------------------------------------------------------- loop -- */

let lastFrame = performance.now();
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;

function tick(now) {
  requestAnimationFrame(tick);

  const dtMs = Math.min(now - lastFrame, 250);
  lastFrame = now;

  timeline.tick(dtMs);
  city.update(now);
  updateCamera(dtMs / 1000);

  fpsAccum += dtMs;
  fpsFrames++;
  if (fpsAccum >= 500) {
    fps = Math.round((fpsFrames * 1000) / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
    if (!el.debug.hidden) updateDebug();
  }

  renderer.render(scene, camera);
}

function updateDebug() {
  const box = city.bounds();
  const size = box ? boxSize(box) : { x: 0, y: 0, z: 0 };
  const f = (n) => n.toFixed(1);

  el.dbgFps.textContent = String(fps);
  el.dbgBuildings.textContent = String(city.buildingCount);
  el.dbgDistricts.textContent = String(city.districtCount);
  el.dbgCamera.textContent = `${f(camera.position.x)}, ${f(camera.position.y)}, ${f(camera.position.z)}`;
  el.dbgBbox.textContent = `${f(size.x)} × ${f(size.y)} × ${f(size.z)}`;
  el.dbgRate.textContent = `${Math.round(timeline.msPerCommit)} @ ${timeline.speed}×`;
}

/* ----------------------------------------------------------------- boot -- */

(async function boot() {
  requestAnimationFrame(tick);
  showStatus('Loading…', { transparent: true });

  const entries = await loadManifest();
  if (!entries) return;

  const params = new URLSearchParams(location.search);
  const repoParam = params.get('repo');
  if (repoParam) {
    el.repoUrl.value = repoParam;
    loadFromInput();
    return;
  }

  const requested = params.get('demo');
  const chosen = entries.find((e) => e.file === requested || e.repo === requested) || entries[0];
  el.preset.value = chosen.file;
  loadPreset(chosen.file);
})();

// Handy for poking at the city from the console.
window.gitCity = { three: THREE, city, timeline, camera, controls, scene, frameCity, get dataset() { return dataset; } };
