/**
 * world.js — everything around the buildings: sky, sun, water, island, roads,
 * streetlights and fog.
 *
 * The sun vector is computed once here and handed to everything that needs to
 * agree about where the sun is — the sky shader, the directional light, and the
 * water's specular highlight. If those three disagree the scene reads as wrong
 * even when nobody can say why, so there is exactly one of them.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { makeWaterNormalsFallback } from './textures.js';
import { FOOTPRINT, boxSize, boxCenter } from './layout.js';

/* ----------------------------------------------------------------- sun -- */

export const SUN_ELEVATION_DEG = 3;    // low sunset sun
export const SUN_AZIMUTH_DEG = 175;

/** The one true sun direction, as a unit vector. */
export function sunVector() {
  const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION_DEG);
  const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

/* --------------------------------------------------------------- world -- */

const ISLAND_MARGIN = 60;
const ROAD_Y = 0.02;
const ROAD_LINE_Y = 0.03;
const LAMP_SPACING = 25;

/**
 * Fog has to match what the sky actually renders at the horizon, which is a
 * light warm grey at this sun angle — not the dark tone the palette suggests.
 * Fog darker than the horizon makes distant geometry stand out against the sky
 * instead of dissolving into it, which is what left the island reading as a
 * black slab dropped on the water.
 *
 * Sampled from a render rather than picked by eye.
 */
export const FOG_COLOR = 0x8a807c;
/**
 * Eased off 0.0012. The camera has to stand ~480 units back to frame a city
 * this wide, and at that range 0.0012 puts a 30% grey veil over the subject
 * itself — every building washed to the same flat tone. 0.0008 still dissolves
 * the island's edge and the far water into the sky, which is what the fog is
 * for, while leaving the city its contrast.
 */
