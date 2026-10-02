/**
 * world.js — everything around the data city: sky, sun, river, land, roads,
 * traffic, streetlights, fog, and the filler skyline on the horizon.
 *
 * The sun vector is computed once here and handed to everything that needs to
 * agree about where the sun is — the sky shader, the directional light, and the
 * water's specular highlight. If those three disagree the scene reads as wrong
 * even when nobody can say why, so there is exactly one of them.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { makeWaterNormalsFallback, makeFacade, WINDOW_TILE_UNITS } from './textures.js';
import { mulberry32 } from './random.js';
import { collapseGaps, fillerReach, lampSpots } from './streets.js';
import {
  FOOTPRINT, CHANNEL_HALF, boxSize, boxCenter,
  HAZE_AT_SUBJECT, HAZE_K, hazeDensityFor, MIN_FRAME_DISTANCE,
  SUN_ELEVATION_DEG, SUN_AZIMUTH_DEG, sunDirection,
} from './layout.js';

/* ----------------------------------------------------------------- sun -- */

export { SUN_ELEVATION_DEG, SUN_AZIMUTH_DEG };

/**
 * The one true sun direction, as a THREE.Vector3.
 *
 * The angles and the arithmetic live in layout.js so they can be checked
 * without a renderer; this only puts the result in the type three.js wants.
 */
export function sunVector() {
  const { x, y, z } = sunDirection();
  return new THREE.Vector3(x, y, z);
}

/* --------------------------------------------------------------- world -- */

const LAND_MARGIN = 70;
const ROAD_Y = 0.02;
const ROAD_LINE_Y = 0.03;
const LAMP_SPACING = 25;
const EMBANKMENT_HEIGHT = 1.6;

const TRAFFIC_SPEED = 3;          // units per second
const TRAFFIC_SPACING = 18;
const TRAFFIC_MAX = 420;

const FILLER_TARGET = 3000;

/**
 * Fog matched to what the sky actually renders at the horizon at this sun
 * angle. Fog darker than the horizon makes distant geometry stand out against
 * the sky instead of dissolving into it, which is the opposite of the job.
 */
export const FOG_COLOR = 0xd8a8b8;

/**
 * Haze. The maths lives in layout.js so it can be verified without a renderer;
 * see hazeDensityFor there for why the density is derived per city rather than
 * chosen. Re-exported here because this is the module that owns the fog.
 */
export { HAZE_AT_SUBJECT, HAZE_K };

