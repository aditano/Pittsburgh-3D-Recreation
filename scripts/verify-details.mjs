/**
 * Headless checks for the procedural building detail generator (src/details.js).
 * Pure geometry — no WebGL/DOM needed:
 *
 *   node scripts/verify-details.mjs
 *
 * 1. Winding: for a sample of real footprints, the closest front-side raycast
 *    hit must match the closest double-side hit from every direction. Any
 *    inverted triangle would let a front-side ray pass through the surface and
 *    hit something behind it, so this catches flipped walls/caps.
 * 2. Containment: detail geometry must sit on the building (y >= base) and stay
 *    inside the footprint bbox (plus the intended cornice overhang).
 * 3. Budget: triangle/vertex totals for the whole city, base vs detail.
 * 4. Merge: every family bucket must still merge into a single geometry, which
 *    only works if detail matches the extruded prisms (non-indexed, same
 *    attribute set).
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyFacadeUVs, buildingFamily, tintGeometry } from '../src/textures.js';
import { buildingDetails } from '../src/details.js';
import { footprintCentroid } from '../src/geo.js';

// The real floor grid comes from materials.families[*] (canvas-backed, so it
// needs a DOM). UV values do not affect geometry, so a stand-in is fine here.
const SPEC = { floorH: 3.6, windowW: 3.2 };
const TINT = new THREE.Color(0xffffff);

function extrudeBuilding(footprint, height) {
  const shape = new THREE.Shape();
  shape.moveTo(footprint[0][0], -footprint[0][1]);
  for (let i = 1; i < footprint.length - 1; i++) {
    shape.lineTo(footprint[i][0], -footprint[i][1]);
  }
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geom.rotateX(-Math.PI / 2);
  applyFacadeUVs(geom, SPEC.floorH, SPEC.windowW, 0);
  tintGeometry(geom, TINT);
  return geom;
}

function detailsFor(b) {
  const [cx, cz] = footprintCentroid(b.f);
  return buildingDetails({
    footprint: b.f,
    height: Math.max(3, b.h || 10),
    base: 0,
    cx,
    cz,
    family: buildingFamily(b),
    spec: SPEC,
    tint: TINT,
    landmark: !!b.landmark,
  });
}

function triCount(geom) {
  return geom.attributes.position.count / 3;
}

const data = JSON.parse(readFileSync(new URL('../public/data/pittsburgh.json', import.meta.url)));
const buildings = data.buildings.filter((b) => b.f && b.f.length >= 4);
let failures = 0;

/* ---------------------------------------------------------- 1 + 2. geometry */

function checkOne(b) {
  const height = Math.max(3, b.h || 10);
  const details = detailsFor(b);
  if (!details.length) return { skipped: true };

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of b.f) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[1]);
    maxZ = Math.max(maxZ, p[1]);
  }

  for (const g of details) {
    const names = Object.keys(g.attributes).sort().join(',');
    if (names !== 'color,normal,position,uv') {
      console.error(`  attribute mismatch on "${b.n}": ${names}`);
      failures++;
    }
    if (g.index !== null) {
      console.error(`  indexed detail geometry on "${b.n}"`);
      failures++;
    }
    const pos = g.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      if (!Number.isFinite(pos[i]) || !Number.isFinite(pos[i + 1]) || !Number.isFinite(pos[i + 2])) {
        console.error(`  non-finite vertex on "${b.n}"`);
        failures++;
        break;
      }
      // Detail must rest on the building (never float below its base), must
      // respect the documented height allowance, and may only hang past the
      // footprint by the mitered cornice overhang (0.55 m * 1.6 miter limit).
      const maxY = height + Math.min(Math.max(6, height * 0.22), 46);
      if (pos[i + 1] < -1e-3 || pos[i + 1] > maxY + 1e-3) {
        console.error(`  detail y out of range on "${b.n}": ${pos[i + 1]} > ${maxY.toFixed(1)}`);
        failures++;
        break;
      }
      if (
        pos[i] < minX - 0.9 ||
        pos[i] > maxX + 0.9 ||
        pos[i + 2] < minZ - 0.9 ||
        pos[i + 2] > maxZ + 0.9
      ) {
        console.error(`  detail overhangs footprint on "${b.n}"`);
        failures++;
        break;
      }
    }
  }

  // Winding: front-side vs double-side first-hit distance from all around.
  const merged = mergeGeometries([extrudeBuilding(b.f, height), ...details], false);
  if (!merged) {
    console.error(`  merge failed on "${b.n}"`);
    failures++;
    return { skipped: false };
  }
  const front = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
  const both = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  front.updateMatrixWorld();
  both.updateMatrixWorld();

  const target = new THREE.Vector3(
    (minX + maxX) * 0.5,
    height * 0.55,
    (minZ + maxZ) * 0.5,
  );
  const span = Math.max(maxX - minX, maxZ - minZ, height) * 3 + 60;
  const raycaster = new THREE.Raycaster();
  let flipped = 0;
  for (let i = 0; i < 220; i++) {
    // Deterministic Fibonacci-ish hemisphere of origins around the building.
    const t = (i + 0.5) / 220;
    const phi = Math.acos(1 - t * 0.98);
    const theta = i * 2.39996;
    const dir = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi) * 0.9 + 0.08,
      Math.sin(phi) * Math.sin(theta),
    ).normalize();
    const origin = target.clone().add(dir.multiplyScalar(span));
    const aim = new THREE.Vector3()
      .subVectors(target, origin)
      .normalize();
    // Jitter the aim point so rays sweep the whole silhouette, not just center.
    aim.x += (((i * 7919) % 97) / 97 - 0.5) * 0.22;
    aim.y += (((i * 6151) % 89) / 89 - 0.5) * 0.22;
    aim.z += (((i * 5387) % 83) / 83 - 0.5) * 0.22;
    aim.normalize();
    raycaster.set(origin, aim);
    const hf = raycaster.intersectObject(front, false);
    const hb = raycaster.intersectObject(both, false);
    if (!hb.length) continue;
    if (!hf.length || hf[0].distance - hb[0].distance > 0.01) flipped++;
  }
  if (flipped > 0) {
    console.error(`  ${flipped}/220 rays hit a back-facing surface first on "${b.n}"`);
    failures++;
  }
  merged.dispose();
  return { skipped: false, rays: 220 };
}

