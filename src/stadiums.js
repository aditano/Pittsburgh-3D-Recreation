import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const DEG = Math.PI / 180;
const FT = 0.3048;

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

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Oriented extents of a footprint, matching the PCA frame that landmarks.js rotates groups into. */
function orientedExtents(f) {
  if (!Array.isArray(f) || f.length < 3) return { long: 0, short: 0 };
  const pts = f.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 3) return { long: 0, short: 0 };
  const n = pts.length - (pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? 1 : 0);
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i][0];
    cz += pts[i][1];
  }
  cx /= n;
  cz /= n;
  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i][0] - cx;
    const dz = pts[i][1] - cz;
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
    const dx = pts[i][0] - cx;
    const dz = pts[i][1] - cz;
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    minX = Math.min(minX, lx);
    maxX = Math.max(maxX, lx);
    minZ = Math.min(minZ, lz);
    maxZ = Math.max(maxZ, lz);
  }
  const w = maxX - minX;
  const d = maxZ - minZ;
  if (!Number.isFinite(w) || !Number.isFinite(d)) return { long: 0, short: 0 };
  return { long: Math.max(w, d), short: Math.min(w, d) };
}

/** Footprints in this dataset are unreliable, so the venue keeps real dimensions and only breathes a little. */
function fitScale(f, nomLong, nomShort, lo = 0.86, hi = 1.12) {
  const e = orientedExtents(f);
  if (e.long < 40 || e.short < 30) return 1;
  return clamp(Math.min(e.long / nomLong, e.short / nomShort), lo, hi);
}

/**
 * Playing-surface bearings surveyed off the OSM pitch rings that back this
 * dataset. Acrisure's ring is the field-level enclosure -- its minimum-area
 * rectangle is 123.3 x 86.2 m at 64.5 deg, which is the 109.7 x 48.8 m field
 * plus the published 25 ft end-line and 60 ft sideline setbacks to the first
 * row -- and PNC's ring carries a 66 m straight third-base foul line at
 * -15.3 deg, so its home-plate-to-centre axis bisects the foul lines at 29.7.
 *
 * The shipped `field.open` is a principal-axis estimate over those same rings
 * sampled unevenly (and, for baseball, a footprint-centroid offset), which
 * lands 10-16 deg off. It is still the authority on WHICH end opens, so the
 * surveyed bearing is only used when the two agree about that.
 */
function surveyedAxis(supplied, surveyed) {
  if (!Number.isFinite(supplied)) return surveyed;
  const d = Math.atan2(Math.sin(supplied - surveyed), Math.cos(supplied - surveyed));
  return Math.abs(d) < 40 * DEG ? surveyed : supplied;
}

function box(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/**
 * Box tilted in the plane of a facade: local +X is the length, tilted by
 * `tilt` in the wall plane before the wall's own yaw is applied. This is what
 * draws diagonal bracing and raking struts rather than only orthogonal members.
 */
function brace(len, thick, depth, tilt, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(len, thick, depth);
  g.rotateZ(tilt);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

function cyl(rTop, rBottom, h, seg, x, y, z, ry = 0) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** Signed-area centroid of a plan ring, used to pin a venue by its playing surface. */
function polygonCentroid(pts) {
  let a2 = 0;
  let cx = 0;
  let cz = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % n];
    const cross = x0 * z1 - x1 * z0;
    a2 += cross;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  if (Math.abs(a2) < 1e-6) return [0, 0];
  return [cx / (3 * a2), cz / (3 * a2)];
}

/**
 * Parks the assembled venue so model point (ax, az) lands on the group origin.
 * landmarks.js drops stadiums on the real field centroid, so the venue has to
 * be pinned by a known point on its playing surface: centring on the whole
 * bounding box instead would let scoreboards and light towers drag the seating
 * off the site.
 */
function anchorAndAttach(core, parent, ax, az) {
  core.position.set(-ax, 0, -az);
  parent.add(core);
}

/** Parks the assembled venue so the group origin lands on its plan centre. */
function centerAndAttach(core, parent) {
  core.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(core);
  if (!bb.isEmpty() && Number.isFinite(bb.min.x) && Number.isFinite(bb.max.z)) {
    const c = bb.getCenter(new THREE.Vector3());
    core.position.set(-c.x, 0, -c.z);
  }
  parent.add(core);
}

function meshFrom(geoms, material, cast = true, receive = true) {
  const usable = geoms.filter(Boolean);
  if (!usable.length) return null;
  const merged = usable.length === 1 ? usable[0] : mergeGeometries(usable, false);
  if (usable.length > 1) for (const g of usable) g.dispose();
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

// ---------------------------------------------------------------------------
// Swept-ribbon bowl construction
// ---------------------------------------------------------------------------

/**
 * Samples a 2D plan curve into path nodes carrying an outward normal.
 * Node normals point AWAY from the enclosed field, which is the direction the
 * seating profile grows in; that convention also fixes the triangle winding.
 */
function buildPath(fn, segs, t0 = 0, t1 = 1, closed = false) {
  const nodes = [];
  const count = closed ? segs : segs + 1;
  const span = t1 - t0;
  const eps = Math.abs(span) / (segs * 64) || 1e-4;
  for (let i = 0; i < count; i++) {
    const t = t0 + (span * i) / segs;
    const a = fn(t - eps);
    const b = fn(t + eps);
    let tx = b[0] - a[0];
    let tz = b[1] - a[1];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const p = fn(t);
    nodes.push({ x: p[0], z: p[1], nx: tz, nz: -tx });
  }
  return nodes;
}

function offsetPath(path, d) {
  return path.map((p) => ({ x: p.x + p.nx * d, z: p.z + p.nz * d, nx: p.nx, nz: p.nz, su: p.su, sv: p.sv }));
}

/** rotation.y that lays a box's local +X tangent to a path and its +Z along the outward normal. */
function nodeYaw(p) {
  return Math.atan2(p.nx, p.nz);
}

function lerpNode(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    nx: a.nx + (b.nx - a.nx) * t,
    nz: a.nz + (b.nz - a.nz) * t,
    su: a.su,
    sv: a.sv,
  };
}

/** Box on a circular drum at polar angle `a`: local +X tangential, +Z outward. */
function drumBox(w, h, d, cx, cz, radius, y, a) {
  return box(w, h, d, cx + Math.cos(a) * radius, y, cz + Math.sin(a) * radius, Math.PI / 2 - a);
}

/**
 * Member laid along a path node's outward normal, so local +X runs radially out
 * from the bowl and `tilt` rakes it in the vertical plane through that normal.
 * Canopy trusses, roof rafters and dome ribs all run this way.
 */
function radialMember(len, thick, depth, tilt, p, u, y) {
  return brace(len, thick, depth, tilt, p.x + p.nx * u, y, p.z + p.nz * u, Math.atan2(-p.nz, p.nx));
}

function superEllipse(rx, rz, power) {
  return (t) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [rx * Math.sign(c) * Math.abs(c) ** power, rz * Math.sign(s) * Math.abs(s) ** power];
  };
}

/**
 * Rounded-rectangle plan, ray-cast from the centre so `t` stays a polar angle
 * and the curve drops into buildPath exactly like superEllipse does. Straight
 * runs stay straight, which is what makes a football bowl read as sidelines
 * rather than as an oval.
 */
function roundedRect(rx, rz, radius) {
  const ax = Math.max(rx - radius, 0.01);
  const az = Math.max(rz - radius, 0.01);
  const reach = Math.hypot(rx, rz);
  return (t) => {
    const dx = Math.cos(t);
    const dz = Math.sin(t);
    let lo = 0;
    let hi = reach;
    for (let i = 0; i < 26; i++) {
      const m = (lo + hi) * 0.5;
      const qx = Math.max(Math.abs(dx * m) - ax, 0);
      const qz = Math.max(Math.abs(dz * m) - az, 0);
      if (Math.hypot(qx, qz) < radius) lo = m;
      else hi = m;
    }
    return [dx * lo, dz * lo];
  };
}

function splineFn(points) {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'centripetal',
    0.5,
  );
  return (t) => {
    const v = curve.getPointAt(clamp(t, 0, 1));
    return [v.x, v.z];
  };
}

/** Arc-length parameterisation of a polyline, so a hard corner stays hard. */
function polylineFn(points) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const L = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    seg.push(L);
    total += L;
  }
  return (t) => {
    let d = clamp(t, 0, 1) * total;
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i] || i === seg.length - 1) {
        const f = seg[i] ? clamp(d / seg[i], 0, 1) : 0;
        return [lerp(points[i][0], points[i + 1][0], f), lerp(points[i][1], points[i + 1][1], f)];
      }
      d -= seg[i];
    }
    return points[points.length - 1];
  };
}

/**
 * Stepped seating cross-section in (outward distance, height).
 * `seats` is the raked stair, `shell` the top fascia plus outer wall, and
 * `closed` the full contour used for end caps -- they share vertices so the
 * two sweeps meet without a seam.
 *
 * `grow` stretches successive treads: real bowls rake harder toward the back,
 * and a constant rise is exactly what makes a deck read as smooth corduroy.
 */
function rakedSection({ u0, v0, steps, run, rise, fascia, base = 0, grow = 0 }) {
  const seats = [[u0, v0]];
  let u = u0;
  let v = v0;
  for (let i = 0; i < steps; i++) {
    const k = 1 + grow * (i / Math.max(steps - 1, 1));
    v += rise * k;
    seats.push([u, v]);
    u += run;
    seats.push([u, v]);
  }
  const shell = [
    [u, v],
    [u + fascia, v],
    [u + fascia, base],
  ];
  return {
    seats,
    shell,
    closed: seats.concat(shell.slice(1), [[u0, base]]),
    uOut: u + fascia,
    uTop: u,
    vTop: v,
    v0,
    u0,
  };
}

function sweepStrip(path, profile, closed = false) {
  const cols = path.length;
  const segs = profile.length - 1;
  if (cols < 2 || segs < 1) return null;
  const rows = segs * 2;
  const vertexCount = cols * rows;
  const pos = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  const along = new Float32Array(cols);
  for (let k = 1; k < cols; k++) {
    along[k] = along[k - 1] + Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z);
  }
  const across = new Float32Array(profile.length);
  for (let j = 1; j < profile.length; j++) {
    across[j] = across[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]);
  }

  let w = 0;
  for (let j = 0; j < segs; j++) {
    for (let e = 0; e < 2; e++) {
      const u = profile[j + e][0];
      const v = profile[j + e][1];
      for (let k = 0; k < cols; k++) {
        const p = path[k];
        const su = p.su ?? 1;
        const sv = p.sv ?? 1;
        pos[w * 3] = p.x + p.nx * u * su;
        pos[w * 3 + 1] = v * sv;
        pos[w * 3 + 2] = p.z + p.nz * u * su;
        uvs[w * 2] = along[k] / 16;
        uvs[w * 2 + 1] = across[j + e] / 16;
        w++;
      }
    }
  }

  const spans = closed ? cols : cols - 1;
  const idx = new Uint32Array(spans * segs * 6);
  let q = 0;
  for (let j = 0; j < segs; j++) {
    const rowA = j * 2 * cols;
    const rowB = (j * 2 + 1) * cols;
    for (let k = 0; k < spans; k++) {
      const k1 = (k + 1) % cols;
      const a = rowA + k;
      const b = rowA + k1;
      const c = rowB + k1;
      const d = rowB + k;
      idx[q++] = a;
      idx[q++] = b;
      idx[q++] = d;
      idx[q++] = b;
      idx[q++] = c;
      idx[q++] = d;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.computeVertexNormals();
  return geom;
}

/** Flat end wall closing an open seating ribbon; emitted double-wound so it reads from either side. */
function sectionCap(section, node) {
  const contour = section.map(([u, v]) => new THREE.Vector2(u, v));
  let faces = null;
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    return null;
  }
  if (!faces || !faces.length) return null;
  const n = contour.length;
  const pos = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = node.x + node.nx * contour[i].x;
    pos[i * 3 + 1] = contour[i].y;
    pos[i * 3 + 2] = node.z + node.nz * contour[i].x;
    uvs[i * 2] = contour[i].x / 16;
    uvs[i * 2 + 1] = contour[i].y / 16;
  }
  const idx = new Uint32Array(faces.length * 6);
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    idx[i * 6] = f[0];
    idx[i * 6 + 1] = f[1];
    idx[i * 6 + 2] = f[2];
    idx[i * 6 + 3] = f[2];
    idx[i * 6 + 4] = f[1];
    idx[i * 6 + 5] = f[0];
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.computeVertexNormals();
  return geom;
}

