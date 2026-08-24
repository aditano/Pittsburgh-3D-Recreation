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

function ringSignedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/**
 * True inward polygon offset with mitred joins, preserving vertex count so the
 * result still pairs 1:1 with the source ring for `bandGeometry`.
 *
 * The park is a 540 x 400 m wedge whose vertices sit anywhere from 88 m to 365 m
 * off the centroid, so scaling toward the centroid varies the offset over 4x and
 * leaves the seawall and walk visibly tapering. Miters are clamped because the
 * confluence tip is acute enough to throw a spike clear across the lawn.
 */
function insetRing(pts, metres) {
  const n = pts.length;
  if (n < 3 || !metres) return pts.map((p) => p.slice());
  const sign = ringSignedArea(pts) > 0 ? 1 : -1;

  const edges = [];
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % n];
    let dx = bx - ax;
    let dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) {
      edges.push(null);
      continue;
    }
    dx /= len;
    dz /= len;
    edges.push({ px: ax - dz * sign * metres, pz: az + dx * sign * metres, dx, dz });
  }

  const prevEdge = (i) => {
    for (let k = 1; k <= n; k++) {
      const e = edges[(i - k + n * 2) % n];
      if (e) return e;
    }
    return null;
  };

  const maxMiter = Math.abs(metres) * 3;
  const out = [];
  for (let i = 0; i < n; i++) {
    const cur = edges[i] || prevEdge(i);
    const prev = prevEdge(i);
    if (!cur || !prev) {
      out.push(pts[i].slice());
      continue;
    }
    const cross = prev.dx * cur.dz - prev.dz * cur.dx;
    let p;
    if (Math.abs(cross) < 1e-6) {
      p = [cur.px, cur.pz];
    } else {
      const s = ((cur.px - prev.px) * cur.dz - (cur.pz - prev.pz) * cur.dx) / cross;
      p = [prev.px + prev.dx * s, prev.pz + prev.dz * s];
    }
    const travel = Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]);
    if (travel > maxMiter) {
      const k = maxMiter / travel;
      p = [pts[i][0] + (p[0] - pts[i][0]) * k, pts[i][1] + (p[1] - pts[i][1]) * k];
    }
    out.push(p);
  }
  return out;
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

/**
 * Edges of Fort Duquesne's bastioned square, centred on FORT_TRACE and turned so
 * a bastion points down the confluence. The fort was small: roughly 50 m across
 * the curtains, with the bastions carrying it out further.
 */
function fortOutline() {
  const a = 25;
  const g = 9;
  const q = 9;
  const ring = [];
  const corners = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  for (let i = 0; i < 4; i++) {
    const [sx, sz] = corners[i];
    const [nx, nz] = corners[(i + 1) % 4];
    // Curtain runs between this corner's shoulder and the next corner's, then
    // the shared bastion tip carries the outline around.
    if (sz === nz) {
      ring.push([sx * (a - g), sz * a], [nx * (a - g), nz * a]);
    } else {
      ring.push([sx * a, sz * (a - g)], [nx * a, nz * (a - g)]);
    }
    ring.push([nx * (a + q), nz * (a + q)]);
  }

  const yaw = -0.42;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const world = ring.map(([x, z]) => [
    FORT_TRACE[0] + x * c - z * s,
    FORT_TRACE[1] + x * s + z * c,
  ]);
  return world.map((p, i) => {
    const n = world[(i + 1) % world.length];
    return [p[0], p[1], n[0], n[1]];
  });
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

  // The jet throws about 150 ft. Additive blending is what makes it read as lit
  // spray: with straight alpha these nested surfaces look like glass tubes.
  const spray = (opacity) =>
    new THREE.MeshBasicMaterial({
      color: 0xdcecf6,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

  // A 150 ft jet is only about a metre across at the nozzle, so the column has
  // to stay thin and faint; anything heavier reads as a white post on the lawn.
  const JET_H = 46;
  const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.5, JET_H, 12, 1, true), spray(0.11));
  jet.position.set(FOUNTAIN[0], lawnY + 1.6 + JET_H * 0.5, FOUNTAIN[1]);
  g.add(jet);

  // Plume of spray thrown off the column, widening as it falls back to the basin.
  const fall = new THREE.Mesh(
    new THREE.CylinderGeometry(9, 1.2, JET_H * 0.92, 20, 1, true),
    spray(0.05),
  );
  fall.position.set(FOUNTAIN[0], lawnY + 1.6 + JET_H * 0.54, FOUNTAIN[1]);
  g.add(fall);

  const mist = new THREE.Mesh(
    new THREE.CylinderGeometry(FOUNTAIN_R - 6, FOUNTAIN_R - 13, 5, 26, 1, true),
    spray(0.05),
  );
  mist.position.set(FOUNTAIN[0], lawnY + 3, FOUNTAIN[1]);
  g.add(mist);

  // Granite trace of Fort Duquesne, laid in the paving where the fort stood.
  // It was a bastioned square: four curtain walls with an arrow-head bastion on
  // each corner, sited with a bastion facing the confluence.
  const traceGeoms = [];
  for (const [ax, az, bx, bz] of fortOutline()) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.round(len / 3.4));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const marker = new THREE.BoxGeometry((len / steps) * 0.78, 0.5, 1.3);
      marker.rotateY(-Math.atan2(dz, dx));
      marker.translate(ax + dx * t, lawnY + 0.25, az + dz * t);
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
  const plantable = insetRing(ring, 20);
  for (let x = -960; x <= -420; x += 26) {
    for (let z = -260; z <= 150; z += 26) {
      const jx = x + (hash01(x, z) - 0.5) * 18;
      const jz = z + (hash01(z, x) - 0.5) * 18;
      if (!pointInRing(jx, jz, plantable)) continue;
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
