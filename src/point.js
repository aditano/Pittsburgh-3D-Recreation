import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01 } from './geo.js';

/**
 * Point State Park, driven by the real OSM park outline in the city data.
 *
 * Real-world anchors, projected into local metres:
 *   fountain basin centre  40.441717 N, 80.011028 W  ->  (-765, -80)
 *   Fort Duquesne trace     ~40.44230 N, 80.01000 W  ->  (-678, -145)
 * The Fort Pitt Museum and Block House are real OSM buildings and are drawn by
 * the normal building pass, so they are deliberately absent here.
 */
const FOUNTAIN = [-765, -80];
const FOUNTAIN_R = 30.5;
const FORT_TRACE = [-678, -145];

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.78,
    metalness: opts.metalness ?? 0.04,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    depthWrite: opts.depthWrite ?? true,
    side: opts.side ?? THREE.FrontSide,
  });
}

function openRing(ring) {
  const n = ring.length;
  const closed = Math.hypot(ring[0][0] - ring[n - 1][0], ring[0][1] - ring[n - 1][1]) < 0.5;
  return closed ? ring.slice(0, -1) : ring.slice();
}

function centroidOf(pts) {
  let cx = 0;
  let cz = 0;
  for (const [x, z] of pts) {
    cx += x;
    cz += z;
  }
  return [cx / pts.length, cz / pts.length];
}

/** Scale a ring toward its centroid; enough for the park's convex outline. */
function insetRing(pts, metres) {
  const [cx, cz] = centroidOf(pts);
  let mean = 0;
  for (const [x, z] of pts) mean += Math.hypot(x - cx, z - cz);
  mean /= pts.length;
  const k = Math.max(0.05, 1 - metres / Math.max(mean, 1));
  return pts.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k]);
}

function shapeFrom(pts, holes = []) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], -pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], -pts[i][1]);
  shape.closePath();
  for (const hole of holes) {
    const path = new THREE.Path();
    path.moveTo(hole[0][0], -hole[0][1]);
    for (let i = 1; i < hole.length; i++) path.lineTo(hole[i][0], -hole[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

function flat(pts, y, holes = []) {
  const geom = new THREE.ShapeGeometry(shapeFrom(pts, holes));
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, y, 0);
  return geom;
}

function pointInRing(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-12) + xi) inside = !inside;
    j = i;
  }
  return inside;
}

/** Closed band between two rings, used for the seawall and perimeter walk. */
function bandGeometry(outer, inner, y) {
  const pos = [];
  const n = outer.length;
  for (let i = 0; i < n; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % n];
    const c = inner[(i + 1) % n];
    const d = inner[i];
    pos.push(a[0], y, a[1], d[0], y, d[1], c[0], y, c[1]);
    pos.push(a[0], y, a[1], c[0], y, c[1], b[0], y, b[1]);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  return geom;
}

