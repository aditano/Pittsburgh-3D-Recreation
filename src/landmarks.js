import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { footprintCentroid, footprintWaterOverlap, footprintLandBaseY } from './geo.js';
import { buildPointStatePark } from './point.js';
import { buildPncPark, buildAcrisureStadium, buildPpgArena } from './stadiums.js';

/**
 * Landmarks that cannot be an extruded footprint.
 *
 * Everything that IS a footprint - US Steel, PPG Place, the Cathedral of
 * Learning, Gulf, Koppers, Union Trust, the Courthouse, Phipps, the Convention
 * Center and the rest - is built by `architecture.js` instead, so it keeps the
 * city's facade textures, its tint and its merge bucket while still getting a
 * modelled crown. What is left here is the work that has no footprint to
 * extrude: the three venues, Point State Park, and the two inclines.
 */

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.45,
    metalness: opts.metalness ?? 0.2,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    envMapIntensity: opts.envMapIntensity ?? 0.6,
  });
}

function footprintBounds(f) {
  const [cx, cz] = footprintCentroid(f);
  let xx = 0;
  let zz = 0;
  let xz = 0;
  const n = f.length - 1;
  for (let i = 0; i < n; i++) {
    const dx = f[i][0] - cx;
    const dz = f[i][1] - cz;
    xx += dx * dx;
    zz += dz * dz;
    xz += dx * dz;
  }
  const yaw = 0.5 * Math.atan2(2 * xz, xx - zz);
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = f[i][0] - cx;
    const dz = f[i][1] - cz;
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    minX = Math.min(minX, lx);
    maxX = Math.max(maxX, lx);
    minZ = Math.min(minZ, lz);
    maxZ = Math.max(maxZ, lz);
  }
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    w: Math.max(8, maxX - minX),
    d: Math.max(8, maxZ - minZ),
    yaw,
    cx,
    cz,
  };
}

function addMerged(group, geoms, material, { cast = true, receive = true } = {}) {
  const usable = geoms.filter(Boolean);
  if (!usable.length) return;
  const merged = mergeGeometries(usable, false);
  if (!merged) return;
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  group.add(mesh);
  for (const g of usable) g.dispose();
}

/* ------------------------------------------------------------------ */
/* the inclines                                                        */
/* ------------------------------------------------------------------ */
/**
 * The two surviving funiculars, from the OSM `railway=funicular` alignments.
 * Endpoints are the real track ends; the station houses at each end are
 * ordinary OSM buildings and are drawn by the normal pass, so only the
 * trestle, the track and the cars belong here.
 *
 *   Duquesne Incline    793 ft of track, 400 ft of rise, opened 1877
 *   Monongahela Incline 635 ft of track, 369 ft of rise, opened 1870
 */
const INCLINES = [
  { n: 'Duquesne Incline', lower: [-1326.2, 128.5], upper: [-1419.3, 294.7], gauge: 5.2, cars: 2 },
  { n: 'Monongahela Incline', lower: [-246.5, 952.3], upper: [-330.2, 1069.4], gauge: 4.4, cars: 2 },
];

function buildIncline(spec, yFn) {
  const g = new THREE.Group();
  g.name = spec.n;
  const timber = mat(0x4a4038, { roughness: 0.86, metalness: 0.05 });
  const steel = mat(0x50565a, { roughness: 0.6, metalness: 0.55 });
  const carMat = mat(0x7a2622, { roughness: 0.52, metalness: 0.15, emissive: 0x180806, emissiveIntensity: 0.12 });

  const [x0, z0] = spec.lower;
  const [x1, z1] = spec.upper;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const run = Math.hypot(dx, dz);
  if (!(run > 20)) return g;
  const ux = dx / run;
  const uz = dz / run;
  const px = -uz;
  const pz = ux;

  // The deck is a straight line between the two station platforms; the bents
  // below it are what follow the hillside.
  const yLo = yFn(x0, z0) + 4.5;
  const yHi = yFn(x1, z1) + 3;
  const deckAt = (t) => yLo + (yHi - yLo) * t;
  const posAt = (t) => [x0 + dx * t, z0 + dz * t];

  const bents = [];
  const steps = Math.max(6, Math.round(run / 13));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [bx, bz] = posAt(t);
    const deckY = deckAt(t);
    const groundY = yFn(bx, bz);
    const drop = deckY - groundY;
    if (drop < 1) continue;
    for (const side of [-1, 1]) {
      const leg = new THREE.BoxGeometry(0.9, drop, 0.9);
      leg.translate(bx + px * side * spec.gauge * 0.5, groundY + drop * 0.5, bz + pz * side * spec.gauge * 0.5);
      bents.push(leg);
    }
    const cap = new THREE.BoxGeometry(spec.gauge + 1.6, 0.8, 1);
    cap.rotateY(-Math.atan2(pz, px));
    cap.translate(bx, deckY - 0.9, bz);
    bents.push(cap);
  }
  addMerged(g, bents, timber);

  const rails = [];
  const pitch = Math.atan2(yHi - yLo, run);
  for (const side of [-1, 1]) {
    const rail = new THREE.BoxGeometry(0.34, 0.34, run);
    rail.rotateX(-pitch);
    rail.rotateY(Math.atan2(ux, uz));
    rail.translate(
      (x0 + x1) * 0.5 + px * side * spec.gauge * 0.42,
      (yLo + yHi) * 0.5,
      (z0 + z1) * 0.5 + pz * side * spec.gauge * 0.42,
    );
    rails.push(rail);
  }
  addMerged(g, rails, steel);

  // The two cars counterbalance, so they are always the same distance from
  // opposite ends of the run.
  const cars = [];
  for (let i = 0; i < spec.cars; i++) {
    const t = i === 0 ? 0.28 : 0.72;
    const [bx, bz] = posAt(t);
    const y = deckAt(t);
    const body = new THREE.BoxGeometry(spec.gauge * 0.86, 5.4, 8.4);
    body.rotateX(-pitch);
    body.rotateY(Math.atan2(ux, uz));
    body.translate(bx, y + 2.4, bz);
    cars.push(body);
  }
  addMerged(g, cars, carMat);
  return g;
}

