/**
 * layout.js — the pure geometry of Git City. No three.js, no DOM.
 *
 * Everything here is a deterministic function of the input, which is the point:
 * scripts/verify.js runs this exact module in Node to print the city's numbers
 * without rendering anything. The renderer and the verifier can never disagree
 * about where a building goes or where the camera ends up.
 *
 * Layout rules (fixed by spec):
 *   - 4x4 unit footprint, 2 unit gap  -> 6 unit pitch
 *   - height = clamp(lines / 20, 1, 40), base sitting on y = 0
 *   - one district per folder, ceil(sqrt(n)) columns inside it
 *   - districts in their own grid, largest first, 10 units of padding
 */

export const FOOTPRINT = 4;
export const GAP = 2;
export const PITCH = FOOTPRINT + GAP;
export const DISTRICT_PADDING = 10;

export const LINES_PER_UNIT = 20;
export const HEIGHT_MIN = 1;
export const HEIGHT_MAX = 40;

export const ROOT_DISTRICT = '(root)';

/* ------------------------------------------------------------ buildings -- */

/** Building height for a line count, clamped so nothing vanishes or scrapes orbit. */
export function heightForLines(lines) {
  const n = Number.isFinite(lines) ? lines : 0;
  return Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, n / LINES_PER_UNIT));
}

/** The folder a file belongs to. Root-level files share one synthetic district. */
export function districtOf(filePath) {
  const cut = filePath.lastIndexOf('/');
  return cut === -1 ? ROOT_DISTRICT : filePath.slice(0, cut);
}

/**
 * Place every path in the city.
 *
 * Pure in its input: the same set of paths always produces the same
 * coordinates, so the layout can be recomputed from scratch on every add or
 * remove without the city scrambling itself.
 *
 * @param {Iterable<string>} paths
 * @returns {{positions: Map<string, {x:number,z:number}>, districts: Array, width:number, depth:number}}
 */
export function layout(paths) {
  const byDistrict = new Map();
  for (const p of paths) {
    const d = districtOf(p);
    if (!byDistrict.has(d)) byDistrict.set(d, []);
    byDistrict.get(d).push(p);
  }

  // Largest district first; alphabetical tiebreak keeps ordering stable.
  const districts = [...byDistrict.entries()]
    .map(([name, files]) => {
      files.sort();
      const cols = Math.ceil(Math.sqrt(files.length));
      const rows = Math.ceil(files.length / cols);
      return { name, files, cols, rows, width: cols * PITCH - GAP, depth: rows * PITCH - GAP };
    })
    .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));

  const positions = new Map();
  if (districts.length === 0) return { positions, districts, width: 0, depth: 0 };

  // Districts get their own grid. Each column is as wide as its widest district
  // and each row as deep as its deepest, so nothing ever overlaps.
  const gridCols = Math.ceil(Math.sqrt(districts.length));
  const gridRows = Math.ceil(districts.length / gridCols);
  const colWidth = new Array(gridCols).fill(0);
  const rowDepth = new Array(gridRows).fill(0);

  districts.forEach((d, i) => {
    const c = i % gridCols;
    const r = Math.floor(i / gridCols);
    colWidth[c] = Math.max(colWidth[c], d.width);
    rowDepth[r] = Math.max(rowDepth[r], d.depth);
  });

  const colX = [];
  for (let c = 0, x = 0; c < gridCols; c++) { colX.push(x); x += colWidth[c] + DISTRICT_PADDING; }
  const rowZ = [];
  for (let r = 0, z = 0; r < gridRows; r++) { rowZ.push(z); z += rowDepth[r] + DISTRICT_PADDING; }

  const width = colWidth.reduce((a, b) => a + b, 0) + DISTRICT_PADDING * (gridCols - 1);
  const depth = rowDepth.reduce((a, b) => a + b, 0) + DISTRICT_PADDING * (gridRows - 1);

  // Centre the city on the origin so the ground grid frames it.
  const originX = -width / 2;
  const originZ = -depth / 2;

  districts.forEach((d, i) => {
    const c = i % gridCols;
    const r = Math.floor(i / gridCols);
    const baseX = originX + colX[c] + (colWidth[c] - d.width) / 2;
    const baseZ = originZ + rowZ[r] + (rowDepth[r] - d.depth) / 2;

    d.files.forEach((p, j) => {
      positions.set(p, {
        x: baseX + (j % d.cols) * PITCH + FOOTPRINT / 2,
        z: baseZ + Math.floor(j / d.cols) * PITCH + FOOTPRINT / 2,
      });
    });
  });

  return { positions, districts, width, depth };
}

