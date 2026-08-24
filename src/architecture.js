/**
 * Architectural articulation for OSM building footprints.
 *
 * Turns a flat prism into something that reads as a building: stepped massing,
 * a cornice/parapet at every tier top, a proud ground-floor plinth, pilaster
 * bays, roof decks and a mechanical roofscape.
 *
 * Everything here returns plain `BufferGeometry` so the caller can push results
 * straight into the existing per-material merge buckets in `main.js`. No
 * meshes, no groups, no per-building draw calls.
 *
 * Coordinates: local metres, +X east, +Y up, +Z south. Footprints are arrays of
 * `[x, z]` and are expected (but not required) to be closed.
 *
 * All pseudo-randomness comes from `hash01()` seeded by the footprint centroid,
 * so the city is identical every run.
 *
 * Triangle budget, shell plus roofscape, measured over all 7,471 footprints in
 * public/data/pittsburgh.json:
 *
 *   tier   count   avg tris   max tris   hard cap
 *   0        153       14.9         36        140
 *   1      6,916       64.4        440        460
 *   2        402      509.0      1,318      1,500
 *
 * City total 652k triangles versus 112k for today's plain prisms, generated in
 * ~0.55 s. Dial the whole thing up or down from `detailTier()` alone.
 */

import * as THREE from 'three';
import { hash01, footprintCentroid } from './geo.js';

const EPS = 1e-7;

/**
 * UV atlas anchors that match `applyFacadeUVs()` in textures.js.
 * ROOF_UV is the dark 2x2 texel painted into the top-left of every facade
 * canvas. TRIM_UV lands on the plain base-material texel just outside it, so
 * cornices and pilasters read as solid stone instead of sliced-up windows.
 * Both are valid for every family in the palette (cols 4-10, rows 4-12).
 */
const ROOF_UV = [0.003, 0.003];
const TRIM_UV = [0.012, 0.0055];

const MODERN_STYLES = new Set(['glass', 'ppg', 'steel', 'steelTower', 'convention', 'stadium']);

/** Max footprint vertices kept per detail tier (cost of every band scales with this). */
const MAX_RING_VERTS = [64, 20, 28];
/** Visvalingam removal threshold in m^2 - a vertex that deviates ~0.5 m over 3 m. */
const SIMPLIFY_TOL = 0.9;

/* ------------------------------------------------------------------ */
/* deterministic hashing                                               */
/* ------------------------------------------------------------------ */

/** Decorrelated stream of hashes from a single [0,1) seed. */
function h01(seed, k) {
  return hash01(seed * 311.7 + k * 41.13, seed * 727.3 - k * 19.71);
}

/**
 * Seed in [0,1) derived from a footprint's centroid.
 * Tolerates holes, non-numeric entries and unclosed rings.
 */
export function footprintSeed(footprint) {
  if (!Array.isArray(footprint) || footprint.length < 2) return 0.5;
  let ok = true;
  for (let i = 0; i < footprint.length; i++) {
    const p = footprint[i];
    if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) {
      ok = false;
      break;
    }
  }
  let cx;
  let cz;
  if (ok) {
    [cx, cz] = footprintCentroid(footprint);
  } else {
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const p of footprint) {
      if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
      sx += +p[0];
      sz += +p[1];
      n++;
    }
    if (!n) return 0.5;
    cx = sx / n;
    cz = sz / n;
  }
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) return 0.5;
  return hash01(cx, cz);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function finite(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/* ------------------------------------------------------------------ */
/* polygon utilities                                                   */
/* ------------------------------------------------------------------ */

function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

function polygonArea(ring) {
  return Math.abs(signedArea(ring));
}

function ringPerimeter(ring) {
  let p = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

/**
 * Normalise an OSM footprint into an open, de-duplicated, CCW ring of [x, z].
 * Returns null for anything that cannot make a polygon.
 */
export function ringFromFootprint(footprint) {
  if (!Array.isArray(footprint) || footprint.length < 3) return null;
  const out = [];
  for (let i = 0; i < footprint.length; i++) {
    const p = footprint[i];
    if (!p || p.length < 2) continue;
    const x = +p[0];
    const z = +p[1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - x) < 0.02 && Math.abs(last[1] - z) < 0.02) continue;
    out.push([x, z]);
  }
  while (out.length > 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 0.02 && Math.abs(a[1] - b[1]) < 0.02) out.pop();
    else break;
  }
  if (out.length < 3) return null;
  const a = signedArea(out);
  if (!Number.isFinite(a) || Math.abs(a) < 0.5) return null;
  if (a < 0) out.reverse();
  return out;
}

/** Area of a footprint in m^2 (0 for degenerate input). */
export function footprintArea(footprint) {
  const ring = ringFromFootprint(footprint);
  return ring ? polygonArea(ring) : 0;
}

/** Visvalingam-Whyatt decimation, kept cheap because rings are short. */
function simplifyRing(ring, tolArea, maxVerts) {
  let pts = ring;
  if (pts.length > 240) {
    const step = Math.ceil(pts.length / 240);
    const t = [];
    for (let i = 0; i < pts.length; i += step) t.push(pts[i]);
    pts = t;
  } else {
    pts = pts.slice();
  }
  while (pts.length > 4) {
    let bestI = -1;
    let bestA = Infinity;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n];
      const b = pts[i];
      const c = pts[(i + 1) % n];
      const ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5;
      if (ar < bestA) {
        bestA = ar;
        bestI = i;
      }
    }
    if (bestI < 0) break;
    if (bestA > tolArea && n <= maxVerts) break;
    pts.splice(bestI, 1);
  }
  return pts;
}