// Sample: every tall tower, plus every Nth building (node scripts/… <stride>).
const stride = Number(process.argv[2]) || 37;
const sample = buildings.filter((b) => (b.h || 10) >= 70);
for (let i = 0; i < buildings.length; i += stride) sample.push(buildings[i]);

console.log(`winding/containment: checking ${sample.length} buildings...`);
let checked = 0;
for (const b of sample) {
  const r = checkOne(b);
  if (!r.skipped) checked++;
}
console.log(`  ${checked} with detail geometry, ${failures} failure(s)`);

/* ------------------------------------------------------------- 3. budget */

const buckets = {};
let baseTris = 0;
let detailTris = 0;
let baseVerts = 0;
let detailVerts = 0;
const byKind = {};
let baseMs = 0;
let detailMs = 0;

for (const b of buildings) {
  const family = buildingFamily(b);
  const height = Math.max(3, b.h || 10);
  let t = Date.now();
  const baseGeom = extrudeBuilding(b.f, height);
  baseMs += Date.now() - t;
  baseTris += triCount(baseGeom);
  baseVerts += baseGeom.attributes.position.count;
  buckets[family] = buckets[family] || [];
  buckets[family].push(baseGeom);

  t = Date.now();
  const details = detailsFor(b);
  detailMs += Date.now() - t;
  const bucketKey =
    height >= 115 ? 'tower >=115m' : height >= 70 ? 'tower 70-115m' : height >= 28 ? 'midrise 28-70m' : height >= 14 ? 'lowrise 14-28m' : 'small <14m';
  const stat = (byKind[bucketKey] = byKind[bucketKey] || { n: 0, tris: 0, withDetail: 0 });
  stat.n++;
  if (details.length) stat.withDetail++;
  for (const g of details) {
    detailTris += triCount(g);
    detailVerts += g.attributes.position.count;
    stat.tris += triCount(g);
    buckets[family].push(g);
  }
}
console.log('\nbudget');
console.log(`  buildings          ${buildings.length}`);
console.log(`  base triangles     ${baseTris.toLocaleString()} (${baseVerts.toLocaleString()} verts)`);
console.log(`  detail triangles   ${detailTris.toLocaleString()} (${detailVerts.toLocaleString()} verts)`);
console.log(`  total triangles    ${(baseTris + detailTris).toLocaleString()}`);
console.log(`  detail vertex mem  ~${((detailVerts * 44) / 1048576).toFixed(1)} MB (pos+nrm+uv+col)`);
console.log(`  build time         ${baseMs} ms prisms + ${detailMs} ms detail (whole city)`);
console.log('\n  by height band                 n   with detail   detail tris   avg/bldg');
for (const [k, v] of Object.entries(byKind)) {
  console.log(
    `  ${k.padEnd(16)} ${String(v.n).padStart(7)} ${String(v.withDetail).padStart(13)} ${v.tris.toLocaleString().padStart(13)} ${(v.tris / v.n).toFixed(1).padStart(10)}`,
  );
}

/* -------------------------------------------------------------- 4. merge */

console.log('\nmerge (as buildCity does, chunked at 800 geometries)');
for (const [family, geoms] of Object.entries(buckets)) {
  let meshes = 0;
  let verts = 0;
  for (let i = 0; i < geoms.length; i += 800) {
    const merged = mergeGeometries(geoms.slice(i, i + 800), false);
    if (!merged) {
      console.error(`  ${family}: merge returned null`);
      failures++;
      continue;
    }
    meshes++;
    verts += merged.attributes.position.count;
    merged.dispose();
  }
  console.log(
    `  ${family.padEnd(10)} ${String(geoms.length).padStart(6)} geoms -> ${String(meshes).padStart(3)} mesh(es), ${verts.toLocaleString().padStart(10)} verts`,
  );
}

console.log(failures === 0 ? '\nOK: all checks passed' : `\nFAILED: ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