/* --------------------------------------------------------------- camera -- */

export const FOV = 55;
export const MARGIN = 1.2;                 // 20% breathing room

/**
 * 28 degrees rather than a top-down 45: low enough to read as a skyline with
 * the towers overlapping each other, which is what makes it look like a city
 * seen from somewhere rather than a chart seen from above.
 */
export const ELEVATION = (28 * Math.PI) / 180;
export const DEFAULT_AZIMUTH = Math.PI * 0.25;

/**
 * How far above "straight at the city centre" the camera aims.
 *
 * At 28 degrees of elevation with a 55 degree field of view the horizon lands
 * within half a degree of the top edge of the frame, so a camera pointed at the
 * city centre shows no sky at all — which throws away the sunset the whole
 * scene is lit by. Tilting the aim up by ten degrees drops the city into the
 * lower part of the frame and puts the horizon in shot, without moving the
 * camera off the 28 degree viewpoint. The fit below accounts for the tilt, so
 * the city is still framed in full.
 *
 * Five degrees is measured, not guessed: the near edge of the city is what
 * binds the fit, so every degree of tilt costs about 5% more distance (and so a
 * smaller city on screen) to buy about 2% of frame height as sky. Five degrees
 * puts the horizon a comfortable step below the top edge for a 14% wider shot;
 * ten degrees buys a dramatic sky and makes the city too small to read.
 */
export const SKY_TILT = (5 * Math.PI) / 180;
export const VIEW_PITCH = ELEVATION - SKY_TILT;

/**
 * Never frame closer than this, however small the city.
 * A handful of buildings filling the screen looks like a rendering accident;
 * the same buildings seen from a distance look like a city that has not been
 * built yet, which is what they are.
 */
export const MIN_FRAME_DISTANCE = 170;

/**
 * Axis-aligned bounds of the city.
 * @param {Array<{x:number,z:number,height:number}>} buildings
 */
export function cityBounds(buildings) {
  if (!buildings.length) return null;
  const half = FOOTPRINT / 2;
  const box = {
    min: { x: Infinity, y: 0, z: Infinity },
    max: { x: -Infinity, y: 0, z: -Infinity },
  };
  for (const b of buildings) {
    box.min.x = Math.min(box.min.x, b.x - half);
    box.max.x = Math.max(box.max.x, b.x + half);
    box.min.z = Math.min(box.min.z, b.z - half);
    box.max.z = Math.max(box.max.z, b.z + half);
    box.max.y = Math.max(box.max.y, Math.max(b.height, HEIGHT_MIN));
  }
  return box;
}

export function boxSize(box) {
  return {
    x: box.max.x - box.min.x,
    y: box.max.y - box.min.y,
    z: box.max.z - box.min.z,
  };
}

export function boxCenter(box) {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
}

/** Radius of the sphere enclosing the box — half its diagonal. */
export function boundingRadius(box) {
  const s = boxSize(box);
  return 0.5 * Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
}