export function buildPointStatePark(yFn, pointPark) {
  const g = new THREE.Group();
  g.name = 'point-state-park';
  if (!pointPark?.f || pointPark.f.length < 8) return g;

  const ring = openRing(pointPark.f);
  const baseY = Math.max(0.6, yFn(FOUNTAIN[0], FOUNTAIN[1]));
  const lawnY = baseY + 0.9;

  const seawallOuter = ring;
  const walkOuter = insetRing(ring, 2.5);
  const walkInner = insetRing(ring, 13);

  const wall = new THREE.Mesh(
    bandGeometry(seawallOuter, walkOuter, lawnY + 0.28),
    mat(0x8d8578, { roughness: 0.82 }),
  );
  wall.receiveShadow = true;
  g.add(wall);

  const walk = new THREE.Mesh(
    bandGeometry(walkOuter, walkInner, lawnY + 0.16),
    mat(0xbdb7a8, { roughness: 0.72, metalness: 0.05 }),
  );
  walk.receiveShadow = true;
  g.add(walk);

  const fountainCut = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    fountainCut.push([
      FOUNTAIN[0] + Math.cos(a) * (FOUNTAIN_R + 9),
      FOUNTAIN[1] + Math.sin(a) * (FOUNTAIN_R + 9),
    ]);
  }
  const lawn = new THREE.Mesh(
    flat(walkInner, lawnY, [fountainCut]),
    mat(0x3f6f3c, { roughness: 0.96 }),
  );
  lawn.receiveShadow = true;
  g.add(lawn);

  const plaza = new THREE.Mesh(
    flat(fountainCut, lawnY + 0.1),
    mat(0xc4beb0, { roughness: 0.7, metalness: 0.05 }),
  );
  plaza.receiveShadow = true;
  g.add(plaza);

  // Fountain: 200 ft granite basin with a single high central jet.
  const basinMat = mat(0x9aa4a8, { roughness: 0.38, metalness: 0.22 });
  const coping = new THREE.Mesh(
    new THREE.CylinderGeometry(FOUNTAIN_R, FOUNTAIN_R + 1.4, 1.6, 56),
    basinMat,
  );
  coping.position.set(FOUNTAIN[0], lawnY + 0.8, FOUNTAIN[1]);
  coping.castShadow = true;
  coping.receiveShadow = true;
  g.add(coping);

  const pool = new THREE.Mesh(
    new THREE.CylinderGeometry(FOUNTAIN_R - 2.2, FOUNTAIN_R - 2.2, 0.6, 56),
    mat(0x2f7d9e, {
      roughness: 0.1,
      metalness: 0.4,
      emissive: 0x123a4e,
      emissiveIntensity: 0.25,
    }),
  );
  pool.position.set(FOUNTAIN[0], lawnY + 1.35, FOUNTAIN[1]);
  g.add(pool);

  const nozzle = new THREE.Mesh(
    new THREE.CylinderGeometry(2.6, 4.2, 2.4, 20),
    basinMat,
  );
  nozzle.position.set(FOUNTAIN[0], lawnY + 2.1, FOUNTAIN[1]);
  g.add(nozzle);

  const sprayMat = mat(0xe4f2fa, {
    roughness: 0.15,
    metalness: 0.02,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const plume = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 3.4, 46, 16, 1, true), sprayMat);
  plume.position.set(FOUNTAIN[0], lawnY + 25, FOUNTAIN[1]);
  g.add(plume);
  const crown = new THREE.Mesh(new THREE.ConeGeometry(9, 16, 20, 1, true), sprayMat);
  crown.position.set(FOUNTAIN[0], lawnY + 50, FOUNTAIN[1]);
  g.add(crown);
  const mist = new THREE.Mesh(new THREE.ConeGeometry(FOUNTAIN_R - 4, 12, 28, 1, true), sprayMat);
  mist.position.set(FOUNTAIN[0], lawnY + 6, FOUNTAIN[1]);
  g.add(mist);

  // Granite trace of the original Fort Duquesne outline.
  const traceGeoms = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    for (let k = 0; k < 7; k++) {
      const b = a + (k / 7) * ((Math.PI * 2) / 5);
      const r = 34;
      const gx = FORT_TRACE[0] + Math.cos(b) * r;
      const gz = FORT_TRACE[1] + Math.sin(b) * r * 0.82;
      const marker = new THREE.BoxGeometry(3.2, 0.5, 1.4);
      marker.rotateY(-b);
      marker.translate(gx, lawnY + 0.25, gz);
      traceGeoms.push(marker);
    }
  }
  const trace = new THREE.Mesh(mergeGeometries(traceGeoms, false), mat(0xa8a29a, { roughness: 0.68 }));
  trace.receiveShadow = true;
  g.add(trace);
  for (const t of traceGeoms) t.dispose();

  // Allée of trees along the lawn edges, kept clear of the fountain plaza.
  const dummy = new THREE.Object3D();
  const spots = [];
  for (let x = -960; x <= -420; x += 26) {
    for (let z = -260; z <= 150; z += 26) {
      const jx = x + (hash01(x, z) - 0.5) * 18;
      const jz = z + (hash01(z, x) - 0.5) * 18;
      if (!pointInRing(jx, jz, insetRing(ring, 20))) continue;
      if (Math.hypot(jx - FOUNTAIN[0], jz - FOUNTAIN[1]) < FOUNTAIN_R + 26) continue;
      if (Math.hypot(jx - FORT_TRACE[0], jz - FORT_TRACE[1]) < 44) continue;
      if (hash01(jz, jx) < 0.45) continue;
      spots.push([jx, jz]);
    }
  }
  if (spots.length) {
    const trees = new THREE.InstancedMesh(
      new THREE.ConeGeometry(4.4, 12, 7),
      mat(0x21421f, { roughness: 1 }),
      spots.length,
    );
    spots.forEach((p, i) => {
      const s = 0.75 + hash01(p[0], p[1]) * 0.6;
      dummy.position.set(p[0], lawnY + 6 * s, p[1]);
      dummy.scale.setScalar(s);
      dummy.rotation.y = hash01(p[1], p[0]) * Math.PI * 2;
      dummy.updateMatrix();
      trees.setMatrixAt(i, dummy.matrix);
    });
    trees.castShadow = true;
    trees.receiveShadow = true;
    g.add(trees);
  }

  return g;
}
