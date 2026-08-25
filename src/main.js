import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  surfaceHeight,
  makeTerrain,
  makeWaterIndex,
  footprintCentroid,
  footprintWaterOverlap,
  footprintLandBaseY,
  pointInPoly,
  hash01,
} from './geo.js';
import {
  createCityMaterials,
  buildingFamily,
  applyFacadeUVs,
  tintGeometry,
  applyXZUvs,
} from './textures.js';
import {
  buildArticulatedBuilding,
  buildRoofscape,
  createRoofscapeMaterial,
  detailTier,
  footprintSeed,
  trimTint,
} from './architecture.js';
import { buildBridges } from './bridges.js';
import { buildLandmarkMeshes, isLandmarkMeshBuilding, INCLINES } from './landmarks.js';
import { buildStreetLights, buildRooftopDetails, buildStreetLightGlows } from './details.js';
import { createSkyDome, createEnvironmentMap } from './sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const canvas = document.getElementById('c');
const layersEl = document.getElementById('layers');
const loaderEl = document.getElementById('loader');
const navEl = document.getElementById('nav');

const DAY_MODE = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(DAY_MODE ? 0x8ec8f0 : 0x05070c);
// Real Allegheny valley haze is a warm-grey blue, not the near-white the old
// value read as once the ambient came down.
scene.fog = new THREE.FogExp2(DAY_MODE ? 0x9dbcd8 : 0x05070c, DAY_MODE ? 0.00009 : 0.00026);

const camera = new THREE.PerspectiveCamera(45, 1, 2, 25000);
camera.position.set(900, 650, 1100);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = DAY_MODE ? 1.0 : 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'label-layer';
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.inset = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
labelRenderer.domElement.style.zIndex = '1';
document.getElementById('app').appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 80;
controls.maxDistance = 6000;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(0, 40, 0);

/**
 * Direct sun against sky ambient.
 *
 * Clear-sky daylight is roughly five parts direct sun to one part skylight on a
 * surface facing the sun. The previous balance was almost one to one - hemi 0.95
 * plus environment 0.75 against a 1.65 sun - so an unlit wall came out nearly as
 * bright as a lit one. With no shading gradient the massing stops reading and
 * every building flattens into a silhouette, which is most of why the city
 * looked hazy and washed out rather than sunlit.
 */
const hemi = new THREE.HemisphereLight(
  DAY_MODE ? 0xcfe2f7 : 0xb8c4d8,
  DAY_MODE ? 0x6a7052 : 0x1a241c,
  DAY_MODE ? 0.4 : 0.5,
);
scene.add(hemi);

const SUN_DIR = new THREE.Vector3(DAY_MODE ? 0.55 : 0.5, DAY_MODE ? 0.72 : 0.74, DAY_MODE ? 0.42 : 0.22)
  .normalize();
const SHADOW_HALF = 1500;

const sun = new THREE.DirectionalLight(0xfff6e8, DAY_MODE ? 2.9 : 1.15);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 6500;
sun.shadow.camera.left = -SHADOW_HALF;
sun.shadow.camera.right = SHADOW_HALF;
sun.shadow.camera.top = SHADOW_HALF;
sun.shadow.camera.bottom = -SHADOW_HALF;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun);
scene.add(sun.target);

/**
 * The shadow frustum is 3 km across, against a 15 km scene, so it has to follow
 * the view or Oakland and the Strip get no shadows at all. The sun DIRECTION
 * stays fixed, so shadows do not swing as the camera moves.
 */
function aimSun(at) {
  sun.target.position.copy(at);
  sun.position.copy(at).addScaledVector(SUN_DIR, 2600);
}
aimSun(new THREE.Vector3(0, 0, 0));

/**
 * Skylight fill for the shadow side, kept deliberately low to the horizon.
 *
 * It used to sit at 38 degrees of elevation, opposite the usual camera, and that
 * is the worst possible place for it: looking down at any horizontal surface the
 * half-vector lands within a few degrees of straight up, so `dot(N,H)` hits 0.995
 * across the whole surface at once and the entire river sat at the peak of the
 * specular lobe. It measured ~1.7 in linear radiance, an order of magnitude over
 * the water beneath it. Dropping it to 9 degrees keeps what it is for - lifting
 * vertical walls out of shadow - and takes it off the mirror direction for
 * everything flat.
 *
 * `sun` must stay the FIRST directional light added: the water shader reads
 * `directionalLights[0]` for its glitter lobe, so adding another before it would
 * hand the river a second sun.
 */
const fill = new THREE.DirectionalLight(DAY_MODE ? 0xbcd2ea : 0x6a7a9a, DAY_MODE ? 0.16 : 0.32);
fill.position.set(-1140, 180, -700);
scene.add(fill);

const materials = createCityMaterials({ dayMode: DAY_MODE });
materials.envMap = createEnvironmentMap(renderer, { day: DAY_MODE });
scene.environment = materials.envMap;
scene.environmentIntensity = DAY_MODE ? 0.42 : 0.55;
scene.add(createSkyDome({ day: DAY_MODE }));

let composer;
function initComposer() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    DAY_MODE ? 0.12 : 0.42,
    DAY_MODE ? 0.35 : 0.55,
    DAY_MODE ? 0.92 : 0.72,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}

const roadLineMats = {
  0: new THREE.LineBasicMaterial({ color: 0x2e3440, transparent: true, opacity: 0.55 }),
  1: new THREE.LineBasicMaterial({ color: 0x4a5260, transparent: true, opacity: 0.7 }),
  2: new THREE.LineBasicMaterial({ color: 0x6a7384, transparent: true, opacity: 0.8 }),
};

const focusLight = new THREE.SpotLight(0xffffff, DAY_MODE ? 0 : 22, 2200, Math.PI / 5, 0.72, 1.15);
focusLight.position.set(0, 700, 0);
focusLight.target.position.set(0, 0, 0);
focusLight.castShadow = false;
scene.add(focusLight);
scene.add(focusLight.target);

const focusGlow = new THREE.Mesh(
  new THREE.CircleGeometry(420, 64),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.04,
    depthWrite: false,
  }),
);
focusGlow.rotation.x = -Math.PI / 2;
focusGlow.position.y = 0.6;
scene.add(focusGlow);

function traceRing(path, ring) {
  path.moveTo(ring[0][0], -ring[0][1]);
  for (let i = 1; i < ring.length - 1; i++) {
    path.lineTo(ring[i][0], -ring[i][1]);
  }
  path.closePath();
}

