import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { footprintCentroid, footprintWaterOverlap, footprintLandBaseY } from './geo.js';
import { buildPointStatePark } from './point.js';
import { buildPncPark, buildAcrisureStadium, buildPpgArena } from './stadiums.js';

/**
 * Landmarks that cannot be an extruded footprint.
 *
 * Everything that IS a footprint - US Steel, PPG Place, the Cathedral of
 * Learning, Gulf, Koppers, the Convention Center and the rest - is built by
 * `architecture.js` instead, so it keeps the city's facade textures, its tint
 * and its merge bucket while still getting a modelled crown. What is left here
 * is the work that has no footprint to extrude: the three venues, Point State
 * Park, the two inclines, and the handful of major buildings that the shipped
 * dataset is simply missing.
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

/**
 * World ring into the frame `buildLandmarkMeshes` places a group in: translated
 * to the footprint centroid and turned by the plan's principal axis.
 */
function localRing(f, frame) {
  const c = Math.cos(frame.yaw);
  const s = Math.sin(frame.yaw);
  const out = [];
  const n = f.length - 1;
  for (let i = 0; i < n; i++) {
    const dx = f[i][0] - frame.cx;
    const dz = f[i][1] - frame.cz;
    out.push([dx * c + dz * s, -dx * s + dz * c]);
  }
  return out;
}

/** Prism over an arbitrary local ring, standing on y0. */
function prism(ring, y0, y1, holes = []) {
  const shape = new THREE.Shape();
  shape.moveTo(ring[0][0], -ring[0][1]);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i][0], -ring[i][1]);
  shape.closePath();
  for (const hole of holes) {
    const path = new THREE.Path();
    path.moveTo(hole[0][0], -hole[0][1]);
    for (let i = 1; i < hole.length; i++) path.lineTo(hole[i][0], -hole[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  const geom = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, y0, 0);
  return geom;
}

/** Ring scaled about its own centroid, used for setbacks and roof ridges. */
function shrinkRing(ring, k) {
  let cx = 0;
  let cz = 0;
  for (const [x, z] of ring) {
    cx += x;
    cz += z;
  }
  cx /= ring.length;
  cz /= ring.length;
  return ring.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k]);
}

