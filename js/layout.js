/**
 * layout.js — the pure geometry of Git City. No three.js, no DOM.
 *
 * Everything here is a deterministic function of the input, which is the point:
 * scripts/verify.js runs this exact module in Node to print the city's numbers
 * without rendering anything, so the renderer and the verifier can never
 * disagree about where a building goes or where the camera ends up.
 *
 * Layout rules:
 *   - 3 x 3 unit footprint, 1 unit gap  ->  4 unit pitch
 *   - height = clamp(lines / 12, 2, 70), base sitting on y = 0
 *   - one district per folder, ceil(sqrt(n)) columns inside it
 *   - top-level folders alternate between two banks of a river
 *   - each bank fronts the water, districts largest-first
 */

export const FOOTPRINT = 3;
export const GAP = 1;
export const PITCH = FOOTPRINT + GAP;
export const DISTRICT_PADDING = 10;

export const LINES_PER_UNIT = 12;
export const HEIGHT_MIN = 2;
export const HEIGHT_MAX = 70;

/** Above this a building is built as a tapered stack rather than one box. */
export const TAPER_HEIGHT = 30;

export const CHANNEL_WIDTH = 90;
export const CHANNEL_HALF = CHANNEL_WIDTH / 2;

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

/** The top-level folder, which is what decides which bank a district lands on. */
export function topLevelOf(district) {
  const cut = district.indexOf('/');
  return cut === -1 ? district : district.slice(0, cut);
}

/**
 * Pack one bank's districts into a grid.
 *
 * The grid is deliberately wider than it is deep — twice as many columns as a
 * square packing would use — so a bank spreads along the river rather than
 * retreating from it. That is what gives both banks a waterfront.
 */
function packBank(districts) {
  const n = districts.length;
  if (n === 0) return { cols: 0, rows: 0, colWidth: [], rowDepth: [], width: 0, depth: 0 };

  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 2)));
  const rows = Math.ceil(n / cols);
  const colWidth = new Array(cols).fill(0);
  const rowDepth = new Array(rows).fill(0);

  districts.forEach((d, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    colWidth[c] = Math.max(colWidth[c], d.width);
    rowDepth[r] = Math.max(rowDepth[r], d.depth);
  });

  return {
    cols, rows, colWidth, rowDepth,
    width: colWidth.reduce((a, b) => a + b, 0) + DISTRICT_PADDING * (cols - 1),
    depth: rowDepth.reduce((a, b) => a + b, 0) + DISTRICT_PADDING * (rows - 1),
  };
}

/**
 * Place every path in the city.
 *
 * Pure in its input: the same set of paths always produces the same
 * coordinates, so the layout can be recomputed from scratch without the city
 * scrambling itself.
 *
 * The river runs along the X axis with the channel centred on z = 0. It is not
 * rotated in world space on purpose — the camera orbits and the ocean is
 * featureless, so a world-space rotation of the whole city produces the same
 * images at a different orbit phase. The diagonal comes from where the camera
 * is put instead (see DEFAULT_AZIMUTH), which costs nothing and keeps every
 * coordinate in this file axis-aligned and checkable.
 *
 * @returns {{positions: Map, districts: Array, banks: Array, channel: object, width: number, depth: number}}
 */