function footprintShape(footprint, holes = null) {
  const shape = new THREE.Shape();
  traceRing(shape, footprint);
  for (const hole of holes || []) {
    if (!hole || hole.length < 4) continue;
    const path = new THREE.Path();
    traceRing(path, hole);
    shape.holes.push(path);
  }
  return shape;
}

function extrudeBuilding(footprint, height, baseY) {
  const shape = footprintShape(footprint);
  const [cx, cz] = footprintCentroid(footprint);
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
  });
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, baseY, 0);
  return { geom, base: baseY, cx, cz };
}

function flatPolygon(footprint, y, yFn, holes = null) {
  const shape = footprintShape(footprint, holes);
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  let lift = y;
  if (yFn) {
    const [cx, cz] = footprintCentroid(footprint);
    lift = yFn(cx, cz) + y;
  }
  geom.translate(0, lift, 0);
  return geom;
}

/**
 * Ground tint from the real landform: flat ground reads as paved city fabric,
 * and the steep hillsides that ring the valleys read as the woods they are.
 */
/**
 * Vertex tints for the ground, which multiply an albedo map whose base sits near
 * 0.25 linear. The night-time set below leaves paved ground at roughly 0.024
 * albedo; asphalt in daylight is nearer 0.11, so the day set is scaled to land
 * on believable albedos (paved ~0.11, mown grass ~0.14, woods ~0.07) instead of
 * reading as tarmac at midnight.
 */
const GROUND_TINTS = {
  day: {
    bed: [0.2, 0.3, 0.34],
    bank: [0.68, 0.56, 0.4],
    paved: [0.4, 0.42, 0.46],
    forest: [0.2, 0.34, 0.18],
    grass: [0.36, 0.56, 0.28],
  },
  night: {
    bed: [0.035, 0.055, 0.07],
    bank: [0.14, 0.11, 0.07],
    paved: [0.098, 0.103, 0.118],
    forest: [0.055, 0.088, 0.048],
    grass: [0.085, 0.115, 0.062],
  },
};

/**
 * Coarse raster of how much of each cell is covered by building footprint.
 *
 * What separates downtown from Lawrenceville from the air is not the buildings,
 * it is the ground between them: the Golden Triangle is continuous paving, and
 * the neighbourhoods are treed heavily enough that the street grid barely shows
 * through the canopy. Slope alone cannot tell those apart - both are flat - so
 * tinting every flat cell as paving turned the whole valley floor into one grey
 * plane, which is most of why the North Shore read as an empty car park.
 *
 * 80 m cells: coarse enough to stay cheap over 7,500 footprints and a 15 km
 * extent, fine enough to resolve one city block.
 */
const DENSITY = { cell: 80, minX: -6000, minZ: -5600, w: 220, h: 160 };

function makeDensityIndex(buildings) {
  const { cell, minX, minZ, w, h } = DENSITY;
  const acc = new Float32Array(w * h);
  for (const b of buildings) {
    if (!b.f || b.f.length < 4) continue;
    const [cx, cz] = footprintCentroid(b.f);
    let area = 0;
    for (let i = 0; i < b.f.length - 1; i++) {
      area += b.f[i][0] * b.f[i + 1][1] - b.f[i + 1][0] * b.f[i][1];
    }
    const gx = Math.floor((cx - minX) / cell);
    const gz = Math.floor((cz - minZ) / cell);
    if (gx < 0 || gz < 0 || gx >= w || gz >= h) continue;
    acc[gz * w + gx] += Math.abs(area) * 0.5;
  }

  // One box pass, so a cell that happens to fall in a back alley still reads as
  // part of its block rather than as a hole in the paving.
  const blur = new Float32Array(w * h);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx;
          const sz = z + dz;
          if (sx < 0 || sz < 0 || sx >= w || sz >= h) continue;
          sum += acc[sz * w + sx];
          n++;
        }
      }
      blur[z * w + x] = sum / (n * cell * cell);
    }
  }
  return (x, z) => {
    const gx = Math.floor((x - minX) / cell);
    const gz = Math.floor((z - minZ) / cell);
    if (gx < 0 || gz < 0 || gx >= w || gz >= h) return 0;
    return blur[gz * w + gx];
  };
}

function smoothstep(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Coverage raster of the OSM woodland polygons, over the same extent as the
 * ground mesh.
 *
 * Woods are the one land cover that has to be baked into the terrain's own
 * vertex colours rather than drawn as a flat polygon on top: they sit on the
 * hillsides, and Pittsburgh's hillsides drop 100 m over 200 m of plan, so a flat
 * polygon at one height either floats off the slope or buries itself in it. The
 * raster follows the terrain for free.
 *
 * 24 m cells at 15 km by 11.2 km. That is finer than the 30 m ground mesh it
 * feeds, so the mesh is the limiting resolution, which is the right way round.
 */
const WOOD_RASTER = { cell: 24, minX: -6300, minZ: -6000, w: 640, h: 480 };

function makeWoodIndex(polys) {
  const { cell, minX, minZ, w, h } = WOOD_RASTER;
  const grid = new Uint8Array(w * h);
  const xs = [];
  for (const p of polys) {
    if (p.c !== 2 || !p.f || p.f.length < 4) continue;
    const ring = p.f;
    let minZr = Infinity;
    let maxZr = -Infinity;
    for (const [, z] of ring) {
      if (z < minZr) minZr = z;
      if (z > maxZr) maxZr = z;
    }
    const z0 = Math.max(0, Math.floor((minZr - minZ) / cell));
    const z1 = Math.min(h - 1, Math.ceil((maxZr - minZ) / cell));
    for (let gz = z0; gz <= z1; gz++) {
      const zc = minZ + (gz + 0.5) * cell;
      xs.length = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const [ax, az] = ring[i];
        const [bx, bz] = ring[i + 1];
        if (az === bz) continue;
        if (zc < Math.min(az, bz) || zc >= Math.max(az, bz)) continue;
        xs.push(ax + ((zc - az) / (bz - az)) * (bx - ax));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const gx0 = Math.max(0, Math.ceil((xs[k] - minX) / cell - 0.5));
        const gx1 = Math.min(w - 1, Math.floor((xs[k + 1] - minX) / cell - 0.5));
        for (let gx = gx0; gx <= gx1; gx++) grid[gz * w + gx] = 1;
      }
    }
  }
  return (x, z) => {
    const gx = Math.floor((x - minX) / cell);
    const gz = Math.floor((z - minZ) / cell);
    if (gx < 0 || gz < 0 || gx >= w || gz >= h) return 0;
    return grid[gz * w + gx];
  };
}