function orient2(px, pz, qx, qz, rx, rz) {
  return (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
}

function segsCross(a, b, c, d) {
  const d1 = orient2(c[0], c[1], d[0], d[1], a[0], a[1]);
  const d2 = orient2(c[0], c[1], d[0], d[1], b[0], b[1]);
  const d3 = orient2(a[0], a[1], b[0], b[1], c[0], c[1]);
  const d4 = orient2(a[0], a[1], b[0], b[1], d[0], d[1]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function ringSelfIntersects(ring) {
  const n = ring.length;
  if (n < 5) return false;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsCross(a, b, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Miter offset of a CCW ring. `d > 0` insets, `d < 0` expands.
 * Vertex correspondence with the source ring is preserved 1:1 (bands depend on
 * it), so instead of collapsing degenerate corners the whole attempt is
 * rejected and the caller retries with a smaller distance.
 */
function offsetRing(ring, d) {
  const n = ring.length;
  if (n < 3) return null;
  const nx = new Array(n);
  const nz = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return null;
    // interior of a CCW ring is to the left of travel
    nx[i] = -dz / len;
    nz[i] = dx / len;
  }

  const maxMag = Math.abs(d) * 3;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i - 1 + n) % n;
    const dot = nx[j] * nx[i] + nz[j] * nz[i];
    const denom = Math.max(0.2, 1 + dot);
    let ox = (d * (nx[j] + nx[i])) / denom;
    let oz = (d * (nz[j] + nz[i])) / denom;
    const mag = Math.hypot(ox, oz);
    if (mag > maxMag && mag > EPS) {
      ox = (ox * maxMag) / mag;
      oz = (oz * maxMag) / mag;
    }
    const x = ring[i][0] + ox;
    const z = ring[i][1] + oz;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    out[i] = [x, z];
  }

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const odx = ring[j][0] - ring[i][0];
    const odz = ring[j][1] - ring[i][1];
    const ndx = out[j][0] - out[i][0];
    const ndz = out[j][1] - out[i][1];
    if (Math.hypot(ndx, ndz) < 0.012) return null;
    if (odx * ndx + odz * ndz <= 0) return null;
  }
  if (ringSelfIntersects(out)) return null;
  return out;
}

/**
 * Inward (or outward for negative `d`) offset with automatic fallback.
 * Returns null when even a heavily reduced offset would collapse the ring.
 */
export function insetRing(ring, d, minAreaFrac = 0.16) {
  if (!ring || ring.length < 3 || !Number.isFinite(d) || Math.abs(d) < 1e-4) return null;
  const area0 = polygonArea(ring);
  if (area0 < 1) return null;
  const perim = ringPerimeter(ring);
  let want = d;
  if (d > 0 && perim > EPS) {
    // ~inradius for a convex-ish ring; never try to eat more than 3/4 of it
    want = Math.min(d, (2 * area0 * 0.75) / perim);
    if (want < 1e-4) return null;
  }
  for (const scale of [1, 0.6, 0.35, 0.18]) {
    const out = offsetRing(ring, want * scale);
    if (!out) continue;
    const a = signedArea(out);
    if (!Number.isFinite(a) || a <= 0) continue;
    if (d > 0) {
      if (a > area0 + 1e-3 || a < area0 * minAreaFrac) continue;
    } else if (a < area0 * 0.95) {
      continue;
    }
    return out;
  }
  return null;
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; i++) {
    const xi = ring[i][0];
    const zi = ring[i][1];
    const xj = ring[j][0];
    const zj = ring[j][1];
    const denom = zj - zi || 1e-12;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / denom + xi) inside = !inside;
    j = i;
  }
  return inside;
}

function distToRing(x, z, ring) {
  let best = Infinity;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz || 1e-9;
    let t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2;
    t = clamp(t, 0, 1);
    const d = Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
    if (d < best) best = d;
  }
  return best;
}

/** Point-in-polygon test with a clearance margin - nothing may hang off a roof edge. */
export function insideWithMargin(x, z, ring, margin) {
  if (!pointInRing(x, z, ring)) return false;
  return distToRing(x, z, ring) >= margin;
}

/** Angle of the longest edge; roof equipment lines up with it. */
function dominantAngle(ring) {
  let best = 0;
  let bestLen = -1;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = dx * dx + dz * dz;
    if (len > bestLen) {
      bestLen = len;
      best = Math.atan2(dz, dx);
    }
  }
  return best;
}

function rectRing(cx, cz, sx, sz, ca, sa) {
  const hx = sx * 0.5;
  const hz = sz * 0.5;
  const corners = [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ];
  return corners.map(([u, v]) => [cx + u * ca - v * sa, cz + u * sa + v * ca]);
}

function regularRing(cx, cz, r, sides, rot) {
  const out = new Array(sides);
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    out[i] = [cx + Math.cos(a) * r, cz + Math.sin(a) * r];
  }
  return out;
}

function scaleRing(ring, cx, cz, k) {
  return ring.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k]);
}