/* ------------------------------------------------------------------ */
/* venues                                                              */
/* ------------------------------------------------------------------ */

/**
 * Bearing from a point to the Golden Triangle, used to aim the features that
 * real buildings deliberately turn toward the skyline (the arena's glass
 * atrium, for one).
 */
const DOWNTOWN = [180, 70];
function downtownBearing(x, z) {
  return Math.atan2(DOWNTOWN[1] - z, DOWNTOWN[0] - x);
}

const BUILDERS = {
  'pnc-park': (b) => buildPncPark({ h: b.h, f: b.f, orientYaw: b.field?.open }),
  'acrisure-stadium': (b) => buildAcrisureStadium({ h: b.h, f: b.f, orientYaw: b.field?.open }),
  'ppg-arena': (b, frame) =>
    buildPpgArena({ h: b.h, f: b.f, orientYaw: downtownBearing(frame.cx, frame.cz) }),
};

/**
 * Venues carry a `field` record solved from the real OSM playing surface: the
 * bowl is centred on the field rather than the footprint, and `open` is the
 * world bearing the seating opens toward. Those already encode orientation, so
 * the footprint's own principal axis must not be applied on top.
 */
const STADIUM_MESHES = new Set(['pnc-park', 'acrisure-stadium', 'ppg-arena']);

function landmarkScore(b) {
  const bb = footprintBounds(b.f);
  return (b.h || 0) + bb.w * bb.d * 0.002;
}

function dedupeLandmarkBuildings(buildings) {
  const singletons = new Map();
  for (const b of buildings) {
    if (!b.f || !BUILDERS[b.landmarkMesh]) continue;
    const prev = singletons.get(b.landmarkMesh);
    if (!prev || landmarkScore(b) > landmarkScore(prev)) singletons.set(b.landmarkMesh, b);
  }
  return [...singletons.values()];
}

export function buildLandmarkMeshes(
  buildings,
  yFn,
  waterIndex = null,
  pointPark = null,
  waterCull = null,
) {
  const group = new THREE.Group();
  group.name = 'landmarks';

  // Base heights come off the true water outline; the cull test uses the eroded
  // one so riverfront venues are not thrown away for overhanging a bank.
  const cull = waterCull || waterIndex;

  const place = (b, mesh, seated) => {
    const [cx, cz] = footprintCentroid(b.f);
    const baseY = waterIndex ? footprintLandBaseY(b.f, yFn, waterIndex) : yFn(cx, cz);
    const frame = footprintBounds(b.f);
    const [px, pz] = seated && b.field?.c ? b.field.c : [frame.cx, frame.cz];
    mesh.position.set(px, baseY, pz);
    if (!seated) mesh.rotation.y = -frame.yaw;
    group.add(mesh);
  };

  for (const b of dedupeLandmarkBuildings(buildings)) {
    if (cull && footprintWaterOverlap(b.f, cull) > 0.35) continue;
    try {
      place(b, BUILDERS[b.landmarkMesh](b, footprintBounds(b.f)), STADIUM_MESHES.has(b.landmarkMesh));
    } catch (err) {
      console.warn('Landmark mesh failed:', b.n, err);
    }
  }

  group.add(buildPointStatePark(yFn, pointPark));
  for (const spec of INCLINES) group.add(buildIncline(spec, yFn));

  return group;
}

export function isLandmarkMeshBuilding(b) {
  return Boolean(b.landmarkMesh && BUILDERS[b.landmarkMesh]);
}