/**
 * Per-vertex variation for a mown-turf surface.
 *
 * A park polygon drawn in one flat colour reads as a green rug laid over the
 * terrain: the ground under it carries 30 m vertex-colour noise and the polygon
 * carries none, so the seam at its edge is the strongest line in the frame even
 * though the two surfaces are 45 cm apart. Giving the polygon its own variation
 * on a comparable scale puts the two on the same footing, and the edge then
 * reads as a mowing line rather than as a pasted decal.
 *
 * Two octaves: a broad one for the drift between a sunny and a shaded sward,
 * and a fine one for mower stripes and wear.
 */
function tintTurf(geom, base) {
  const pos = geom.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const broad = hash01(Math.floor(x / 34), Math.floor(z / 34)) - 0.5;
    const fine = hash01(Math.floor(x / 9) * 1.7, Math.floor(z / 9) * 1.3) - 0.5;
    const v = 1 + broad * 0.30 + fine * 0.14;
    // Drier grass is yellower as well as lighter, so the hue rides with the
    // value rather than wandering independently of it.
    c.setRGB(
      Math.min(1, base[0] * v * (1 + broad * 0.10)),
      Math.min(1, base[1] * v),
      Math.min(1, base[2] * v * (1 - broad * 0.14)),
    );
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geom;
}

function groundColor(x, y, z, slope, waterIndex, density, wooded, dayMode = true) {
  const tint = dayMode ? GROUND_TINTS.day : GROUND_TINTS.night;
  if (waterIndex.inside(x, z)) return tint.bed;
  const bank = waterIndex.bankStrength(x, z);
  if (bank > 0.15) return [tint.bank[0] + bank * 0.04, tint.bank[1], tint.bank[2]];

  const { paved, forest, grass } = tint;
  const dry = Math.min(1, Math.max(0, (y - 60) / 110));
  const green = [
    grass[0] * (1 - dry) + forest[0] * dry,
    grass[1] * (1 - dry) + forest[1] * dry,
    grass[2] * (1 - dry) + forest[2] * dry,
  ];
  // Mapped woodland wins outright. Failing that, steep ground is wooded whatever
  // is built on it - these are the hillsides nobody could develop - and ground
  // with buildings on it is paved however flat it is.
  const green01 = wooded(x, z)
    ? 1
    : Math.max(smoothstep(0.13, 0.34, slope), 1 - smoothstep(0.012, 0.09, density(x, z)));
  return [
    paved[0] * (1 - green01) + green[0] * green01,
    paved[1] * (1 - green01) + green[1] * green01,
    paved[2] * (1 - green01) + green[2] * green01,
  ];
}

/**
 * Covers the full data extent (Sewickley to Squirrel Hill). The 30 m sampling is
 * set by the shorelines rather than the hills: a coarser grid leaves single
 * cells spanning a river bank, which read as slabs of land in the water.
 */
const GROUND = { w: 15000, d: 11200, cx: 1200, cz: -400, segX: 500, segZ: 374 };

function makeGround(terrainFn, waterIndex, density, wooded) {
  const geom = new THREE.PlaneGeometry(GROUND.w, GROUND.d, GROUND.segX, GROUND.segZ);
  geom.rotateX(-Math.PI / 2);
  geom.translate(GROUND.cx, 0, GROUND.cz);
  const pos = geom.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = surfaceHeight(x, z, terrainFn, waterIndex);
    pos.setY(i, y);
    const slope =
      Math.hypot(
        terrainFn(x + 40, z) - terrainFn(x - 40, z),
        terrainFn(x, z + 40) - terrainFn(x, z - 40),
      ) / 80;
    const c = groundColor(x, y, z, slope, waterIndex, density, wooded, DAY_MODE);
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
  }
  pos.needsUpdate = true;
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, materials.groundMat);
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Every label ever added, so the declutter pass can rank them against each
 * other. `rank` is a tie-break for which of two colliding labels survives:
 * lower wins, so a district beats a bridge beats an ordinary building.
 */
const LABELS = [];

function addLabel(text, position, rank = 2) {
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = text;
  el.style.cssText = `
    color: rgba(242,244,248,0.85);
    font-family: "DM Sans", system-ui, sans-serif;
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    white-space: nowrap;
    text-shadow: 0 0 12px rgba(0,0,0,0.85);
    user-select: none;
    pointer-events: none;
    transition: opacity 160ms linear;
  `;
  const obj = new CSS2DObject(el);
  obj.position.copy(position);
  scene.add(obj);

  const stemMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.25,
  });
  const stem = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(position.x, Math.max(0, position.y - position.y * 0.55), position.z),
    position.clone(),
  ]);
  const line = new THREE.Line(stem, stemMat);
  scene.add(line);

  // Width is measured once the glyphs exist rather than guessed from the
  // character count, because the tracking is wide enough that a proportional
  // estimate is off by a third on the longer names.
  LABELS.push({ el, obj, line, stemMat, rank, width: 0, anchor: position.clone() });
  return obj;
}

const LABEL_FADE_NEAR = 2600;
const LABEL_FADE_FAR = 4200;
const LABEL_PAD_X = 10;
const LABEL_PAD_Y = 7;

/**
 * Hide labels that collide on screen, and fade out the far ones.
 *
 * With every landmark labelled at once, an oblique view stacks a dozen names
 * into the same few hundred pixels near the horizon and the result is an
 * unreadable smear that also hides the city behind it. So each frame the labels
 * are projected, sorted near-to-far within their rank, and kept only while
 * their box does not touch a box already kept. Nearest wins, which is the
 * behaviour you want: the thing you flew to keeps its name.
 *
 * The kept boxes are compared by brute force. There are only a few dozen
 * labels, so a grid or an interval tree would cost more to maintain than the
 * comparisons it saves.
 */
const labelProj = new THREE.Vector3();
const keptBoxes = [];