function triangulateRing(ring) {
  const n = ring.length;
  if (n < 3) return null;
  if (n === 3) return [[0, 1, 2]];
  try {
    const contour = new Array(n);
    for (let i = 0; i < n; i++) contour[i] = new THREE.Vector2(ring[i][0], ring[i][1]);
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    if (!faces || !faces.length) return null;
    return faces;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* geometry builder                                                    */
/* ------------------------------------------------------------------ */

class Builder {
  constructor({ colors = false, flatFlags = false, indexed = false } = {}) {
    this.indexed = indexed;
    this.pos = [];
    this.nrm = [];
    this.col = colors ? [] : null;
    this.flat = flatFlags ? [] : null;
    this.idx = [];
    this.count = 0;
  }

  get triangles() {
    return this.idx.length / 3;
  }

  vert(x, y, z, nx, ny, nz, c, isFlat) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    if (this.col) this.col.push(c ? c[0] : 1, c ? c[1] : 1, c ? c[2] : 1);
    if (this.flat) this.flat.push(isFlat ? 1 : 0);
    this.count++;
  }

  tri(p0, p1, p2, c, isFlat) {
    const ax = p1[0] - p0[0];
    const ay = p1[1] - p0[1];
    const az = p1[2] - p0[2];
    const bx = p2[0] - p0[0];
    const by = p2[1] - p0[1];
    const bz = p2[2] - p0[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) return false;
    nx /= len;
    ny /= len;
    nz /= len;
    if (!Number.isFinite(p0[0] + p0[1] + p0[2] + p1[0] + p1[1] + p1[2] + p2[0] + p2[1] + p2[2])) {
      return false;
    }
    const base = this.count;
    this.vert(p0[0], p0[1], p0[2], nx, ny, nz, c, isFlat);
    this.vert(p1[0], p1[1], p1[2], nx, ny, nz, c, isFlat);
    this.vert(p2[0], p2[1], p2[2], nx, ny, nz, c, isFlat);
    this.idx.push(base, base + 1, base + 2);
    return true;
  }

  /** p0..p3 wound so that (p1-p0) x (p2-p0) points out of the surface. */
  quad(p0, p1, p2, p3, c, isFlat) {
    let ax = p1[0] - p0[0];
    let ay = p1[1] - p0[1];
    let az = p1[2] - p0[2];
    let bx = p2[0] - p0[0];
    let by = p2[1] - p0[1];
    let bz = p2[2] - p0[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    let len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) {
      // first triangle was degenerate - derive the normal from the second
      ax = p2[0] - p0[0];
      ay = p2[1] - p0[1];
      az = p2[2] - p0[2];
      bx = p3[0] - p0[0];
      by = p3[1] - p0[1];
      bz = p3[2] - p0[2];
      nx = ay * bz - az * by;
      ny = az * bx - ax * bz;
      nz = ax * by - ay * bx;
      len = Math.hypot(nx, ny, nz);
      if (!(len > 1e-9)) return false;
    }
    const sum =
      p0[0] + p0[1] + p0[2] + p1[0] + p1[1] + p1[2] + p2[0] + p2[1] + p2[2] + p3[0] + p3[1] + p3[2];
    if (!Number.isFinite(sum)) return false;
    nx /= len;
    ny /= len;
    nz /= len;
    const base = this.count;
    this.vert(p0[0], p0[1], p0[2], nx, ny, nz, c, isFlat);
    this.vert(p1[0], p1[1], p1[2], nx, ny, nz, c, isFlat);
    this.vert(p2[0], p2[1], p2[2], nx, ny, nz, c, isFlat);
    this.vert(p3[0], p3[1], p3[2], nx, ny, nz, c, isFlat);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return true;
  }

  /**
   * Indexed output is ~25% smaller, but ExtrudeGeometry is NOT indexed and
   * mergeGeometries() refuses to mix the two, so the default expands.
   * Also rewrites `this.flat` into the emitted vertex order.
   */
  geometry() {
    if (this.idx.length < 3) return null;
    const g = new THREE.BufferGeometry();
    if (this.indexed) {
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
      if (this.col) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      g.setIndex(this.idx);
      return g;
    }
    const n = this.idx.length;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const col = this.col ? new Float32Array(n * 3) : null;
    const flat = this.flat ? new Uint8Array(n) : null;
    for (let i = 0; i < n; i++) {
      const v = this.idx[i];
      pos[i * 3] = this.pos[v * 3];
      pos[i * 3 + 1] = this.pos[v * 3 + 1];
      pos[i * 3 + 2] = this.pos[v * 3 + 2];
      nrm[i * 3] = this.nrm[v * 3];
      nrm[i * 3 + 1] = this.nrm[v * 3 + 1];
      nrm[i * 3 + 2] = this.nrm[v * 3 + 2];
      if (col) {
        col[i * 3] = this.col[v * 3];
        col[i * 3 + 1] = this.col[v * 3 + 1];
        col[i * 3 + 2] = this.col[v * 3 + 2];
      }
      if (flat) flat[i] = this.flat[v];
    }
    if (flat) this.flat = flat;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  }
}

/**
 * Ruled surface between two rings of identical vertex count.
 * For an outward-facing wall pass the lower ring as A. For an up-facing
 * annulus pass the outer ring as A and the inner ring as B at the same y.
 */
function band(builder, ringA, yA, ringB, yB, c, isFlat) {
  const n = ringA.length;
  if (n < 3 || ringB.length !== n) return;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a0 = ringA[i];
    const a1 = ringA[j];
    const b0 = ringB[i];
    const b1 = ringB[j];
    builder.quad(
      [a0[0], yA, a0[1]],
      [b0[0], yB, b0[1]],
      [b1[0], yB, b1[1]],
      [a1[0], yA, a1[1]],
      c,
      isFlat,
    );
  }
}

/** Single outward-facing wall panel between two plan points. */
function faceQuad(builder, a, b, yLo, yHi, c, isFlat) {
  builder.quad(
    [a[0], yLo, a[1]],
    [a[0], yHi, a[1]],
    [b[0], yHi, b[1]],
    [b[0], yLo, b[1]],
    c,
    isFlat,
  );
}

/** Horizontal cap over an arbitrary (possibly concave) ring. */
function cap(builder, ring, y, up, c, isFlat) {
  const faces = triangulateRing(ring);
  if (!faces) return;
  for (let k = 0; k < faces.length; k++) {
    const f = faces[k];
    const p0 = ring[f[0]];
    const p1 = ring[f[1]];
    const p2 = ring[f[2]];
    if (!p0 || !p1 || !p2) continue;
    // CCW in the xz plane yields a downward normal, so flip when needed
    const cw = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    if (cw >= 0 === up) {
      builder.tri([p0[0], y, p0[1]], [p2[0], y, p2[1]], [p1[0], y, p1[1]], c, isFlat);
    } else {
      builder.tri([p0[0], y, p0[1]], [p1[0], y, p1[1]], [p2[0], y, p2[1]], c, isFlat);
    }
  }
}

function capUp(builder, ring, y, c, isFlat) {
  cap(builder, ring, y, true, c, isFlat);
}

function capDown(builder, ring, y, c, isFlat) {
  cap(builder, ring, y, false, c, isFlat);
}

/** Cheap fan cap, valid only for convex rings (boxes, prisms, discs). */
function capUpConvex(builder, ring, y, c, isFlat) {
  const n = ring.length;
  for (let i = 1; i < n - 1; i++) {
    builder.tri(
      [ring[0][0], y, ring[0][1]],
      [ring[i + 1][0], y, ring[i + 1][1]],
      [ring[i][0], y, ring[i][1]],
      c,
      isFlat,
    );
  }
}