export const FOG_DENSITY = 0.0008;

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sun = sunVector();

    scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

    this._buildSky();
    this._buildLights();
    this._buildWater();

    // Rebuilt whenever a new dataset changes the city's footprint.
    this.island = null;
    this.roads = new THREE.Group();
    this.lamps = null;
    scene.add(this.roads);
  }

  /* ----------------------------------------------------------- pieces -- */

  _buildSky() {
    this.sky = new Sky();
    this.sky.scale.setScalar(45000);

    const u = this.sky.material.uniforms;
    u.turbidity.value = 10;
    u.rayleigh.value = 3;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(this.sun);

    this.scene.add(this.sky);
  }

  _buildLights() {
    // Warm, low and strong: at 3 degrees of elevation the sun is doing all the
    // shaping, so the fill has to stay well under it.
    this.sunLight = new THREE.DirectionalLight(0xffb27a, 3.5);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0006;
    this.sunLight.shadow.normalBias = 0.6;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.hemi = new THREE.HemisphereLight(0xff9d5c, 0x1a1a2e, 0.5);
    this.scene.add(this.hemi);
  }

  _buildWater() {
    const geometry = new THREE.PlaneGeometry(10000, 10000);
    this.water = new Water(geometry, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: makeWaterNormalsFallback(),
      sunDirection: this.sun.clone(),
      sunColor: 0xffa95c,
      waterColor: 0x07131f,
      distortionScale: 3.7,
      fog: true,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -0.5;
    this.scene.add(this.water);

    // Swap in the real normal map once it arrives; the procedural one keeps the
    // water looking right in the meantime rather than flashing untextured.
    new THREE.TextureLoader().load(
      'assets/waternormals.jpg',
      (texture) => {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        this.water.material.uniforms.normalSampler.value = texture;
      },
      undefined,
      () => console.warn('assets/waternormals.jpg failed to load — using the procedural fallback.')
    );
  }

  /* ------------------------------------------------------------ layout -- */

  /**
   * Rebuild the island, street grid and streetlights for a city footprint.
   *
   * @param {object} box       city bounds
   * @param {Array}  districts district records from layout()
   * @param {Map}    positions path -> {x, z}
   */
  rebuild(box, districts, positions) {
    this._clearGround();
    if (!box) return;

    const size = boxSize(box);
    const centre = boxCenter(box);
    const width = size.x + ISLAND_MARGIN * 2;
    const depth = size.z + ISLAND_MARGIN * 2;

    // Island: the city needs ground to sit on, or the buildings float on water.
    // The albedo is lighter than it looks like it should be: a sun three
    // degrees above the horizon delivers about 5% of its light to a flat
    // surface, so anything genuinely dark renders as a hole in the sea.
    const island = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({ color: 0x232732, roughness: 0.95, metalness: 0.0 })
    );
    island.rotation.x = -Math.PI / 2;
    island.position.set(centre.x, 0, centre.z);
    island.receiveShadow = true;
    this.scene.add(island);
    this.island = island;

    this._buildRoads(districts, positions, box);
    this.fitShadowCamera(box);
  }

  /**
   * The padding between districts is already empty ground — surfacing it as
   * road is what turns a scatter of blocks into blocks separated by streets.
   *
   * District rectangles are derived from the building positions rather than
   * from the layout internals, so this stays correct without the layout code
   * having to know that roads exist.
   */
  _buildRoads(districts, positions, box) {
    const half = FOOTPRINT / 2;
    const rects = [];
    for (const d of districts) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of d.files) {
        const pos = positions.get(p);
        if (!pos) continue;
        x0 = Math.min(x0, pos.x - half); x1 = Math.max(x1, pos.x + half);
        z0 = Math.min(z0, pos.z - half); z1 = Math.max(z1, pos.z + half);
      }
      if (x0 <= x1) rects.push({ x0, x1, z0, z1 });
    }
    if (!rects.length) return;

    const gapsX = collapseGaps(rects.map((r) => [r.x0, r.x1]));
    const gapsZ = collapseGaps(rects.map((r) => [r.z0, r.z1]));

    const bx0 = box.min.x - ISLAND_MARGIN / 2;
    const bx1 = box.max.x + ISLAND_MARGIN / 2;
    const bz0 = box.min.z - ISLAND_MARGIN / 2;
    const bz1 = box.max.z + ISLAND_MARGIN / 2;

    const surface = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.9, metalness: 0.0 });
    const paint = new THREE.MeshStandardMaterial({ color: 0x4a4535, roughness: 0.8, metalness: 0.0 });
    this._roadMaterials = [surface, paint];

    const lampSpots = [];

    for (const [a, b] of gapsX) {
      this._addRoad(surface, paint, (a + b) / 2, (bz0 + bz1) / 2, b - a, bz1 - bz0, false);
      collectLamps(lampSpots, bz0, bz1, LAMP_SPACING, (t) => [[a + 1.2, t], [b - 1.2, t]]);
    }
    for (const [a, b] of gapsZ) {
      this._addRoad(surface, paint, (bx0 + bx1) / 2, (a + b) / 2, bx1 - bx0, b - a, true);
      collectLamps(lampSpots, bx0, bx1, LAMP_SPACING, (t) => [[t, a + 1.2], [t, b - 1.2]]);
    }

    this._addLamps(lampSpots);
  }

  _addRoad(surface, paint, cx, cz, w, d, horizontal) {
    const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d), surface);
    road.rotation.x = -Math.PI / 2;
    road.position.set(cx, ROAD_Y, cz);
    road.receiveShadow = true;
    this.roads.add(road);

    // A thin dashed-looking centre line: enough to read as a road at distance.
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(horizontal ? w : 0.35, horizontal ? 0.35 : d),
      paint
    );
    line.rotation.x = -Math.PI / 2;
    line.position.set(cx, ROAD_LINE_Y, cz);
    this.roads.add(line);
  }

  /**
   * Streetlights are the cheapest possible thing that reads as a lit city:
   * emissive spheres bright enough to clear the bloom threshold. One instanced
   * mesh, so a few hundred of them cost a single draw call and no lighting.
   */
  _addLamps(spots) {
    if (!spots.length) return;

    const geometry = new THREE.SphereGeometry(0.45, 8, 6);
    const material = new THREE.MeshStandardMaterial({
      color: 0x2a1e12,
      emissive: 0xffcc88,
      emissiveIntensity: 2.2,
      roughness: 1,
      metalness: 0,
      fog: true,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    const m = new THREE.Matrix4();
    spots.forEach(([x, z], i) => {
      m.makeTranslation(x, 3.2, z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;

    this.roads.add(mesh);
    this.lamps = mesh;
  }

  _clearGround() {
    if (this.island) {
      this.scene.remove(this.island);
      this.island.geometry.dispose();
      this.island.material.dispose();
      this.island = null;
    }
    for (const child of [...this.roads.children]) {
      this.roads.remove(child);
      child.geometry.dispose();
    }
    for (const m of this._roadMaterials || []) m.dispose();
    this._roadMaterials = null;
    if (this.lamps) {
      this.lamps.material.dispose();
      this.lamps = null;
    }
  }

  /* ------------------------------------------------------------ shadow -- */

  /**
   * Fit the shadow camera to the city.
   *
   * At three degrees of elevation a 40-unit tower throws a shadow over 700
   * units long, so a default frustum misses the shadows entirely and a
   * hand-guessed one either clips them or wastes most of the shadow map on
   * empty water. Transforming the eight corners of the city's bounding box into
   * the light's own space and taking the extents gets it exactly right at any
   * sun angle.
   */
  fitShadowCamera(box) {
    if (!box) return;

    const size = boxSize(box);
    const c = boxCenter(box);
    const centre = new THREE.Vector3(c.x, c.y, c.z);
    const reach = Math.max(size.x, size.z, 1);

    this.sunLight.position.copy(centre).addScaledVector(this.sun, reach * 2);
    this.sunLight.target.position.copy(centre);
    this.sunLight.target.updateMatrixWorld();

    const cam = this.sunLight.shadow.camera;
    cam.position.copy(this.sunLight.position);
    cam.up.set(0, 1, 0);
    cam.lookAt(centre);
    cam.updateMatrixWorld(true);

    const toLight = new THREE.Matrix4().copy(cam.matrixWorld).invert();
    const corner = new THREE.Vector3();
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    // Include the ground the shadows land on, not just the buildings.
    const pad = ISLAND_MARGIN;
    for (let i = 0; i < 8; i++) {
      corner.set(
        (i & 1 ? box.max.x + pad : box.min.x - pad),
        (i & 2 ? box.max.y : 0),
        (i & 4 ? box.max.z + pad : box.min.z - pad)
      ).applyMatrix4(toLight);
      minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
      minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
      minZ = Math.min(minZ, corner.z); maxZ = Math.max(maxZ, corner.z);
    }

    // The camera looks down its own -z, so near/far come from negated z.
    cam.left = minX; cam.right = maxX;
    cam.bottom = minY; cam.top = maxY;
    cam.near = Math.max(0.5, -maxZ - reach);
    cam.far = -minZ + reach;
    cam.updateProjectionMatrix();

    this.renderer.shadowMap.needsUpdate = true;
  }

  /* ------------------------------------------------------------- frame -- */

  update(deltaSeconds) {
    this.water.material.uniforms.time.value += deltaSeconds;
  }
}

/* --------------------------------------------------------------- utils -- */

/**
 * Given a set of 1D intervals, return the gaps between the merged runs.
 * Used to turn "where the districts are" into "where the roads go".
 */
function collapseGaps(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 0.001) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const gaps = [];
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1][1];
    const b = merged[i][0];
    if (b - a > 1) gaps.push([a, b]);
  }
  return gaps;
}

function collectLamps(out, from, to, spacing, place) {
  for (let t = from + spacing / 2; t < to; t += spacing) {
    for (const spot of place(t)) out.push(spot);
  }
}