export const FOG_DENSITY = hazeDensityFor(MIN_FRAME_DISTANCE);

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sun = sunVector();

    scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

    this._buildSky();
    this._buildLights();
    this._buildWater();

    this.ground = new THREE.Group();
    scene.add(this.ground);

    this.lamps = null;
    this.filler = null;
    this.traffic = null;
    this._lanes = [];
    this._materials = [];
  }

  /* ----------------------------------------------------------- pieces -- */

  _buildSky() {
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);

    const u = this.sky.material.uniforms;
    u.turbidity.value = 8;
    u.rayleigh.value = 2.5;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.85;
    u.sunPosition.value.copy(this.sun);

    this.scene.add(this.sky);
  }

  _buildLights() {
    // Warm, low and strong: two degrees up, the sun is doing all the shaping,
    // so the fill has to stay well under it.
    this.sunLight = new THREE.DirectionalLight(0xffa06a, 3);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0006;
    this.sunLight.shadow.normalBias = 0.6;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.hemi = new THREE.HemisphereLight(0xffb088, 0x1a1428, 0.6);
    this.scene.add(this.hemi);
  }

  _buildWater() {
    this.water = new Water(new THREE.PlaneGeometry(10000, 10000), {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: makeWaterNormalsFallback(),
      sunDirection: this.sun.clone(),
      sunColor: 0xffa95c,
      waterColor: 0x0a1520,
      distortionScale: 2.5,
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
   * Rebuild the land, streets and horizon for a city footprint.
   *
   * @param {object} box       city bounds
   * @param {object} plan      the layout() result: districts, banks, channel
   */
  rebuild(box, plan) {
    this._clearGround();
    if (!box || !plan) return;

    const size = boxSize(box);
    const centre = boxCenter(box);

    // The land has to reach at least as far as the filler, or the horizon
    // skyline ends up standing in open water.
    const reach = fillerReach(size);

    // Two banks with the river running between them. The land is not one slab
    // with a hole cut in it — each bank is its own plane, so the channel is
    // simply the gap left between them.
    const landWidth = reach * 2.4;
    for (const bank of plan.banks) {
      const inner = bank.bank === 0 ? -CHANNEL_HALF : CHANNEL_HALF;
      const outer = bank.bank === 0 ? -(reach * 1.2) : reach * 1.2;
      this._addLand(centre.x, landWidth, inner, outer);
      this._addEmbankment(centre.x, landWidth, inner);
    }

    this._buildRoads(plan, box);
    this._buildFiller(plan, box);
    this.fitShadowCamera(box);
  }

  _addLand(cx, width, innerZ, outerZ) {
    const depth = Math.abs(outerZ - innerZ);
    // The albedo is lighter than it looks like it should be: a sun two degrees
    // above the horizon delivers almost nothing to a flat surface, so anything
    // genuinely dark renders as a hole in the sea.
    const material = new THREE.MeshStandardMaterial({
      color: 0x232732, roughness: 0.95, metalness: 0.0,
    });
    this._materials.push(material);

    const land = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
    land.rotation.x = -Math.PI / 2;
    land.position.set(cx, 0, (innerZ + outerZ) / 2);
    land.receiveShadow = true;
    this.ground.add(land);
  }

  /** A lip along the waterline, so the bank has an edge instead of a seam. */
  _addEmbankment(cx, width, innerZ) {
    const material = new THREE.MeshStandardMaterial({
      color: 0x1a1d25, roughness: 0.9, metalness: 0.05,
    });
    this._materials.push(material);

    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, EMBANKMENT_HEIGHT, 2.5), material);
    wall.position.set(cx, EMBANKMENT_HEIGHT / 2 - 0.6, innerZ + Math.sign(innerZ) * 1.25);
    wall.castShadow = true;
    wall.receiveShadow = true;
    this.ground.add(wall);
  }

  /**
   * The padding between districts is already empty ground — surfacing it as
   * road is what turns a scatter of blocks into blocks separated by streets.
   * District rectangles come from the layout, so this stays correct without the
   * layout code having to know that roads exist.
   */
  _buildRoads(plan, box) {
    const surface = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.9, metalness: 0.0 });
    const paint = new THREE.MeshStandardMaterial({
      color: 0x4a4535, roughness: 0.8, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this._materials.push(surface, paint);

    const lamps = [];
    this._lanes = [];

    for (const bank of plan.banks) {
      const districts = plan.districts.filter((d) => d.bank === bank.bank && d.x0 !== undefined);
      if (!districts.length) continue;

      const x0 = Math.min(...districts.map((d) => d.x0)) - 6;
      const x1 = Math.max(...districts.map((d) => d.x1)) + 6;
      const z0 = Math.min(...districts.map((d) => d.z0)) - 6;
      const z1 = Math.max(...districts.map((d) => d.z1)) + 6;

      const gapsX = collapseGaps(districts.map((d) => [d.x0, d.x1]));
      const gapsZ = collapseGaps(districts.map((d) => [d.z0, d.z1]));

      // A boulevard along the waterfront, plus the streets between districts.
      const waterfront = bank.bank === 0 ? [-CHANNEL_HALF - 8, -CHANNEL_HALF - 1] : [CHANNEL_HALF + 1, CHANNEL_HALF + 8];
      gapsZ.push(waterfront);

      for (const [a, b] of gapsX) {
        this._addRoad(surface, paint, (a + b) / 2, (z0 + z1) / 2, b - a, z1 - z0, false);
        this._lanes.push({ axis: 'z', fixed: (a + b) / 2, from: z0, to: z1, width: b - a });
        lamps.push(...lampSpots(z0, z1, LAMP_SPACING, (t) => [[a + 1.2, t], [b - 1.2, t]]));
      }
      for (const [a, b] of gapsZ) {
        this._addRoad(surface, paint, (x0 + x1) / 2, (a + b) / 2, x1 - x0, b - a, true);
        this._lanes.push({ axis: 'x', fixed: (a + b) / 2, from: x0, to: x1, width: b - a });
        lamps.push(...lampSpots(x0, x1, LAMP_SPACING, (t) => [[t, a + 1.2], [t, b - 1.2]]));
      }
    }

    this._addLamps(lamps);
    this._addTraffic();
  }

  _addRoad(surface, paint, cx, cz, w, d, horizontal) {
    const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d), surface);
    road.rotation.x = -Math.PI / 2;
    road.position.set(cx, ROAD_Y, cz);
    road.receiveShadow = true;
    this.ground.add(road);

    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(horizontal ? w : 0.3, horizontal ? 0.3 : d),
      paint
    );
    line.rotation.x = -Math.PI / 2;
    line.position.set(cx, ROAD_LINE_Y, cz);
    this.ground.add(line);
  }

  /**
   * Streetlights are the cheapest thing that reads as a lit city: emissive
   * spheres bright enough to clear the bloom threshold. One instanced mesh, so
   * a few hundred cost a single draw call and no lighting.
   */
  _addLamps(spots) {
    if (!spots.length) return;

    const material = new THREE.MeshStandardMaterial({
      color: 0x2a1e12, emissive: 0xffcc88, emissiveIntensity: 2.2,
      roughness: 1, metalness: 0, fog: true,
    });
    this._materials.push(material);

    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.4, 8, 6), material, spots.length);
    const m = new THREE.Matrix4();
    spots.forEach(([x, z], i) => {
      m.makeTranslation(x, 3.2, z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    this.ground.add(mesh);
    this.lamps = mesh;
  }

  /**
   * Headlights and tail lights running the streets.
   *
   * Nothing about traffic carries data — it exists because a still city reads
   * as a model and a moving one reads as a place. Two instanced meshes, warm
   * one way and red the other, wrapping at the ends of each lane.
   */
  _addTraffic() {
    if (!this._lanes.length) return;

    const slots = [];
    for (const lane of this._lanes) {
      const span = lane.to - lane.from;
      if (span <= TRAFFIC_SPACING) continue;
      const offset = Math.min(lane.width, 8) * 0.22;
      const count = Math.floor(span / TRAFFIC_SPACING);
      for (let i = 0; i < count; i++) {
        slots.push({ lane, t: lane.from + i * TRAFFIC_SPACING, dir: 1, offset: -offset });
        slots.push({ lane, t: lane.from + i * TRAFFIC_SPACING + TRAFFIC_SPACING / 2, dir: -1, offset });
      }
    }

    // Thin the traffic evenly rather than truncating, so a big city does not
    // end up with cars on one side only.
    this._cars = slots.length > TRAFFIC_MAX
      ? slots.filter((_, i) => i % Math.ceil(slots.length / TRAFFIC_MAX) === 0)
      : slots;
    if (!this._cars.length) return;

    const geometry = new THREE.BoxGeometry(0.9, 0.5, 1.8);
    const make = (hex, intensity) => {
      const material = new THREE.MeshStandardMaterial({
        color: 0x120c08, emissive: hex, emissiveIntensity: intensity,
        roughness: 1, metalness: 0, fog: true,
      });
      this._materials.push(material);
      const mesh = new THREE.InstancedMesh(geometry, material, this._cars.length);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.ground.add(mesh);
      return mesh;
    };

    this.traffic = {
      geometry,
      head: make(0xfff4d0, 2.4),
      tail: make(0xff3b30, 2.0),
      matrix: new THREE.Matrix4(),
    };
    this._advanceTraffic(0);
  }

  _advanceTraffic(dt) {
    const t = this.traffic;
    if (!t) return;

    let heads = 0;
    let tails = 0;

    for (const car of this._cars) {
      const span = car.lane.to - car.lane.from;
      car.t += car.dir * TRAFFIC_SPEED * dt;
      if (car.t > car.lane.to) car.t -= span;
      else if (car.t < car.lane.from) car.t += span;

      const alongX = car.lane.axis === 'x';
      const x = alongX ? car.t : car.lane.fixed + car.offset;
      const z = alongX ? car.lane.fixed + car.offset : car.t;

      t.matrix.makeRotationY(alongX ? Math.PI / 2 : 0);
      t.matrix.setPosition(x, 0.45, z);

      if (car.dir > 0) t.head.setMatrixAt(heads++, t.matrix);
      else t.tail.setMatrixAt(tails++, t.matrix);
    }

    t.head.count = heads;
    t.tail.count = tails;
    t.head.instanceMatrix.needsUpdate = true;
    t.tail.instanceMatrix.needsUpdate = true;
  }

  /**
   * A filler skyline on the horizon.
   *
   * These buildings carry NO data — not one of them is a file. They exist
   * because a real skyline does not stop at the edge of the interesting part,
   * and a data city floating alone on an empty plane reads as a diagram. They
   * are placed outside the data city and across the far bank, weighted heavily
   * towards short, and the haze eats most of them. The data city stays the
   * foreground subject, and this is documented in the README so nobody reads
   * meaning into the horizon.
   *
   * One InstancedMesh, so three thousand of them cost one draw call.
   */
  _buildFiller(plan, box) {
    const rand = mulberry32(0xc17ded);
    const size = boxSize(box);
    const centre = boxCenter(box);

    const reach = fillerReach(size);
    // Keep the filler off the data city itself, but only just. Push it further
    // and the repository sits in an empty ring with scenery on the horizon;
    // the reference photographs have the subject embedded in continuous city,
    // and the data city is picked out by its streetlights, not by isolation.
    const moat = Math.max(size.x, size.z) / 2 + 55;

    const matrices = [];
    const uvScales = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();

    let guard = 0;
    while (matrices.length < FILLER_TARGET && guard++ < FILLER_TARGET * 12) {
      const x = centre.x + (rand() * 2 - 1) * reach;
      const z = centre.z + (rand() * 2 - 1) * reach;

      // Never in the river, never within the moat around the data city.
      if (Math.abs(z) < CHANNEL_HALF + 6) continue;
      if (Math.hypot(x - centre.x, z - centre.z) < moat) continue;

      // Weighted towards short: a cubed random gives a dense low-rise mass with
      // a scattering of towers, which is what a real skyline looks like.
      const r = rand();
      const height = 5 + Math.pow(r, 3) * 80;
      // Proportioned like the data city's own buildings. Filler that is much
      // chunkier than the subject makes the repository look like a model
      // village parked next to a real skyline.
      const width = FOOTPRINT * (0.9 + rand() * 0.8) + height * 0.02;

      pos.set(x, 0, z);
      scale.set(width, height, width * (0.7 + rand() * 0.6));
      q.setFromAxisAngle(UP, rand() * Math.PI);
      m.compose(pos, q, scale);
      matrices.push(m.clone());
      uvScales.push(width / WINDOW_TILE_UNITS, height / WINDOW_TILE_UNITS);
    }

    if (!matrices.length) return;

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);
    geometry.setAttribute(
      'aUvScale',
      new THREE.InstancedBufferAttribute(new Float32Array(uvScales), 2)
    );

    // The horizon uses the same facades as the data city, so the two read as
    // one city rather than a model parked in front of a backdrop.
    const facade = makeFacade('concrete', 7);
    const material = new THREE.MeshStandardMaterial({
      color: 0x4c525f,
      map: facade.map,
      roughness: facade.roughness,
      metalness: facade.metalness,
      emissive: new THREE.Color('#ffd9a0'),
      emissiveMap: facade.emissiveMap,
      emissiveIntensity: 0.9,
    });

    // Per-instance facade scaling, on both the colour and the emissive map.
    // Without it every filler building stretches one tile over its whole face,
    // so a tall one gets tall windows and the horizon reads as striped boxes.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aUvScale;\nvarying vec2 vUvScale;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvUvScale = aUvScale;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vUvScale;')
        .replace(
          '#include <map_fragment>',
          'vec4 gcTexel = texture2D(map, fract(vMapUv * vUvScale));\n' +
          '\tdiffuseColor *= gcTexel;'
        )
        .replace(
          '#include <emissivemap_fragment>',
          'totalEmissiveRadiance *= texture2D(emissiveMap, fract(vEmissiveMapUv * vUvScale)).rgb;'
        );
    };
    material.customProgramCacheKey = () => 'gitcity-filler';
    this._materials.push(material);

    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((mat, i) => mesh.setMatrixAt(i, mat));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    // Deliberately no shadows: the filler is scenery, and shadow-casting three
    // thousand boxes would blow the shadow budget on buildings nobody reads.
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    this.ground.add(mesh);
    this.filler = mesh;
    this.fillerCount = matrices.length;
  }

  _clearGround() {
    for (const child of [...this.ground.children]) {
      this.ground.remove(child);
      if (child.geometry) child.geometry.dispose();
    }
    for (const m of this._materials) m.dispose();
    this._materials = [];
    this.lamps = null;
    this.filler = null;
    this.fillerCount = 0;
    this.traffic = null;
    this._cars = [];
    this._lanes = [];
  }

  /* ------------------------------------------------------------ shadow -- */

  /**
   * Fit the shadow camera to the data city — not the filler.
   *
   * At two degrees of elevation a seventy-unit tower throws a shadow two
   * kilometres long, so a default frustum misses the shadows entirely and a
   * hand-guessed one either clips them or spends the whole shadow map on empty
   * water. Transforming the eight corners of the city's bounding box into the
   * light's own space and taking the extents gets it right at any sun angle.
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

    const pad = LAND_MARGIN;
    for (let i = 0; i < 8; i++) {
      corner.set(
        i & 1 ? box.max.x + pad : box.min.x - pad,
        i & 2 ? box.max.y : 0,
        i & 4 ? box.max.z + pad : box.min.z - pad
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

  /**
   * Set the haze for a given camera standoff. See HAZE_AT_SUBJECT: the veil
   * over the city is what stays constant, not the density.
   */
  setHaze(frameDistance) {
    this.scene.fog.density = hazeDensityFor(frameDistance);
  }

  update(deltaSeconds) {
    this.water.material.uniforms.time.value += deltaSeconds;
    this._advanceTraffic(deltaSeconds);
  }
}

/* --------------------------------------------------------------- utils -- */

const UP = new THREE.Vector3(0, 1, 0);

