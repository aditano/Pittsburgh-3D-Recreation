import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const DEG = Math.PI / 180;

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

function box(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
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

/**
 * Stepped seating cross-section in (outward distance, height).
 * `seats` is the raked stair, `shell` the top fascia plus outer wall, and
 * `closed` the full contour used for end caps -- they share vertices so the
 * two sweeps meet without a seam.
 */
function rakedSection({ u0, v0, steps, run, rise, fascia, base = 0 }) {
  const seats = [[u0, v0]];
  let u = u0;
  let v = v0;
  for (let i = 0; i < steps; i++) {
    v += rise;
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
const INFIELD_DIRT = '#8a5a36';
const WARNING_DIRT = '#7a4f30';

function baseballFieldMaps(boundary, dom) {
  const made = makeCtx(1024, 1024);
  if (!made) return null;
  const { canvas, ctx } = made;
  const ppm = 1024 / dom.span;
  const toPx = (x, z) => [(x - dom.x0) * ppm, (z - dom.z0) * ppm];
  const hx = (x, z) => toPx(x, z)[0];
  const hz = (x, z) => toPx(x, z)[1];
  const home = toPx(0, 0);

  ctx.fillStyle = GRASS_DARK;
  ctx.fillRect(0, 0, 1024, 1024);

  // Mow pattern: wedges fanning out of home plate, the way a real crew cuts it.
  ctx.fillStyle = GRASS_LIGHT;
  for (let i = -8; i < 8; i += 2) {
    ctx.beginPath();
    ctx.moveTo(home[0], home[1]);
    ctx.arc(home[0], home[1], 1500, i * 9 * DEG, (i + 1) * 9 * DEG);
    ctx.closePath();
    ctx.fill();
  }

  ctx.save();
  tracePolygon(ctx, boundary, toPx);
  ctx.clip();

  ctx.strokeStyle = WARNING_DIRT;
  ctx.lineWidth = 4.6 * ppm;
  tracePolygon(ctx, boundary, toPx);
  ctx.stroke();

  // Infield skin: a 95 ft arc off the pitching rubber, closed back to the foul lines.
  const moundX = 18.44;
  const skinReach = 38.9;
  const skinSweep = 71.8 * DEG;
  ctx.fillStyle = INFIELD_DIRT;
  ctx.beginPath();
  ctx.moveTo(hx(-6, -6), hz(-6, -6));
  ctx.lineTo(hx(skinReach * 0.7071, -skinReach * 0.7071), hz(skinReach * 0.7071, -skinReach * 0.7071));
  ctx.arc(hx(moundX, 0), hz(moundX, 0), 28.96 * ppm, -skinSweep, skinSweep);
  ctx.lineTo(hx(-6, 6), hz(-6, 6));
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(home[0], home[1], 4.2 * ppm, 0, Math.PI * 2);
  ctx.fill();

  // Infield grass diamond, set 3 m inside the base paths.
  ctx.fillStyle = GRASS_LIGHT;
  tracePolygon(
    ctx,
    [
      [4.3, 0],
      [19.4, -16.4],
      [35.5, 0],
      [19.4, 16.4],
    ],
    toPx,
  );
  ctx.fill();

  ctx.fillStyle = INFIELD_DIRT;
  ctx.beginPath();
  ctx.arc(hx(moundX, 0), hz(moundX, 0), 5.5 * ppm, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#f2f4ef';
  ctx.lineWidth = 0.5 * ppm;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(home[0], home[1]);
    ctx.lineTo(hx(103 * 0.7071, sign * 103 * 0.7071), hz(103 * 0.7071, sign * 103 * 0.7071));
    ctx.stroke();
  }
  ctx.strokeRect(hx(-0.9, -1.5), hz(-0.9, -1.5), 1.85 * ppm, 1.2 * ppm);
  ctx.strokeRect(hx(-0.9, 0.3), hz(-0.9, 0.3), 1.85 * ppm, 1.2 * ppm);

  ctx.fillStyle = '#f2f4ef';
  for (const [bx, bz] of [
    [19.4, 19.4],
    [38.8, 0],
    [19.4, -19.4],
  ]) {
    ctx.fillRect(hx(bx, bz) - 0.8 * ppm, hz(bx, bz) - 0.8 * ppm, 1.6 * ppm, 1.6 * ppm);
  }
  ctx.restore();

  return fieldTexture(canvas);
}

const FOOTBALL_DOM = { x: 150, z: 112.5 };

function footballFieldMaps() {
  const made = makeCtx(1024, 768);
  if (!made) return null;
  const { canvas, ctx } = made;
  const ppm = 1024 / FOOTBALL_DOM.x;
  const toPx = (x, z) => [(x + FOOTBALL_DOM.x * 0.5) * ppm, (z + FOOTBALL_DOM.z * 0.5) * ppm];
  const halfLen = 45.72;
  const endZone = 9.14;
  const halfWide = 24.4;

  // Turf runs to the edge of the domain so the apron outside the sidelines
  // reads as grass rather than a dark moat.
  ctx.fillStyle = GRASS_DARK;
  ctx.fillRect(0, 0, 1024, 768);
  ctx.fillStyle = GRASS_LIGHT;
  for (let i = -4; i < 14; i += 2) {
    ctx.fillRect(toPx(-halfLen + i * 9.144, 0)[0], 0, 9.144 * ppm, 768);
  }

  const top = toPx(0, -halfWide)[1];
  const bottom = toPx(0, halfWide)[1];

  ctx.fillStyle = '#14161a';
  ctx.fillRect(toPx(-halfLen - endZone, 0)[0], top, endZone * ppm, bottom - top);
  ctx.fillRect(toPx(halfLen, 0)[0], top, endZone * ppm, bottom - top);
  ctx.fillStyle = '#c8a93a';
  ctx.font = `bold ${5.2 * ppm}px sans-serif`;
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
  for (let i = 0; i <= 20; i++) {
    const x = toPx(-halfLen + i * 4.572, 0)[0];
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  ctx.lineWidth = 0.5 * ppm;
  ctx.strokeRect(
    toPx(-halfLen - endZone, -halfWide)[0],
    top,
    (2 * halfLen + 2 * endZone) * ppm,
    bottom - top,
  );

  // NFL hash marks sit 70 ft 9 in in from each sideline, so 2.83 m off the centre line.
  ctx.lineWidth = 0.28 * ppm;
  for (const hz of [-2.83, 2.83]) {
    for (let i = 1; i < 100; i++) {
      const x = toPx(-halfLen + i * 0.9144, 0)[0];
      const y = toPx(0, hz)[1];
      ctx.beginPath();
      ctx.moveTo(x, y - 0.6 * ppm);
      ctx.lineTo(x, y + 0.6 * ppm);
      ctx.stroke();
    }
  }

  ctx.fillStyle = '#eef2ee';
  ctx.font = `bold ${3.6 * ppm}px sans-serif`;
  for (let i = 1; i < 10; i++) {
    const yard = i * 10;
    const label = String(yard > 50 ? 100 - yard : yard);
    const x = toPx(-halfLen + yard * 0.9144, 0)[0];
    for (const [zz, rot] of [
      [-13.4, 0],
      [13.4, Math.PI],
    ]) {
      const p = toPx(0, zz);
      ctx.save();
      ctx.translate(x, p[1]);
      ctx.rotate(rot);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }

  ctx.strokeStyle = '#c8a93a';
  ctx.lineWidth = 0.6 * ppm;
  const mid = toPx(0, 0);
  ctx.beginPath();
  ctx.arc(mid[0], mid[1], 8 * ppm, 0, Math.PI * 2);
  ctx.stroke();

  return fieldTexture(canvas);
}

function fallbackTurf() {
  return mat(0x2c6a33, { roughness: 0.95, metalness: 0.01 });
}

function turfMaterial(map) {
  if (!map) return fallbackTurf();
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
 * Outfield wall distance in metres by angle off dead centre, negative on the
 * left-field side: the published 325 / 389 / 410 / 399 / 375 / 320 ft posted
 * distances, with the 410 ft pocket sitting in the left-centre gap.
 */
const PNC_WALL = [
  [-45, 99.1],
  [-38, 106.5],
  [-32, 113.5],
  [-27, 118.6],
  [-22, 122.6],
  [-17, 125.0],
  [-12, 124.2],
  [-6, 122.4],
  [0, 121.6],
  [8, 119.2],
  [16, 116.6],
  [22, 114.3],
  [30, 107.5],
  [38, 101.5],
  [45, 97.5],
];

// Inner edge of the grandstand, right-field corner -> behind home -> left-field corner.
const PNC_STAND_EDGE = [
  [56, 73],
  [36, 54],
  [16, 34],
  [2, 22],
  [-9, 16],
  [-16, 7],
  [-18.5, 0],
  [-16, -7],
  [-9, -16],
  [2, -22],
  [16, -34],
  [36, -54],
  [57, -74],
];

/**
 * Where the OSM playing surface has its centroid, in this model's frame: home
 * plate at the origin, +X toward dead centre, +Z the right-field side. The
 * shipped dataset positions the venue on exactly that centroid, so anchoring
 * here is what puts the grandstand back inside the real footprint instead of
 * out over the Allegheny.
 */
const PNC_FIELD_ANCHOR = [52.8, 6.9];

function pncWallPoints() {
  return PNC_WALL.map(([a, r]) => [Math.cos(a * DEG) * r, Math.sin(a * DEG) * r]);
}

/** rotation.y that lays a box's local +X tangent to the outfield arc at `angle`. */
function tangentYaw(angle) {
  return Math.PI / 2 - angle;
}

/** 6 ft in left, 10 ft through centre, then the 21 ft Clemente Wall in right. */
function pncWallHeight(angle) {
  if (angle <= -14) return lerp(1.8, 3.0, (angle + 45) / 31);
  if (angle <= 18) return 3.0;
  if (angle >= 26) return 6.4;
  return lerp(3.0, 6.4, (angle - 18) / 8);
}

/**
 * PNC Park: two-deck, 220-degree bowl that stays open across the outfield so the
 * downtown skyline reads through it. Kasota limestone shell, navy exposed steel.
 * Local +X runs from home plate to dead centre, +Z is the right-field side.
 */
export function buildPncPark(spec = {}) {
  const group = new THREE.Group();
  group.name = 'pnc-park';

  const h = clamp(spec.h, 30, 46);
  const hs = h / 36;
  const s = fitScale(spec.f, 280, 218);
  const yaw = Number.isFinite(spec.orientYaw) ? spec.orientYaw : 0.2503;

  const oriented = new THREE.Group();
  oriented.rotation.y = -yaw;
  oriented.scale.set(s, 1, s);
  group.add(oriented);
  const core = new THREE.Group();

  const limestone = mat(0xc7bda6, { roughness: 0.84, metalness: 0.05 });
  const concrete = mat(0x9c988c, { roughness: 0.9, metalness: 0.04 });
  const steel = mat(0x2a4d7c, { roughness: 0.5, metalness: 0.55, envMapIntensity: 0.9 });
  const seatLower = mat(0x27548c, { roughness: 0.88, metalness: 0.04 });
  const seatUpper = mat(0x1e4372, { roughness: 0.88, metalness: 0.04 });
  const padding = mat(0x14361f, { roughness: 0.92, metalness: 0.03 });
  const board = mat(0x0b0d10, { roughness: 0.35, metalness: 0.3, emissive: 0x2a3550, emissiveIntensity: 0.55 });
  const lamp = mat(0xdfe4d8, { roughness: 0.3, metalness: 0.5, emissive: 0xfff0c0, emissiveIntensity: 0.9 });

  const stone = [];
  const conc = [];
  const steelG = [];
  const seatsA = [];
  const seatsB = [];
  const dark = [];
  const boards = [];
  const lamps = [];

  // --- playing surface -----------------------------------------------------
  const wall = pncWallPoints();
  const boundary = PNC_STAND_EDGE.concat(wall);
  const dom = { x0: -32, z0: -84, span: 168 };
  const turf = turfMaterial(baseballFieldMaps(boundary, dom));
  const fieldGeom = groundPolygon(boundary, 0.35, (x, z) => [
    (x - dom.x0) / dom.span,
    1 - (z - dom.z0) / dom.span,
  ]);
  const field = new THREE.Mesh(fieldGeom, turf);
  field.receiveShadow = true;
  core.add(field);

  // --- outfield wall (6 ft in left, the 21 ft Clemente Wall in right) -------
  const wallPath = buildPath(splineFn(wall), 56, 0, 1);
  const wallAngles = wallPath.map((_, i) => lerp(-45, 45, i / (wallPath.length - 1)));
  wallPath.forEach((p, i) => {
    p.sv = pncWallHeight(wallAngles[i]);
  });
  dark.push(sweepStrip(wallPath, [[0, 0], [0, 1], [0.6, 1], [0.6, 0]]));

  // --- lower and upper decks: only two, which is the whole point of the park -
  const standFn = splineFn(PNC_STAND_EDGE);
  const standPath = buildPath(standFn, 78, 0, 1);
  const lowerPath = offsetPath(standPath, 2.4);
  const lower = rakedSection({ u0: 0, v0: 1.3 * hs, steps: 14, run: 1.5, rise: 0.78 * hs, fascia: 2.6 });
  seatsA.push(sweepStrip(lowerPath, lower.seats));
  conc.push(sweepStrip(lowerPath, lower.shell));

  const upper = rakedSection({
    u0: 13.5,
    v0: 17 * hs,
    steps: 16,
    run: 1.6,
    rise: 0.92 * hs,
    fascia: 2.8,
    base: 0,
  });
  seatsB.push(sweepStrip(lowerPath, upper.seats));
  stone.push(sweepStrip(lowerPath, upper.shell));
  const standEnds = [lowerPath[0], lowerPath[lowerPath.length - 1]];
  for (const node of standEnds) {
    conc.push(sectionCap(lower.closed, node));
    stone.push(sectionCap(upper.closed, node));
  }

  // Suite band tucked between the decks, and the canopy over the upper deck.
  const suitePath = offsetPath(lowerPath, 11.0);
  stone.push(
    sweepStrip(suitePath, [
      [0, 16.8 * hs],
      [1.6, 16.8 * hs],
      [1.6, 12.6 * hs],
      [0, 12.6 * hs],
    ]),
  );
  // Only the back rows and press box are sheltered; the upper deck is open air.
  const canopyTop = upper.vTop + 4.4 * hs;
  steelG.push(
    sweepStrip(lowerPath, [
      [upper.uTop - 7, canopyTop],
      [upper.uOut + 1.2, canopyTop],
      [upper.uOut + 1.2, canopyTop - 1.0],
      [upper.uTop - 7, canopyTop - 1.0],
    ]),
  );
  stone.push(
    sweepStrip(lowerPath, [
      [upper.uTop, canopyTop - 1.1],
      [upper.uTop, upper.vTop],
    ]),
  );

  // --- limestone base arcade: the rhythmic archways at street level --------
  const facadePath = offsetPath(lowerPath, upper.uOut - 0.4);
  const arcadeTop = 10.6 * hs;
  stone.push(
    sweepStrip(facadePath, [
      [0, arcadeTop],
      [1.9, arcadeTop],
      [1.9, arcadeTop - 1.7],
      [0, arcadeTop - 1.7],
    ]),
  );
  stone.push(
    sweepStrip(facadePath, [
      [0, 1.3],
      [1.9, 1.3],
      [1.9, 0],
      [0, 0],
    ]),
  );
  for (let i = 0; i < facadePath.length; i += 3) {
    const p = facadePath[i];
    const a = Math.atan2(p.nx, p.nz);
    const pierH = arcadeTop - 3.0;
    stone.push(box(2.2, pierH, 2.0, p.x + p.nx * 0.9, 1.3 + pierH * 0.5, p.z + p.nz * 0.9, a));
    if (i % 6 !== 0) {
      // Exposed navy trusswork carried up the limestone between the arches.
      steelG.push(
        box(0.7, upper.vTop - arcadeTop, 1.2, p.x + p.nx * 0.6, (upper.vTop + arcadeTop) * 0.5, p.z + p.nz * 0.6, a),
      );
    }
  }

  // --- left-field bleachers, open right field keeps the skyline view --------
  const bleacherPath = offsetPath(buildPath(splineFn(wall.slice(0, 7)), 28, 0, 1), 4.4);
  const bleach = rakedSection({ u0: 0, v0: 3.4 * hs, steps: 9, run: 1.5, rise: 0.85 * hs, fascia: 2.2, base: 0 });
  seatsA.push(sweepStrip(bleacherPath, bleach.seats));
  stone.push(sweepStrip(bleacherPath, bleach.shell));
  for (const node of [bleacherPath[0], bleacherPath[bleacherPath.length - 1]]) {
    stone.push(sectionCap(bleach.closed, node));
  }

  // --- right-field riverwalk terrace, kept low for the skyline view ---------
  const riverPath = offsetPath(buildPath(splineFn(wall.slice(9)), 28, 0, 1), 2.2);
  stone.push(
    sweepStrip(riverPath, [
      [0, 4.2 * hs],
      [11, 4.2 * hs],
      [11, 0],
      [0, 0],
    ]),
  );
  for (const node of [riverPath[0], riverPath[riverPath.length - 1]]) {
    stone.push(
      sectionCap(
        [
          [0, 0],
          [0, 4.2 * hs],
          [11, 4.2 * hs],
          [11, 0],
        ],
        node,
      ),
    );
  }
  for (let i = 0; i < riverPath.length; i += 2) {
    const p = riverPath[i];
    steelG.push(box(0.25, 1.4, 0.25, p.x + p.nx * 10.4, 4.2 * hs + 0.7, p.z + p.nz * 10.4));
  }
  steelG.push(
    sweepStrip(offsetPath(riverPath, 10.4), [
      [0, 4.2 * hs + 1.4],
      [0, 4.2 * hs + 1.0],
    ]),
  );

  // --- heptagonal ramp rotundas seated on the facade -----------------------
  for (const [idx, radius, height] of [
    [0, 12, 26 * hs],
    [facadePath.length - 1, 12, 26 * hs],
    [Math.round((facadePath.length - 1) / 2), 13, 21 * hs],
  ]) {
    const p = facadePath[idx];
    const cx = p.x + p.nx * radius * 0.34;
    const cz = p.z + p.nz * radius * 0.34;
    stone.push(cyl(radius, radius, height, 7, cx, height * 0.5, cz, Math.PI / 7));
    steelG.push(cyl(radius + 0.6, radius + 0.6, 0.8, 7, cx, height * 0.45, cz, Math.PI / 7));
    steelG.push(cyl(radius + 0.6, radius + 0.6, 0.8, 7, cx, height * 0.76, cz, Math.PI / 7));
    steelG.push(cyl(radius + 1.5, radius + 1.5, 0.9, 7, cx, height + 0.5, cz, Math.PI / 7));
  }

  // --- scoreboards ----------------------------------------------------------
  const mainAngle = -26 * DEG;
  const mainR = 133;
  const mainX = Math.cos(mainAngle) * mainR;
  const mainZ = Math.sin(mainAngle) * mainR;
  const mainRot = tangentYaw(mainAngle);
  steelG.push(box(22, 18 * hs, 1.6, mainX, 9 * hs, mainZ, mainRot));
  boards.push(box(20, 10.5, 1.0, mainX - Math.cos(mainAngle), 17.5 * hs, mainZ - Math.sin(mainAngle), mainRot));
  for (let i = 0; i < 4; i++) {
    const off = (i - 1.5) * 5.2;
    lamps.push(
      box(4.2, 0.9, 1.2, mainX - Math.sin(mainAngle) * off, 24.5 * hs, mainZ + Math.cos(mainAngle) * off, mainRot),
    );
  }

  // Manually operated out-of-town board on the tall right-field wall.
  const ootAngle = 33 * DEG;
  const ootR = 103;
  boards.push(
    box(24, 3.4, 0.5, Math.cos(ootAngle) * ootR, 3.9, Math.sin(ootAngle) * ootR, tangentYaw(ootAngle)),
  );

  // --- Forbes Field style light towers -------------------------------------
  const towerTs = [0.06, 0.22, 0.38, 0.62, 0.78, 0.94];
  for (const t of towerTs) {
    const idx = Math.round(t * (facadePath.length - 1));
    const p = facadePath[idx];
    const px = p.x - p.nx * 4;
    const pz = p.z - p.nz * 4;
    const a = Math.atan2(p.nx, p.nz);
    const top = canopyTop + 8 * hs;
    steelG.push(box(3.2, top - canopyTop + 2, 1.6, px, canopyTop + (top - canopyTop) * 0.5, pz, a));
    steelG.push(box(11, 1.2, 1.4, px, top, pz, a));
    for (let i = 0; i < 3; i++) {
      lamps.push(box(2.8, 1.4, 0.7, px + Math.cos(a) * (i - 1) * 3.6, top + 1.2, pz - Math.sin(a) * (i - 1) * 3.6, a));
    }
  }
  for (const [tx, tz] of [
    [112, -76],
    [131, -34],
  ]) {
    const top = 32 * hs;
    steelG.push(box(2.4, top, 2.4, tx, top * 0.5, tz));
    steelG.push(box(12, 1.2, 1.6, tx, top + 0.8, tz, Math.atan2(tx, tz)));
    lamps.push(box(9, 1.3, 0.9, tx, top + 2.0, tz, Math.atan2(tx, tz)));
  }

  // --- outfield backdrop shrubbery / batter's eye ---------------------------
  const eyeAngle = -4 * DEG;
  dark.push(
    box(28, 8.5, 3.0, Math.cos(eyeAngle) * 124, 4.25, Math.sin(eyeAngle) * 124, tangentYaw(eyeAngle)),
  );

  const parts = [
    [stone, limestone],
    [conc, concrete],
    [steelG, steel],
    [seatsA, seatLower],
    [seatsB, seatUpper],
    [dark, padding],
    [boards, board],
    [lamps, lamp],
  ];
  for (const [geoms, material] of parts) {
    const mesh = meshFrom(geoms, material);
    if (mesh) core.add(mesh);
  }
  anchorAndAttach(core, oriented, PNC_FIELD_ANCHOR[0], PNC_FIELD_ANCHOR[1]);
  return group;
}

// ---------------------------------------------------------------------------
// Acrisure Stadium
// ---------------------------------------------------------------------------

/**
 * Field-level plan taken from the OSM playing surface: 123 x 86 m, which is a
 * 109.7 x 48.8 m football field plus its aprons. The bowl grows outward from
 * that edge, and the generous corner radius is what keeps the sidelines
 * straight instead of letting the bowl slump into an oval.
 */
const ACR_RX = 61.5;
const ACR_RZ = 42.5;
const ACR_CORNER = 25;
// The club tier stops at the south corners and the upper deck stops shorter
// still, so the whole end zone end stays open to the skyline.
const ACR_CLUB_OPEN = 35 * DEG;
const ACR_UPPER_OPEN = 43 * DEG;

/**
 * Acrisure Stadium: rounded-rectangle plan, a lower bowl that rings the field,
 * three-tier sideline grandstands wrapping the closed north end, and nothing
 * taller than a concourse terrace across the south end zone -- the open
 * horseshoe that frames downtown. Local +X points out through the open end.
 */
export function buildAcrisureStadium(spec = {}) {
  const group = new THREE.Group();
  group.name = 'acrisure-stadium';

  const h = clamp(spec.h, 42, 64);
  const hs = h / 58;
  const s = fitScale(spec.f, 290, 261);
  const yaw = Number.isFinite(spec.orientYaw) ? spec.orientYaw : 1.131;

  const oriented = new THREE.Group();
  oriented.rotation.y = -yaw;
  oriented.scale.set(s, 1, s);
  group.add(oriented);
  const core = new THREE.Group();

  const concrete = mat(0x9b978c, { roughness: 0.88, metalness: 0.05 });
  const clad = mat(0x6e737a, { roughness: 0.62, metalness: 0.3 });
  const steel = mat(0x4a4f56, { roughness: 0.45, metalness: 0.62, envMapIntensity: 0.9 });
  const seatLower = mat(0xa08a2c, { roughness: 0.9, metalness: 0.05 });
  const seatUpper = mat(0x86722a, { roughness: 0.9, metalness: 0.05 });
  const board = mat(0x0a0c0f, { roughness: 0.3, metalness: 0.35, emissive: 0x3a4460, emissiveIntensity: 0.6 });
  const lamp = mat(0xe4e8dc, { roughness: 0.28, metalness: 0.5, emissive: 0xfff2c8, emissiveIntensity: 1.0 });

  const conc = [];
  const shell = [];
  const steelG = [];
  const seatsA = [];
  const seatsB = [];
  const boards = [];
  const lamps = [];

  const rx = 70;
  const rz = 40;
  const plan = superEllipse(rx, rz, 0.38);
  const openHalf = 29 * DEG;

  // --- field: turf apron follows the bowl plan so it never clips the seats --
  const apron = [];
  for (let i = 0; i < 48; i++) {
    const p = plan((i / 48) * Math.PI * 2);
    apron.push([p[0] * 0.93, p[1] * 0.93]);
  }
  const turf = turfMaterial(footballFieldMaps());
  const fieldGeom = groundPolygon(apron, 0.3, (x, z) => [
    x / FOOTBALL_DOM.x + 0.5,
    0.5 - z / FOOTBALL_DOM.z,
  ]);
  const field = new THREE.Mesh(fieldGeom, turf);
  field.receiveShadow = true;
  core.add(field);

  // --- lower bowl: complete ring around the field --------------------------
  const ringPath = buildPath(plan, 84, 0, Math.PI * 2, true);
  const lower = rakedSection({ u0: 0, v0: 1.6 * hs, steps: 14, run: 1.55, rise: 0.86 * hs, fascia: 2.4 });
  seatsA.push(sweepStrip(ringPath, lower.seats, true));
  conc.push(sweepStrip(ringPath, lower.shell, true));

  // --- club and upper decks: horseshoe, open at +X -------------------------
  const horseshoe = buildPath(plan, 78, openHalf, Math.PI * 2 - openHalf);
  const club = rakedSection({ u0: 11, v0: 18.5 * hs, steps: 7, run: 1.7, rise: 0.9 * hs, fascia: 2.6 });
  seatsA.push(sweepStrip(horseshoe, club.seats));
  shell.push(sweepStrip(horseshoe, club.shell));

  const upper = rakedSection({
    u0: 13,
    v0: 29 * hs,
    steps: 17,
    run: 1.5,
    rise: 1.28 * hs,
    fascia: 3.4,
    base: 0,
  });
  seatsB.push(sweepStrip(horseshoe, upper.seats));
  conc.push(sweepStrip(horseshoe, upper.shell));
  const ends = [horseshoe[0], horseshoe[horseshoe.length - 1]];
  for (const node of ends) {
    shell.push(sectionCap(club.closed, node));
    conc.push(sectionCap(upper.closed, node));
  }

  // --- partial canopy over the back of the upper deck ----------------------
  const canopyY = upper.vTop + 5.5 * hs;
  const canopyIn = upper.uTop - 8;
  steelG.push(
    sweepStrip(horseshoe, [
      [canopyIn, canopyY],
      [upper.uOut + 1, canopyY],
      [upper.uOut + 1, canopyY - 1.1],
      [canopyIn, canopyY - 1.1],
    ]),
  );
  conc.push(
    sweepStrip(horseshoe, [
      [upper.uTop, upper.vTop],
      [upper.uTop, canopyY - 1.2],
    ]),
  );
  for (let i = 2; i < horseshoe.length - 2; i += 5) {
    const p = horseshoe[i];
    const a = Math.atan2(p.nx, p.nz);
    steelG.push(
      box(1.1, canopyY, 3.5, p.x + p.nx * (upper.uTop + 1.5), canopyY * 0.5, p.z + p.nz * (upper.uTop + 1.5), a),
    );
    lamps.push(box(7.0, 1.1, 1.0, p.x + p.nx * (canopyIn + 0.5), canopyY - 1.8, p.z + p.nz * (canopyIn + 0.5), a));
  }

  // --- south end: low plaza structure keeps the end open to downtown -------
  const southPath = buildPath(plan, 22, -openHalf, openHalf);
  shell.push(
    sweepStrip(southPath, [
      [10, 17.5 * hs],
      [30, 17.5 * hs],
      [30, 0],
    ]),
  );
  for (let i = 0; i < southPath.length; i += 4) {
    const p = southPath[i];
    steelG.push(box(0.3, 1.2, 0.3, p.x + p.nx * 10.4, 18.2 * hs, p.z + p.nz * 10.4));
  }

  // --- scoreboards at both ends --------------------------------------------
  const southX = rx + 26;
  steelG.push(box(3.0, 26 * hs, 34, southX + 2.5, 13 * hs, 0));
  boards.push(box(1.2, 9.5, 31, southX, 24 * hs, 0));
  const northX = -(rx + 14);
  steelG.push(box(3.0, 13, 32, northX - 2.5, upper.vTop + 2.5, 0));
  boards.push(box(1.2, 10.5, 29, northX, upper.vTop + 3, 0));

  // --- exterior ramp towers and cladding fins ------------------------------
  for (let i = 3; i < horseshoe.length - 3; i += 9) {
    const p = horseshoe[i];
    const a = Math.atan2(p.nx, p.nz);
    const ox = p.x + p.nx * (upper.uOut + 5.5);
    const oz = p.z + p.nz * (upper.uOut + 5.5);
    conc.push(box(13, upper.vTop * 0.92, 10, ox, upper.vTop * 0.46, oz, a));
    for (let k = 1; k <= 3; k++) {
      shell.push(box(14, 0.8, 11, ox, (upper.vTop * 0.92 * k) / 3.4, oz, a));
    }
  }
  const fascia = offsetPath(horseshoe, upper.uOut + 0.4);
  shell.push(
    sweepStrip(fascia, [
      [0, upper.vTop + 0.4],
      [0.9, upper.vTop + 0.4],
      [0.9, upper.vTop - 4.5],
      [0, upper.vTop - 4.5],
    ]),
  );

  const parts = [
    [conc, concrete],
    [shell, clad],
    [steelG, steel],
    [seatsA, seatLower],
    [seatsB, seatUpper],
    [boards, board],
    [lamps, lamp],
  ];
  for (const [geoms, material] of parts) {
    const mesh = meshFrom(geoms, material);
    if (mesh) core.add(mesh);
  }
  centerAndAttach(core, oriented);
  return group;
}

// ---------------------------------------------------------------------------
// PPG Paints Arena
// ---------------------------------------------------------------------------

/**
 * PPG Paints Arena: chamfered rounded-rectangle body in light precast, a shallow
 * arched roof, and the serpentine glass atrium wall facing downtown.
 * Local +X is the outward normal of the glass facade.
 */
export function buildPpgArena(spec = {}) {
  const group = new THREE.Group();
  group.name = 'ppg-paints-arena';

  const h = clamp(spec.h, 32, 48);
  const hs = h / 40;
  const s = fitScale(spec.f, 190, 175);
  const yaw = Number.isFinite(spec.orientYaw) ? spec.orientYaw : Math.PI;

  const oriented = new THREE.Group();
  oriented.rotation.y = -yaw;
  oriented.scale.set(s, 1, s);
  group.add(oriented);
  const core = new THREE.Group();

  const precast = mat(0xcfcabb, { roughness: 0.82, metalness: 0.06 });
  const accent = mat(0x8d8878, { roughness: 0.72, metalness: 0.12 });
  const steel = mat(0x5a6068, { roughness: 0.4, metalness: 0.68, envMapIntensity: 1.0 });
  const roofMat = mat(0x93999f, { roughness: 0.7, metalness: 0.26 });
  const glass = mat(0x9cc0d4, {
    roughness: 0.1,
    metalness: 0.55,
    transparent: true,
    opacity: 0.66,
    emissive: 0x2c4a63,
    emissiveIntensity: 0.5,
    envMapIntensity: 1.4,
    side: THREE.DoubleSide,
  });
  const lamp = mat(0xe8ecdf, { roughness: 0.3, metalness: 0.4, emissive: 0xffe9b4, emissiveIntensity: 0.85 });

  const body = [];
  const trim = [];
  const steelG = [];
  const roofG = [];
  const glassG = [];
  const lamps = [];

  const rx = 80;
  const rz = 78;
  const plan = superEllipse(rx, rz, 0.5);
  const wallTop = 25 * hs;
  const wallPath = buildPath(plan, 96, 0, Math.PI * 2, true);

  // Cornice down to plinth. Profiles run top-to-bottom so the swept faces
  // point outward rather than into the bowl.
  body.push(
    sweepStrip(wallPath, [
      [0.2, wallTop + 0.6],
      [1.7, wallTop],
      [1.7, wallTop - 1.4],
      [0, wallTop - 3.2],
      [0, 6.4],
      [0.9, 5.5],
      [0.9, 0],
    ]),
  );
  trim.push(
    sweepStrip(wallPath, [
      [0.25, wallTop - 6.5],
      [0.25, wallTop - 11.5],
    ]),
  );

  // Shallow arched roof, ringed by a parapet at the springing line.
  const roofRise = h - wallTop - 1.2;
  roofG.push(domeCap(plan, 96, 8, wallTop + 0.6, roofRise));
  steelG.push(
    sweepStrip(wallPath, [
      [0.2, wallTop + 2.4],
      [1.0, wallTop + 2.4],
      [1.0, wallTop + 0.4],
      [0.2, wallTop + 0.4],
    ]),
  );

  // The pair of tied-arch trusses reads outside as a raised ridge over the bowl.
  for (const oz of [-19, 19]) {
    roofG.push(box(112, 2.6, 3.4, 0, wallTop + roofRise * 0.94, oz));
    steelG.push(box(114, 0.7, 1.0, 0, wallTop + roofRise * 0.94 + 1.6, oz));
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
  // Rooftop catwalk ring and stair penthouse give the shallow dome some scale.
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
  steelG.push(box(15, 7, 12, -46, penthouseY + 2.5, 4));

  // --- serpentine glass curtain wall on the downtown-facing facade ---------
  const spineFn = (t) => {
    const a = lerp(-62 * DEG, 62 * DEG, t);
    const base = plan(a);
    const bulge = 6 * Math.sin(t * Math.PI * 3) + 11 * Math.sin(t * Math.PI);
    const len = Math.hypot(base[0], base[1]) || 1;
    return [base[0] + (base[0] / len) * bulge, base[1] + (base[1] / len) * bulge];
  };
  const spine = buildPath(spineFn, 52, 0, 1);
  const glassTop = 31 * hs;
  glassG.push(
    sweepStrip(spine, [
      [0, glassTop],
      [0, 1.5],
    ]),
  );
  // Sloped glazing folds the atrium back into the precast wall.
  glassG.push(
    sweepStrip(spine, [
      [-7, glassTop - 3.5],
      [0, glassTop],
    ]),
  );
  for (let i = 0; i < spine.length; i += 3) {
    const p = spine[i];
    const a = Math.atan2(p.nx, p.nz);
    steelG.push(box(0.9, glassTop - 1.5, 0.9, p.x, (glassTop + 1.5) * 0.5, p.z, a));
    steelG.push(box(0.6, 0.6, 7.6, p.x - p.nx * 3.5, glassTop - 1.5, p.z - p.nz * 3.5, a));
  }
  for (const level of [0.26, 0.46, 0.66, 0.86]) {
    steelG.push(
      sweepStrip(spine, [
        [-0.5, glassTop * level],
        [0.6, glassTop * level],
        [0.6, glassTop * level - 0.7],
        [-0.5, glassTop * level - 0.7],
      ]),
    );
  }
  // Grand stair and entry canopy under the atrium.
  const entry = spine[Math.floor(spine.length / 2)];
  for (let i = 0; i < 7; i++) {
    trim.push(box(3.0, 0.95, 40 - i * 2.4, entry.x + 11 - i * 1.7, 0.48 + i * 0.95, entry.z));
  }
  steelG.push(box(2.2, 1.2, 52, entry.x + 14, glassTop * 0.44, entry.z));
  trim.push(box(19, 0.9, 50, entry.x + 6, glassTop * 0.44, entry.z));
  for (const cz of [-20, 0, 20]) {
    steelG.push(box(1.0, glassTop * 0.44, 1.0, entry.x + 13.5, glassTop * 0.22, entry.z + cz));
  }

  // --- perimeter detail: precast joints, signage band, roof-edge lighting --
  for (let i = 0; i < wallPath.length; i += 4) {
    const p = wallPath[i];
    const a = Math.atan2(p.nx, p.nz);
    trim.push(box(0.5, wallTop - 7.5, 1.0, p.x + p.nx * 0.4, 6.4 + (wallTop - 7.5) * 0.5, p.z + p.nz * 0.4, a));
  }
  for (let i = 0; i < wallPath.length; i += 8) {
    const p = wallPath[i];
    const a = Math.atan2(p.nx, p.nz);
    lamps.push(box(3.4, 0.7, 0.6, p.x + p.nx * 2.0, wallTop - 2.2, p.z + p.nz * 2.0, a));
  }
  for (const [sx, sz] of [
    [-rx - 2, 0],
    [0, -rz - 2],
    [0, rz + 2],
  ]) {
    const acrossX = sx === 0;
    lamps.push(box(acrossX ? 26 : 1.0, 4.5, acrossX ? 1.0 : 26, sx, wallTop - 9, sz));
  }

  const parts = [
    [body, precast],
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
