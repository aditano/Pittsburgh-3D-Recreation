import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  surfaceHeight,
  makeWaterIndex,
  footprintCentroid,
  footprintWaterOverlap,
  footprintLandBaseY,
  hash01,
  insidePointPark,
} from './geo.js';
import {
  createCityMaterials,
  buildingFamily,
  applyFacadeUVs,
  tintGeometry,
  applyXZUvs,
} from './textures.js';
import { buildBridges } from './bridges.js';
import { buildLandmarkMeshes, isLandmarkMeshBuilding } from './landmarks.js';
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
scene.fog = new THREE.FogExp2(DAY_MODE ? 0xb8d8f0 : 0x05070c, DAY_MODE ? 0.00012 : 0.00026);

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
renderer.toneMappingExposure = DAY_MODE ? 1.22 : 1.08;
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

const hemi = new THREE.HemisphereLight(DAY_MODE ? 0xd8e8ff : 0xb8c4d8, DAY_MODE ? 0x6a7a58 : 0x1a241c, DAY_MODE ? 0.95 : 0.5);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, DAY_MODE ? 1.65 : 1.15);
sun.position.set(DAY_MODE ? 800 : 600, DAY_MODE ? 1200 : 900, DAY_MODE ? 400 : 200);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 100;
sun.shadow.camera.far = 5000;
sun.shadow.camera.left = -1800;
sun.shadow.camera.right = 1800;
sun.shadow.camera.top = 1800;
sun.shadow.camera.bottom = -1800;
sun.shadow.bias = -0.0002;
scene.add(sun);

const fill = new THREE.DirectionalLight(DAY_MODE ? 0xc8d8f0 : 0x6a7a9a, DAY_MODE ? 0.45 : 0.32);
fill.position.set(-500, 400, -500);
scene.add(fill);

const materials = createCityMaterials({ dayMode: DAY_MODE });
materials.envMap = createEnvironmentMap(renderer, { day: DAY_MODE });
scene.environment = materials.envMap;
scene.environmentIntensity = DAY_MODE ? 0.75 : 0.55;
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