export function layout(paths) {
  const byDistrict = new Map();
  for (const p of paths) {
    const d = districtOf(p);
    if (!byDistrict.has(d)) byDistrict.set(d, []);
    byDistrict.get(d).push(p);
  }

  const districts = [...byDistrict.entries()]
    .map(([name, files]) => {
      files.sort();
      const cols = Math.ceil(Math.sqrt(files.length));
      const rows = Math.ceil(files.length / cols);
      return {
        name, files, cols, rows,
        top: topLevelOf(name),
        width: cols * PITCH - GAP,
        depth: rows * PITCH - GAP,
      };
    })
    .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));

  const positions = new Map();
  if (districts.length === 0) {
    return { positions, districts, banks: [], channel: null, width: 0, depth: 0 };
  }

  // Top-level folders alternate between the banks, largest first, so the two
  // sides stay comparable in size instead of one swallowing the whole repo.
  const byTop = new Map();
  for (const d of districts) {
    if (!byTop.has(d.top)) byTop.set(d.top, []);
    byTop.get(d.top).push(d);
  }
  const tops = [...byTop.entries()]
    .map(([name, ds]) => ({ name, ds, size: ds.reduce((n, d) => n + d.files.length, 0) }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));

  const bankDistricts = [[], []];
  tops.forEach((t, i) => {
    const bank = i % 2;
    for (const d of t.ds) {
      d.bank = bank;
      bankDistricts[bank].push(d);
    }
  });
  for (const list of bankDistricts) {
    list.sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));
  }

  const packs = bankDistricts.map(packBank);

  for (let bank = 0; bank < 2; bank++) {
    const pack = packs[bank];
    const list = bankDistricts[bank];
    if (!list.length) continue;

    // Row 0 fronts the water on both banks; later rows retreat from it.
    const side = bank === 0 ? -1 : 1;
    const rowNear = [];
    for (let r = 0, acc = 0; r < pack.rows; r++) {
      rowNear.push(CHANNEL_HALF + acc);
      acc += pack.rowDepth[r] + DISTRICT_PADDING;
    }

    const colX = [];
    for (let c = 0, x = -pack.width / 2; c < pack.cols; c++) {
      colX.push(x);
      x += pack.colWidth[c] + DISTRICT_PADDING;
    }

    list.forEach((d, i) => {
      const c = i % pack.cols;
      const r = Math.floor(i / pack.cols);

      const baseX = colX[c] + (pack.colWidth[c] - d.width) / 2;
      // Distance from the channel edge to this district's near face.
      const near = rowNear[r] + (pack.rowDepth[r] - d.depth) / 2;
      const baseZ = side < 0 ? -(near + d.depth) : near;

      d.x0 = baseX; d.x1 = baseX + d.width;
      d.z0 = baseZ; d.z1 = baseZ + d.depth;

      d.files.forEach((p, j) => {
        positions.set(p, {
          x: baseX + (j % d.cols) * PITCH + FOOTPRINT / 2,
          z: baseZ + Math.floor(j / d.cols) * PITCH + FOOTPRINT / 2,
        });
      });
    });
  }

  const width = Math.max(packs[0].width, packs[1].width);
  const depth = packs[0].depth + packs[1].depth + CHANNEL_WIDTH + DISTRICT_PADDING * 2;

  return {
    positions,
    districts,
    banks: packs.map((p, bank) => ({
      bank,
      width: p.width,
      depth: p.depth,
      z0: bank === 0 ? -(CHANNEL_HALF + p.depth) : CHANNEL_HALF,
      z1: bank === 0 ? -CHANNEL_HALF : CHANNEL_HALF + p.depth,
    })),
    channel: { halfWidth: CHANNEL_HALF, width: CHANNEL_WIDTH },
    width,
    depth,
  };
}

/* --------------------------------------------------------------- camera -- */

export const FOV = 48;
export const MARGIN = 1.2;                 // 20% breathing room

/**
 * 18 degrees: a skyline is something you look *across*, not down at. Low enough
 * that towers overlap and occlude each other, which is most of what makes a
 * cluster of boxes read as a city.
 */
export const ELEVATION = (18 * Math.PI) / 180;

/**
 * Where the camera starts.
 *
 * This is not a free choice: it decides whether the shot faces the sun. The sun
 * sits at azimuth 175, which points very nearly along -z, so a camera placed
 * near azimuth 95 looks straight into it. Placed opposite, the scene is lit
 * entirely from behind and the sky renders as the dull grey-green of the
 * anti-solar horizon — all the colour is on the other side of the camera.
 *
 * 135 degrees puts the sun about 40 degrees off the view axis — just outside
 * the frame on a landscape window, so its glow floods in from the edge without
 * the disc itself blowing out the middle of the shot. It also sets the river at
 * roughly 45 degrees to the view, so the channel runs corner to corner rather
 * than straight across.
 */
export const DEFAULT_AZIMUTH = (135 * Math.PI) / 180;

/**
 * How far above "straight at the city centre" the camera aims, to put the
 * horizon in the upper third of the frame rather than at its very edge.
 * The fit below accounts for it, so the city is still framed in full.
 */
export const SKY_TILT = (7 * Math.PI) / 180;
export const VIEW_PITCH = ELEVATION - SKY_TILT;