/** Closed skirt between two rings at different heights - a mansard or a hip. */
function slopeGeometry(lower, upper, yLo, yHi) {
  const pos = [];
  const n = lower.length;
  for (let i = 0; i < n; i++) {
    const a = lower[i];
    const b = lower[(i + 1) % n];
    const c = upper[(i + 1) % n];
    const d = upper[i];
    pos.push(a[0], yLo, a[1], d[0], yHi, d[1], c[0], yHi, c[1]);
    pos.push(a[0], yLo, a[1], c[0], yHi, c[1], b[0], yLo, b[1]);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  return geom;
}

/**
 * Storey bands cut into a wall as thin recessed strips. These buildings are
 * missing from the dataset, so they do not get the city's facade texture and
 * have to carry their fenestration in geometry or read as blank slabs.
 */
function windowBands(ring, y0, y1, floorH, inset) {
  const geoms = [];
  const inner = shrinkRing(ring, 1 - inset / Math.max(12, ringRadius(ring)));
  for (let y = y0 + floorH * 0.55; y < y1 - floorH * 0.4; y += floorH) {
    geoms.push(bandGeometry(inner, y, Math.min(floorH * 0.5, y1 - y - 0.4)));
  }
  return geoms.length ? mergeGeometries(geoms, false) : null;
}

function ringRadius(ring) {
  let cx = 0;
  let cz = 0;
  for (const [x, z] of ring) {
    cx += x;
    cz += z;
  }
  cx /= ring.length;
  cz /= ring.length;
  let r = 0;
  for (const [x, z] of ring) r = Math.max(r, Math.hypot(x - cx, z - cz));
  return r;
}

function bandGeometry(ring, y, h) {
  const pos = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    pos.push(a[0], y, a[1], a[0], y + h, a[1], b[0], y + h, b[1]);
    pos.push(a[0], y, a[1], b[0], y + h, b[1], b[0], y, b[1]);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  return geom;
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
/* landmarks the shipped dataset does not contain                      */
/* ------------------------------------------------------------------ */

/**
 * Footprints lifted straight from Overpass and projected with the same
 * transform as the rest of the city (scripts/osm.mjs), so they land on their
 * real blocks. Each is skipped the moment a building of that name appears in
 * public/data/pittsburgh.json, which is where they belong.
 */
const MISSING = [
  {
    n: 'Union Trust Building',
    match: /union trust/i,
    // OSM way 121046649. Osterling, 1917: 237 ft to the roof over 15 floors,
    // Flemish-Gothic, with a terra-cotta mansard, dormers on every face and
    // two chapel-like mechanical towers standing on the ridge.
    f: [
      [465.72, 105.45], [467.53, 101.71], [466.81, 99.17], [458.45, 94.43], [411.07, 71.14],
      [408.34, 71.93], [393, 102.28], [375.85, 136.02], [376.41, 138.53], [399.93, 150.34],
      [432.32, 166.59], [435.02, 165.14], [454.01, 128.41], [465.72, 105.45],
    ],
    h: 72,
    build: buildUnionTrust,
  },
  {
    n: 'Allegheny County Courthouse',
    match: /allegheny county courthouse/i,
    // OSM relation 2730675, outer way 203445067, simplified to the four main
    // corners. Richardson, 1888: a granite block round a courtyard, hipped
    // roofs and dormers, and a 300 ft tower on the Grant Street front.
    f: [[419.26, 253.26], [447.03, 197], [527.95, 236.04], [500.35, 293.5], [419.26, 253.26]],
    h: 30.5,
    build: buildCourthouse,
  },
  {
    n: 'Phipps Conservatory',
    match: /phipps conservatory/i,
    // OSM way 207207952, the historic Lord & Burnham glasshouse of 1893: a
    // domed Palm Court with barrel-vaulted display houses running off it.
    f: [
      [4560.42, 92.62], [4573.42, 124.7], [4586.02, 151.9], [4563.42, 169.7],
      [4547.52, 179.74], [4527.32, 199.33], [4510.66, 183.02], [4517.12, 85.56],
      [4531.5, 89.53], [4560.42, 92.62],
    ],
    h: 20,
    build: buildPhipps,
  },
];

function buildUnionTrust(ring, h) {
  const g = new THREE.Group();
  const stone = mat(0xb4a892, { roughness: 0.82, metalness: 0.05 });
  const terracotta = mat(0x4e5a50, { roughness: 0.68, metalness: 0.14 });
  const glass = mat(0x1c2630, { roughness: 0.3, metalness: 0.5, emissive: 0x24303c, emissiveIntensity: 0.35 });

  // shaft to the eaves, then the mansard occupying the top four storeys
  const eave = h * 0.72;
  const shaft = shrinkRing(ring, 0.985);
  addMerged(g, [prism(ring, 0, eave)], stone);
  addMerged(g, [windowBands(shaft, 5, eave - 3, 4.6, 0.5)], glass, { cast: false });

  const ridge = shrinkRing(ring, 0.7);
  addMerged(g, [slopeGeometry(shrinkRing(ring, 1.01), ridge, eave, h)], terracotta);
  addMerged(g, [prism(ridge, h - 0.4, h)], terracotta);

  // dormers along the mansard, and the two "little chapels" over the ridge
  const dormers = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 12) continue;
    const count = Math.max(1, Math.round(len / 11));
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count;
      const px = a[0] + dx * t;
      const pz = a[1] + dz * t;
      const box = new THREE.BoxGeometry(4.2, 5, 3.4);
      box.rotateY(-Math.atan2(dz, dx));
      box.translate(px * 0.94, eave + 3.4, pz * 0.94);
      dormers.push(box);
      const cap = new THREE.ConeGeometry(2.9, 3.2, 4);
      cap.rotateY(Math.PI / 4);
      cap.translate(px * 0.94, eave + 7.4, pz * 0.94);
      dormers.push(cap);
    }
  }
  addMerged(g, dormers, terracotta);

  const chapels = [];
  for (const side of [-1, 1]) {
    const cx = side * ringRadius(ring) * 0.3;
    const tower = new THREE.BoxGeometry(9, 13, 9);
    tower.translate(cx, h + 6.5, 0);
    chapels.push(tower);
    const spire = new THREE.ConeGeometry(6.4, 14, 4);
    spire.rotateY(Math.PI / 4);
    spire.translate(cx, h + 20, 0);
    chapels.push(spire);
    for (let i = 0; i < 4; i++) {
      const t = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const pin = new THREE.ConeGeometry(1, 5, 4);
      pin.translate(cx + Math.cos(t) * 5, h + 15, Math.sin(t) * 5);
      chapels.push(pin);
    }
  }
  addMerged(g, chapels, stone);
  return g;
}