/** Convex prism: sides plus a top cap. Bottoms are never visible on a roof. */
function extrudeConvex(builder, ring, y0, y1, c, isFlat) {
  band(builder, ring, y0, ring, y1, c, isFlat);
  capUpConvex(builder, ring, y1, c, isFlat);
}

function coneUp(builder, ring, y0, apexX, apexY, apexZ, c, isFlat) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    builder.tri([a[0], y0, a[1]], [apexX, apexY, apexZ], [b[0], y0, b[1]], c, isFlat);
  }
}

/**
 * Facade UVs matching `applyFacadeUVs()` in textures.js: u = along / windowW,
 * v = (y - baseY) / floorH, with horizontal faces pinned to the roof texel.
 * Vertices flagged `flat` by the builder are pinned to the plain-wall texel so
 * cornices and pilasters read as solid masonry.
 */
function applyArchitectureUVs(geom, builder, floorH, windowW, baseY) {
  const pos = geom.attributes.position;
  const nrm = geom.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const fh = Math.abs(floorH) > 0.05 ? floorH : 3.5;
  const ww = Math.abs(windowW) > 0.05 ? windowW : 3.2;
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i);
    if (builder.flat && builder.flat[i]) {
      uv[i * 2] = TRIM_UV[0];
      uv[i * 2 + 1] = TRIM_UV[1];
      continue;
    }
    if (ny > 0.55 || ny < -0.55) {
      uv[i * 2] = ROOF_UV[0];
      uv[i * 2 + 1] = ROOF_UV[1];
      continue;
    }
    const nx = nrm.getX(i);
    const nz = nrm.getZ(i);
    const along = Math.abs(nx) > Math.abs(nz) ? pos.getZ(i) : pos.getX(i);
    uv[i * 2] = along / ww;
    uv[i * 2 + 1] = (pos.getY(i) - baseY) / fh;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/* ------------------------------------------------------------------ */
/* level of detail                                                     */
/* ------------------------------------------------------------------ */

/**
 * Cheap budget gate.
 *   2 - full articulation: multi-tier massing, deep cornice with a recessed
 *       deck, plinth, pilaster bays, full roofscape (towers, civic slabs,
 *       big-box retail)
 *   1 - massing plus a cornice/parapet at every tier top; the larger half also
 *       gets a plinth and a small roofscape (ordinary street fabric)
 *   0 - plain prism, same cost as today's extrusion (sheds, garages, huts)
 *
 * On the shipped Pittsburgh dataset this yields 153 / 6,916 / 402 buildings
 * for tiers 0 / 1 / 2. Raising the tier-1 floor is the cheapest way to cut
 * triangles: at `h >= 17 || area >= 900` the city drops to ~510k.
 *
 * @param {Array<[number, number]>} footprint
 * @param {number} height
 * @returns {0|1|2}
 */
export function detailTier(footprint, height) {
  const ring = ringFromFootprint(footprint);
  if (!ring) return 0;
  const area = polygonArea(ring);
  const h = finite(height, 0);
  if (h >= 52 || area >= 3600 || (h >= 30 && area >= 1500)) return 2;
  if (h >= 5.5 && area >= 70) return 1;
  return 0;
}

/* ------------------------------------------------------------------ */
/* massing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Pick a massing archetype deterministically from position, height and plan size.
 * @returns {'prism'|'crown'|'podium'|'tower'|'setback'|'setbackCrown'}
 */
function pickArchetype(seed, height, area, style) {
  const w = Math.sqrt(Math.max(area, 1));
  const slender = height / Math.max(8, w);
  const modern = MODERN_STYLES.has(style);
  const r = h01(seed, 1);

  if (height < 15 || area < 140 || w < 9) return 'prism';
  if (style === 'stadium' || style === 'convention') return r < 0.45 ? 'podium' : 'prism';

  if (height >= 130) {
    if (modern) return r < 0.55 ? 'tower' : 'setbackCrown';
    return r < 0.62 ? 'setbackCrown' : 'tower';
  }
  if (height >= 68) {
    if (modern) return r < 0.42 ? 'tower' : r < 0.72 ? 'podium' : 'crown';
    return r < 0.46 ? 'setback' : r < 0.74 ? 'setbackCrown' : 'podium';
  }
  if (height >= 38) {
    if (slender > 1.6 && r < 0.5) return 'setback';
    return r < 0.3 ? 'podium' : r < 0.62 ? 'crown' : 'prism';
  }
  // mid-rise: a recessed top floor is what stops a 5-storey block reading as a box
  return r < 0.36 ? 'crown' : r < 0.46 ? 'podium' : 'prism';
}

/**
 * Stepped/setback massing for one footprint.
 *
 * @param {Array<[number, number]>} footprint closed or open ring of [x, z]
 * @param {number} height total height in metres above the building base
 * @param {number} [seed] deterministic seed in [0,1); defaults to the centroid hash
 * @param {object} [options]
 * @param {string} [options.style] facade family, biases prewar vs modern archetypes
 * @param {number} [options.maxVerts] ring decimation cap (default 28)
 * @returns {Array<{ring: Array<[number,number]>, y0: number, y1: number, archetype: string, index: number, top: boolean}>}
 *   Tiers bottom-to-top. `y0`/`y1` are relative to the building base (0 = base).
 *   Empty array for degenerate footprints.
 */