function updateLabels(w, h) {
  keptBoxes.length = 0;
  const candidates = [];

  for (const lab of LABELS) {
    const dist = camera.position.distanceTo(lab.anchor);
    labelProj.copy(lab.anchor).project(camera);
    const behind = labelProj.z > 1 || labelProj.z < -1;
    const offscreen = labelProj.x < -1.08 || labelProj.x > 1.08 || labelProj.y < -1.08 || labelProj.y > 1.08;
    if (behind || offscreen || dist > LABEL_FADE_FAR) {
      lab.el.style.opacity = '0';
      lab.line.visible = false;
      continue;
    }
    if (!lab.width) lab.width = lab.el.offsetWidth || 0;
    candidates.push({
      lab,
      dist,
      x: (labelProj.x * 0.5 + 0.5) * w,
      y: (-labelProj.y * 0.5 + 0.5) * h,
    });
  }

  candidates.sort((a, b) => a.lab.rank - b.lab.rank || a.dist - b.dist);

  for (const c of candidates) {
    const halfW = (c.lab.width || 90) * 0.5 + LABEL_PAD_X;
    const x0 = c.x - halfW;
    const x1 = c.x + halfW;
    const y0 = c.y - 6 - LABEL_PAD_Y;
    const y1 = c.y + 6 + LABEL_PAD_Y;
    let clear = true;
    for (const b of keptBoxes) {
      if (x1 > b[0] && x0 < b[1] && y1 > b[2] && y0 < b[3]) {
        clear = false;
        break;
      }
    }
    if (!clear) {
      c.lab.el.style.opacity = '0';
      c.lab.line.visible = false;
      continue;
    }
    keptBoxes.push([x0, x1, y0, y1]);
    // Fade rather than pop, so a label that survives the collision test at the
    // edge of range does not blink on and off as the camera drifts.
    const fade = 1 - smoothstep(LABEL_FADE_NEAR, LABEL_FADE_FAR, c.dist);
    c.lab.el.style.opacity = String(0.9 * fade);
    c.lab.line.visible = fade > 0.15;
    c.lab.stemMat.opacity = 0.25 * fade;
  }
}

/**
 * Ribbon straddling a ring, used for the wet band along a shoreline. The strip
 * is symmetric about each edge, so the offset direction only decides winding;
 * normals are written straight up and the material draws both sides.
 */
function outlineRibbon(poly, width, y) {
  if (!poly || poly.length < 3) return null;
  const n = poly.length;
  const closed = Math.hypot(poly[0][0] - poly[n - 1][0], poly[0][1] - poly[n - 1][1]) < 0.05;
  const count = closed ? n - 1 : n;

  const positions = [];
  const normals = [];
  const half = width * 0.5;
  for (let i = 0; i < count; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    // Long river rings carry near-duplicate vertices; skip the degenerate ones
    // so they cannot emit NaN normals into the merged buffer.
    if (len < 0.01) continue;
    const nx = -dz / len;
    const nz = dx / len;
    const a0 = [a[0] - nx * half, a[1] - nz * half];
    const a1 = [a[0] + nx * half, a[1] + nz * half];
    const b0 = [b[0] - nx * half, b[1] - nz * half];
    const b1 = [b[0] + nx * half, b[1] + nz * half];
    positions.push(a0[0], y, a0[1], a1[0], y, a1[1], b1[0], y, b1[1]);
    positions.push(a0[0], y, a0[1], b1[0], y, b1[1], b0[0], y, b0[1]);
    for (let k = 0; k < 6; k++) normals.push(0, 1, 0);
  }
  if (!positions.length) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geom;
}

function buildWaterEdges(water, yFn) {
  const geoms = [];
  for (const w of water) {
    if (!w.f || w.f.length < 4) continue;
    let cx = 0;
    let cz = 0;
    const n = w.f.length - 1;
    for (let i = 0; i < n; i++) {
      cx += w.f[i][0];
      cz += w.f[i][1];
    }
    cx /= n;
    cz /= n;
    const edgeY = Math.max(0.35, yFn(cx, cz) + 0.55);
    // Islands get the same wet band as the banks, or they read as floating slabs.
    for (const ring of [w.f, ...(w.holes || [])]) {
      const ribbon = outlineRibbon(ring, 7, edgeY);
      if (ribbon) geoms.push(ribbon);
    }
  }
  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, materials.foamMat);
  mesh.receiveShadow = true;
  return mesh;
}