/**
 * How far back the camera has to sit for the whole city to fit, with a 20%
 * margin, from the given elevation.
 *
 * This is the single most load-bearing function in the project — get it wrong
 * and you ship a black screen or a cropped city — so it is solved rather than
 * approximated.
 *
 * The city is modelled as the cylinder enclosing its footprint: a cylinder
 * radius does not depend on azimuth, so a fit that works at one angle works at
 * every angle the auto-orbit swings through. We then bisect for the smallest
 * distance at which every point on that cylinder's rim still projects inside
 * the frustum, testing the projection honestly instead of assuming the
 * orthographic extent (perspective makes the near edge project much lower than
 * an orthographic estimate, and that is exactly what crops a city).
 *
 * Both fields of view are checked: on a portrait window the horizontal one
 * binds, and ignoring that is another way cities end up cropped.
 */
export function requiredDistance(box, aspect, fovDeg = FOV, margin = MARGIN, elevation = ELEVATION) {
  const s = boxSize(box);
  const radius = 0.5 * Math.hypot(s.x, s.z);
  const halfHeight = s.y / 2;
  if (radius <= 0 && halfHeight <= 0) return 1;

  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const tanV = Math.tan(vFov / 2) / margin;
  const tanH = Math.tan(hFov / 2) / margin;

  // Silhouette candidates: the top and bottom rims of that cylinder.
  const rim = [];
  const SAMPLES = 32;
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const x = radius * Math.cos(t);
    const z = radius * Math.sin(t);
    rim.push([x, halfHeight, z], [x, -halfHeight, z]);
  }

  // Camera sits at `elevation` above the origin (the box centre, translated
  // out) but aims along the shallower VIEW_PITCH, so the city occupies the
  // lower part of the frame and the sky occupies the top.
  const cosE = Math.cos(elevation);
  const sinE = Math.sin(elevation);
  const pitch = Math.max(elevation - SKY_TILT, 0.01);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const fwd = [-cosP, -sinP, 0];
  const right = [0, 0, -1];
  const up = [-sinP, cosP, 0];

  const fits = (d) => {
    const cx = cosE * d;
    const cy = sinE * d;
    for (const p of rim) {
      const vx = p[0] - cx;
      const vy = p[1] - cy;
      const vz = p[2];
      const zc = vx * fwd[0] + vy * fwd[1] + vz * fwd[2];
      if (zc <= 0) return false; // behind the camera
      const xc = vx * right[0] + vy * right[1] + vz * right[2];
      const yc = vx * up[0] + vy * up[1] + vz * up[2];
      if (Math.abs(xc) > zc * tanH || Math.abs(yc) > zc * tanV) return false;
    }
    return true;
  };

  // The bounding-sphere fit always contains the city, so it brackets the search.
  let hi = Math.max(
    (Math.hypot(radius, halfHeight) * margin) / Math.sin(Math.min(vFov, hFov) / 2),
    1
  );
  while (!fits(hi) && hi < 1e7) hi *= 2;

  let lo = 0;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return Math.max(hi, MIN_FRAME_DISTANCE);
}

/**
 * Where to put the camera so the whole city is visible.
 * Never hardcoded — always derived from the bounds that actually exist.
 *
 * The orbit target sits directly above the city centre rather than on the view
 * ray, so orbiting sweeps around the city instead of swinging it across frame.
 */
export function framing(box, aspect, azimuth = DEFAULT_AZIMUTH) {
  const centre = boxCenter(box);
  const distance = requiredDistance(box, aspect);
  const horizontal = Math.cos(ELEVATION);

  const position = {
    x: centre.x + Math.cos(azimuth) * horizontal * distance,
    y: centre.y + Math.sin(ELEVATION) * distance,
    z: centre.z + Math.sin(azimuth) * horizontal * distance,
  };

  // Lift the aim point so the look direction runs at VIEW_PITCH rather than
  // straight at the centre. Derived from the geometry, not tuned by eye:
  //   tan(pitch) = (camera height above centre - lift) / horizontal distance
  const lift = Math.sin(ELEVATION) * distance - Math.tan(VIEW_PITCH) * horizontal * distance;

  return {
    distance,
    position,
    target: { x: centre.x, y: centre.y + lift, z: centre.z },
  };
}