export function massingProfile(footprint, height, seed, options = {}) {
  const raw = ringFromFootprint(footprint);
  if (!raw) return [];
  const maxVerts = options.maxVerts || MAX_RING_VERTS[2];
  const base = simplifyRing(raw, SIMPLIFY_TOL, maxVerts);
  if (base.length < 3) return [];

  const h = clamp(finite(height, 10), 2, 800);
  const s = Number.isFinite(seed) ? seed : footprintSeed(footprint);
  const area = polygonArea(base);
  const w = Math.sqrt(Math.max(area, 1));
  const archetype = pickArchetype(s, h, area, options.style || null);

  const single = [{ ring: base, y0: 0, y1: h, archetype: 'prism', index: 0, top: true }];
  if (archetype === 'prism') return single;

  const r2 = h01(s, 2);
  const r3 = h01(s, 3);
  const r4 = h01(s, 4);

  // steps: [fraction of total height at the TOP of the tier, inward offset from
  // the tier below]. Offsets are a fraction of the plan's characteristic width;
  // insetRing() clamps each one against the current ring's inradius, so deep
  // steps degrade instead of collapsing.
  let steps;
  if (archetype === 'crown') {
    steps = [
      [1 - (0.07 + r2 * 0.06), 0],
      [1, w * (0.08 + r3 * 0.06)],
    ];
  } else if (archetype === 'podium') {
    const podium = clamp(Math.min(h * 0.3, 14 + r2 * 12), 6, h * 0.45);
    steps = [
      [podium / h, 0],
      [1, w * (0.09 + r3 * 0.07)],
    ];
  } else if (archetype === 'tower') {
    const podium = clamp(Math.min(h * 0.22, 12 + r2 * 18), 6, h * 0.4);
    steps = [
      [podium / h, 0],
      [1, w * (0.2 + r3 * 0.12)],
    ];
  } else if (archetype === 'setback') {
    steps = [
      [0.4 + r2 * 0.1, 0],
      [0.68 + r3 * 0.08, w * (0.1 + r4 * 0.05)],
      [1, w * (0.09 + r2 * 0.05)],
    ];
  } else {
    steps = [
      [0.36 + r2 * 0.08, 0],
      [0.62 + r3 * 0.08, w * (0.1 + r4 * 0.05)],
      [0.84 + r4 * 0.06, w * (0.09 + r2 * 0.04)],
      [1, w * (0.08 + r3 * 0.04)],
    ];
  }

  const tiers = [];
  let ring = base;
  let y0 = 0;
  for (let i = 0; i < steps.length; i++) {
    const [frac, inset] = steps[i];
    const last = i === steps.length - 1;
    if (!last && h - 3 <= y0 + 3) continue;
    const y1 = last ? h : clamp(h * frac, y0 + 3, h - 3);
    if (y1 - y0 < 2.5) continue;
    if (inset > 0.05) {
      const next = insetRing(ring, inset);
      if (next) ring = next;
    }
    tiers.push({ ring, y0, y1, archetype, index: tiers.length, top: false });
    y0 = y1;
  }
  if (!tiers.length) return single;
  // collapse tiers that ended up sharing a ring (a failed inset)
  const merged = [tiers[0]];
  for (let i = 1; i < tiers.length; i++) {
    const prev = merged[merged.length - 1];
    if (tiers[i].ring === prev.ring) prev.y1 = tiers[i].y1;
    else merged.push(tiers[i]);
  }
  merged[merged.length - 1].y1 = h;
  merged[merged.length - 1].top = true;
  for (let i = 0; i < merged.length; i++) merged[i].index = i;
  return merged;
}

/* ------------------------------------------------------------------ */
/* building shell                                                      */
/* ------------------------------------------------------------------ */

function trimProportions(seed, style, height) {
  const modern = MODERN_STYLES.has(style);
  const r = h01(seed, 11);
  if (modern) {
    return {
      corniceProud: 0.4 + r * 0.15,
      corniceH: 0.8 + r * 0.35,
      plinthProud: 0.4 + r * 0.2,
      plinthH: clamp(Math.min(height * 0.28, 5 + r * 2.5), 3.4, 8),
      pilasterDepth: 0.28,
      pilasterWidth: 0.9 + r * 0.4,
      pilasterSpacing: 6.5 + r * 2.5,
    };
  }
  return {
    corniceProud: 0.5 + r * 0.3,
    corniceH: 1 + r * 0.5,
    plinthProud: 0.5 + r * 0.3,
    plinthH: clamp(Math.min(height * 0.3, 4.5 + r * 2.5), 3.2, 7.5),
    pilasterDepth: 0.3 + r * 0.12,
    pilasterWidth: 1 + r * 0.5,
    pilasterSpacing: 6 + r * 3,
  };
}

/**
 * Cornice + parapet + roof deck at the top of a tier. The cornice is a flared
 * band rather than an overhang with an open soffit, so the shell stays closed.
 *
 * `mode` trades triangles for depth:
 *   'light' - a single flared coping, 3n-2 tris (background fabric)
 *   'full'  - flare plus a vertical parapet, 5n-2 tris
 *   'rich'  - full plus a coping annulus and a recessed deck, 9n-2 tris
 */
function emitTierTop(trim, wall, ring, y0, y1, p, mode) {
  const outer = insetRing(ring, -p.corniceProud);
  const ch = Math.min(p.corniceH, Math.max(0.35, (y1 - y0) * 0.5));
  if (!outer) {
    capUp(wall, ring, y1, null, false);
    return;
  }
  if (mode === 'light') {
    // steeply battered coping: 2n triangles, but the wall still visibly steps
    // out near the top instead of reading as a 45-degree bevel
    band(trim, ring, y1 - ch, outer, y1 - ch * 0.12, null, true);
    capUp(wall, outer, y1 - ch * 0.12, null, false);
    return;
  }
  band(trim, ring, y1 - ch, outer, y1 - ch * 0.45, null, true);
  band(trim, outer, y1 - ch * 0.45, outer, y1, null, true);
  if (mode === 'rich') {
    const drop = 0.35;
    band(trim, outer, y1, ring, y1, null, true);
    band(trim, ring, y1, ring, y1 - drop, null, true);
    capUp(wall, ring, y1 - drop, null, false);
  } else {
    capUp(wall, outer, y1, null, false);
  }
}

/**
 * Ground-floor plinth: proud storefront band capped by a sloped water table.
 * Returns the proud ring so the caller can close the shell underneath it.
 */