/**
 * A seating tier: raked treads in the seat colour, a pale stepped aisle every
 * `aisleStep` nodes, and dark vomitory mouths punched through the back riser.
 * The radial aisles are what break a bowl into wedge-shaped sections; without
 * them a swept deck reads as one continuous corduroy ramp.
 *
 * An aisle is a 4 ft walkway between 60 ft wide sections, so it has to be drawn
 * as a narrow strip inside one node span rather than the whole span -- a full
 * span makes the pale concrete a fifth of the bowl surface and the deck reads as
 * corduroy from the air, which is the opposite of the intended effect.
 */
function seatingTier({
  path,
  section,
  closed = false,
  seats,
  aisles,
  dark,
  aisleStep = 6,
  aisleFrom = 0,
  aisleFrac = 0.3,
  vomStep = 0,
  vomWidth = 3.2,
}) {
  seats.push(sweepStrip(path, section.seats, closed));
  const lifted = section.seats.map(([u, v]) => [u, v + 0.12]);
  const spans = closed ? path.length : path.length - 1;
  if (aisles && aisleStep > 0) {
    const half = aisleFrac / 2;
    for (let i = aisleFrom; i < spans; i += aisleStep) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      aisles.push(sweepStrip([lerpNode(a, b, 0.5 - half), lerpNode(a, b, 0.5 + half)], lifted));
    }
  }
  if (dark && vomStep > 0) {
    const backU = section.uTop - 1.6;
    for (let i = Math.floor(vomStep / 2); i < spans; i += vomStep) {
      const p = path[i];
      dark.push(
        box(vomWidth, 3.0, 2.4, p.x + p.nx * backU, section.vTop - 1.2, p.z + p.nz * backU, nodeYaw(p)),
      );
    }
  }
}

/**
 * Exterior bay rhythm: a column every `step` nodes standing off the wall line,
 * with an optional diagonal brace pair in every other bay. Real stadium
 * exteriors are read almost entirely from this vertical rhythm, so a flat
 * swept wall always looks like a warehouse.
 */
function colonnade({ path, y0, y1, step, colW, colD, cols, braces, braceEvery = 0, braceBands = [], outset = 0 }) {
  const spans = path.length - 1;
  for (let i = 0; i < path.length; i += step) {
    const p = path[i];
    const a = nodeYaw(p);
    cols.push(box(colW, y1 - y0, colD, p.x + p.nx * outset, (y0 + y1) * 0.5, p.z + p.nz * outset, a));
    if (!braces || !braceEvery || i % (step * braceEvery) !== 0 || i + step > spans) continue;
    const q = path[Math.min(i + step, spans)];
    const bay = Math.hypot(q.x - p.x, q.z - p.z);
    const mx = (p.x + q.x) * 0.5 + p.nx * outset;
    const mz = (p.z + q.z) * 0.5 + p.nz * outset;
    for (const [b0, b1] of braceBands) {
      const rise = b1 - b0;
      const diag = Math.hypot(bay, rise);
      const tilt = Math.atan2(rise, bay);
      for (const sgn of [1, -1]) {
        braces.push(brace(diag, 0.5, colD * 0.5, sgn * tilt, mx, (b0 + b1) * 0.5, mz, a));
      }
    }
  }
}

function flipIfDownward(geom) {
  const idx = geom.getIndex();
  const pos = geom.attributes.position;
  if (!idx) return geom;
  let acc = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(pos, idx.getX(i));
    b.fromBufferAttribute(pos, idx.getX(i + 1));
    c.fromBufferAttribute(pos, idx.getX(i + 2));
    b.sub(a);
    c.sub(a);
    acc += b.z * c.x - b.x * c.z;
  }
  if (acc < 0) {
    for (let i = 0; i < idx.count; i += 3) {
      const t = idx.getX(i);
      idx.setX(i, idx.getX(i + 2));
      idx.setX(i + 2, t);
    }
    idx.needsUpdate = true;
    geom.computeVertexNormals();
  }
  return geom;
}

/** Shallow domed cap over a closed plan curve. */
function domeCap(fn, segs, rings, y0, rise) {
  const ring = buildPath(fn, segs, 0, Math.PI * 2, true);
  const cols = ring.length;
  const vertexCount = cols * rings + 1;
  const pos = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let i = 0; i < rings; i++) {
    const s = 1 - i / rings;
    const y = y0 + rise * (1 - s * s);
    for (let k = 0; k < cols; k++) {
      const w = i * cols + k;
      pos[w * 3] = ring[k].x * s;
      pos[w * 3 + 1] = y;
      pos[w * 3 + 2] = ring[k].z * s;
      uvs[w * 2] = k / cols;
      uvs[w * 2 + 1] = i / rings;
    }
  }
  const apex = cols * rings;
  pos[apex * 3 + 1] = y0 + rise;
  uvs[apex * 2] = 0.5;
  uvs[apex * 2 + 1] = 1;

  const idx = new Uint32Array(cols * (rings - 1) * 6 + cols * 3);
  let q = 0;
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < cols; k++) {
      const k1 = (k + 1) % cols;
      const a = i * cols + k;
      const b = i * cols + k1;
      const c = (i + 1) * cols + k1;
      const d = (i + 1) * cols + k;
      idx[q++] = a;
      idx[q++] = b;
      idx[q++] = d;
      idx[q++] = b;
      idx[q++] = c;
      idx[q++] = d;
    }
  }
  for (let k = 0; k < cols; k++) {
    idx[q++] = (rings - 1) * cols + k;
    idx[q++] = (rings - 1) * cols + ((k + 1) % cols);
    idx[q++] = apex;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.computeVertexNormals();
  return flipIfDownward(geom);
}

/** Flat ground polygon with planar UVs, using the (x, -z) shape convention from point.js. */
function groundPolygon(pts, y, uvFn) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], -pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], -pts[i][1]);
  shape.closePath();
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, y, 0);
  if (uvFn) {
    const pos = geom.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const [u, v] = uvFn(pos.getX(i), pos.getZ(i));
      uv[i * 2] = u;
      uv[i * 2 + 1] = v;
    }
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  return geom;
}

/**
 * Drops collinear samples so the ear clipper is not handed zero-area triangles
 * when a plan curve is sampled by polar angle across a straight run.
 */
function dedupeCollinear(pts, tol = 0.05) {
  const out = [];
  for (const q of pts) {
    const a = out[out.length - 1];
    const b = out[out.length - 2];
    if (a && b && Math.abs((a[0] - b[0]) * (q[1] - b[1]) - (a[1] - b[1]) * (q[0] - b[0])) < tol) out.pop();
    out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Procedural playing-surface textures
// ---------------------------------------------------------------------------

function makeCtx(w, h) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

function fieldTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function tracePolygon(ctx, pts, toPx) {
  ctx.beginPath();
  const p0 = toPx(pts[0][0], pts[0][1]);
  ctx.moveTo(p0[0], p0[1]);
  for (let i = 1; i < pts.length; i++) {
    const p = toPx(pts[i][0], pts[i][1]);
    ctx.lineTo(p[0], p[1]);
  }
  ctx.closePath();
}

const GRASS_DARK = '#255d2c';
const GRASS_LIGHT = '#357f3a';
const APRON_GRASS = '#1d4a23';
const INFIELD_DIRT = '#8a5a36';
const WARNING_DIRT = '#6f4527';
const CHALK = '#f2f4ef';

/**
 * PNC Park's surface, home plate at the texture origin, +X to dead centre and
 * +Z the first-base / right-field side. 96,750 sq ft of Kentucky bluegrass,
 * mown in wedges out of home plate the way the Pirates' crew cuts it.
 */
function baseballFieldMaps(boundary, dom) {
  const made = makeCtx(1024, 1024);
  if (!made) return null;
  const { canvas, ctx } = made;
  const ppm = 1024 / dom.span;
  const toPx = (x, z) => [(x - dom.x0) * ppm, (z - dom.z0) * ppm];
  const hx = (x, z) => toPx(x, z)[0];
  const hz = (x, z) => toPx(x, z)[1];
  const home = toPx(0, 0);

  ctx.fillStyle = APRON_GRASS;
  ctx.fillRect(0, 0, 1024, 1024);

  ctx.save();
  tracePolygon(ctx, boundary, toPx);
  ctx.clip();

  ctx.fillStyle = GRASS_DARK;
  ctx.fillRect(0, 0, 1024, 1024);
  ctx.fillStyle = GRASS_LIGHT;
  for (let i = -10; i < 10; i += 2) {
    ctx.beginPath();
    ctx.moveTo(home[0], home[1]);
    ctx.arc(home[0], home[1], 1500, i * 7 * DEG, (i + 1) * 7 * DEG);
    ctx.closePath();
    ctx.fill();
  }

  // Warning track: 15 ft of crushed brick inside the wall and around the arc.
  ctx.strokeStyle = WARNING_DIRT;
  ctx.lineWidth = 9.2 * ppm;
  tracePolygon(ctx, boundary, toPx);
  ctx.stroke();

  // Infield skin: the 95 ft arc off the pitching rubber, closed to the foul lines.
  const moundX = 60.5 * FT;
  const skinReach = 39.6;
  const skinSweep = 72 * DEG;
  ctx.fillStyle = INFIELD_DIRT;
  ctx.beginPath();
  ctx.moveTo(hx(-6.5, -6.5), hz(-6.5, -6.5));
  ctx.lineTo(hx(skinReach * 0.7071, -skinReach * 0.7071), hz(skinReach * 0.7071, -skinReach * 0.7071));
  ctx.arc(hx(moundX, 0), hz(moundX, 0), 95 * FT * ppm, -skinSweep, skinSweep);
  ctx.lineTo(hx(-6.5, 6.5), hz(-6.5, 6.5));
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(home[0], home[1], 4.0 * ppm, 0, Math.PI * 2);
  ctx.fill();

  // Infield grass, cut 3 m inside base paths that run 90 ft between bags.
  const bag = 90 * FT;
  ctx.fillStyle = GRASS_LIGHT;
  tracePolygon(
    ctx,
    [
      [4.6, 0],
      [bag * 0.7071, -(bag * 0.7071 - 4.6)],
      [bag * 1.4142 - 4.6, 0],
      [bag * 0.7071, bag * 0.7071 - 4.6],
    ],
    toPx,
  );
  ctx.fill();
  ctx.fillStyle = GRASS_DARK;
  for (let i = 0; i < 4; i += 2) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(hx(6 + i * 9, -40), hz(0, -40), 9 * ppm, 80 * ppm);
    ctx.clip();
    tracePolygon(
      ctx,
      [
        [4.6, 0],
        [bag * 0.7071, -(bag * 0.7071 - 4.6)],
        [bag * 1.4142 - 4.6, 0],
        [bag * 0.7071, bag * 0.7071 - 4.6],
      ],
      toPx,
    );
    ctx.fill();
    ctx.restore();
  }

  // Mound and its 18 ft dirt circle.
  ctx.fillStyle = INFIELD_DIRT;
  ctx.beginPath();
  ctx.arc(hx(moundX, 0), hz(moundX, 0), 9 * FT * ppm, 0, Math.PI * 2);
  ctx.fill();

  // Foul lines run the full 325 / 320 ft to the poles.
  ctx.strokeStyle = CHALK;
  ctx.lineWidth = 0.42 * ppm;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(home[0], home[1]);
    ctx.lineTo(hx(104 * 0.7071, sign * 104 * 0.7071), hz(104 * 0.7071, sign * 104 * 0.7071));
    ctx.stroke();
  }
  // Batter's boxes, catcher's box, on-deck circles and coach's boxes.
  ctx.strokeRect(hx(-1.1, -1.9), hz(-1.1, -1.9), 1.83 * ppm, 1.22 * ppm);
  ctx.strokeRect(hx(-1.1, 0.7), hz(-1.1, 0.7), 1.83 * ppm, 1.22 * ppm);
  ctx.strokeRect(hx(-3.6, -1.1), hz(-3.6, -1.1), 2.4 * ppm, 2.2 * ppm);
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(hx(9, sign * 13), hz(9, sign * 13), 1.5 * ppm, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeRect(hx(24, sign * 24), hz(24, sign * 24), 6 * ppm, 3 * ppm);
  }

  ctx.fillStyle = CHALK;
  for (const [bx, bz] of [
    [bag * 0.7071, bag * 0.7071],
    [bag * 1.4142, 0],
    [bag * 0.7071, -bag * 0.7071],
  ]) {
    ctx.fillRect(hx(bx, bz) - 0.75 * ppm, hz(bx, bz) - 0.75 * ppm, 1.5 * ppm, 1.5 * ppm);
  }
  ctx.restore();

  return fieldTexture(canvas);
}