function buildRoadRibbons(streets, yFn, waterIndex) {
  const widths = { 3: 7.5, 4: 10.5, 5: 14 };
  const colors = {
    3: [0.42, 0.44, 0.48],
    4: [0.52, 0.54, 0.58],
    5: [0.62, 0.64, 0.68],
  };
  const byRank = { 3: { pos: [], col: [] }, 4: { pos: [], col: [] }, 5: { pos: [], col: [] } };

  for (const s of streets) {
    const r = s.r ?? 1;
    if (r < 3 || !byRank[r]) continue;
    const half = widths[r] * 0.5;
    const rgb = colors[r];
    const bucket = byRank[r];
    for (let i = 0; i < s.c.length - 1; i++) {
      const a = s.c[i];
      const b = s.c[i + 1];
      const mx = (a[0] + b[0]) * 0.5;
      const mz = (a[1] + b[1]) * 0.5;
      if (waterIndex.inside(mx, mz)) continue;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 1) continue;
      const rx = (-dz / len) * half;
      const rz = (dx / len) * half;
      const ya = yFn(a[0], a[1]) + 1.15;
      const yb = yFn(b[0], b[1]) + 1.15;
      const a0 = [a[0] + rx, ya, a[1] + rz];
      const a1 = [a[0] - rx, ya, a[1] - rz];
      const b0 = [b[0] + rx, yb, b[1] + rz];
      const b1 = [b[0] - rx, yb, b[1] - rz];
      bucket.pos.push(...a0, ...a1, ...b1, ...a0, ...b1, ...b0);
      for (let k = 0; k < 6; k++) bucket.col.push(...rgb);
    }
  }

  const group = new THREE.Group();
  for (const r of [3, 4, 5]) {
    const { pos, col } = byRank[r];
    if (pos.length < 9) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    applyXZUvs(geom, 0.08);
    geom.computeVertexNormals();
    const mesh = new THREE.Mesh(geom, materials.roadMat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Rasterized mask of the OSM park/greenspace polygons, for tree placement. */
function makeParkMask(parks) {
  const minX = -5600;
  const minZ = -5000;
  const res = 20;
  const cols = 700;
  const rows = 460;
  const mask = new Uint8Array(cols * rows);
  for (const p of parks) {
    if (!p.f || p.f.length < 4) continue;
    for (let row = 0; row < rows; row++) {
      const zy = minZ + (row + 0.5) * res;
      const xs = [];
      const n = p.f.length - 1;
      for (let i = 0; i < n; i++) {
        const a = p.f[i];
        const b = p.f[i + 1];
        if (a[1] > zy !== b[1] > zy) {
          xs.push(a[0] + ((zy - a[1]) * (b[0] - a[0])) / (b[1] - a[1] || 1e-9));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.floor((xs[k] - minX) / res));
        const c1 = Math.min(cols - 1, Math.ceil((xs[k + 1] - minX) / res));
        for (let c = c0; c <= c1; c++) mask[row * cols + c] = 1;
      }
    }
  }
  return (x, z) => {
    const c = Math.floor((x - minX) / res);
    const r = Math.floor((z - minZ) / res);
    return c >= 0 && r >= 0 && c < cols && r < rows && mask[r * cols + c] === 1;
  };
}

/**
 * Trees go where Pittsburgh actually has them: inside mapped parks and on the
 * steep wooded hillsides that wall in the river valleys.
 */
function plantTrees(parks, terrainFn, waterIndex, yFn, wooded, exclude = null) {
  const dummy = new THREE.Object3D();
  const inPark = makeParkMask(parks);
  const positions = [];

  // 17 m spacing. Canopy has to close to read as woodland from the air; at the
  // 26 m the slope test alone used, the crowns never touch and the hillsides
  // came out as scattered bushes on bare ground rather than as forest.
  for (let x = -5200; x <= 7600; x += 17) {
    for (let z = -4600; z <= 3600; z += 17) {
      const jx = x + (hash01(x, z) - 0.5) * 14;
      const jz = z + (hash01(z, x) - 0.5) * 14;
      if (waterIndex.inside(jx, jz) || waterIndex.nearBank(jx, jz)) continue;
      // Point State Park plants itself, to its own path layout. Letting the
      // generic pass plant it as well doubled the canopy there and closed over
      // the lawn, which on the real Point is the whole point of it.
      if (exclude && pointInPoly(jx, jz, exclude)) continue;

      const slope =
        Math.hypot(
          terrainFn(jx + 40, jz) - terrainFn(jx - 40, jz),
          terrainFn(jx, jz + 40) - terrainFn(jx, jz - 40),
        ) / 80;

      const park = inPark(jx, jz);
      const wood = wooded(jx, jz) === 1;
      const steep = slope > 0.16;
      if (!park && !wood && !steep) continue;

      // Mapped woodland is closed canopy; a park is mown grass with specimen
      // trees on it; an unmapped steep slope is scrub thickening with gradient.
      const density = wood ? 0.88 : park ? 0.3 : Math.min(0.66, (slope - 0.16) * 3.2);
      if (hash01(jz * 1.7, jx * 1.3) > density) continue;

      positions.push(jx, yFn(jx, jz), jz, 0.7 + hash01(jx, jz) * 0.75);
    }
  }

  if (!positions.length) return null;
  const count = positions.length / 4;

  // Pittsburgh's hillsides are mostly oak and maple, so a single cone read as a
  // field of identical Christmas trees. Split the stand into rounded broadleaf
  // canopies and a minority of conifers, and vary each instance's proportions
  // and tint so the massed planting does not repeat.
  const broadleaf = [];
  const conifer = [];
  for (let i = 0; i < count; i++) {
    const x = positions[i * 4];
    const z = positions[i * 4 + 2];
    (hash01(x * 0.31, z * 0.29) < 0.24 ? conifer : broadleaf).push(i);
  }

  const group = new THREE.Group();
  const kinds = [
    { idx: broadleaf, geom: new THREE.IcosahedronGeometry(4.6, 0), lift: 5.4, squash: 0.86 },
    { idx: conifer, geom: new THREE.ConeGeometry(3.4, 13, 6), lift: 6.4, squash: 1 },
  ];

  for (const kind of kinds) {
    if (!kind.idx.length) continue;
    const mesh = new THREE.InstancedMesh(kind.geom, materials.treeMat, kind.idx.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const colors = new Float32Array(kind.idx.length * 3);
    const tint = new THREE.Color();
    for (let n = 0; n < kind.idx.length; n++) {
      const i = kind.idx[n];
      const x = positions[i * 4];
      const y = positions[i * 4 + 1];
      const z = positions[i * 4 + 2];
      const s = positions[i * 4 + 3];
      const wobble = 0.78 + hash01(z * 0.7, x * 0.9) * 0.5;
      dummy.position.set(x, y + kind.lift * s * kind.squash, z);
      dummy.scale.set(s * wobble, s * kind.squash * (1.9 - wobble), s * wobble);
      dummy.rotation.y = hash01(x, z) * Math.PI * 2;
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      const h = hash01(x * 1.7, z * 1.3);
      // Instance colours are consumed in the working (linear) space, so the
      // lightness has to be authored as sRGB and converted or the canopy comes
      // out bleached. Broadleaf foliage sits near 0.09 albedo and is far less
      // saturated than a paint-chip green - closer to olive than to emerald.
      tint.setHSL(0.22 + h * 0.06, 0.24 + h * 0.16, 0.24 + h * 0.13, THREE.SRGBColorSpace);
      colors[n * 3] = tint.r;
      colors[n * 3 + 1] = tint.g;
      colors[n * 3 + 2] = tint.b;
    }
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/**
 * Labels are anchored to the footprint the dataset actually holds.
 *
 * The `landmarks` array in the dataset carries hand-placed anchors that have
 * drifted badly from the geometry they name - the Carnegie Museum label sat
 * 780 m west of the museum, the Monongahela Incline label 1.1 km west of the
 * incline - so a viewer reading the labels was being told the buildings were in
 * the wrong place even where they were not. Resolving each label against the
 * dataset by name keeps the two in step by construction.
 *
 * Bridges are labelled by `buildBridges` from their own deck geometry, so the
 * six bridge entries in the array are dropped rather than drawn twice.
 */
const LABELLED = [
  ['U.S. STEEL TOWER', 'U.S. Steel Tower'],
  ['PPG PLACE', 'One PPG Place'],
  ['BNY MELLON CENTER', 'BNY Mellon Center'],
  ['FIFTH AVENUE PLACE', 'Fifth Avenue Place'],
  ['ONE OXFORD CENTRE', 'One Oxford Centre'],
  ['TOWER AT PNC PLAZA', 'Tower at PNC Plaza'],
  ['GULF TOWER', 'Gulf Tower'],
  ['KOPPERS BUILDING', 'Koppers Building'],
  ['GRANT BUILDING', 'Grant Building'],
  ['UNION TRUST BUILDING', 'Union Trust Building'],
  ['ALLEGHENY COUNTY COURTHOUSE', 'Allegheny County Courthouse'],
  ['CONVENTION CENTER', 'David L. Lawrence Convention Center'],
  ['PNC PARK', 'PNC Park'],
  ['ACRISURE STADIUM', 'Acrisure Stadium'],
  ['PPG PAINTS ARENA', 'PPG Paints Arena'],
  ['ANDY WARHOL MUSEUM', 'The Andy Warhol Museum'],
  ['SCIENCE CENTER', 'Kamin Science Center'],
  ['CATHEDRAL OF LEARNING', 'Cathedral of Learning'],
  ['HEINZ MEMORIAL CHAPEL', 'Heinz Memorial Chapel'],
  ['CARNEGIE MUSEUM', 'Carnegie Museum of Natural History'],
  ['SOLDIERS & SAILORS MEMORIAL', 'Soldiers and Sailors Memorial Hall'],
  ['PHIPPS CONSERVATORY', 'Phipps Conservatory'],
];

/** Districts, which name a place rather than a building. */
const DISTRICT_LABELS = [
  ['POINT STATE PARK', -800, -70, 40],
  ['MOUNT WASHINGTON', -720, 1000, 60],
  ['THE STRIP DISTRICT', 1500, -900, 50],
  ['OAKLAND', 4200, 0, 60],
];

function placeLandmarkLabels(data, yFn) {
  const byName = new Map();
  for (const b of data.buildings || []) {
    if (!b.n || !b.f || b.f.length < 4) continue;
    const prev = byName.get(b.n);
    if (!prev || (b.h || 0) > (prev.h || 0)) byName.set(b.n, b);
  }
  const loose = (want) => {
    const key = want.toLowerCase();
    for (const [n, b] of byName) if (n.toLowerCase().includes(key)) return b;
    return null;
  };

  for (const [text, want] of LABELLED) {
    const b = byName.get(want) || loose(want);
    if (!b) continue;
    const [cx, cz] = footprintCentroid(b.f);
    // Taller wins a collision: on a skyline view the towers are what a viewer
    // is trying to identify, and a 14 m museum label sitting in front of a
    // 250 m tower's label is the wrong one to keep.
    const rank = 2 + Math.max(0, 1 - (b.h || 0) / 260);
    addLabel(text, new THREE.Vector3(cx, yFn(cx, cz) + Math.max(24, b.h || 24) + 28, cz), rank);
  }
  for (const [text, x, z, lift] of DISTRICT_LABELS) {
    addLabel(text, new THREE.Vector3(x, yFn(x, z) + lift, z), 0);
  }
  // Straight off the funicular alignments the meshes are built from, so the
  // label cannot drift away from the incline it names.
  for (const inc of INCLINES) {
    const [x, z] = inc.upper;
    addLabel(inc.n.toUpperCase(), new THREE.Vector3(x, yFn(x, z) + 34, z), 1);
  }
}

function buildingTint(b, cx, cz) {
  const n = (b.n || '').toLowerCase();
  if (/u\.?s\.? steel|us steel/.test(n)) return new THREE.Color(0x6a4a3a);
  if (/ppg/.test(n)) return new THREE.Color(0xd8ece6);
  if (/koppers/.test(n)) return new THREE.Color(0x4a7a58);
  if (/gulf tower|grant building/.test(n)) return new THREE.Color(0x9a9488);
  if (/cathedral|chapel|church/.test(n)) return new THREE.Color(0x8a8478);
  if (/carnegie|sandstone|soldiers/.test(n)) return new THREE.Color(0x8a8070);
  if (/convention/.test(n)) return new THREE.Color(0xd8dcd8);
  // The family palette already carries the hue, so this only needs to break up
  // the repetition: a wide spread in value plus a slight warm/cool drift, so two
  // neighbours in the same family are not the same building twice.
  const h = hash01(cx, cz);
  const g = hash01(cz * 3.1, cx * 1.7);
  const cool = b.h > 70 ? 0.58 : 0.07;
  return new THREE.Color().setHSL(cool + g * 0.06, 0.03 + h * 0.07, 0.74 + h * 0.3);
}

/**
 * The park material with per-vertex variation switched on. Cloned rather than
 * changed in place because the mown surfaces are the only ones that carry
 * vertex colours, and turning the flag on for the shared material would make
 * every other mesh drawn with it render untinted white.
 */
let turfMatCache = null;
function turfMat() {
  if (!turfMatCache) {
    turfMatCache = materials.parkMat.clone();
    turfMatCache.vertexColors = true;
  }
  return turfMatCache;
}

/**
 * Flat land-cover surfaces from OSM: car parks, yards, plazas and lawns.
 *
 * Drawn as polygons rather than baked into the ground mesh's vertex colours
 * because their EDGES are what identify them from the air - a car park is a
 * hard-edged grey rectangle against green, and the 30 m ground mesh cannot
 * resolve an edge. Only the flat classes are drawn here; woodland goes into the
 * ground tint instead, since it lives on slopes that a flat polygon cannot
 * follow. Small polygons are skipped: at flyover range a single parking bay is
 * subpixel and costs a draw's worth of triangles for nothing.
 */
function buildLandcover(polys, yFn, waterIndex) {
  const group = new THREE.Group();
  group.name = 'landcover';
  if (!polys?.length) return group;

  const byClass = { 0: [], 1: [], 3: [] };
  for (const p of polys) {
    const bucket = byClass[p.c];
    if (!bucket || !p.f || p.f.length < 4) continue;
    const [cx, cz] = footprintCentroid(p.f);
    if (waterIndex.inside(cx, cz)) continue;
    let span = 0;
    for (const [x, z] of p.f) span = Math.max(span, Math.hypot(x - cx, z - cz));
    if (span < 14) continue;
    try {
      const g = flatPolygon(p.f, 0.45, yFn);
      applyXZUvs(g, 0.045);
      bucket.push(p.c === 1 ? tintTurf(g, [1, 1, 1]) : g);
    } catch {
      /* self-intersecting OSM ring; the ground tint still covers it */
    }
  }

  const surfaces = [
    { cls: 0, mat: materials.pavingMat },
    { cls: 3, mat: materials.sandMat },
    { cls: 1, mat: turfMat() },
  ];
  for (const { cls, mat } of surfaces) {
    const geoms = byClass[cls];
    if (!geoms.length) continue;
    const merged = mergeGeometries(geoms, false);
    for (const g of geoms) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

async function buildCity(data, landcover) {
  const terrainFn = makeTerrain(data.terrain);
  // The rivers need two masks with opposite biases. Everything that shapes or
  // dresses the landform reads the true OSM water outline, so no ground is left
  // standing inside a river. Building culling reads an eroded outline, so the
  // wharves and riverfront blocks that legitimately overhang the bank survive.
  const waterIndex = makeWaterIndex(data.water || []);
  const waterCull = makeWaterIndex(data.water || [], { erosion: 12 });
  const yFn = (x, z) => surfaceHeight(x, z, terrainFn, waterIndex);

  const density = makeDensityIndex(data.buildings || []);
  const wooded = makeWoodIndex(landcover?.polys || []);
  scene.add(makeGround(terrainFn, waterIndex, density, wooded));
  scene.add(buildLandcover(landcover?.polys, yFn, waterIndex));

  // Point State Park and the lawns nested inside it are drawn in full detail by
  // buildPointStatePark. Left in the generic pass as well they land within a few
  // centimetres of it and z-fight, which turns the whole Point into a dark plate.
  const pointRing = data.pointPark?.f;
  const parkGeoms = [];
  for (const p of data.parks) {
    if (p.f.length < 4) continue;
    if (pointRing) {
      const [pcx, pcz] = footprintCentroid(p.f);
      if (pointInPoly(pcx, pcz, pointRing)) continue;
    }
    try {
      const g = flatPolygon(p.f, 0.5, yFn);
      applyXZUvs(g, 0.012);
      parkGeoms.push(tintTurf(g, [1, 1, 1]));
    } catch {
      /* skip bad poly */
    }
  }
  if (parkGeoms.length) {
    const parkMesh = new THREE.Mesh(mergeGeometries(parkGeoms, false), turfMat());
    parkMesh.receiveShadow = true;
    scene.add(parkMesh);
  }

  const waterGeoms = [];
  for (const w of data.water) {
    if (w.f.length < 4) continue;
    try {
      const g = flatPolygon(w.f, 0.15, null, w.holes);
      applyXZUvs(g, 0.004);
      waterGeoms.push(g);
    } catch {
      /* skip */
    }
  }
  if (waterGeoms.length) {
    const waterMesh = new THREE.Mesh(mergeGeometries(waterGeoms, false), materials.waterMat);
    waterMesh.receiveShadow = true;
    scene.add(waterMesh);
  }
  const foam = buildWaterEdges(data.water, yFn);
  if (foam) scene.add(foam);

  const buckets = {
    lowrise: [],
    brick: [],
    limestone: [],
    steel: [],
    glass: [],
    ppg: [],
    gothic: [],
    stadium: [],
    artdeco: [],
    chapel: [],
    sandstone: [],
    copper: [],
    convention: [],
    steelTower: [],
  };
  let buildingCount = 0;
  const roofGeoms = [];
  const tiers = [0, 0, 0];
  // Rooftop clutter is placed in a second pass from the source records, so it
  // has to be told which of them actually became a building. Otherwise the
  // culled river footprints and the floating landings sprout vents and cooling
  // towers over open water with nothing underneath them.
  const roofSubjects = [];

  for (const b of data.buildings) {
    if (!b.f || b.f.length < 4) continue;
    if (isLandmarkMeshBuilding(b)) continue;
    if (footprintWaterOverlap(b.f, waterCull) > 0.18) continue;
    try {
      const family = buildingFamily(b);
      const spec = materials.families[family];
      const [cx, cz] = footprintCentroid(b.f);

      // A handful of footprints stand out over the river: the Gateway Clipper
      // landing, boathouses and marina sheds, all tagged `building=yes` with no
      // height and so handed a storeys-tall default. They are floating landings,
      // so cap them and float them instead of standing them on the riverbed.
      const afloat = footprintWaterOverlap(b.f, waterIndex) > 0.6;
      const height = afloat ? Math.min(Math.max(3, b.h || 10), 7) : Math.max(3, b.h || 10);
      const baseY = afloat ? 0.4 : footprintLandBaseY(b.f, yFn, waterIndex);

      // On a slope the base is taken from the highest footprint corner, so the
      // downhill wall needs a skirt to stay buried in the hillside.
      let low = baseY;
      if (!afloat) for (const [vx, vz] of b.f) low = Math.min(low, yFn(vx, vz));
      const skirt = Math.min(28, Math.max(0, baseY - low) + 1.2);

      const seed = footprintSeed(b.f);
      const tier = detailTier(b.f, height);
      const tint = buildingTint(b, cx, cz);

      const { wall, trim, roofRing, roofY } = buildArticulatedBuilding({
        footprint: b.f,
        height,
        baseY,
        style: family,
        seed,
        floorH: spec.floorH,
        windowW: spec.windowW,
        skirt,
      });
      if (!wall) continue;

      tintGeometry(wall, tint);
      buckets[family].push(wall);
      if (trim) {
        tintGeometry(trim, trimTint(tint));
        buckets[family].push(trim);
      }

      if (tier > 0) {
        const roof = buildRoofscape({
          footprint: b.f,
          height,
          baseY,
          seed,
          tier,
          style: family,
          roofRing,
          roofY,
        });
        if (roof) roofGeoms.push(roof);
      }

      if (!afloat) roofSubjects.push(b);
      tiers[tier] += 1;
      buildingCount += 1;
    } catch {
      /* skip degenerate */
    }
  }

  const CHUNK = 800;
  function addChunks(geoms, mat) {
    for (let i = 0; i < geoms.length; i += CHUNK) {
      const slice = geoms.slice(i, i + CHUNK);
      const merged = mergeGeometries(slice, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      for (const g of slice) g.dispose();
    }
  }

  for (const [name, geoms] of Object.entries(buckets)) {
    if (!materials.families[name]) continue;
    addChunks(geoms, materials.families[name].mat);
  }

  // The roofscapes were being generated and dropped: a quarter of a million
  // triangles of overruns, plant, cooling towers and parapets built on every
  // load and never merged into the scene. From a flyover, which is the angle
  // this city is mostly seen from, that left every roof a bare slab, and a bare
  // slab is most of what makes a building read as a box.
  if (roofGeoms.length) addChunks(roofGeoms, createRoofscapeMaterial({ dayMode: DAY_MODE }));

  scene.add(buildLandmarkMeshes(data.buildings, yFn, waterIndex, data.pointPark, waterCull));
  scene.add(buildRooftopDetails(roofSubjects, yFn));
  scene.add(buildStreetLights(data.streets || [], yFn, waterIndex, { dayMode: DAY_MODE }));
  if (!DAY_MODE) buildStreetLightGlows(data.streets || [], yFn, waterIndex, scene);

  const byRank = new Map();
  for (const s of data.streets) {
    const r = s.r ?? 1;
    if (r >= 3) continue;
    if (!byRank.has(r)) byRank.set(r, []);
    const pts = byRank.get(r);
    for (let i = 0; i < s.c.length - 1; i++) {
      const a = s.c[i];
      const b = s.c[i + 1];
      const ya = yFn(a[0], a[1]) + 1.2;
      const yb = yFn(b[0], b[1]) + 1.2;
      pts.push(a[0], ya, a[1], b[0], yb, b[1]);
    }
  }
  for (const [r, arr] of byRank) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    scene.add(new THREE.LineSegments(geom, roadLineMats[r] || roadLineMats[1]));
  }
  scene.add(buildRoadRibbons(data.streets || [], yFn, waterIndex));

  const bridgeGroup = buildBridges(data.bridges || [], {
    yFn,
    waterIndex,
    // Bridges outrank buildings in a collision: they are the landmarks a viewer
    // navigates by here, and unlike a tower they cannot be identified by shape.
    addLabel: (text, position) => addLabel(text, position, 1.5),
    dayMode: DAY_MODE,
  });
  scene.add(bridgeGroup);

  const trees = plantTrees(data.parks || [], terrainFn, waterIndex, yFn, wooded, pointRing);
  if (trees) scene.add(trees);

  placeLandmarkLabels(data, yFn);

  layersEl.textContent = `buildings ${buildingCount.toLocaleString()} · live`;
  return buildingCount;
}

/**
 * Framing is anchored on the real projected positions: the Point fountain at
 * (-765, -80), the Three Sisters at x = -112 / 46 / 190, the Cathedral of
 * Learning at (4133, -369), and the Mount Washington bluff edge, which the
 * elevation grid puts at roughly (-1000, 550) and 126 m above pool.
 */
const views = {
  aerial: {
    position: new THREE.Vector3(-300, 2500, 900),
    target: new THREE.Vector3(-300, 0, -180),
  },
  downtown: {
    position: new THREE.Vector3(880, 430, 700),
    target: new THREE.Vector3(180, 70, 40),
  },
  point: {
    position: new THREE.Vector3(-280, 240, 240),
    target: new THREE.Vector3(-790, 20, -80),
  },
  bridges: {
    position: new THREE.Vector3(300, 260, -140),
    target: new THREE.Vector3(20, 30, -540),
  },
  stadiums: {
    position: new THREE.Vector3(-560, 300, -1180),
    target: new THREE.Vector3(-900, 30, -650),
  },
  oakland: {
    position: new THREE.Vector3(4780, 430, 260),
    target: new THREE.Vector3(4050, 110, -320),
  },
  cathedral: {
    position: new THREE.Vector3(4460, 300, -60),
    target: new THREE.Vector3(4133, 150, -369),
  },
  mountwashington: {
    position: new THREE.Vector3(-1010, 195, 560),
    target: new THREE.Vector3(240, 60, -40),
  },
};

let rotateMode = false;
let anim = null;

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function animateCamera(toView, duration = 2200) {
  const fromPos = camera.position.clone();
  const fromTarget = controls.target.clone();
  const toPos = toView.position.clone();
  const toTarget = toView.target.clone();
  const start = performance.now();
  controls.enabled = false;
  anim = { start, duration, fromPos, fromTarget, toPos, toTarget };
}

function setView(name) {
  if (name === 'rotate') {
    rotateMode = !rotateMode;
    for (const btn of navEl.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset.view === 'rotate' ? rotateMode : false);
    }
    if (rotateMode) animateCamera(views.downtown, 1600);
    else controls.enabled = true;
    return;
  }
  rotateMode = false;
  controls.enabled = true;
  for (const btn of navEl.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.view === name);
  }
  if (views[name]) animateCamera(views[name]);
}

for (const btn of navEl.querySelectorAll('button[data-view]')) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setView(btn.dataset.view);
  });
}

/** `#point`, `#stadiums`, ... jumps straight to a preset, so a viewpoint is linkable. */
function viewFromHash() {
  const name = location.hash.replace(/^#/, '').toLowerCase();
  return views[name] ? name : null;
}

window.addEventListener('hashchange', () => {
  const name = viewFromHash();
  if (name) setView(name);
});

let viewW = window.innerWidth;
let viewH = window.innerHeight;

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  viewW = w;
  viewH = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  if (composer) composer.setSize(w, h);
}
window.addEventListener('resize', onResize);
onResize();

function tick(now) {
  requestAnimationFrame(tick);

  if (anim) {
    const t = Math.min(1, (now - anim.start) / anim.duration);
    const e = easeInOut(t);
    camera.position.lerpVectors(anim.fromPos, anim.toPos, e);
    controls.target.lerpVectors(anim.fromTarget, anim.toTarget, e);
    if (t >= 1) {
      anim = null;
      controls.enabled = !rotateMode;
    }
  } else if (rotateMode) {
    const t = now * 0.00012;
    const r = 980;
    camera.position.x = Math.cos(t) * r;
    camera.position.z = Math.sin(t) * r;
    camera.position.y = 480;
    controls.target.set(20, 50, -20);
  }

  materials.waterUniforms.uTime.value = now * 0.001;
  aimSun(controls.target);
  focusLight.position.set(controls.target.x, 750, controls.target.z);
  focusLight.target.position.copy(controls.target);
  focusGlow.position.x = controls.target.x;
  focusGlow.position.z = controls.target.z;

  controls.update();
  if (composer) composer.render();
  else renderer.render(scene, camera);
  camera.updateMatrixWorld();
  updateLabels(viewW, viewH);
  labelRenderer.render(scene, camera);
}
requestAnimationFrame(tick);

(async () => {
  try {
    const [res, coverRes] = await Promise.all([
      fetch('./data/pittsburgh.json'),
      fetch('./data/landcover.json'),
    ]);
    if (!res.ok) throw new Error(`Failed to load city data (${res.status})`);
    const data = await res.json();
    // Land cover only decides ground tone, so a missing or stale file should
    // degrade to the slope-and-density fallback rather than lose the city.
    const landcover = coverRes.ok ? await coverRes.json() : null;
    await buildCity(data, landcover);
    initComposer();
    const start = viewFromHash() || 'downtown';
    setView(start);
    // Land on a hash-selected view immediately rather than flying in, so a
    // screenshot taken right after load shows the requested framing.
    if (anim && viewFromHash()) {
      camera.position.copy(anim.toPos);
      controls.target.copy(anim.toTarget);
      anim = null;
      controls.enabled = true;
    }
    for (const btn of navEl.querySelectorAll('button[data-view]')) {
      btn.classList.toggle('active', btn.dataset.view === start);
    }
    loaderEl.classList.add('hide');
  } catch (err) {
    console.error(err);
    loaderEl.querySelector('.loader-text').textContent = String(err.message || err);
  }
})();