function emitPlinth(trim, ring, y0, p) {
  const outer = insetRing(ring, -p.plinthProud);
  if (!outer) return null;
  const top = y0 + p.plinthH;
  band(trim, outer, y0, outer, top, null, false);
  band(trim, outer, top, ring, top + Math.min(0.6, p.plinthProud + 0.15), null, true);
  return outer;
}

/**
 * Shallow vertical bays so big blank walls catch side light.
 * Three faces per pilaster (front plus two returns); top and bottom are buried
 * in the cornice and the plinth cap.
 */
function emitPilasters(trim, ring, y0, y1, p, maxCount) {
  const n = ring.length;
  const depth = p.pilasterDepth;
  const halfW = p.pilasterWidth * 0.5;
  // stretch the bay rhythm on very long perimeters so the budget spreads over
  // the whole building instead of running out on the first few edges
  const spacing = Math.max(p.pilasterSpacing, ringPerimeter(ring) / Math.max(1, maxCount));
  let placed = 0;
  for (let i = 0; i < n && placed < maxCount; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 9) continue;
    const ux = dx / len;
    const uz = dz / len;
    const ox = uz;
    const oz = -ux;
    const bays = Math.max(2, Math.round(len / spacing));
    for (let k = 1; k < bays && placed < maxCount; k++) {
      const t = (k / bays) * len;
      if (t < halfW + 0.8 || t > len - halfW - 0.8) continue;
      const cx = a[0] + ux * t;
      const cz = a[1] + uz * t;
      const q0 = [cx - ux * halfW, cz - uz * halfW];
      const q1 = [cx + ux * halfW, cz + uz * halfW];
      const f0 = [q0[0] + ox * depth, q0[1] + oz * depth];
      const f1 = [q1[0] + ox * depth, q1[1] + oz * depth];
      faceQuad(trim, f0, f1, y0, y1, null, true);
      faceQuad(trim, q0, f0, y0, y1, null, true);
      faceQuad(trim, f1, q1, y0, y1, null, true);
      placed++;
    }
  }
}

/**
 * Full articulated shell for one building.
 *
 * @param {object} opts
 * @param {Array<[number, number]>} opts.footprint ring of [x, z]
 * @param {number} opts.height height in metres
 * @param {number} [opts.baseY=0] world Y of the building base
 * @param {string} [opts.style] facade family name (see textures.js families)
 * @param {number} [opts.seed] deterministic seed in [0,1); defaults to centroid hash
 * @param {0|1|2} [opts.tier] override the LOD gate
 * @param {number} [opts.floorH=3.5] metres per facade texture repeat (family spec)
 * @param {number} [opts.windowW=3.2] metres per horizontal texture repeat (family spec)
 * @param {number} [opts.skirt=0] extra metres of wall below baseY, hides gaps on slopes
 * @param {boolean} [opts.indexed=false] emit indexed geometry. Leave false to stay
 *   mergeable with `THREE.ExtrudeGeometry` (which is non-indexed); set true, on
 *   every building, once nothing else feeds the same merge bucket - it saves
 *   about 25% of the vertex buffer.
 * @returns {{wall: THREE.BufferGeometry|null, trim: THREE.BufferGeometry|null,
 *            tier: 0|1|2, triangles: number,
 *            roofRing: Array<[number,number]>|null, roofY: number}}
 *   `wall` carries the tiered shaft plus roof decks, `trim` carries the plinth,
 *   cornices, parapets and pilasters. Both use the SAME facade material as
 *   today; keep them apart only so the caller can tint the trim differently.
 *   Both carry position/normal/uv, ready for `tintGeometry()` and
 *   `mergeGeometries()` alongside the existing ExtrudeGeometry output.
 */
export function buildArticulatedBuilding(opts) {
  const {
    footprint,
    height,
    baseY = 0,
    style = null,
    seed = null,
    tier = null,
    floorH = 3.5,
    windowW = 3.2,
    skirt = 0,
    indexed = false,
  } = opts || {};

  const empty = { wall: null, trim: null, tier: 0, triangles: 0, roofRing: null, roofY: baseY };
  const raw = ringFromFootprint(footprint);
  if (!raw) return empty;

  const h = clamp(finite(height, 10), 2, 800);
  const s = Number.isFinite(seed) ? seed : footprintSeed(footprint);
  const det = tier === 0 || tier === 1 || tier === 2 ? tier : detailTier(footprint, h);
  const y0 = baseY - Math.max(0, skirt);

  const wall = new Builder({ flatFlags: true, indexed });
  const trim = new Builder({ flatFlags: true, indexed });

  if (det === 0) {
    const ring = simplifyRing(raw, 0.05, MAX_RING_VERTS[0]);
    band(wall, ring, y0, ring, baseY + h, null, false);
    capUp(wall, ring, baseY + h, null, false);
    capDown(wall, ring, y0, null, false);
    const g = wall.geometry();
    if (g) applyArchitectureUVs(g, wall, floorH, windowW, baseY);
    return {
      wall: g,
      trim: null,
      tier: 0,
      triangles: wall.triangles,
      roofRing: ring,
      roofY: baseY + h,
    };
  }

  const maxVerts = MAX_RING_VERTS[det];
  const tiers = massingProfile(footprint, h, s, { style, maxVerts });
  if (!tiers.length) return empty;

  const p = trimProportions(s, style, h);
  const rich = det === 2;
  const baseRing = tiers[0].ring;
  const area = polygonArea(baseRing);
  // small tier-1 fabric gets the cornice only - a proud plinth is invisible at
  // the distance those buildings are read from and doubles their cost
  const plinthOk = h > p.plinthH * 1.8 && area > 40 && (rich || area > 520 || h > 21);
  // a many-sided ring stacked into many tiers gets expensive fast; only the
  // visible top keeps the recessed deck in that case
  const busy = tiers.length * baseRing.length > 70;
  const baseMode = rich ? 'rich' : plinthOk ? 'full' : 'light';

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const ty0 = i === 0 ? y0 : baseY + t.y0;
    const ty1 = baseY + t.y1;
    band(wall, t.ring, ty0, t.ring, ty1, null, false);
    const mode = busy && !t.top && baseMode === 'rich' ? 'full' : baseMode;
    emitTierTop(trim, wall, t.ring, ty0, ty1, p, mode);
  }

  const plinthOuter = plinthOk ? emitPlinth(trim, baseRing, y0, p) : null;
  // closed underside: shadow maps render back faces, and on a slope the
  // downhill side of a footprint sits above the terrain
  capDown(wall, plinthOuter || baseRing, y0, null, false);

  if (rich) {
    const shaftTop = baseY + Math.min(tiers[0].y1 - p.corniceH - 0.4, h);
    const shaftBottom = baseY + (plinthOk ? p.plinthH + 0.7 : 0.4);
    const perim = ringPerimeter(baseRing);
    const room = Math.floor((1000 - wall.triangles - trim.triangles) / 6);
    if (perim > 55 && shaftTop - shaftBottom > 8 && room > 4) {
      emitPilasters(trim, baseRing, shaftBottom, shaftTop, p, Math.min(40, room));
    }
  }

  const wallGeom = wall.geometry();
  const trimGeom = trim.geometry();
  if (wallGeom) applyArchitectureUVs(wallGeom, wall, floorH, windowW, baseY);
  if (trimGeom) applyArchitectureUVs(trimGeom, trim, floorH, windowW, baseY);

  const top = tiers[tiers.length - 1];
  return {
    wall: wallGeom,
    trim: trimGeom,
    tier: det,
    triangles: wall.triangles + trim.triangles,
    roofRing: top.ring,
    roofY: baseY + top.y1 - (rich ? 0.35 : 0),
  };
}