function buildCourthouse(ring, h) {
  const g = new THREE.Group();
  const granite = mat(0x87806f, { roughness: 0.88, metalness: 0.04 });
  const slate = mat(0x38403f, { roughness: 0.7, metalness: 0.12 });
  const glass = mat(0x1a222a, { roughness: 0.35, metalness: 0.45, emissive: 0x202832, emissiveIntensity: 0.3 });

  const court = shrinkRing(ring, 0.44);
  addMerged(g, [prism(ring, 0, h, [court.slice().reverse()])], granite);
  addMerged(g, [windowBands(shrinkRing(ring, 0.99), 4, h - 4, 6.2, 0.55)], glass, { cast: false });

  // hipped roofs over the four ranges, with dormers picking out the attic
  const eave = h;
  addMerged(g, [slopeGeometry(shrinkRing(ring, 1.015), shrinkRing(ring, 0.78), eave, eave + 7)], slate);
  addMerged(g, [slopeGeometry(court, shrinkRing(court, 1.18), eave + 7, eave)], slate);

  const corners = [];
  for (const [x, z] of shrinkRing(ring, 0.9)) {
    const turret = new THREE.CylinderGeometry(3.4, 3.8, 12, 8);
    turret.translate(x, h + 2, z);
    corners.push(turret);
    const cap = new THREE.ConeGeometry(4.1, 8, 8);
    cap.translate(x, h + 12, z);
    corners.push(cap);
  }
  addMerged(g, corners, granite);

  // The Grant Street tower: 300 ft, square, with a steep pyramidal cap and a
  // corner turret at each shoulder. Grant Street runs along the west front,
  // between the ring's first two corners.
  const west = [(ring[0][0] + ring[1][0]) * 0.5, (ring[0][1] + ring[1][1]) * 0.5];
  const inward = [-west[0] * 0.16, -west[1] * 0.16];
  const tx = west[0] + inward[0];
  const tz = west[1] + inward[1];
  const TOWER_H = 91;
  const tower = [];
  const shaft = new THREE.BoxGeometry(17, TOWER_H, 17);
  shaft.translate(tx, TOWER_H * 0.5, tz);
  tower.push(shaft);
  const belfry = new THREE.BoxGeometry(19, 9, 19);
  belfry.translate(tx, TOWER_H + 4.5, tz);
  tower.push(belfry);
  for (let i = 0; i < 4; i++) {
    const t = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const turret = new THREE.CylinderGeometry(2.4, 2.6, 22, 8);
    turret.translate(tx + Math.cos(t) * 9.4, TOWER_H - 3, tz + Math.sin(t) * 9.4);
    tower.push(turret);
    const cap = new THREE.ConeGeometry(3, 7, 8);
    cap.translate(tx + Math.cos(t) * 9.4, TOWER_H + 11.5, tz + Math.sin(t) * 9.4);
    tower.push(cap);
  }
  addMerged(g, tower, granite);

  const roof = new THREE.ConeGeometry(14, 22, 4);
  roof.rotateY(Math.PI / 4);
  roof.translate(tx, TOWER_H + 20, tz);
  addMerged(g, [roof], slate);
  return g;
}

function buildPhipps(ring, h) {
  const g = new THREE.Group();
  const frame = mat(0xe4e8e4, { roughness: 0.5, metalness: 0.18 });
  const glass = mat(0xbcd8d0, {
    roughness: 0.1,
    metalness: 0.25,
    transparent: true,
    opacity: 0.62,
    emissive: 0x87b8a8,
    emissiveIntensity: 0.3,
    side: THREE.DoubleSide,
    envMapIntensity: 1.3,
  });

  const wallH = h * 0.32;
  addMerged(g, [prism(ring, 0, 1.2)], frame);
  addMerged(g, [prism(shrinkRing(ring, 0.995), 1.2, wallH)], glass, { cast: false });

  // barrel-vaulted display houses running the length of the plan
  const ridge = shrinkRing(ring, 0.4);
  addMerged(g, [slopeGeometry(ring, ridge, wallH, wallH + h * 0.2)], glass, { cast: false });
  addMerged(g, [prism(ridge, wallH + h * 0.2, wallH + h * 0.2 + 0.5)], frame);

  // Palm Court dome over the centre, with two smaller houses flanking it
  const r = ringRadius(ring);
  const domes = [];
  for (const [ox, oz, k] of [[0, 0, 1], [-r * 0.36, r * 0.3, 0.52], [r * 0.3, -r * 0.34, 0.46]]) {
    const dome = new THREE.SphereGeometry(r * 0.3 * k, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
    dome.translate(ox, wallH + h * 0.1, oz);
    domes.push(dome);
    const lantern = new THREE.ConeGeometry(r * 0.06 * k, h * 0.16 * k, 8);
    lantern.translate(ox, wallH + h * 0.1 + r * 0.3 * k + h * 0.06 * k, oz);
    domes.push(lantern);
  }
  addMerged(g, domes, glass, { cast: false });

  // glazing bars, without which the domes read as soap bubbles
  const bars = [];
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    const rib = new THREE.TorusGeometry(r * 0.3, 0.18, 4, 14, Math.PI);
    rib.rotateY(t);
    rib.translate(0, wallH + h * 0.1, 0);
    bars.push(rib);
  }
  addMerged(g, bars, frame, { receive: false });
  return g;
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

  for (const lm of MISSING) {
    if (buildings.some((b) => b.n && lm.match.test(b.n))) continue;
    try {
      const frame = footprintBounds(lm.f);
      const mesh = lm.build(localRing(lm.f, frame), lm.h);
      mesh.name = lm.n;
      place({ f: lm.f }, mesh, false);
    } catch (err) {
      console.warn('Landmark mesh failed:', lm.n, err);
    }
  }

  group.add(buildPointStatePark(yFn, pointPark));
  for (const spec of INCLINES) group.add(buildIncline(spec, yFn));

  return group;
}

export function isLandmarkMeshBuilding(b) {
  return Boolean(b.landmarkMesh && BUILDERS[b.landmarkMesh]);
}