function footprintShape(footprint) {
  const shape = new THREE.Shape();
  const first = footprint[0];
  shape.moveTo(first[0], -first[1]);
  for (let i = 1; i < footprint.length - 1; i++) {
    shape.lineTo(footprint[i][0], -footprint[i][1]);
  }
  shape.closePath();
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

function flatPolygon(footprint, y, yFn) {
  const shape = footprintShape(footprint);
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

function groundColor(x, y, z, waterIndex) {
  if (waterIndex.inside(x, z)) return [0.035, 0.055, 0.07];
  const bank = waterIndex.bankStrength(x, z);
  if (bank > 0.15) {
    return [0.14 + bank * 0.04, 0.11, 0.07];
  }

  const dist = Math.hypot(x, z);
  const southHills = z > 680 && y > 10;
  const northSide = z < -720 && x < 900;
  const oakland = x > 2200 && x < 5400 && z > -1400 && z < 900;
  const downtown = dist < 1150 && y < 10 && z > -880 && z < 560 && x > -1300 && x < 1500;

  if (southHills) {
    const t = Math.min(1, y / 90);
    return [0.1 - t * 0.03, 0.13 - t * 0.02, 0.06];
  }
  if (oakland) return [0.11, 0.14, 0.09];
  if (northSide) return [0.1, 0.11, 0.09];
  if (downtown) return [0.1, 0.105, 0.125];
  return [0.08, 0.09, 0.07];
}

function makeGround(peaks, waterIndex) {
  const size = 7000;
  const segs = 160;
  const geom = new THREE.PlaneGeometry(size, size, segs, segs);
  geom.rotateX(-Math.PI / 2);
  const pos = geom.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = surfaceHeight(x, z, peaks, waterIndex);
    pos.setY(i, y);
    const c = groundColor(x, y, z, waterIndex);
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

function makeGrid() {
  const helper = new THREE.GridHelper(5000, 100, 0x8aa0b8, 0xa8b8c8);
  helper.position.y = 0.4;
  helper.material.transparent = true;
  helper.material.opacity = DAY_MODE ? 0.03 : 0.1;
  return helper;
}

function addLabel(text, position) {
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
  `;
  const obj = new CSS2DObject(el);
  obj.position.copy(position);
  scene.add(obj);

  const stem = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(position.x, Math.max(0, position.y - position.y * 0.55), position.z),
    position.clone(),
  ]);
  const line = new THREE.Line(
    stem,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }),
  );
  scene.add(line);
  return obj;
}

function outlineRibbon(poly, width, y) {
  if (!poly || poly.length < 3) return null;
  const n = poly.length;
  const closed = Math.hypot(poly[0][0] - poly[n - 1][0], poly[0][1] - poly[n - 1][1]) < 0.05;
  const count = closed ? n - 1 : n;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += poly[i][0];
    cz += poly[i][1];
  }
  cx /= count;
  cz /= count;

  const positions = [];
  const half = width * 0.5;
  for (let i = 0; i < count; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    let nx = -dz / len;
    let nz = dx / len;
    const mx = (a[0] + b[0]) * 0.5;
    const mz = (a[1] + b[1]) * 0.5;
    if ((mx - cx) * nx + (mz - cz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const a0 = [a[0] - nx * half, a[1] - nz * half];
    const a1 = [a[0] + nx * half, a[1] + nz * half];
    const b0 = [b[0] - nx * half, b[1] - nz * half];
    const b1 = [b[0] + nx * half, b[1] + nz * half];
    positions.push(a0[0], y, a0[1], a1[0], y, a1[1], b1[0], y, b1[1]);
    positions.push(a0[0], y, a0[1], b1[0], y, b1[1], b0[0], y, b0[1]);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

function buildWaterEdges(water, yFn) {
  const geoms = [];
  for (const w of water) {
    if (!w.f || w.f.length < 4 || w.f.length > 200) continue;
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
    const ribbon = outlineRibbon(w.f, 7, edgeY);
    if (ribbon) geoms.push(ribbon);
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

function plantTrees(peaks, waterIndex, yFn) {
  const dummy = new THREE.Object3D();
  const positions = [];
  const tryPlant = (x, z, minH) => {
    if (waterIndex.inside(x, z) || waterIndex.nearBank(x, z)) return;
    const y = yFn(x, z);
    if (y < minH) return;
    positions.push(x, y, z, 0.65 + hash01(x, z) * 0.7);
  };

  for (let x = -2000; x <= 900; x += 30) {
    for (let z = 520; z <= 2200; z += 30) {
      const jx = x + (hash01(x, z) - 0.5) * 22;
      const jz = z + (hash01(z, x) - 0.5) * 22;
      tryPlant(jx, jz, 16);
    }
  }
  for (let x = 2400; x <= 5200; x += 42) {
    for (let z = -1600; z <= 400; z += 42) {
      const jx = x + (hash01(x, z) - 0.5) * 28;
      const jz = z + (hash01(z, x) - 0.5) * 28;
      tryPlant(jx, jz, 18);
    }
  }
  for (let x = -800; x <= 1600; x += 40) {
    for (let z = -2400; z <= -1400; z += 40) {
      const jx = x + (hash01(x, z) - 0.5) * 24;
      const jz = z + (hash01(z, x) - 0.5) * 24;
      tryPlant(jx, jz, 14);
    }
  }

  if (!positions.length) return null;
  const count = positions.length / 4;
  const geo = new THREE.ConeGeometry(4.2, 13, 5);
  const mesh = new THREE.InstancedMesh(geo, materials.treeMat, count);
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  for (let i = 0; i < count; i++) {
    dummy.position.set(positions[i * 4], positions[i * 4 + 1] + 6.2, positions[i * 4 + 2]);
    dummy.scale.setScalar(positions[i * 4 + 3]);
    dummy.rotation.y = hash01(positions[i * 4], positions[i * 4 + 2]) * Math.PI * 2;
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
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
  const h = hash01(cx, cz);
  const height = b.h || 10;
  const cool = height > 70 ? 0.62 : 0.08;
  return new THREE.Color().setHSL(cool + h * 0.05, 0.06 + h * 0.04, 0.9 + h * 0.08);
}

async function buildCity(data) {
  const peaks = data.terrainPeaks || [];
  const waterPolys = (data.water || []).map((w) => w.f);
  const waterIndex = makeWaterIndex(waterPolys, { erosion: 12 });
  const yFn = (x, z) => surfaceHeight(x, z, peaks, waterIndex);

  scene.add(makeGround(peaks, waterIndex));
  scene.add(makeGrid());

  const parkGeoms = [];
  for (const p of data.parks) {
    if (p.f.length < 4) continue;
    try {
      const g = flatPolygon(p.f, 0.85, yFn);
      applyXZUvs(g, 0.012);
      parkGeoms.push(g);
    } catch {
      /* skip bad poly */
    }
  }
  if (parkGeoms.length) {
    const parkMesh = new THREE.Mesh(mergeGeometries(parkGeoms, false), materials.parkMat);
    parkMesh.receiveShadow = true;
    scene.add(parkMesh);
  }

  const waterGeoms = [];
  for (const w of data.water) {
    if (w.f.length < 4) continue;
    try {
      const g = flatPolygon(w.f, 0.15, null);
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

  for (const b of data.buildings) {
    if (!b.f || b.f.length < 4) continue;
    if (isLandmarkMeshBuilding(b)) continue;
    if (footprintWaterOverlap(b.f, waterIndex) > 0.18) continue;
    const [cx0, cz0] = footprintCentroid(b.f);
    if (insidePointPark(cx0, cz0)) continue;
    const n = (b.n || '').toLowerCase();
    if (/point state park|fort pitt museum|fort pitt block house/.test(n)) continue;
    try {
      const family = buildingFamily(b);
      const spec = materials.families[family];
      const baseY = footprintLandBaseY(b.f, yFn, waterIndex);
      const { geom, base, cx, cz } = extrudeBuilding(b.f, Math.max(3, b.h || 10), baseY);
      applyFacadeUVs(geom, spec.floorH, spec.windowW, base);
      tintGeometry(geom, buildingTint(b, cx, cz));
      buckets[family].push(geom);
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

  scene.add(buildLandmarkMeshes(data.buildings, yFn, waterIndex));
  scene.add(buildRooftopDetails(data.buildings, yFn));
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

  const bridgeGroup = buildBridges(data.bridges || [], { yFn, waterIndex, addLabel, dayMode: DAY_MODE });
  scene.add(bridgeGroup);

  const trees = plantTrees(peaks, waterIndex, yFn);
  if (trees) scene.add(trees);

  for (const lm of data.landmarks || []) {
    const [x, z] = lm.p;
    const y = yFn(x, z) + (lm.h || 40) + 30;
    addLabel(lm.n, new THREE.Vector3(x, y, z));
  }

  layersEl.textContent = `buildings ${buildingCount.toLocaleString()} · live`;
  return buildingCount;
}

const views = {
  aerial: {
    position: new THREE.Vector3(-280, 2600, 280),
    target: new THREE.Vector3(-280, 0, -60),
  },
  downtown: {
    position: new THREE.Vector3(520, 360, 520),
    target: new THREE.Vector3(120, 45, 20),
  },
  point: {
    position: new THREE.Vector3(-520, 210, 200),
    target: new THREE.Vector3(-864, 12, -78),
  },
  bridges: {
    position: new THREE.Vector3(320, 250, -100),
    target: new THREE.Vector3(-60, 28, -560),
  },
  oakland: {
    position: new THREE.Vector3(4550, 420, 150),
    target: new THREE.Vector3(3850, 70, -280),
  },
  cathedral: {
    position: new THREE.Vector3(4550, 360, -80),
    target: new THREE.Vector3(4134, 110, -356),
  },
  mountwashington: {
    position: new THREE.Vector3(-1050, 300, 1150),
    target: new THREE.Vector3(-100, 35, -80),
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

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
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
  focusLight.position.set(controls.target.x, 750, controls.target.z);
  focusLight.target.position.copy(controls.target);
  focusGlow.position.x = controls.target.x;
  focusGlow.position.z = controls.target.z;

  controls.update();
  if (composer) composer.render();
  else renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
requestAnimationFrame(tick);

(async () => {
  try {
    const res = await fetch('./data/pittsburgh.json');
    if (!res.ok) throw new Error(`Failed to load city data (${res.status})`);
    const data = await res.json();
    await buildCity(data);
    initComposer();
    setView('downtown');
    loaderEl.classList.add('hide');
  } catch (err) {
    console.error(err);
    loaderEl.querySelector('.loader-text').textContent = String(err.message || err);
  }
})();