/* ------------------------------------------------------------------ */
/* roofscape                                                           */
/* ------------------------------------------------------------------ */

const ROOF_COLORS = {
  deck: [0.3, 0.3, 0.31],
  housing: [0.4, 0.4, 0.41],
  duct: [0.46, 0.47, 0.5],
  metal: [0.52, 0.53, 0.55],
  rail: [0.24, 0.25, 0.27],
  tank: [0.32, 0.26, 0.2],
};

function tinted(base, k) {
  return [clamp(base[0] * k, 0, 1), clamp(base[1] * k, 0, 1), clamp(base[2] * k, 0, 1)];
}

function makePlacer(ring, seed) {
  const placed = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  let k = 0;
  return function place(radius, tries = 14) {
    for (let i = 0; i < tries; i++) {
      k++;
      const x = minX + h01(seed, 200 + k * 2) * (maxX - minX);
      const z = minZ + h01(seed, 201 + k * 2) * (maxZ - minZ);
      if (!insideWithMargin(x, z, ring, radius)) continue;
      let clash = false;
      for (const q of placed) {
        if (Math.hypot(x - q[0], z - q[1]) < radius + q[2]) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      placed.push([x, z, radius]);
      return [x, z];
    }
    return null;
  };
}

/**
 * Mechanical roofscape for one building: penthouse blocks, chillers, elevator
 * overrun, stair bulkhead, vents, a guardrail, and occasionally a water tower
 * or a mast. Everything is placed strictly inside an inset of the roof ring.
 *
 * @param {object} opts
 * @param {Array<[number, number]>} opts.footprint ring of [x, z]
 * @param {number} opts.height building height in metres
 * @param {number} [opts.baseY=0] world Y of the building base
 * @param {number} [opts.seed] deterministic seed in [0,1); defaults to centroid hash
 * @param {0|1|2} [opts.tier] LOD gate; tier 0 returns null
 * @param {string} [opts.style] facade family, only used to reproduce the massing
 * @param {Array<[number,number]>} [opts.roofRing] top-tier ring from
 *   `buildArticulatedBuilding()`; pass it to avoid recomputing the massing
 * @param {number} [opts.roofY] world Y of the roof deck; defaults to baseY + height
 * @param {number} [opts.maxTriangles] hard cap (tier 1: 90, tier 2: 460)
 * @param {boolean} [opts.indexed=false] see `buildArticulatedBuilding`
 * @returns {THREE.BufferGeometry|null} geometry with position/normal/color,
 *   intended for a single shared rooftop material (see `createRoofscapeMaterial`).
 */
export function buildRoofscape(opts) {
  const {
    footprint,
    height,
    baseY = 0,
    seed = null,
    tier = null,
    style = null,
    roofRing = null,
    roofY = null,
    maxTriangles = null,
    indexed = false,
  } = opts || {};

  const h = clamp(finite(height, 10), 2, 800);
  const s = Number.isFinite(seed) ? seed : footprintSeed(footprint);
  const det = tier === 0 || tier === 1 || tier === 2 ? tier : detailTier(footprint, h);
  if (det === 0) return null;

  let ring = roofRing;
  let deckY = roofY;
  if (!ring) {
    const tiers = massingProfile(footprint, h, s, { style, maxVerts: MAX_RING_VERTS[det] });
    if (!tiers.length) return null;
    const top = tiers[tiers.length - 1];
    ring = top.ring;
    if (deckY === null) deckY = baseY + top.y1 - (det === 2 ? 0.35 : 0);
  }
  if (!ring || ring.length < 3) return null;
  if (deckY === null || !Number.isFinite(deckY)) deckY = baseY + h;

  const inner = insetRing(ring, 1.6) || insetRing(ring, 0.8) || ring;
  const area = polygonArea(inner);
  if (!(area > 12)) return null;
  // small low roofs are never seen from above; skip them entirely
  if (det === 1 && (area < 200 || h < 12)) return null;

  const w = Math.sqrt(area);
  const ang = dominantAngle(inner);
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const rich = det === 2;
  const budget = maxTriangles ?? (rich ? 460 : 90);
  const b = new Builder({ colors: true, indexed });
  const place = makePlacer(inner, s);

  const boxAt = (x, z, sx, sz, sy, color) => {
    extrudeConvex(b, rectRing(x, z, sx, sz, ca, sa), deckY, deckY + sy, color, false);
  };

  // 1. mechanical penthouse(s) - the dominant rooftop mass
  const phCount = rich && area > 1400 ? 2 : area > 110 ? 1 : 0;
  for (let i = 0; i < phCount && b.triangles < budget; i++) {
    const r = h01(s, 20 + i);
    const sx = clamp(w * (0.24 + r * 0.14), 3, 18);
    const sz = clamp(w * (0.17 + h01(s, 30 + i) * 0.12), 2.5, 14);
    const sy = 3 + r * 2.4;
    const pt = place(Math.hypot(sx, sz) * 0.5 + 0.4);
    if (!pt) break;
    boxAt(pt[0], pt[1], sx, sz, sy, tinted(ROOF_COLORS.housing, 0.9 + r * 0.25));
  }

  // 2. elevator overrun - the tall one
  if (h > 32 && area > 80 && (rich || h > 45) && b.triangles < budget) {
    const r = h01(s, 41);
    const sx = clamp(w * 0.17, 2.8, 8);
    const sz = clamp(w * 0.15, 2.4, 7);
    const pt = place(Math.hypot(sx, sz) * 0.5 + 0.4);
    if (pt) boxAt(pt[0], pt[1], sx, sz, 4.2 + r * 2.2, tinted(ROOF_COLORS.housing, 0.85));
  }

  // 3. stair bulkhead
  if (area > (rich ? 55 : 150) && b.triangles < budget) {
    const r = h01(s, 42);
    const pt = place(2.6);
    if (pt) boxAt(pt[0], pt[1], 2.6 + r * 1.4, 3 + r * 1.2, 2.5 + r * 0.9, ROOF_COLORS.housing);
  }

  // 4. cooling units, half of them with a fan cowl
  const chillers = clamp(Math.floor(area / 210), 1, rich ? 6 : 2);
  for (let i = 0; i < chillers && b.triangles < budget; i++) {
    const r = h01(s, 50 + i);
    const sx = 2 + r * 1.6;
    const sz = 1.6 + h01(s, 60 + i) * 1.4;
    const sy = 1.2 + r * 0.8;
    const pt = place(Math.hypot(sx, sz) * 0.5 + 0.3);
    if (!pt) continue;
    boxAt(pt[0], pt[1], sx, sz, sy, tinted(ROOF_COLORS.duct, 0.9 + r * 0.2));
    if (r > 0.5) {
      const cowl = regularRing(pt[0], pt[1], Math.min(sx, sz) * 0.36, 6, ang);
      extrudeConvex(b, cowl, deckY + sy, deckY + sy + 0.4 + r * 0.3, ROOF_COLORS.metal, false);
    }
  }

  // 5. guardrail set back from the parapet
  if (rich && area > 260 && b.triangles + inner.length * 4 < budget) {
    const railRing = insetRing(inner, 0.9);
    if (railRing) {
      const ry0 = deckY + 0.75;
      const ry1 = deckY + 1.15;
      band(b, railRing, ry0, railRing, ry1, ROOF_COLORS.rail, false);
      band(b, railRing, ry1, railRing, ry0, ROOF_COLORS.rail, false);
    }
  }

  // 6. mast / antenna on the tall ones
  if (h > 85 || (h > 55 && h01(s, 70) < 0.3)) {
    const pt = place(1.9);
    if (pt) {
      const mh = clamp(h * 0.1, 6, 26);
      const foot = rectRing(pt[0], pt[1], 1.1, 1.1, ca, sa);
      const tip = scaleRing(foot, pt[0], pt[1], 0.3);
      band(b, foot, deckY, tip, deckY + mh, ROOF_COLORS.metal, false);
      capUpConvex(b, tip, deckY + mh, ROOF_COLORS.metal, false);
      const bar = rectRing(pt[0], pt[1], 3.4, 0.28, ca, sa);
      extrudeConvex(b, bar, deckY + mh * 0.62, deckY + mh * 0.62 + 0.24, ROOF_COLORS.metal, false);
    }
  }

  // 7. vents
  const vents = rich ? clamp(Math.floor(area / 150), 1, 8) : clamp(Math.floor(area / 400), 0, 2);
  for (let i = 0; i < vents && b.triangles < budget; i++) {
    const r = h01(s, 80 + i);
    const sx = 0.5 + r * 0.6;
    const pt = place(sx, 8);
    if (!pt) continue;
    boxAt(pt[0], pt[1], sx, sx, 0.6 + r * 0.9, tinted(ROOF_COLORS.metal, 0.85 + r * 0.3));
  }

  // 8. the occasional water tower
  if (rich && area > 220 && h01(s, 90) < 0.14) {
    const r = h01(s, 91);
    const rad = clamp(w * 0.11, 1.6, 3.4);
    const pt = place(rad + 1);
    if (pt) {
      const legH = 2.6 + r * 1.8;
      for (let i = 0; i < 4; i++) {
        const a = ang + Math.PI * 0.25 + (i / 4) * Math.PI * 2;
        const lx = pt[0] + Math.cos(a) * rad * 0.72;
        const lz = pt[1] + Math.sin(a) * rad * 0.72;
        const leg = rectRing(lx, lz, 0.26, 0.26, ca, sa);
        band(b, leg, deckY, leg, deckY + legH, ROOF_COLORS.rail, false);
      }
      const tank = regularRing(pt[0], pt[1], rad, 8, ang);
      const tankTop = deckY + legH + 3 + r * 1.4;
      band(b, tank, deckY + legH, tank, tankTop, ROOF_COLORS.tank, false);
      coneUp(b, tank, tankTop, pt[0], tankTop + rad * 0.55, pt[1], ROOF_COLORS.tank, false);
    }
  }

  return b.geometry();
}

/* ------------------------------------------------------------------ */
/* materials                                                           */
/* ------------------------------------------------------------------ */

/** Shared material for every merged roofscape chunk. */
export function createRoofscapeMaterial({ dayMode = true } = {}) {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.34,
    envMapIntensity: dayMode ? 0.45 : 0.3,
  });
}

/** Slightly brighter, slightly desaturated version of a facade tint for stone trim. */
export function trimTint(color) {
  const out = color.clone();
  out.offsetHSL(0, -0.02, 0.05);
  return out;
}