/**
 * NFL field: 120 yd x 53 1/3 yd including end zones. The texture domain is the
 * field-level enclosure, 25 ft behind each end line and 60 ft outside each
 * sideline, so the painted field fills its bowl the way the real one does.
 */
const ACR_FIELD = { half: 60 * 0.9144, wide: 26 + 2 / 3 };
const FOOTBALL_DOM = { x: 132, z: 94 };

function footballFieldMaps() {
  const made = makeCtx(1024, 728);
  if (!made) return null;
  const { canvas, ctx } = made;
  const ppm = 1024 / FOOTBALL_DOM.x;
  const toPx = (x, z) => [(x + FOOTBALL_DOM.x * 0.5) * ppm, (z + FOOTBALL_DOM.z * 0.5) * ppm];
  const halfLen = 50 * 0.9144;
  const endZone = 10 * 0.9144;
  const halfWide = 26.5 * 0.9144;
  const outer = halfLen + endZone;

  ctx.fillStyle = APRON_GRASS;
  ctx.fillRect(0, 0, 1024, 728);

  // Bench aprons: the trodden strip between the sidelines and the front row.
  ctx.fillStyle = '#22532a';
  for (const sign of [-1, 1]) {
    const y0 = toPx(0, sign * (halfWide + 1.8))[1];
    const y1 = toPx(0, sign * (halfWide + 13))[1];
    ctx.fillRect(toPx(-halfLen, 0)[0], Math.min(y0, y1), 2 * halfLen * ppm, Math.abs(y1 - y0));
  }

  const top = toPx(0, -halfWide)[1];
  const bottom = toPx(0, halfWide)[1];
  const gh = bottom - top;

  ctx.fillStyle = GRASS_DARK;
  ctx.fillRect(toPx(-outer, 0)[0], top, 2 * outer * ppm, gh);
  ctx.fillStyle = GRASS_LIGHT;
  for (let i = 0; i < 20; i += 2) {
    ctx.fillRect(toPx(-halfLen + i * 4.572, 0)[0], top, 4.572 * ppm, gh);
  }

  // Steelers end zones are painted black with the wordmark in gold.
  ctx.fillStyle = '#14161a';
  ctx.fillRect(toPx(-outer, 0)[0], top, endZone * ppm, gh);
  ctx.fillRect(toPx(halfLen, 0)[0], top, endZone * ppm, gh);
  ctx.fillStyle = '#ffb612';
  ctx.font = `bold ${5.4 * ppm}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [ex, rot] of [
    [-halfLen - endZone * 0.5, -Math.PI / 2],
    [halfLen + endZone * 0.5, Math.PI / 2],
  ]) {
    const p = toPx(ex, 0);
    ctx.save();
    ctx.translate(p[0], p[1]);
    ctx.rotate(rot);
    ctx.fillText('STEELERS', 0, 0);
    ctx.restore();
  }

  ctx.strokeStyle = '#eef2ee';
  ctx.lineWidth = 0.32 * ppm;
  for (let i = 1; i < 20; i++) {
    const x = toPx(-halfLen + i * 4.572, 0)[0];
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  // Sidelines, end lines and the 6 ft white border outside them.
  ctx.lineWidth = 0.6 * ppm;
  ctx.strokeRect(toPx(-outer, -halfWide)[0], top, 2 * outer * ppm, gh);
  ctx.lineWidth = 0.7 * ppm;
  for (const gx of [-halfLen, halfLen]) {
    const x = toPx(gx, 0)[0];
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  ctx.lineWidth = 0.35 * ppm;
  ctx.strokeRect(
    toPx(-outer - 1.83, -halfWide - 1.83)[0],
    toPx(0, -halfWide - 1.83)[1],
    (2 * outer + 3.66) * ppm,
    (2 * halfWide + 3.66) * ppm,
  );

  // Hash marks 70 ft 9 in in from each sideline, one per yard.
  ctx.lineWidth = 0.28 * ppm;
  for (const hz of [-(halfWide - 70.75 * FT), halfWide - 70.75 * FT]) {
    for (let i = 1; i < 100; i++) {
      if (i % 5 === 0) continue;
      const x = toPx(-halfLen + i * 0.9144, 0)[0];
      const y = toPx(0, hz)[1];
      ctx.beginPath();
      ctx.moveTo(x, y - 0.6 * ppm);
      ctx.lineTo(x, y + 0.6 * ppm);
      ctx.stroke();
    }
  }

  // Yard numbers are 6 ft tall, 27 ft in from the sideline.
  ctx.fillStyle = '#eef2ee';
  ctx.font = `bold ${5.5 * ppm}px sans-serif`;
  for (let i = 1; i < 10; i++) {
    const yard = i * 10;
    const label = String(yard > 50 ? 100 - yard : yard);
    const x = toPx(-halfLen + yard * 0.9144, 0)[0];
    for (const [zz, rot] of [
      [-(halfWide - 27 * FT), 0],
      [halfWide - 27 * FT, Math.PI],
    ]) {
      const p = toPx(0, zz);
      ctx.save();
      ctx.translate(p[0], p[1]);
      ctx.rotate(rot);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }

  // Midfield mark.
  ctx.strokeStyle = '#ffb612';
  ctx.lineWidth = 0.7 * ppm;
  const mid = toPx(0, 0);
  ctx.beginPath();
  ctx.arc(mid[0], mid[1], 9 * ppm, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#ffb612';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(mid[0] + (i - 1) * 3.4 * ppm, mid[1], 1.5 * ppm, 0, Math.PI * 2);
    ctx.fill();
  }

  return fieldTexture(canvas);
}

/** Hockey sheet, 200 x 85 ft, drawn white with the NHL line markings. */
function iceMaps() {
  const made = makeCtx(512, 256);
  if (!made) return null;
  const { canvas, ctx } = made;
  const L = 200 * FT;
  const W = 85 * FT;
  const ppm = 512 / L;
  const toPx = (x, z) => [(x + L * 0.5) * ppm, (z + W * 0.5) * ppm];
  ctx.fillStyle = '#eef3f7';
  ctx.fillRect(0, 0, 512, 256);
  ctx.strokeStyle = '#c22b32';
  ctx.lineWidth = 0.35 * ppm;
  for (const gx of [-64 * FT, 64 * FT]) {
    const x = toPx(gx, 0)[0];
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  ctx.lineWidth = 0.32 * ppm;
  const c = toPx(0, 0);
  ctx.beginPath();
  ctx.moveTo(c[0], 0);
  ctx.lineTo(c[0], 256);
  ctx.stroke();
  ctx.strokeStyle = '#2b4fa2';
  ctx.lineWidth = 0.9 * ppm;
  for (const gx of [-25 * FT, 25 * FT]) {
    const x = toPx(gx, 0)[0];
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  ctx.strokeStyle = '#2b4fa2';
  ctx.lineWidth = 0.3 * ppm;
  ctx.beginPath();
  ctx.arc(c[0], c[1], 15 * FT * ppm, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#c22b32';
  for (const fx of [-69 * FT, -20 * FT, 20 * FT, 69 * FT]) {
    for (const fz of [-22 * FT, 22 * FT]) {
      const p = toPx(fx, fz);
      ctx.beginPath();
      ctx.arc(p[0], p[1], 15 * FT * ppm, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  return fieldTexture(canvas);
}

function fallbackTurf() {
  return mat(0x2c6a33, { roughness: 0.95, metalness: 0.01 });
}

function turfMaterial(map, fallback) {
  if (!map) return fallback || fallbackTurf();
  return new THREE.MeshStandardMaterial({
    map,
    roughness: 0.93,
    metalness: 0.02,
    envMapIntensity: 0.3,
  });
}

// ---------------------------------------------------------------------------
// PNC Park
// ---------------------------------------------------------------------------

/**
 * Outfield wall by angle off dead centre, negative on the left-field side:
 * the posted 325 / 389 / 410 / 399 / 375 / 320 ft distances, with the 410 ft
 * North Side Notch stepped rather than faired so it reads as a corner.
 */
const PNC_WALL = [
  [-45, 325 * FT],
  [-38, 108.0],
  [-32, 114.5],
  [-26, 389 * FT],
  [-21, 122.0],
  [-18.5, 410 * FT],
  [-13.5, 410 * FT],
  [-11, 122.4],
  [-5, 121.8],
  [0, 399 * FT],
  [8, 119.4],
  [16, 116.6],
  [24, 375 * FT],
  [31, 108.0],
  [38, 102.0],
  [45, 320 * FT],
];

/**
 * Inner edge of the grandstand, right-field corner -> behind home -> left-field
 * corner. The 51 ft from the plate to the first seats behind home is the
 * published backstop distance, and the foul-side edge stands about 8 m outside
 * each foul line, which is all the foul ground a park wedged into the city grid
 * has room for.
 */
const PNC_STAND_EDGE = [
  [62, 74],
  [44, 56],
  [28, 40],
  [14, 27],
  [2, 19],
  [-8, 13.5],
  [-14, 6],
  [-51 * FT, 0],
  [-14, -6],
  [-8, -13.5],
  [2, -19],
  [14, -27],
  [28, -40],
  [44, -56],
  [62, -74],
];

function pncWallPoints() {
  return PNC_WALL.map(([a, r]) => [Math.cos(a * DEG) * r, Math.sin(a * DEG) * r]);
}

/** rotation.y that lays a box's local +X tangent to the outfield arc at `angle`. */
function tangentYaw(angle) {
  return Math.PI / 2 - angle;
}

/** 6 ft in left and left-centre, 10 ft through centre, the 21 ft Clemente Wall in right. */
function pncWallHeight(angle) {
  if (angle <= -6) return 6 * FT;
  if (angle <= 6) return lerp(6 * FT, 10 * FT, (angle + 6) / 12);
  if (angle <= 18) return 10 * FT;
  if (angle >= 27) return 21 * FT;
  return lerp(10 * FT, 21 * FT, (angle - 18) / 9);
}

/**
 * PNC Park: 38,747 seats in the only two-deck park built in the United States
 * since 1953, deliberately low -- the highest seat is 88 ft above the field --
 * so the downtown skyline reads over the outfield. Ochre Kasota limestone with
 * an arched street arcade, exposed navy steel, and the bowl left open across
 * the outfield for the river and the bridge.
 *
 * Local +X runs from home plate to dead centre and +Z is the first-base /
 * right-field side, which the surveyed axis puts over the Allegheny.
 */
export function buildPncPark(spec = {}) {
  const group = new THREE.Group();
  group.name = 'pnc-park';

  const h = clamp(spec.h, 30, 46);
  const hs = clamp(h / 36, 0.9, 1.15);
  const s = fitScale(spec.f, 280, 218);
  // Home plate to dead centre bears 111 deg (ESE), so local +X sits 21 deg off
  // east. Bisecting the two foul lines of the OSM pitch ring gives 110.8 deg and
  // Clem's survey gives 111.2; that also puts the foul poles on Federal Street
  // (left, bearing 76) and the riverfront trail (right, bearing 156), which is
  // how the park is described. `field.open` is now 21 deg (bearing 111).
  const yaw = surveyedAxis(spec.orientYaw, 21 * DEG);

  const oriented = new THREE.Group();
  oriented.rotation.y = -yaw;
  oriented.scale.set(s, 1, s);
  group.add(oriented);
  const core = new THREE.Group();

  // Kasota stone is a warm ochre dolomitic limestone, not a white marble. Held
  // well below its apparent tone because the sun plus ACES exposure lifts it.
  const limestone = mat(0xb0a17c, { roughness: 0.85, metalness: 0.04 });
  const limeDark = mat(0x8e8262, { roughness: 0.88, metalness: 0.04 });
  const concrete = mat(0x8d8a80, { roughness: 0.9, metalness: 0.04 });
  const steel = mat(0x1f3b66, { roughness: 0.48, metalness: 0.6, envMapIntensity: 0.9 });
  const seatLower = mat(0x25436f, { roughness: 0.88, metalness: 0.04 });
  const seatUpper = mat(0x1b3358, { roughness: 0.88, metalness: 0.04 });
  const roofDeck = mat(0x9fa5a9, { roughness: 0.52, metalness: 0.4, envMapIntensity: 0.6 });
  // The outfield wall including the 21 ft Clemente Wall is padded navy, not
  // green; the only green mass out there is the batter's-eye rhododendron bank.
  const padding = mat(0x16263f, { roughness: 0.92, metalness: 0.03 });
  const foliage = mat(0x24471f, { roughness: 0.95, metalness: 0.02 });
  const shade = mat(0x1b1d20, { roughness: 0.85, metalness: 0.05 });
  const glass = mat(0x8fb2c8, {
    roughness: 0.12,
    metalness: 0.5,
    transparent: true,
    opacity: 0.62,
    emissive: 0x24405c,
    emissiveIntensity: 0.35,
    envMapIntensity: 1.3,
  });
  const board = mat(0x0b0d10, { roughness: 0.35, metalness: 0.3, emissive: 0x2a3550, emissiveIntensity: 0.55 });
  const lamp = mat(0xdfe4d8, { roughness: 0.3, metalness: 0.5, emissive: 0xfff0c0, emissiveIntensity: 0.9 });

  const stone = [];
  const stoneDark = [];
  const conc = [];
  const steelG = [];
  const roofG = [];
  const seatsA = [];
  const seatsB = [];
  const aisles = [];
  const dark = [];
  const shades = [];
  const green = [];
  const glassG = [];
  const boards = [];
  const lamps = [];

  // --- playing surface -----------------------------------------------------
  const wall = pncWallPoints();
  const boundary = PNC_STAND_EDGE.concat(wall);
  const dom = { x0: -36, z0: -92, span: 184 };
  const turf = turfMaterial(baseballFieldMaps(boundary, dom));
  const fieldGeom = groundPolygon(boundary, 0.3, (x, z) => [
    (x - dom.x0) / dom.span,
    1 - (z - dom.z0) / dom.span,
  ]);
  const field = new THREE.Mesh(fieldGeom, turf);
  field.receiveShadow = true;
  core.add(field);

  // --- outfield wall -------------------------------------------------------
  const wallPath = buildPath(polylineFn(wall), 64, 0, 1);
  const wallAngles = wallPath.map((_, i) => lerp(-45, 45, i / (wallPath.length - 1)));
  wallPath.forEach((p, i) => {
    p.sv = pncWallHeight(wallAngles[i]);
  });
  dark.push(sweepStrip(wallPath, [[0, 0], [0, 1], [0.55, 1], [0.55, 0]]));
  // Yellow-topped padding rail, and the foul poles at each 45 deg corner.
  steelG.push(sweepStrip(offsetPath(wallPath, 0.55), [[0, 1.02], [0.16, 1.02], [0.16, 0.97]]));
  for (const a of [-45, 45]) {
    const r = a < 0 ? 325 * FT : 320 * FT;
    steelG.push(box(0.5, 12, 0.5, Math.cos(a * DEG) * r, 6, Math.sin(a * DEG) * r));
  }

  // --- lower bowl: 34 rows from the 51 ft backstop out to the concourse ----
  const standFn = splineFn(PNC_STAND_EDGE);
  const standPath = buildPath(standFn, 76, 0, 1);
  const lowerPath = offsetPath(standPath, 1.4);
  const lower = rakedSection({ u0: 0, v0: 1.0 * hs, steps: 16, run: 1.4, rise: 0.46 * hs, fascia: 2.4, grow: 0.5 });
  seatingTier({
    path: lowerPath,
    section: lower,
    seats: seatsA,
    aisles,
    dark: shades,
    aisleStep: 5,
    aisleFrom: 2,
    vomStep: 10,
  });
  conc.push(sweepStrip(lowerPath, lower.shell));

  // --- club and suite band between the decks -------------------------------
  const clubFront = lower.uTop - 1.0;
  const suiteTop = lower.vTop + 5.6 * hs;
  conc.push(
    sweepStrip(lowerPath, [
      [clubFront, lower.vTop + 1.1],
      [clubFront + 4.2, lower.vTop + 1.1],
      [clubFront + 4.2, lower.vTop - 1.4],
      [clubFront, lower.vTop - 1.4],
    ]),
  );
  glassG.push(
    sweepStrip(offsetPath(lowerPath, clubFront + 0.5), [
      [0, suiteTop],
      [0, lower.vTop + 1.3],
    ]),
  );
  stone.push(
    sweepStrip(lowerPath, [
      [clubFront + 0.5, suiteTop + 1.5],
      [clubFront + 5.4, suiteTop + 1.5],
      [clubFront + 5.4, suiteTop],
      [clubFront + 0.5, suiteTop],
    ]),
  );

  // --- upper deck: cantilevered over the lower concourse, top seat at 88 ft -
  const upperFront = lower.uTop - 5.0;
  const upper = rakedSection({
    u0: upperFront,
    v0: suiteTop + 1.8 * hs,
    steps: 12,
    run: 1.45,
    rise: 0.62 * hs,
    fascia: 3.0,
    base: 0,
    grow: 0.3,
  });
  seatingTier({
    path: lowerPath,
    section: upper,
    seats: seatsB,
    aisles,
    dark: shades,
    aisleStep: 5,
    aisleFrom: 2,
    vomStep: 12,
  });
  stone.push(sweepStrip(lowerPath, upper.shell));
  const standEnds = [lowerPath[0], lowerPath[lowerPath.length - 1]];
  for (const node of standEnds) {
    conc.push(sectionCap(lower.closed, node));
    stone.push(sectionCap(upper.closed, node));
  }
  // Raking struts under the cantilever, and the fascia the boards hang from.
  // Raking struts carry the cantilevered upper deck back to the concourse.
  for (let i = 2; i < lowerPath.length - 2; i += 5) {
    const p = lowerPath[i];
    const reach = 9.5;
    const rise = 5.0;
    steelG.push(radialMember(Math.hypot(reach, rise), 0.7, 0.9, -Math.atan2(rise, reach), p, upperFront + reach * 0.5, upper.v0 - rise * 0.5));
  }
  conc.push(
    sweepStrip(lowerPath, [
      [upperFront, upper.v0],
      [upperFront - 0.5, upper.v0],
      [upperFront - 0.5, upper.v0 - 2.6],
      [upperFront, upper.v0 - 2.6],
    ]),
  );

  // --- steel roof over the back rows, carried on navy trusses --------------
  // Light metal deck on exposed navy truss, the Forbes Field reference: the
  // canopy only shelters the top rows and the press box, and the parapet of
  // the limestone shell still shows above the upper-deck fascia.
  const roofY = upper.vTop + 4.2 * hs;
  const roofIn = upper.uTop - 8.5;
  roofG.push(
    sweepStrip(lowerPath, [
      [roofIn, roofY],
      [upper.uOut + 0.4, roofY],
      [upper.uOut + 0.4, roofY - 1.0],
      [roofIn, roofY - 1.0],
    ]),
  );
  stone.push(
    sweepStrip(lowerPath, [
      [upper.uTop, roofY - 1.2],
      [upper.uTop, upper.vTop],
    ]),
  );
  for (let i = 1; i < lowerPath.length - 1; i += 4) {
    const p = lowerPath[i];
    const a = nodeYaw(p);
    steelG.push(box(0.7, roofY - upper.vTop, 0.7, p.x + p.nx * (upper.uTop + 1.2), (roofY + upper.vTop) * 0.5, p.z + p.nz * (upper.uTop + 1.2), a));
    const reach = upper.uOut - roofIn;
    steelG.push(radialMember(reach, 0.85, 0.5, -0.09, p, roofIn + reach * 0.5, roofY - 1.9));
  }

  // --- Kasota limestone shell: arched arcade at street level ---------------
  const facadePath = offsetPath(lowerPath, upper.uOut - 0.3);
  const arcadeTop = 8.4;
  const parapet = upper.vTop + 1.2;
  stone.push(
    sweepStrip(facadePath, [
      [0, parapet],
      [1.7, parapet],
      [1.7, arcadeTop],
      [0, arcadeTop],
    ]),
  );
  stoneDark.push(
    sweepStrip(facadePath, [
      [0.3, arcadeTop + 1.3],
      [2.2, arcadeTop + 1.3],
      [2.2, arcadeTop - 0.4],
      [0.3, arcadeTop - 0.4],
    ]),
  );
  // Every other bay of the arcade is an opening; the rest is a rusticated pier.
  // The openings run nearly the full height of the arcade storey, because the
  // masonry arches onto the public street arcade are the Forbes Field quotation
  // the whole elevation is built around.
  for (let i = 0; i < facadePath.length; i += 2) {
    const p = facadePath[i];
    const a = nodeYaw(p);
    stoneDark.push(box(2.6, arcadeTop, 2.3, p.x + p.nx * 1.0, arcadeTop * 0.5, p.z + p.nz * 1.0, a));
    shades.push(box(3.4, 6.6, 0.5, p.x + p.nx * 2.0, 3.3, p.z + p.nz * 2.0, a));
    // Keystone and springing course above each arch.
    stoneDark.push(box(3.9, 0.7, 0.7, p.x + p.nx * 2.05, 7.0, p.z + p.nz * 2.05, a));
  }
  // Pilasters carrying the upper wall, on the same bay rhythm as the arcade.
  for (let i = 1; i < facadePath.length; i += 2) {
    const p = facadePath[i];
    const a = nodeYaw(p);
    stone.push(box(1.8, parapet - arcadeTop, 1.0, p.x + p.nx * 2.0, (parapet + arcadeTop) * 0.5, p.z + p.nz * 2.0, a));
  }
  // Thin jagged stone courses band the smooth upper wall.
  for (const y of [12.0, 16.4, 20.8]) {
    stoneDark.push(
      sweepStrip(facadePath, [
        [0.15, y + 0.5],
        [1.9, y + 0.5],
        [1.9, y],
        [0.15, y],
      ]),
    );
  }
  // Navy stair towers slice vertically through the limestone.
  for (let i = 6; i < facadePath.length - 6; i += 12) {
    const p = facadePath[i];
    const a = nodeYaw(p);
    steelG.push(box(6.4, parapet, 2.4, p.x + p.nx * 2.4, parapet * 0.5, p.z + p.nz * 2.4, a));
    for (let k = 1; k <= 3; k++) {
      steelG.push(brace(8.4, 0.5, 2.6, 0.5, p.x + p.nx * 2.6, (parapet * k) / 3.6, p.z + p.nz * 2.6, a));
    }
  }

  // --- left-field bleachers; open right field keeps the skyline view -------
  // Both outfield ribbons start on the grandstand's own end node, otherwise
  // they begin out at the foul pole and leave a hole at each corner.
  const bleachSeed = [PNC_STAND_EDGE[PNC_STAND_EDGE.length - 1]].concat(wall.slice(0, 6));
  const bleacherPath = offsetPath(buildPath(splineFn(bleachSeed), 30, 0, 1), 3.6);
  const bleach = rakedSection({ u0: 0, v0: 2.6 * hs, steps: 9, run: 1.45, rise: 0.62 * hs, fascia: 2.0, base: 0, grow: 0.4 });
  seatingTier({ path: bleacherPath, section: bleach, seats: seatsA, aisles, aisleStep: 5, aisleFrom: 2 });
  stone.push(sweepStrip(bleacherPath, bleach.shell));
  for (const node of [bleacherPath[0], bleacherPath[bleacherPath.length - 1]]) {
    stone.push(sectionCap(bleach.closed, node));
  }
  const bleachFacade = offsetPath(bleacherPath, bleach.uOut - 0.3);
  colonnade({
    path: bleachFacade,
    y0: 0,
    y1: bleach.vTop + 1.0,
    step: 3,
    colW: 1.2,
    colD: 1.6,
    cols: stoneDark,
    outset: 0.7,
  });

  // --- left-field rotunda: skeletal navy steel, wrapped by a spiral ramp ---
  {
    const p = bleacherPath[1];
    const radius = 13.5;
    const height = 22 * hs;
    const cx = p.x + p.nx * (radius * 0.55 + bleach.uOut);
    const cz = p.z + p.nz * (radius * 0.55 + bleach.uOut);
    steelG.push(cyl(radius, radius, 0.9, 14, cx, height, cz));
    for (let k = 0; k < 4; k++) {
      steelG.push(cyl(radius + 0.5, radius + 0.5, 0.7, 14, cx, 4.5 + k * 5.6, cz));
    }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      steelG.push(drumBox(1.0, height, 1.0, cx, cz, radius, height * 0.5, a));
      if (k % 3 === 0) continue;
      // Baseball-card tapestries of Pirates legends face Federal Street.
      stoneDark.push(drumBox(5.6, 9.0, 0.5, cx, cz, radius + 0.3, 13.5, a));
    }
    // The ramp helix is open to the air, so what shows between the columns is
    // shadowed soffit, not a solid drum.
    shades.push(cyl(radius - 1.4, radius - 1.4, height - 1.0, 14, cx, (height - 1.0) * 0.5, cz));
  }

  // --- right-field riverwalk terrace, kept low for the skyline view ---------
  const riverSeed = wall.slice(11).concat([PNC_STAND_EDGE[0]]);
  const riverPath = offsetPath(buildPath(splineFn(riverSeed), 26, 0, 1), 1.6);
  const walkY = 4.6 * hs;
  const walkDeep = 13;
  stone.push(
    sweepStrip(riverPath, [
      [0, walkY],
      [walkDeep, walkY],
      [walkDeep, 0],
      [0, 0],
    ]),
  );
  for (const node of [riverPath[0], riverPath[riverPath.length - 1]]) {
    stone.push(
      sectionCap(
        [
          [0, 0],
          [0, walkY],
          [walkDeep, walkY],
          [walkDeep, 0],
        ],
        node,
      ),
    );
  }
  for (let i = 0; i < riverPath.length; i += 2) {
    const p = riverPath[i];
    steelG.push(box(0.24, 1.3, 0.24, p.x + p.nx * (walkDeep - 0.5), walkY + 0.65, p.z + p.nz * (walkDeep - 0.5)));
  }
  steelG.push(
    sweepStrip(offsetPath(riverPath, walkDeep - 0.5), [
      [0, walkY + 1.3],
      [0, walkY + 0.95],
    ]),
  );
  // A few rows of river-side seats above the concourse.
  const rivSeat = rakedSection({ u0: 0.6, v0: walkY + 0.6, steps: 5, run: 1.3, rise: 0.6 * hs, fascia: 1.4, base: walkY });
  seatingTier({ path: riverPath, section: rivSeat, seats: seatsA, aisles, aisleStep: 5, aisleFrom: 2 });
  stone.push(sweepStrip(riverPath, rivSeat.shell));

  // --- home-plate gate rotunda, its steel held behind the stone ------------
  {
    const p = facadePath[Math.round((facadePath.length - 1) / 2)];
    const radius = 14;
    const height = 24 * hs;
    const cx = p.x + p.nx * radius * 0.28;
    const cz = p.z + p.nz * radius * 0.28;
    stone.push(cyl(radius, radius, height, 9, cx, height * 0.5, cz, Math.PI / 9));
    stoneDark.push(cyl(radius + 0.7, radius + 0.7, 1.0, 9, cx, arcadeTop + 1.0, cz, Math.PI / 9));
    stoneDark.push(cyl(radius + 1.5, radius + 1.5, 1.2, 9, cx, height + 0.6, cz, Math.PI / 9));
    steelG.push(cyl(radius - 1.0, radius - 1.0, 1.0, 9, cx, height + 1.8, cz, Math.PI / 9));
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + Math.PI / 9;
      glassG.push(drumBox(8.4, height - arcadeTop - 3.0, 0.4, cx, cz, radius, (height + arcadeTop) * 0.5, a));
    }
  }

  // The corner ramp pavilions sit back inside the facade line: the grandstand
  // already reaches the river-side property edge there, so anything projecting
  // out of the corners lands in the Allegheny.
  for (const idx of [0, facadePath.length - 1]) {
    const p = facadePath[idx];
    const a = nodeYaw(p);
    const height = 25 * hs;
    const cx = p.x - p.nx * 6;
    const cz = p.z - p.nz * 6;
    stone.push(box(18, height, 15, cx, height * 0.5, cz, a));
    for (let k = 1; k <= 3; k++) {
      steelG.push(box(19, 0.7, 16, cx, (height * k) / 3.6, cz, a));
    }
    stoneDark.push(box(19.4, 1.1, 16.4, cx, height + 0.55, cz, a));
  }

  // --- scoreboards ----------------------------------------------------------
  // Main board over the left-field seats: 24 x 42 ft video with LED wings.
  const mainAngle = -30 * DEG;
  const mainR = 122;
  const mainX = Math.cos(mainAngle) * mainR;
  const mainZ = Math.sin(mainAngle) * mainR;
  const mainRot = tangentYaw(mainAngle);
  for (const off of [-16, 16]) {
    steelG.push(box(1.5, 24 * hs, 1.5, mainX - Math.sin(mainAngle) * off, 12 * hs, mainZ + Math.cos(mainAngle) * off, mainRot));
  }
  steelG.push(box(36, 15 * hs, 1.5, mainX, 17 * hs, mainZ, mainRot));
  boards.push(box(12.8, 7.3, 0.9, mainX - Math.cos(mainAngle) * 0.9, 18.5 * hs, mainZ - Math.sin(mainAngle) * 0.9, mainRot));
  boards.push(box(30, 2.4, 0.7, mainX - Math.cos(mainAngle) * 0.9, 12.4 * hs, mainZ - Math.sin(mainAngle) * 0.9, mainRot));

  // Out-of-town board set into the 21 ft Clemente Wall in right field.
  const ootAngle = 34 * DEG;
  const ootR = 104;
  boards.push(
    box(26, 3.6, 0.5, Math.cos(ootAngle) * ootR, 4.0, Math.sin(ootAngle) * ootR, tangentYaw(ootAngle)),
  );

  // --- Forbes Field style light towers above the roof ----------------------
  for (const t of [0.07, 0.24, 0.4, 0.6, 0.76, 0.93]) {
    const idx = Math.round(t * (facadePath.length - 1));
    const p = facadePath[idx];
    const px = p.x - p.nx * 3;
    const pz = p.z - p.nz * 3;
    const a = nodeYaw(p);
    const top = roofY + 9.5 * hs;
    steelG.push(box(2.6, top - roofY + 2, 1.4, px, roofY + (top - roofY) * 0.5, pz, a));
    steelG.push(box(13, 1.1, 1.2, px, top, pz, a));
    for (let i = 0; i < 4; i++) {
      lamps.push(box(2.6, 1.3, 0.6, px + Math.cos(a) * (i - 1.5) * 3.3, top + 1.1, pz - Math.sin(a) * (i - 1.5) * 3.3, a));
    }
  }
  for (const [tx, tz] of [
    [104, -84],
    [126, -44],
    [120, 52],
  ]) {
    const top = 30 * hs;
    const a = Math.atan2(tx, tz);
    steelG.push(box(2.2, top, 2.2, tx, top * 0.5, tz));
    steelG.push(box(12, 1.1, 1.4, tx, top + 0.8, tz, a));
    lamps.push(box(9, 1.2, 0.8, tx, top + 1.9, tz, a));
  }

  // --- batter's eye: the centre-field rhododendron bank -------------------
  const eyeAngle = -3 * DEG;
  dark.push(
    box(26, 7.5, 3.4, Math.cos(eyeAngle) * 123, 3.75, Math.sin(eyeAngle) * 123, tangentYaw(eyeAngle)),
  );
  for (let i = 0; i < 7; i++) {
    const a = (-10 + i * 3.2) * DEG;
    green.push(cyl(2.4, 2.0, 3.0, 6, Math.cos(a) * 120, 8.4, Math.sin(a) * 120));
  }

  const parts = [
    [stone, limestone],
    [stoneDark, limeDark],
    [conc, concrete],
    [aisles, concrete],
    [steelG, steel],
    [roofG, roofDeck],
    [seatsA, seatLower],
    [seatsB, seatUpper],
    [dark, padding],
    [shades, shade],
    [green, foliage],
    [glassG, glass],
    [boards, board],
    [lamps, lamp],
  ];
  for (const [geoms, material] of parts) {
    const mesh = meshFrom(geoms, material);
    if (mesh) core.add(mesh);
  }
  // landmarks.js drops the venue on the OSM playing-surface centroid, so the
  // model has to hang from the centroid of its own playing surface.
  const anchor = polygonCentroid(boundary);
  anchorAndAttach(core, oriented, anchor[0], anchor[1]);
  return group;
}

// ---------------------------------------------------------------------------
// Acrisure Stadium
// ---------------------------------------------------------------------------

/**
 * Field-level plan, half-extents. The first row stands 60 ft off each sideline
 * and 25 ft off each end line, so the enclosure around the 109.7 x 48.8 m
 * field is 124.9 x 85.4 m -- which is exactly the 123.3 x 86.2 m minimum-area
 * rectangle of the OSM field-level ring. 36 m of straight run either side of
 * the corner radius keeps the sidelines reading straight rather than slumping
 * into an oval.
 */
const ACR_RX = 62.5;
const ACR_RZ = 42.7;
const ACR_CORNER = 26;
// The club tier and the suites stop at the south corners and the upper deck
// stops shorter still, so the whole south end zone stays open to the skyline.
const ACR_CLUB_OPEN = 40 * DEG;
const ACR_UPPER_OPEN = 47 * DEG;

/**
 * Acrisure Stadium: 68,400 seats in a horseshoe, the lower bowl ringing the
 * field, three-tier grandstands down both sidelines wrapping the closed north
 * end, and nothing across the south end but the 2015 South Plaza terrace and
 * the 28 x 96 ft video board -- the gap that frames downtown, on axis with
 * Point State Park.
 *
 * The exterior is the point of the building: charcoal exposed structural steel
 * (12,000 tons of it) over buff precast, with 50,000 sq ft of glass at the
 * corners and the Great Hall. Local +X points out through the open end.
 */
export function buildAcrisureStadium(spec = {}) {
  const group = new THREE.Group();
  group.name = 'acrisure-stadium';

  const h = clamp(spec.h, 42, 64);
  const hs = clamp(h / 58, 0.9, 1.12);
  const s = fitScale(spec.f, 290, 261);
  const yaw = surveyedAxis(spec.orientYaw, 64.5 * DEG);

  const oriented = new THREE.Group();
  oriented.rotation.y = -yaw;
  oriented.scale.set(s, 1, s);
  group.add(oriented);
  const core = new THREE.Group();

  // Buff architectural precast. Kept well below the tone it reads at, because
  // the scene's sun plus ACES exposure lifts a mid-tan to near cream.
  const precast = mat(0x82775f, { roughness: 0.87, metalness: 0.05 });
  const concrete = mat(0x6f6b62, { roughness: 0.9, metalness: 0.05 });
  const steel = mat(0x3b3f45, { roughness: 0.44, metalness: 0.66, envMapIntensity: 0.95 });
  // The canopy deck is the largest single surface seen from above, and it is
  // painted steel rather than bright sheet. It has to stay matte: any metalness
  // on a plane that big mirrors the sky and turns the whole stadium white, which
  // is what made this read as a clad drum instead of an exposed frame.
  const steelPale = mat(0x474c52, { roughness: 0.78, metalness: 0.08, envMapIntensity: 0.15 });
  const seatGold = mat(0xe8b21c, { roughness: 0.9, metalness: 0.05 });
  const seatBlack = mat(0x22242a, { roughness: 0.9, metalness: 0.06 });
  // 50,000 sq ft of PPG glazing. Kept dark and only mildly reflective: at full
  // envMap the stair towers blow out to white boxes and read as solid panel.
  const glass = mat(0x53718a, {
    roughness: 0.14,
    metalness: 0.5,
    transparent: true,
    opacity: 0.55,
    emissive: 0x1b2c3c,
    emissiveIntensity: 0.16,
    envMapIntensity: 0.85,
  });
  const board = mat(0x0a0c0f, { roughness: 0.3, metalness: 0.35, emissive: 0x3a4460, emissiveIntensity: 0.6 });
  const lamp = mat(0xe4e8dc, { roughness: 0.28, metalness: 0.5, emissive: 0xfff2c8, emissiveIntensity: 1.0 });

  const conc = [];
  const cast = [];
  const steelG = [];
  const steelG2 = [];
  const seatsA = [];
  const seatsB = [];
  const aisles = [];
  const dark = [];
  const glassG = [];
  const boards = [];
  const lamps = [];

  const plan = roundedRect(ACR_RX, ACR_RZ, ACR_CORNER);

  // --- field ---------------------------------------------------------------
  const apron = dedupeCollinear(
    Array.from({ length: 108 }, (_, i) => {
      const p = plan((i / 108) * Math.PI * 2);
      return [p[0] * 0.995, p[1] * 0.995];
    }),
  );
  const turf = turfMaterial(footballFieldMaps());
  const fieldGeom = groundPolygon(apron, 0.25, (x, z) => [
    x / FOOTBALL_DOM.x + 0.5,
    0.5 - z / FOOTBALL_DOM.z,
  ]);
  const field = new THREE.Mesh(fieldGeom, turf);
  field.receiveShadow = true;
  core.add(field);

  // --- lower bowl: a complete ring, 60 ft off the sidelines ----------------
  const ringPath = buildPath(plan, 108, 0, Math.PI * 2, true);
  dark.push(sweepStrip(ringPath, [[-0.4, 1.1], [0.3, 1.1], [0.3, 0]], true));
  const lower = rakedSection({ u0: 0.4, v0: 1.2 * hs, steps: 16, run: 1.5, rise: 0.52 * hs, fascia: 2.6, grow: 0.5 });
  seatingTier({
    path: ringPath,
    section: lower,
    closed: true,
    seats: seatsA,
    aisles,
    dark,
    aisleStep: 5,
    vomStep: 9,
  });
  conc.push(sweepStrip(ringPath, lower.shell, true));

  // --- club tier and the suite ring, both stopping at the south corners ----
  const clubPath = buildPath(plan, 84, ACR_CLUB_OPEN, Math.PI * 2 - ACR_CLUB_OPEN);
  const clubBase = lower.vTop + 3.2 * hs;
  conc.push(
    sweepStrip(clubPath, [
      [lower.uTop - 0.4, clubBase - 0.4],
      [lower.uOut + 3.0, clubBase - 0.4],
      [lower.uOut + 3.0, lower.vTop - 2.2],
      [lower.uTop - 0.4, lower.vTop - 2.2],
    ]),
  );
  const club = rakedSection({ u0: lower.uTop + 1.6, v0: clubBase, steps: 7, run: 1.7, rise: 0.7 * hs, fascia: 2.6, grow: 0.25 });
  seatingTier({ path: clubPath, section: club, seats: seatsA, aisles, aisleStep: 6, aisleFrom: 3 });
  cast.push(sweepStrip(clubPath, club.shell));
  // 129 luxury suites in a glazed band, with the upper deck cantilevered over.
  const suiteBase = club.vTop + 1.5 * hs;
  const suiteTop = suiteBase + 6.6 * hs;
  glassG.push(
    sweepStrip(offsetPath(clubPath, club.uTop - 0.6), [
      [0, suiteTop],
      [0, suiteBase],
    ]),
  );
  cast.push(
    sweepStrip(clubPath, [
      [club.uTop - 1.2, suiteTop + 1.4],
      [club.uOut + 2.4, suiteTop + 1.4],
      [club.uOut + 2.4, suiteTop],
      [club.uTop - 1.2, suiteTop],
    ]),
  );
  cast.push(
    sweepStrip(clubPath, [
      [club.uTop - 1.2, suiteBase],
      [club.uOut + 2.4, suiteBase],
      [club.uOut + 2.4, suiteBase - 1.5],
      [club.uTop - 1.2, suiteBase - 1.5],
    ]),
  );

  // --- upper deck: sidelines plus the north end bleachers, nothing south ---
  // It cantilevers 45 ft out over the suites on tapered diagonal pipes bearing
  // on quadpods at the upper concourse, which is the building's signature.
  const upperFront = club.uTop - 4.0;
  const upper = rakedSection({
    u0: upperFront,
    v0: suiteTop + 2.8 * hs,
    steps: 18,
    run: 1.3,
    rise: 0.78 * hs,
    fascia: 3.4,
    base: 0,
    grow: 0.4,
  });
  const upperPath = buildPath(plan, 88, ACR_UPPER_OPEN, Math.PI * 2 - ACR_UPPER_OPEN);
  seatingTier({
    path: upperPath,
    section: upper,
    seats: seatsB,
    aisles,
    dark,
    aisleStep: 5,
    aisleFrom: 2,
    vomStep: 11,
  });
  // The 2025 reseat mixed black into the upper deck to take the edge off the
  // sea of gold; the back rows carry most of it.
  dark.push(sweepStrip(upperPath, upper.seats.slice(-11).map(([u, v]) => [u, v + 0.08])));
  conc.push(sweepStrip(upperPath, upper.shell));
  conc.push(
    sweepStrip(upperPath, [
      [upperFront, upper.v0],
      [upperFront - 0.6, upper.v0],
      [upperFront - 0.6, upper.v0 - 3.4],
      [upperFront, upper.v0 - 3.4],
    ]),
  );
  for (const node of [clubPath[0], clubPath[clubPath.length - 1]]) {
    cast.push(sectionCap(club.closed, node));
  }
  for (const node of [upperPath[0], upperPath[upperPath.length - 1]]) {
    conc.push(sectionCap(upper.closed, node));
  }
  const cantilever = 45 * FT;
  for (let i = 1; i < upperPath.length - 1; i += 4) {
    const p = upperPath[i];
    const drop = upper.v0 - suiteTop - 0.5;
    steelG.push(
      radialMember(Math.hypot(cantilever, drop), 1.0, 1.3, -Math.atan2(drop, cantilever), p, upperFront + cantilever * 0.5, upper.v0 - drop * 0.5),
    );
  }

  // --- 75 ft cantilevered canopy over the back of the upper deck ----------
  const canopyY = upper.vTop + 5.0 * hs;
  const canopyIn = upper.uTop - 75 * FT;
  steelG2.push(
    sweepStrip(upperPath, [
      [canopyIn, canopyY],
      [upper.uOut + 2.0, canopyY],
      [upper.uOut + 2.0, canopyY - 1.4],
      [canopyIn, canopyY - 1.4],
    ]),
  );
  conc.push(
    sweepStrip(upperPath, [
      [upper.uTop, canopyY - 1.5],
      [upper.uTop, upper.vTop],
    ]),
  );
  for (let i = 2; i < upperPath.length - 2; i += 4) {
    const p = upperPath[i];
    const a = nodeYaw(p);
    steelG.push(box(1.1, canopyY - upper.vTop + 3, 2.6, p.x + p.nx * (upper.uTop + 1.4), (canopyY + upper.vTop) * 0.5 - 1, p.z + p.nz * (upper.uTop + 1.4), a));
    const reach = upper.uOut + 2.0 - canopyIn;
    steelG.push(radialMember(reach, 1.2, 0.7, -0.06, p, canopyIn + reach * 0.5, canopyY - 2.4));
    if (i % 8 === 2) {
      lamps.push(box(8.4, 1.1, 1.0, p.x + p.nx * (canopyIn + 1.0), canopyY - 2.6, p.z + p.nz * (canopyIn + 1.0), a));
    }
  }

  // --- south end: the 2015 South Plaza, 2,700 seats and five suites -------
  const southPath = buildPath(plan, 34, -ACR_CLUB_OPEN, ACR_CLUB_OPEN);
  const southDeck = rakedSection({ u0: lower.uTop + 1.6, v0: clubBase - 1.4, steps: 8, run: 1.7, rise: 0.8 * hs, fascia: 2.8, grow: 0.3 });
  seatingTier({ path: southPath, section: southDeck, seats: seatsA, aisles, aisleStep: 6, aisleFrom: 3 });
  cast.push(sweepStrip(southPath, southDeck.shell));
  for (const node of [southPath[0], southPath[southPath.length - 1]]) {
    cast.push(sectionCap(southDeck.closed, node));
  }
  glassG.push(
    sweepStrip(offsetPath(southPath, southDeck.uTop - 0.4), [
      [0, southDeck.vTop + 5.6 * hs],
      [0, southDeck.vTop + 1.0],
    ]),
  );
  cast.push(
    sweepStrip(southPath, [
      [southDeck.uTop - 1.0, southDeck.vTop + 7.0 * hs],
      [southDeck.uOut + 1.6, southDeck.vTop + 7.0 * hs],
      [southDeck.uOut + 1.6, southDeck.vTop + 5.6 * hs],
      [southDeck.uTop - 1.0, southDeck.vTop + 5.6 * hs],
    ]),
  );
  for (let i = 0; i < southPath.length; i += 3) {
    const p = southPath[i];
    steelG.push(box(0.3, 1.2, 0.3, p.x + p.nx * (southDeck.u0 - 0.5), southDeck.v0 + 0.6, p.z + p.nz * (southDeck.u0 - 0.5)));
  }

  // --- 28 x 96 ft video board on open legs behind the south terrace -------
  const boardX = ACR_RX + 42;
  for (const bz of [-16, 16]) {
    steelG.push(box(2.4, 30 * hs, 2.4, boardX + 3.4, 15 * hs, bz));
  }
  for (let k = 0; k < 3; k++) {
    const y0 = 4 + k * 9 * hs;
    const y1 = y0 + 9 * hs;
    for (const sgn of [1, -1]) {
      steelG.push(
        brace(Math.hypot(32, 9 * hs), 0.5, 1.2, sgn * Math.atan2(9 * hs, 32), boardX + 3.4, (y0 + y1) * 0.5, 0, Math.PI / 2),
      );
    }
  }
  steelG.push(box(3.0, 2.0, 34, boardX + 3.4, 22.5 * hs, 0));
  steelG.push(box(3.0, 2.0, 34, boardX + 3.4, 33.5 * hs, 0));
  boards.push(box(1.2, 28 * FT, 96 * FT, boardX + 1.6, 28 * hs, 0));
  cast.push(box(9, 8, 44, boardX + 8, 4, 0));

  // --- 35 x 73 ft corner board, north-west, added 2014 --------------------
  {
    const t = 152 * DEG;
    const p = plan(t);
    const r = Math.hypot(p[0], p[1]);
    const ux = p[0] / r;
    const uz = p[1] / r;
    const bx = p[0] + ux * (upper.uOut + 4);
    const bz = p[1] + uz * (upper.uOut + 4);
    const a = Math.atan2(ux, uz);
    steelG.push(box(24, 4, 2.2, bx, upper.vTop + 2.0, bz, a));
    boards.push(box(73 * FT, 35 * FT, 1.0, bx - ux * 1.2, upper.vTop + 8.0, bz - uz * 1.2, a));
  }

  // --- exterior: a buff precast podium under an open charcoal steel frame --
  // Above the upper concourse the real building has almost no skin at all:
  // the exposed frame stands clear of the raked concrete deck behind it, which
  // is why the stadium reads dark grey rather than as a clad drum.
  const outer = offsetPath(upperPath, upper.uOut + 0.5);
  const ringTop = canopyY + 1.6;
  const podium = upper.v0 - 9.5;
  cast.push(
    sweepStrip(outer, [
      [0.2, podium],
      [2.0, podium],
      [2.0, 5.2],
      [0.2, 5.2],
    ]),
  );
  cast.push(
    sweepStrip(outer, [
      [0.5, 5.0],
      [2.7, 5.0],
      [2.7, 0],
      [0.5, 0],
    ]),
  );
  // Punched openings in the podium, one per bay.
  for (let i = 1; i < outer.length - 1; i += 3) {
    const p = outer[i];
    const a = nodeYaw(p);
    for (const y of [9.5, 16.0]) {
      dark.push(box(6.4, 3.6, 0.6, p.x + p.nx * 2.4, y, p.z + p.nz * 2.4, a));
    }
  }
  // Columns on a 9 m bay, X-braced in every other bay: 12,000 tons of exposed
  // structural steel is what the building is remembered for.
  colonnade({
    path: outer,
    y0: 0,
    y1: ringTop,
    step: 3,
    colW: 2.0,
    colD: 3.4,
    cols: steelG,
    braces: steelG,
    braceEvery: 3,
    braceBands: [
      [5.0, podium],
      [podium + 2.4, upper.v0],
      [upper.v0 + 2.0, ringTop - 3.0],
    ],
    outset: 2.2,
  });
  // Horizontal ring beams tie the frame at each concourse level.
  for (const y of [podium + 1.2, upper.v0 + 1.0, (upper.v0 + upper.vTop) * 0.5]) {
    steelG.push(
      sweepStrip(offsetPath(outer, 2.0), [
        [0, y + 0.9],
        [1.1, y + 0.9],
        [1.1, y - 0.9],
        [0, y - 0.9],
      ]),
    );
  }
  // Ring beam at the top, and the glazed upper concourse behind the frame.
  steelG.push(
    sweepStrip(offsetPath(outer, 1.4), [
      [0, ringTop + 1.4],
      [2.2, ringTop + 1.4],
      [2.2, ringTop - 3.0],
      [0, ringTop - 3.0],
    ]),
  );
  glassG.push(
    sweepStrip(offsetPath(outer, 0.6), [
      [0, upper.v0 - 0.5],
      [0, podium + 1.6],
    ]),
  );
  // Street-level gates: glazed openings under a steel entry canopy.
  glassG.push(
    sweepStrip(offsetPath(outer, 2.6), [
      [0, 4.6],
      [0, 0.2],
    ]),
  );
  steelG.push(
    sweepStrip(offsetPath(outer, 2.4), [
      [0, 5.4],
      [2.6, 5.4],
      [2.6, 4.7],
      [0, 4.7],
    ]),
  );
  for (let i = 2; i < outer.length - 2; i += 3) {
    const p = outer[i];
    const a = nodeYaw(p);
    dark.push(box(3.4, 4.2, 0.8, p.x + p.nx * 2.9, 2.1, p.z + p.nz * 2.9, a));
  }

  // Glazed escalator and stair towers standing off the frame.
  for (let i = 6; i < outer.length - 6; i += 13) {
    const p = outer[i];
    const a = nodeYaw(p);
    const top = upper.v0 + 3;
    const ox = p.x + p.nx * 8.0;
    const oz = p.z + p.nz * 8.0;
    glassG.push(box(14, top, 13, ox, top * 0.5, oz, a));
    for (const k of [-1, 1]) {
      steelG.push(box(1.1, top, 1.1, ox + Math.cos(a) * k * 6.8, top * 0.5, oz - Math.sin(a) * k * 6.8, a));
    }
    // Escalator runs climbing the tower face, on their own concrete beams.
    for (let k = 0; k < 3; k++) {
      const y = 4.0 + (k * (top - 6.5)) / 3;
      conc.push(brace(18, 1.1, 5.0, k % 2 ? -0.44 : 0.44, ox, y, oz, a));
      steelG.push(box(15.4, 0.5, 5.6, ox, y + 4.6, oz, a));
    }
    steelG.push(box(15.6, 1.4, 14.6, ox, top + 0.7, oz, a));
    conc.push(box(15, 1.4, 13.6, ox, 0.7, oz, a));
  }
  // The two south corners carry the open-air ramps up to the upper concourse.
  for (const t of [ACR_UPPER_OPEN, -ACR_UPPER_OPEN]) {
    const p = plan(t);
    const r = Math.hypot(p[0], p[1]);
    const ux = p[0] / r;
    const uz = p[1] / r;
    const cx = p[0] + ux * (upper.uOut * 0.72);
    const cz = p[1] + uz * (upper.uOut * 0.72);
    const a = Math.atan2(ux, uz);
    conc.push(box(21, 6, 17, cx, 3, cz, a));
    for (let k = 1; k <= 5; k++) {
      conc.push(box(21, 0.8, 17, cx, 3 + k * (upper.v0 - 3) / 5, cz, a));
      steelG.push(box(22, 0.5, 0.6, cx, 3.6 + k * (upper.v0 - 3) / 5, cz, a));
    }
    steelG.push(box(1.4, upper.v0, 1.4, cx + ux * 8, upper.v0 * 0.5, cz + uz * 8, a));
  }

  // --- FedEx Great Hall: 40,000 sq ft of glazed hall on the east side -----
  {
    const t = -100 * DEG;
    const p = plan(t);
    const r = Math.hypot(p[0], p[1]);
    const ux = p[0] / r;
    const uz = p[1] / r;
    const gx = p[0] + ux * (upper.uOut + 8);
    const gz = p[1] + uz * (upper.uOut + 8);
    const a = Math.atan2(ux, uz);
    cast.push(box(64, 17, 15, gx, 8.5, gz, a));
    glassG.push(box(56, 13, 15.6, gx, 8.0, gz, a));
    steelG2.push(box(68, 1.4, 19, gx + ux * 1.5, 17.6, gz + uz * 1.5, a));
    for (let k = -3; k <= 3; k++) {
      steelG.push(box(1.1, 18, 1.1, gx + Math.cos(a) * k * 9.2, 9, gz - Math.sin(a) * k * 9.2, a));
      steelG.push(brace(11, 0.6, 1.0, -1.05, gx + ux * 3.6 + Math.cos(a) * k * 9.2, 18.5, gz + uz * 3.6 - Math.sin(a) * k * 9.2, a));
    }
  }

  const parts = [
    [conc, concrete],
    [cast, precast],
    [aisles, concrete],
    [steelG, steel],
    [steelG2, steelPale],
    [seatsA, seatGold],
    [seatsB, seatGold],
    [dark, seatBlack],
    [glassG, glass],
    [boards, board],
    [lamps, lamp],
  ];
  for (const [geoms, material] of parts) {
    const mesh = meshFrom(geoms, material);
    if (mesh) core.add(mesh);
  }
  // The playing surface is centred on the model origin, which is where
  // landmarks.js drops the venue, so no bounding-box recentring is wanted.
  anchorAndAttach(core, oriented, 0, 0);
  return group;
}

// ---------------------------------------------------------------------------
// PPG Paints Arena
// ---------------------------------------------------------------------------

/**
 * PPG Paints Arena: 720,000 sq ft and 18,400 seats under a shallow domed roof
 * on steel trusses, clad in light metal panel over precast. The identifying
 * feature is the 400 ft long S-shaped curtain wall wrapping a 100 ft atrium,
 * turned to face downtown; local +X is its outward normal.
 */
export function buildPpgArena(spec = {}) {
  const group = new THREE.Group();
  group.name = 'ppg-paints-arena';

  const h = clamp(spec.h, 32, 48);
  const hs = clamp(h / 40, 0.9, 1.15);
  const s = fitScale(spec.f, 166, 154);
  const yaw = Number.isFinite(spec.orientYaw) ? spec.orientYaw : Math.PI;

  const oriented = new THREE.Group();
  oriented.rotation.y = -yaw;
  oriented.scale.set(s, 1, s);
  group.add(oriented);
  const core = new THREE.Group();

  const precast = mat(0xc9c4b6, { roughness: 0.84, metalness: 0.06 });
  const panel = mat(0xb9bec4, { roughness: 0.42, metalness: 0.52, envMapIntensity: 1.0 });
  const accent = mat(0x8d8878, { roughness: 0.72, metalness: 0.12 });
  const steel = mat(0x5a6068, { roughness: 0.4, metalness: 0.68, envMapIntensity: 1.0 });
  // The dome is the largest surface in any view from above; matte standing-seam
  // rather than bright sheet, or the sky reflection flattens it to white.
  const roofMat = mat(0x7c828a, { roughness: 0.7, metalness: 0.18, envMapIntensity: 0.35 });
  const glass = mat(0x8fb6cf, {
    roughness: 0.08,
    metalness: 0.55,
    transparent: true,
    opacity: 0.58,
    emissive: 0x2c4a63,
    emissiveIntensity: 0.45,
    envMapIntensity: 1.5,
    side: THREE.DoubleSide,
  });
  const lamp = mat(0xe8ecdf, { roughness: 0.3, metalness: 0.4, emissive: 0xffe9b4, emissiveIntensity: 0.85 });

  const body = [];
  const clad = [];
  const trim = [];
  const steelG = [];
  const roofG = [];
  const glassG = [];
  const lamps = [];

  const rx = 78;
  const rz = 74;
  const plan = superEllipse(rx, rz, 0.52);
  const wallTop = 24 * hs;
  const wallPath = buildPath(plan, 100, 0, Math.PI * 2, true);

  // Precast plinth, metal panel above it, parapet on top. Profiles run
  // top-to-bottom so the swept faces point outward rather than into the bowl.
  clad.push(
    sweepStrip(wallPath, [
      [0.2, wallTop + 0.8],
      [1.6, wallTop + 0.2],
      [1.6, wallTop - 1.6],
      [0, wallTop - 3.4],
      [0, 9.5],
    ]),
  );
  body.push(
    sweepStrip(wallPath, [
      [0, 9.8],
      [0.9, 9.2],
      [0.9, 0],
    ]),
  );
  trim.push(
    sweepStrip(wallPath, [
      [0.3, wallTop - 5.0],
      [0.3, wallTop - 8.6],
    ]),
  );

  // Shallow arched roof, ringed by a parapet at the springing line.
  const roofRise = Math.max(h - wallTop - 1.0, 6);
  roofG.push(domeCap(plan, 100, 9, wallTop + 0.6, roofRise));
  steelG.push(
    sweepStrip(wallPath, [
      [0.2, wallTop + 2.6],
      [1.0, wallTop + 2.6],
      [1.0, wallTop + 0.4],
      [0.2, wallTop + 0.4],
    ]),
  );
  // Radial standing-seam ribs so the dome is not a bald shell from the air.
  // domeCap puts radius fraction s at y0 + rise*(1 - s*s), so a rib running
  // from s = 0.3 out to the eave only needs a matching rake.
  for (let i = 0; i < wallPath.length; i += 2) {
    const p = wallPath[i];
    const rr = Math.hypot(p.x, p.z) || 1;
    const sIn = 0.3;
    const run = rr * (1 - sIn);
    const drop = roofRise * (1 - sIn * sIn);
    const midS = (1 + sIn) * 0.5;
    const spoke = { x: 0, z: 0, nx: p.x / rr, nz: p.z / rr };
    roofG.push(
      radialMember(Math.hypot(run, drop), 0.5, 0.32, -Math.atan2(drop, run), spoke, rr * midS, wallTop + 0.8 + roofRise * (1 - midS * midS)),
    );
  }

  // The pair of tied-arch roof trusses reads outside as a raised ridge.
  for (const oz of [-18, 18]) {
    roofG.push(box(108, 2.4, 3.2, 0, wallTop + roofRise * 0.95, oz));
    steelG.push(box(110, 0.7, 1.0, 0, wallTop + roofRise * 0.95 + 1.5, oz));
    for (let k = -4; k <= 4; k++) {
      steelG.push(box(1.0, 2.6, 1.0, k * 11, wallTop + roofRise * 0.95 + 2.6, oz));
    }
  }
  for (const [mx, mz, mw, md] of [
    [-30, -34, 18, 12],
    [-8, -40, 14, 10],
    [14, -30, 20, 13],
    [-22, 32, 16, 11],
    [10, 38, 13, 10],
    [34, 6, 15, 22],
  ]) {
    const my = wallTop + roofRise * (1 - ((mx / rx) ** 2 + (mz / rz) ** 2) * 0.5);
    steelG.push(box(mw, 4.6, md, mx, my + 1.4, mz));
    trim.push(box(mw * 0.45, 1.8, md * 0.5, mx, my + 4.6, mz));
  }
  const catRatio = 0.72;
  const catwalk = buildPath((t) => {
    const p = plan(t);
    return [p[0] * catRatio, p[1] * catRatio];
  }, 64, 0, Math.PI * 2, true);
  const catY = wallTop + roofRise * (1 - catRatio * catRatio) + 1.1;
  steelG.push(
    sweepStrip(
      catwalk,
      [
        [0.6, catY],
        [0.6, catY - 0.9],
      ],
      true,
    ),
  );
  const penthouseY = wallTop + roofRise * (1 - (46 / rx) ** 2 * 0.5);
  clad.push(box(15, 7, 12, -46, penthouseY + 2.5, 4));

  // --- the ice sheet, visible in the plan view through the roof opening ----
  const ice = new THREE.Mesh(
    groundPolygon(
      [
        [-30.5, -12.9],
        [30.5, -12.9],
        [30.5, 12.9],
        [-30.5, 12.9],
      ],
      0.2,
      (x, z) => [x / (200 * FT) + 0.5, 0.5 - z / (85 * FT)],
    ),
    turfMaterial(iceMaps(), mat(0xe6edf2, { roughness: 0.2, metalness: 0.1 })),
  );
  ice.receiveShadow = true;
  core.add(ice);

  // --- the 400 ft S-shaped curtain wall on the downtown-facing facade -----
  const spineFn = (t) => {
    const a = lerp(-64 * DEG, 64 * DEG, t);
    const base = plan(a);
    const bulge = 7.5 * Math.sin(t * Math.PI * 2) + 13 * Math.sin(t * Math.PI);
    const len = Math.hypot(base[0], base[1]) || 1;
    return [base[0] + (base[0] / len) * bulge, base[1] + (base[1] / len) * bulge];
  };
  const spine = buildPath(spineFn, 56, 0, 1);
  const glassTop = 100 * FT * hs * 0.62 + 12;
  glassG.push(
    sweepStrip(spine, [
      [0, glassTop],
      [0, 1.5],
    ]),
  );
  // Sloped glazing folds the atrium back into the wall behind it.
  glassG.push(
    sweepStrip(spine, [
      [-8, glassTop - 4.0],
      [0, glassTop],
    ]),
  );
  steelG.push(
    sweepStrip(spine, [
      [-8.4, glassTop - 4.0],
      [0.7, glassTop + 0.5],
      [0.7, glassTop - 0.4],
      [-8.4, glassTop - 4.8],
    ]),
  );
  for (let i = 0; i < spine.length; i += 2) {
    const p = spine[i];
    const a = nodeYaw(p);
    steelG.push(box(0.75, glassTop - 1.5, 0.75, p.x, (glassTop + 1.5) * 0.5, p.z, a));
    steelG.push(box(0.5, 0.5, 8.6, p.x - p.nx * 4.0, glassTop - 1.9, p.z - p.nz * 4.0, a));
  }
  // Six atrium levels read as horizontal spandrels behind the glass.
  for (const level of [0.2, 0.35, 0.5, 0.66, 0.82]) {
    trim.push(
      sweepStrip(spine, [
        [-0.6, glassTop * level],
        [0.7, glassTop * level],
        [0.7, glassTop * level - 0.8],
        [-0.6, glassTop * level - 0.8],
      ]),
    );
  }
  // Grand stair and entry canopy under the atrium.
  const entry = spine[Math.floor(spine.length / 2)];
  for (let i = 0; i < 7; i++) {
    body.push(box(3.0, 0.95, 42 - i * 2.6, entry.x + 11 - i * 1.7, 0.48 + i * 0.95, entry.z));
  }
  steelG.push(box(2.2, 1.2, 54, entry.x + 14, glassTop * 0.42, entry.z));
  clad.push(box(19, 0.9, 52, entry.x + 6, glassTop * 0.42, entry.z));
  for (const cz of [-20, 0, 20]) {
    steelG.push(box(1.0, glassTop * 0.42, 1.0, entry.x + 13.5, glassTop * 0.21, entry.z + cz));
  }

  // --- perimeter detail: panel joints, corner glazing, signage, lighting --
  for (let i = 0; i < wallPath.length; i += 3) {
    const p = wallPath[i];
    const a = nodeYaw(p);
    trim.push(box(0.45, wallTop - 11.5, 1.0, p.x + p.nx * 0.4, 9.8 + (wallTop - 11.5) * 0.5, p.z + p.nz * 0.4, a));
  }
  for (const t of [55 * DEG, 125 * DEG, 235 * DEG, 305 * DEG]) {
    const p = plan(t);
    const r = Math.hypot(p[0], p[1]);
    const a = Math.atan2(p[0] / r, p[1] / r);
    glassG.push(box(26, wallTop - 8, 1.0, p[0] * 1.005, 4 + (wallTop - 8) * 0.5, p[1] * 1.005, a));
    steelG.push(box(27, 1.1, 3.0, p[0] * 1.01, wallTop - 3.4, p[1] * 1.01, a));
  }
  for (let i = 0; i < wallPath.length; i += 10) {
    const p = wallPath[i];
    const a = nodeYaw(p);
    lamps.push(box(3.4, 0.7, 0.6, p.x + p.nx * 2.0, wallTop - 2.2, p.z + p.nz * 2.0, a));
  }
  for (const [sx, sz] of [
    [-rx - 2, 0],
    [0, -rz - 2],
    [0, rz + 2],
  ]) {
    const acrossX = sx === 0;
    lamps.push(box(acrossX ? 26 : 1.0, 4.5, acrossX ? 1.0 : 26, sx, wallTop - 10, sz));
  }

  const parts = [
    [body, precast],
    [clad, panel],
    [trim, accent],
    [steelG, steel],
    [roofG, roofMat],
    [glassG, glass],
    [lamps, lamp],
  ];
  for (const [geoms, material] of parts) {
    const mesh = meshFrom(geoms, material);
    if (mesh) core.add(mesh);
  }
  centerAndAttach(core, oriented);
  return group;
}