/** Never frame closer than this, however small or sparse the city. */
export const MIN_FRAME_DISTANCE = 220;

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
  return { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
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
 * This is the most load-bearing function in the project — get it wrong and you
 * ship a black screen or a cropped city — so it is solved rather than
 * approximated.
 *
 * The city is modelled as the cylinder enclosing its footprint: a cylinder
 * radius does not depend on azimuth, so a fit that works at one angle works at
 * every angle the auto-orbit swings through. We then bisect for the smallest
 * distance at which every point on that cylinder's rim still projects inside
 * the frustum. The obvious closed form is an orthographic estimate, and under
 * perspective the near edge projects much lower than that estimate predicts,
 * which crops the front of the city.
 *
 * Both fields of view are checked: on a portrait window the horizontal one
 * binds, and ignoring that is another way cities end up cropped.
 */
export function requiredDistance(box, aspect, fovDeg = FOV, margin = MARGIN, elevation = ELEVATION) {
  const s = boxSize(box);
  const radius = 0.5 * Math.hypot(s.x, s.z);
  const halfHeight = s.y / 2;
  if (radius <= 0 && halfHeight <= 0) return MIN_FRAME_DISTANCE;

  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const tanV = Math.tan(vFov / 2) / margin;
  const tanH = Math.tan(hFov / 2) / margin;

  const rim = [];
  const SAMPLES = 32;
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const x = radius * Math.cos(t);
    const z = radius * Math.sin(t);
    rim.push([x, halfHeight, z], [x, -halfHeight, z]);
  }

  // The camera sits at `elevation` above the origin but aims along the
  // shallower VIEW_PITCH, so the city occupies the lower part of the frame.
  const cosE = Math.cos(elevation);
  const sinE = Math.sin(elevation);
  const pitch = Math.max(elevation - SKY_TILT, 0.01);
  const fwd = [-Math.cos(pitch), -Math.sin(pitch), 0];
  const right = [0, 0, -1];
  const up = [-Math.sin(pitch), Math.cos(pitch), 0];

  const fits = (d) => {
    const cx = cosE * d;
    const cy = sinE * d;
    for (const p of rim) {
      const vx = p[0] - cx;
      const vy = p[1] - cy;
      const vz = p[2];
      const zc = vx * fwd[0] + vy * fwd[1] + vz * fwd[2];
      if (zc <= 0) return false;
      const xc = vx * right[0] + vy * right[1] + vz * right[2];
      const yc = vx * up[0] + vy * up[1] + vz * up[2];
      if (Math.abs(xc) > zc * tanH || Math.abs(yc) > zc * tanV) return false;
    }
    return true;
  };

  let hi = Math.max((Math.hypot(radius, halfHeight) * margin) / Math.sin(Math.min(vFov, hFov) / 2), 1);
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

  // Lift the aim so the look direction runs at VIEW_PITCH rather than straight
  // at the centre. Derived from the geometry, not tuned by eye:
  //   tan(pitch) = (camera height above centre - lift) / horizontal distance
  const lift = Math.sin(ELEVATION) * distance - Math.tan(VIEW_PITCH) * horizontal * distance;

  return { distance, position, target: { x: centre.x, y: centre.y + lift, z: centre.z } };
}

/* ---------------------------------------------------------------- haze -- */

/**
 * How thick the veil over the city itself should be — see hazeDensityFor.
 *
 * This is the constant that is actually chosen. The density is derived from it
 * per city, because the density that looks right depends on how far back the
 * camera had to stand, and that is a consequence of the repository's size
 * rather than a decision anybody made.
 */
export const HAZE_AT_SUBJECT = 0.15;

/** Solved once from HAZE_AT_SUBJECT: density = HAZE_K / framing distance. */
export const HAZE_K = Math.sqrt(-Math.log(1 - HAZE_AT_SUBJECT));

/**
 * Bounds on the result. Below the floor there is no atmosphere at all and the
 * horizon has a hard edge; above the ceiling a small city is looking through
 * soup.
 */
export const HAZE_DENSITY_MIN = 0.0004;
export const HAZE_DENSITY_MAX = 0.0025;

/**
 * Fog density for a camera standing `frameDistance` from the city.
 *
 * Solves 1 - exp(-(density * d)^2) = HAZE_AT_SUBJECT, so the veil over the
 * subject is the same for every repository and the horizon still washes out
 * because it is still far away. A fixed density instead puts a 15% veil on a
 * city framed from 220 units and a 63% one on a city framed from 560 — the
 * difference between atmosphere and a pink screen.
 *
 * Lives here rather than in world.js so it can be checked without a renderer,
 * for the same reason the rest of this module does.
 */
export function hazeDensityFor(frameDistance) {
  const d = Math.max(Number(frameDistance) || 0, 1);
  return Math.min(HAZE_DENSITY_MAX, Math.max(HAZE_DENSITY_MIN, HAZE_K / d));
}

/** The share of the subject hidden by haze at a given density and distance. */
export function veilAt(density, distance) {
  return 1 - Math.exp(-((density * distance) ** 2));
}
