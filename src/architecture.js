/**
 * Architectural articulation for OSM building footprints.
 *
 * Turns a flat prism into something that reads as a building: a typology guess
 * from bulk and position, stepped massing on the towers, a stone base course, a
 * shaft divided by belt courses and pier bays, a cornice and parapet over a
 * recessed roof deck, pitched roofs on the rowhouse stock, and masonry rooftop
 * housings under a mechanical roofscape.
 *
 * Two things carry a building at flyover distance, and neither is depth. A
 * 45-degree field of view over 1080 px puts one pixel at 0.6 m from 800 m, so
 * relief is decided by the VERTICAL EXTENT of each element - a 4 m base, a 2 m
 * cornice band - and by TONE, which comes from pinning trim to its own texel in
 * the facade atlas (see PIN_STONE / PIN_DARK). A pinned triangle has zero
 * texture derivative, so it samples mip 0 and holds its exact tone at any
 * range, while the window grid itself has long since averaged out.
 *
 * All relief steps INWARD from the footprint. These are party-wall lots and a
 * projecting cornice lands inside the neighbour.
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
 * Triangle budget, shell plus roofscape, over all 7,471 footprints in
 * public/data/pittsburgh.json:
 *
 *   tier   count   avg tris   max tris   hard cap
 *   0        133       15.4         36          -
 *   1      6,449      106.7        424        420
 *   2        869      314.1      1,322      1,900
 *
 * City total 1.25M triangles against 639k for the previous articulation and
 * 112k for plain prisms, generated in ~1.0 s. Dial the whole thing up or down
 * from `detailTier()`, `courseCount()` and `pierCount()`.
 */

import * as THREE from 'three';
import { hash01, footprintCentroid } from './geo.js';

const EPS = 1e-7;

/**
 * UV atlas anchors that match `paintFacade()` in textures.js.
 * ROOF_UV is the dark 2x2 texel painted into the top-left of every facade
 * canvas. TRIM_UV lands on the plain base-material texel just outside it, so
 * cornices and piers read as solid masonry instead of sliced-up windows.
 * Both are valid for every family in the palette (cols 4-10, rows 4-12).
 */
const ROOF_UV = [0.003, 0.003];
const TRIM_UV = [0.012, 0.0055];

/**
 * Surface tone, selected per triangle through the builder's `flat` channel.
 *   PIN_NONE  - the facade texture proper, windows and all
 *   PIN_STONE - solid wall material: base courses, belt courses, cornices,
 *               parapets, piers, chimneys, rooftop housings
 *   PIN_DARK  - storefront glazing, soffits, roof decks, shingles
 *
 * A triangle whose three vertices share one UV has zero texture derivative, so
 * it samples mip 0 whatever the distance and holds its tone exactly. That is
 * the only reason a 2 m cornice band still reads from 800 m, where the window
 * grid itself has long since mipped down to a flat average.
 */
const PIN_NONE = 0;
const PIN_STONE = 1;
const PIN_DARK = 2;
const PIN_UV = [null, TRIM_UV, ROOF_UV];

/**
 * Window grid that `paintFacade()` draws into each family's canvas, so one
 * texture repeat spans `cols * windowW` metres across and `rows * floorH`
 * metres up. Mapping a repeat to a single window instead puts every feature on
 * every wall at roughly half a metre, which is subpixel beyond ~500 m and mips
 * to flat colour - the whole city then reads as coloured boxes however much
 * relief the geometry carries.
 */
const FACADE_GRID = {
  lowrise: [5, 6],
  brick: [6, 8],
  limestone: [6, 8],
  steel: [8, 10],
  glass: [8, 10],
  ppg: [8, 12],
  gothic: [5, 6],
  stadium: [4, 4],
  artdeco: [5, 9],
  chapel: [4, 5],
  sandstone: [6, 7],
  copper: [5, 8],
  convention: [10, 4],
  steelTower: [7, 11],
};
const DEFAULT_GRID = [6, 8];

const MODERN_STYLES = new Set(['glass', 'ppg', 'steel', 'steelTower', 'convention', 'stadium']);

/** Max footprint vertices kept per detail tier (cost of every band scales with this). */
const MAX_RING_VERTS = [10, 18, 34];
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

/**
 * Visvalingam-Whyatt decimation, kept cheap because rings are short.
 *
 * Dropping a convex vertex cuts a corner off and stays inside the footprint;
 * dropping a reflex one fills a notch in and bulges outside it. On a party-wall
 * lot that bulge ends up inside the neighbour, so reflex vertices are weighted
 * to go last and only when the vertex budget demands it.
 */
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
    let bestCost = Infinity;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n];
      const b = pts[i];
      const c = pts[(i + 1) % n];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const ar = Math.abs(cross) * 0.5;
      const cost = cross > 0 ? ar : ar * 12 + 4;
      if (cost < bestCost) {
        bestCost = cost;
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

/** Bounding extent of a ring measured along and across `ang`. */
function planExtent(ring, ang) {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const u = ring[i][0] * ca + ring[i][1] * sa;
    const v = ring[i][1] * ca - ring[i][0] * sa;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  return { along: maxU - minU, across: maxV - minV };
}

/** Vertex mean of an open ring. */
function ringCentroid(ring) {
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length; i++) {
    cx += ring[i][0];
    cz += ring[i][1];
  }
  return [cx / ring.length, cz / ring.length];
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
  constructor({ colors = false, pins = false, indexed = false } = {}) {
    this.indexed = indexed;
    this.pos = [];
    this.nrm = [];
    this.col = colors ? [] : null;
    this.pin = pins ? [] : null;
    this.idx = [];
    this.count = 0;
  }

  get triangles() {
    return this.idx.length / 3;
  }

  vert(x, y, z, nx, ny, nz, c, pin) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    if (this.col) this.col.push(c ? c[0] : 1, c ? c[1] : 1, c ? c[2] : 1);
    if (this.pin) this.pin.push(pin | 0);
    this.count++;
  }

  tri(p0, p1, p2, c, pin) {
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
    this.vert(p0[0], p0[1], p0[2], nx, ny, nz, c, pin);
    this.vert(p1[0], p1[1], p1[2], nx, ny, nz, c, pin);
    this.vert(p2[0], p2[1], p2[2], nx, ny, nz, c, pin);
    this.idx.push(base, base + 1, base + 2);
    return true;
  }

  /** p0..p3 wound so that (p1-p0) x (p2-p0) points out of the surface. */
  quad(p0, p1, p2, p3, c, pin) {
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
    this.vert(p0[0], p0[1], p0[2], nx, ny, nz, c, pin);
    this.vert(p1[0], p1[1], p1[2], nx, ny, nz, c, pin);
    this.vert(p2[0], p2[1], p2[2], nx, ny, nz, c, pin);
    this.vert(p3[0], p3[1], p3[2], nx, ny, nz, c, pin);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return true;
  }

  /**
   * Indexed output is ~25% smaller, but ExtrudeGeometry is NOT indexed and
   * mergeGeometries() refuses to mix the two, so the default expands.
   * Also rewrites `this.pin` into the emitted vertex order.
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
    const pin = this.pin ? new Uint8Array(n) : null;
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
      if (pin) pin[i] = this.pin[v];
    }
    if (pin) this.pin = pin;
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
function band(builder, ringA, yA, ringB, yB, c, pin) {
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
      pin,
    );
  }
}

/** Single outward-facing wall panel between two plan points. */
function faceQuad(builder, a, b, yLo, yHi, c, pin) {
  builder.quad(
    [a[0], yLo, a[1]],
    [a[0], yHi, a[1]],
    [b[0], yHi, b[1]],
    [b[0], yLo, b[1]],
    c,
    pin,
  );
}

/** Horizontal cap over an arbitrary (possibly concave) ring. */
function cap(builder, ring, y, up, c, pin) {
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
      builder.tri([p0[0], y, p0[1]], [p2[0], y, p2[1]], [p1[0], y, p1[1]], c, pin);
    } else {
      builder.tri([p0[0], y, p0[1]], [p1[0], y, p1[1]], [p2[0], y, p2[1]], c, pin);
    }
  }
}

function capUp(builder, ring, y, c, pin) {
  cap(builder, ring, y, true, c, pin);
}

function capDown(builder, ring, y, c, pin) {
  cap(builder, ring, y, false, c, pin);
}

/** Cheap fan cap, valid only for convex rings (boxes, prisms, discs). */
function capUpConvex(builder, ring, y, c, pin) {
  const n = ring.length;
  for (let i = 1; i < n - 1; i++) {
    builder.tri(
      [ring[0][0], y, ring[0][1]],
      [ring[i + 1][0], y, ring[i + 1][1]],
      [ring[i][0], y, ring[i][1]],
      c,
      pin,
    );
  }
}

/** Convex prism: sides plus a top cap. Bottoms are never visible on a roof. */
function extrudeConvex(builder, ring, y0, y1, c, pin) {
  band(builder, ring, y0, ring, y1, c, pin);
  capUpConvex(builder, ring, y1, c, pin);
}

function coneUp(builder, ring, y0, apexX, apexY, apexZ, c, pin) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    builder.tri([a[0], y0, a[1]], [apexX, apexY, apexZ], [b[0], y0, b[1]], c, pin);
  }
}

/**
 * Facade UVs. One texture repeat carries `cols` windows over `rows` floors, so
 * a repeat spans cols*windowW metres across and rows*floorH up - which puts one
 * painted window on one real window instead of compressing the whole grid into
 * a single window's width, as `applyFacadeUVs()` in textures.js still does.
 * Vertices pinned by the builder take a fixed texel instead.
 */
function applyArchitectureUVs(geom, builder, floorH, windowW, baseY, grid) {
  const pos = geom.attributes.position;
  const nrm = geom.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const [cols, rows] = grid || DEFAULT_GRID;
  const fh = (Math.abs(floorH) > 0.05 ? floorH : 3.5) * rows;
  const ww = (Math.abs(windowW) > 0.05 ? windowW : 3.2) * cols;
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i);
    const pin = builder.pin ? builder.pin[i] : PIN_NONE;
    if (pin) {
      uv[i * 2] = PIN_UV[pin][0];
      uv[i * 2 + 1] = PIN_UV[pin][1];
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
 * Where the camera actually lives, and where the stock is worth the triangles:
 * the Golden Triangle from the Point back to the Hill, and Oakland around the
 * Cathedral of Learning. Every preset view in main.js targets one of these.
 * [x, z, radius] in metres.
 */
const FOCUS = [
  [-120, -110, 1300],
  [4150, -330, 900],
];

/** 1 at the centre of a focus area, 0 outside all of them. */
function focusWeight(cx, cz) {
  let best = 0;
  for (let i = 0; i < FOCUS.length; i++) {
    const w = 1 - Math.hypot(cx - FOCUS[i][0], cz - FOCUS[i][1]) / FOCUS[i][2];
    if (w > best) best = w;
  }
  return clamp(best, 0, 1);
}

function tierForRing(ring, h) {
  const area = polygonArea(ring);
  if (h < 5.5 || area < 55) return 0;
  const [cx, cz] = ringCentroid(ring);
  const near = focusWeight(cx, cz);
  if (h >= 34 - near * 13 || area >= 2200 - near * 900 || (h >= 22 && area >= 1000)) return 2;
  return 1;
}

/**
 * Budget gate.
 *   2 - stepped massing, belt courses, pier bays, deep cornice with a recessed
 *       deck and a full rooftop programme (towers, mill blocks, anything
 *       downtown or in Oakland that is big enough to look at)
 *   1 - stone base, banded shaft, cornice, parapet, roof housings; a pitched
 *       roof instead where the plan reads as a rowhouse (ordinary fabric)
 *   0 - plain prism (sheds, garages, huts)
 *
 * Half the shipped dataset carries a default 14 m height, so height alone
 * cannot separate a rowhouse from a downtown block; position does most of that
 * work here and in `typology()`.
 *
 * @param {Array<[number, number]>} footprint
 * @param {number} height
 * @returns {0|1|2}
 */
export function detailTier(footprint, height) {
  const ring = ringFromFootprint(footprint);
  if (!ring) return 0;
  return tierForRing(ring, finite(height, 0));
}

/* ------------------------------------------------------------------ */
/* typology                                                            */
/* ------------------------------------------------------------------ */

/**
 * Programme guessed from bulk and position. Pittsburgh's stock is brick
 * rowhouses and mill-era loft buildings through the flats and the slopes, with
 * masonry and glass concentrated in the Triangle and around Oakland.
 *   'shed'      garages, huts, infill - not worth any articulation
 *   'house'     rowhouse or frame house: water table, frieze, pitched roof
 *   'block'     2-8 storey street block: storefront, belt courses, cornice
 *   'warehouse' loft/mill building: pier bays, monitor roof
 *   'midrise'   banded shaft, deep cornice, mechanical housings
 *   'tower'     setback massing, mechanical crown
 * @returns {'shed'|'house'|'block'|'warehouse'|'midrise'|'tower'}
 */
function typology(h, area, style, urban) {
  if (h < 5.5 || area < 55) return 'shed';
  const modern = MODERN_STYLES.has(style);
  if (h >= 46) return 'tower';
  if (h >= 30) return 'midrise';
  if (area >= 900) return h >= 26 ? 'midrise' : 'warehouse';
  if (modern) return h >= 20 ? 'midrise' : 'block';
  if (h <= 15 && area <= 430 && urban < 0.4) return 'house';
  return 'block';
}

/**
 * Roof form. A hip that rises to the stated height rather than above it, so
 * putting pitches on the rowhouse stock varies the silhouette without growing
 * the city: half the dataset sits at exactly 14 m and reads as one plateau
 * until something breaks the eave line.
 * @returns {{form: 'hip'|'flat', rise: number}}
 */
function roofPlan(typ, h, seed, ring, ang) {
  if (typ === 'house' && h01(seed, 7) < 0.66) {
    const rise = clamp(planExtent(ring, ang).across * 0.33, 1.8, 5);
    if (h - rise > 4.5) return { form: 'hip', rise };
  }
  return { form: 'flat', rise: 0 };
}

/**
 * The decisions the shell and the roofscape both depend on. Derived from the
 * ring rather than passed between them, so the two entry points cannot drift.
 */
function buildingProgram(ring, height, seed, style) {
  const [cx, cz] = ringCentroid(ring);
  const ang = dominantAngle(ring);
  const typ = typology(height, polygonArea(ring), style, focusWeight(cx, cz));
  return { ang, typ, roof: roofPlan(typ, height, seed, ring, ang) };
}

/* ------------------------------------------------------------------ */
/* massing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Pick a massing archetype deterministically from position, height and plan size.
 * Below about eight storeys the silhouette comes from the roof, not from
 * setbacks - a four-storey block that steps back reads as a mistake.
 * @returns {'prism'|'crown'|'podium'|'tower'|'setback'|'setbackCrown'}
 */
function pickArchetype(seed, height, area, style) {
  const w = Math.sqrt(Math.max(area, 1));
  const slender = height / Math.max(8, w);
  const modern = MODERN_STYLES.has(style);
  const r = h01(seed, 1);

  if (height < 24 || area < 140 || w < 9) return 'prism';
  if (style === 'stadium' || style === 'convention') return r < 0.45 ? 'podium' : 'prism';

  if (height >= 130) {
    if (modern) return r < 0.5 ? 'tower' : 'setbackCrown';
    return r < 0.68 ? 'setbackCrown' : 'tower';
  }
  if (height >= 68) {
    if (modern) return r < 0.38 ? 'tower' : r < 0.68 ? 'podium' : 'crown';
    return r < 0.44 ? 'setback' : r < 0.78 ? 'setbackCrown' : 'podium';
  }
  if (height >= 38) {
    if (slender > 1.6 && r < 0.55) return 'setback';
    return r < 0.34 ? 'podium' : r < 0.7 ? 'crown' : 'prism';
  }
  // 24-38 m: a recessed top floor is what stops an eight-storey block reading
  // as one extrusion, and it is common on Pittsburgh's interwar fabric
  return r < 0.42 ? 'crown' : r < 0.56 ? 'podium' : 'prism';
}

/**
 * Stepped/setback massing for one footprint.
 *
 * @param {Array<[number, number]>} footprint closed or open ring of [x, z]
 * @param {number} height total height in metres above the building base
 * @param {number} [seed] deterministic seed in [0,1); defaults to the centroid hash
 * @param {object} [options]
 * @param {string} [options.style] facade family, biases prewar vs modern archetypes
 * @param {number} [options.maxVerts] ring decimation cap (default 26)
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
      [1 - (0.09 + r2 * 0.08), 0],
      [1, w * (0.1 + r3 * 0.07)],
    ];
  } else if (archetype === 'podium') {
    const podium = clamp(Math.min(h * 0.3, 14 + r2 * 12), 6, h * 0.45);
    steps = [
      [podium / h, 0],
      [1, w * (0.1 + r3 * 0.08)],
    ];
  } else if (archetype === 'tower') {
    const podium = clamp(Math.min(h * 0.22, 12 + r2 * 18), 6, h * 0.4);
    steps = [
      [podium / h, 0],
      [1, w * (0.2 + r3 * 0.12)],
    ];
  } else if (archetype === 'setback') {
    steps = [
      [0.38 + r2 * 0.1, 0],
      [0.66 + r3 * 0.08, w * (0.11 + r4 * 0.06)],
      [1, w * (0.1 + r2 * 0.06)],
    ];
  } else {
    steps = [
      [0.34 + r2 * 0.08, 0],
      [0.58 + r3 * 0.08, w * (0.11 + r4 * 0.06)],
      [0.8 + r4 * 0.07, w * (0.1 + r2 * 0.05)],
      [1, w * (0.09 + r3 * 0.05)],
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
/* rooftop programme                                                   */
/* ------------------------------------------------------------------ */

/**
 * Rejection sampler for roof equipment. Works in the roof's own frame, where
 * every piece is axis-aligned, so the clash test is an exact rectangle overlap
 * and a 40 m mill monitor is not rejected for failing to fit inside a circle of
 * its own diagonal. `taken` is shared between the shell's masonry housings and
 * the roofscape's plant so the two never land on each other.
 *
 * @returns {function(number, number, number=, Array<number>=): Array<number>|null}
 *   place(sx, sz, tries, hint) -> world [x, z] or null
 */
function makePlacer(ring, seed, ang, taken = []) {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
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

  function accept(x, z, sx, sz) {
    const hx = sx * 0.5;
    const hz = sz * 0.5;
    if (!insideWithMargin(x, z, ring, 0.2)) return false;
    for (let c = 0; c < 4; c++) {
      const du = c === 0 || c === 3 ? -hx : hx;
      const dv = c < 2 ? -hz : hz;
      if (!insideWithMargin(x + du * ca - dv * sa, z + du * sa + dv * ca, ring, 0.2)) return false;
    }
    const u = x * ca + z * sa;
    const v = z * ca - x * sa;
    for (const q of taken) {
      if (Math.abs(u - q[0]) < (sx + q[2]) * 0.5 + 0.4 && Math.abs(v - q[1]) < (sz + q[3]) * 0.5 + 0.4) {
        return false;
      }
    }
    taken.push([u, v, sx, sz]);
    return true;
  }

  return function place(sx, sz, tries = 14, hint = null) {
    if (hint && accept(hint[0], hint[1], sx, sz)) return hint;
    for (let i = 0; i < tries; i++) {
      k++;
      const x = minX + h01(seed, 200 + k * 2) * (maxX - minX);
      const z = minZ + h01(seed, 201 + k * 2) * (maxZ - minZ);
      if (accept(x, z, sx, sz)) return [x, z];
    }
    return null;
  };
}

/**
 * The masonry half of the rooftop: mechanical penthouse, elevator overrun,
 * stair bulkhead, a mill monitor on the loft buildings. These are structure
 * rather than plant, so the shell emits them in the facade material; the metal
 * that stands next to them is `buildRoofscape()`'s job. Both call this, so the
 * reservations line up.
 *
 * @returns {{inner: Array<[number,number]>|null, area: number, ang: number,
 *            ca: number, sa: number, boxes: Array<object>, taken: Array<Array<number>>}}
 */
function roofStructures(deckRing, h, typ, seed, det) {
  const ang = dominantAngle(deckRing);
  const inner = insetRing(deckRing, 1.1) || insetRing(deckRing, 0.5) || deckRing;
  const area = polygonArea(inner);
  const out = {
    inner,
    area,
    ang,
    ca: Math.cos(ang),
    sa: Math.sin(ang),
    boxes: [],
    taken: [],
  };
  if (!(area > 30) || h < 7) return out;

  const w = Math.sqrt(area);
  const place = makePlacer(inner, seed, ang, out.taken);
  const add = (sx, sz, sy, hint) => {
    if (!(sx > 0.4 && sz > 0.4 && sy > 0.3)) return;
    const pt = place(sx, sz, 14, hint);
    if (pt) out.boxes.push({ x: pt[0], z: pt[1], sx, sz, sy });
  };
  const r1 = h01(seed, 21);
  const r2 = h01(seed, 22);
  const r3 = h01(seed, 23);

  // mill monitor: the raised clerestory that runs the length of a loft roof
  if (typ === 'warehouse' && area > 700) {
    const { along, across } = planExtent(inner, ang);
    add(clamp(along * 0.58, 6, 64), clamp(across * 0.28, 2.4, 9), 1.8 + r1 * 1.5, ringCentroid(inner));
  }
  // mechanical penthouse
  if (area > 140 && h >= 9) {
    add(
      clamp(w * (0.26 + r1 * 0.16), 3, 22),
      clamp(w * (0.18 + r2 * 0.13), 2.4, 16),
      typ === 'tower' ? 4.4 + r1 * 3 : 2.8 + r1 * 2.2,
    );
  }
  // elevator overrun
  if (h > 26 && area > 90) {
    add(clamp(w * 0.18, 2.8, 8), clamp(w * 0.16, 2.4, 7), 3.8 + r2 * 2.6);
  }
  // stair bulkhead
  if (area > (det === 2 ? 45 : 90)) {
    add(2.3 + r3 * 1.5, 2.7 + r3 * 1.3, 2.3 + r3 * 1.1);
  }
  // brick stack: the flat-roofed rowhouse and corner-block signature
  if ((typ === 'house' || typ === 'block') && area > 40 && r3 > 0.28) {
    add(0.85 + r1 * 0.4, 0.7 + r2 * 0.35, 1.4 + r1 * 1.3);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* building shell                                                      */
/* ------------------------------------------------------------------ */

/**
 * Vertical extents of every trim element. Depth is deliberately secondary: a
 * 45-degree field of view over 1080 px puts one pixel at 0.6 m from 800 m, so a
 * 0.3 m step is invisible from the air however carefully it is modelled, while
 * a 4 m stone base and a 2 m cornice band still cover several pixels because
 * they are pinned to their own texel and keep their tone through every mip.
 *
 * `reveal` is the only depth that matters, and it always steps INWARD: these
 * are party-wall lots, and a cornice that projects past the footprint lands
 * inside the neighbour.
 */
function trimProportions(seed, style, height, typ) {
  const modern = MODERN_STYLES.has(style);
  const r = h01(seed, 11);
  const r2 = h01(seed, 12);
  const tall = typ === 'tower' || typ === 'midrise';

  let baseH;
  let baseGlazed;
  let sillH;
  if (typ === 'house') {
    baseH = 0.7 + r * 0.8;
    baseGlazed = false;
    sillH = 0.22 + r2 * 0.14;
  } else if (tall) {
    baseH = clamp(Math.min(height * 0.22, 4.2 + r * 2.8), 3.4, 9);
    baseGlazed = true;
    sillH = 0.4 + r2 * 0.45;
  } else {
    baseH = clamp(Math.min(height * 0.34, 3.1 + r * 1.9), 2.4, 6);
    baseGlazed = typ === 'block' || r > 0.45;
    sillH = 0.4 + r2 * 0.4;
  }

  let corniceH;
  if (typ === 'house') corniceH = 0.5 + r2 * 0.55;
  else if (modern) corniceH = clamp(height * 0.014 + 0.6, 0.8, 2.4);
  else if (tall) corniceH = clamp(height * 0.026 + 0.9, 1.3, 4.4);
  else corniceH = clamp(height * 0.022 + 1.1, 1.1, 3);

  return {
    reveal: clamp(0.24 + r * 0.18 + (tall ? 0.18 : 0), 0.24, 0.62),
    baseH,
    baseGlazed,
    sillH,
    corniceH,
    parapetH: (modern ? 1 : 0.8) + r * 0.6,
    deckDrop: 0.45 + r2 * 0.45,
    copingIn: 0.35 + r * 0.3,
    courseH: 0.4 + r * 0.35,
    pierW: 1 + r * 0.8,
    pierSpacing: (typ === 'warehouse' ? 5.2 : 6.4) + r2 * 3.2,
  };
}

/**
 * Base course sitting on the lot line, capped by a stone sill, with the shaft
 * above stepped back to `shaft`. Reads as a proud plinth without projecting.
 * @returns {number} y at which the shaft starts
 */
function emitBase(wall, trim, ring, shaft, y0, p) {
  const sf = y0 + p.baseH;
  band(wall, ring, y0, ring, sf, null, p.baseGlazed ? PIN_DARK : PIN_STONE);
  band(trim, ring, sf, ring, sf + p.sillH, null, PIN_STONE);
  band(trim, ring, sf + p.sillH, shaft, sf + p.sillH, null, PIN_STONE);
  return sf + p.sillH;
}

/**
 * Shaft wall broken by belt courses. The courses sit in the shaft plane rather
 * than stepping out: the tonal change is what carries at distance and a flush
 * band costs a third of a moulded one.
 */
function emitShaft(wall, trim, ring, y0, y1, p, courses) {
  const span = y1 - y0;
  if (!(span > 0.05)) return;
  if (courses < 1 || span < 7) {
    band(wall, ring, y0, ring, y1, null, PIN_NONE);
    return;
  }
  const step = span / (courses + 1);
  let y = y0;
  for (let i = 1; i <= courses; i++) {
    const cy0 = y0 + step * i - p.courseH * 0.5;
    const cy1 = cy0 + p.courseH;
    if (cy0 <= y + 0.6 || cy1 >= y1 - 0.6) continue;
    band(wall, ring, y, ring, cy0, null, PIN_NONE);
    band(trim, ring, cy0, ring, cy1, null, PIN_STONE);
    y = cy1;
  }
  if (y1 - y > 0.05) band(wall, ring, y, ring, y1, null, PIN_NONE);
}

/**
 * Pier bays: the shaft returns to the lot line at each bay division, which is
 * how every mill loft and masonry block in the Strip is actually built. Three
 * faces each; the top dies into the cornice flare and the bottom into the sill
 * annulus, so neither needs capping.
 *
 * Depth is measured off `lot` per edge rather than taken from `p.reveal`:
 * insetRing() silently settles for a smaller offset when a plan is too tight
 * for the one asked, and projecting the full reveal off that would push the
 * pier past the footprint and into the neighbour.
 */
function emitPiers(trim, shaft, lot, y0, y1, p, maxCount) {
  const n = shaft.length;
  const halfW = p.pierW * 0.5;
  // stretch the bay rhythm on very long perimeters so the budget spreads over
  // the whole building instead of running out on the first few edges
  const spacing = Math.max(p.pierSpacing, ringPerimeter(shaft) / Math.max(1, maxCount));
  let placed = 0;
  for (let i = 0; i < n && placed < maxCount; i++) {
    const a = shaft[i];
    const b = shaft[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 8) continue;
    const ux = dx / len;
    const uz = dz / len;
    const ox = uz;
    const oz = -ux;
    const depth = Math.min(p.reveal, (lot[i][0] - a[0]) * ox + (lot[i][1] - a[1]) * oz);
    if (depth < 0.08) continue;
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
      faceQuad(trim, f0, f1, y0, y1, null, PIN_STONE);
      faceQuad(trim, q0, f0, y0, y1, null, PIN_STONE);
      faceQuad(trim, f1, q1, y0, y1, null, PIN_STONE);
      placed++;
    }
  }
}

/**
 * Cornice, parapet, coping and roof deck at the top of a tier. The cornice
 * flares from the stepped-back shaft out to the lot line, which is what gives
 * the top a crisp lit edge instead of the raw arris of an extrusion.
 *
 * `mode` trades triangles for depth:
 *   'cap'  - flare and a cap, for intermediate setback tiers seen edge-on
 *   'deck' - flare, parapet, coping and a deck recessed below the coping. The
 *            recess is the whole point from the air: it is what turns a roof
 *            into a rimmed tray instead of a flat lid, and it costs 2n.
 *
 * The crown fills [yBot, yTop] exactly, whatever the proportions ask for, so a
 * tier too short for a full parapet loses depth rather than leaving a gap
 * between the shaft and the coping.
 *
 * @returns {{ring: Array<[number,number]>, y: number}} the deck to stand
 *   rooftop structures on
 */
function emitCrown(wall, trim, ring, shaft, yBot, yTop, p, mode, ch) {
  const span = yTop - yBot;
  if (mode === 'cap' || span < 0.4) {
    band(trim, shaft, yBot, ring, yTop, null, PIN_STONE);
    capUp(wall, ring, yTop, null, PIN_DARK);
    return { ring, y: yTop };
  }
  band(trim, shaft, yBot, ring, yBot + ch * 0.55, null, PIN_STONE);
  band(trim, ring, yBot + ch * 0.55, ring, yTop, null, PIN_STONE);
  const coping = insetRing(ring, p.copingIn);
  if (!coping) {
    capUp(wall, ring, yTop, null, PIN_DARK);
    return { ring, y: yTop };
  }
  band(trim, ring, yTop, coping, yTop, null, PIN_STONE);
  const deckY = Math.max(yBot + 0.15, yTop - p.deckDrop);
  band(trim, coping, yTop, coping, deckY, null, PIN_DARK);
  capUp(wall, coping, deckY, null, PIN_DARK);
  return { ring: coping, y: deckY };
}

/**
 * Hip roof: the eave ring lifted to an inset ridge. A long plan's ridge wants
 * to collapse to a line, which offsetRing() rejects, and the fallback scales
 * then give a truncated hip - which is what most of the rowhouse rows actually
 * carry anyway.
 * @returns {{ring: Array<[number,number]>, y: number}|null}
 */
function emitPitchedRoof(wall, ring, eaveY, rise, ang) {
  if (!(polygonArea(ring) > 4)) return null;
  const ridge = insetRing(ring, planExtent(ring, ang).across * 0.44, 0.02);
  if (!ridge) return null;
  const ridgeY = eaveY + rise;
  band(wall, ring, eaveY, ridge, ridgeY, null, PIN_DARK);
  capUp(wall, ridge, ridgeY, null, PIN_DARK);
  return { ring: ridge, y: ridgeY };
}

/** Belt courses are worth their triangles only once there is wall to divide. */
function courseCount(typ, det, shaftSpan) {
  if (typ === 'house' || shaftSpan < 7) return 0;
  const room = Math.floor(shaftSpan / 5.5) - 1;
  if (room < 1) return 0;
  if (typ === 'block') return Math.min(room, det === 2 ? 2 : 1);
  if (typ === 'warehouse') return Math.min(room, 2);
  return Math.min(room, det === 2 ? 4 : 2);
}

function pierCount(typ, det, perim) {
  if (perim < 55) return 0;
  if (typ === 'house') return 0;
  if (typ === 'warehouse') return det === 2 ? 24 : 12;
  if (typ === 'block') return det === 2 ? 14 : 5;
  return det === 2 ? 28 : 10;
}

/* ------------------------------------------------------------------ */
/* landmark crowns                                                     */
/* ------------------------------------------------------------------ */

/**
 * A landmark is a building whose silhouette people recognise, which is exactly
 * what a hashed archetype cannot produce: US Steel is a plain triangular prism,
 * Koppers is a chateau roof, Gulf is a ziggurat. Each entry below replaces the
 * random massing with the real setback programme and hangs a modelled crown off
 * the top, while the shell, the facade texture and the merge bucket stay
 * exactly as they are for every other building - so a landmark still costs one
 * building's worth of draw calls and still carries real windows.
 *
 * Keyed by the footprint's AREA centroid in local metres, not by name: the
 * dataset is rebuilt from Overpass and names churn (the Carnegie Science Center
 * is "Kamin Science Center" in OSM since 2023), but a city block does not move.
 * The entry is claimed by the one footprint that COVERS `at`, so downtown
 * neighbours a block apart cannot inherit each other's crowns; `r` only bounds
 * how far a re-imported footprint's centroid may drift from the recorded point,
 * and churn measured against Overpass is under 10 m for all of these.
 *
 * `h` is the real height in metres and overrides the dataset. `tiers` is the
 * setback programme as [fraction of h at the tier top, inset from the tier
 * below in metres], bottom-to-top, the last entry being the parapet the crown
 * stands on.
 */
const LANDMARKS = [
  // 841 ft, 64 floors. Triangular plan with truncated corners, hung on 18
  // liquid-filled Cor-Ten box columns that stand proud of the glass line.
  { n: 'U.S. Steel Tower', at: [614.7, -39.8], r: 45, h: 256, shell: 0.95, crown: 'usSteel' },
  // 725 ft, 54 floors; stepped mechanical crown over a chamfered shaft.
  {
    n: 'BNY Mellon Center',
    at: [517.5, 150.6],
    r: 45,
    h: 221,
    shell: 0.93,
    tiers: [[0.9, 0], [1, 3.5]],
    crown: 'steppedCap',
  },
  // 635 ft, 40 floors. Neo-gothic glass: corner turrets and a central spire
  // over a pinnacled parapet, part of the 231 spires across the six buildings.
  { n: 'One PPG Place', at: [-150.1, 112.1], r: 45, h: 194, shell: 0.84, crown: 'ppgTower' },
  { n: 'Two PPG Place', at: [-112.8, 58.1], r: 40, h: 22.9, crown: 'ppgSpires' },
  { n: 'Three PPG Place', at: [-61.1, 98.9], r: 30, h: 22.9, crown: 'ppgSpires' },
  { n: 'Four PPG Place', at: [-66.5, 154.4], r: 30, h: 22.9, crown: 'ppgSpires' },
  { n: 'Five PPG Place', at: [-102.9, 197.8], r: 34, h: 22.9, crown: 'ppgSpires' },
  { n: 'Six PPG Place', at: [-156.1, 172.6], r: 40, h: 51.3, crown: 'ppgSpires' },
  { n: 'PPG Place Wintergarden', at: [-185.8, 94.8], r: 34, h: 32, crown: 'ppgSpires' },
  // 616 ft, 31 floors: red granite shaft tapering into a slender finial.
  {
    n: 'Fifth Avenue Place',
    at: [-116.2, -111.6],
    r: 45,
    h: 188,
    shell: 0.88,
    tiers: [[0.74, 0], [0.86, 5], [1, 4.5]],
    crown: 'obelisk',
  },
  // 615 ft, 45 floors. Five silver octagonal towers of stepped heights sharing
  // one podium, which is why the raw footprint alone reads as nothing at all.
  { n: 'One Oxford Centre', at: [290.2, 331.0], r: 50, h: 187, shell: 0.13, crown: 'oxford' },
  // 582 ft, 44 floors. The crown is a stepped pyramid after the Mausoleum at
  // Halicarnassus, glazed and lit, and it is the top of the 1932 skyline.
  {
    n: 'Gulf Tower',
    at: [575.0, -178.3],
    r: 45,
    h: 177,
    shell: 0.8,
    tiers: [[0.6, 0], [0.72, 4.5], [0.8, 4], [1, 3.5]],
    crown: 'ziggurat',
  },
  // 475 ft, 34 floors, and the only chateau roof on the skyline: a steep
  // copper pyramid, green with age, dormered on all four faces.
  {
    n: 'Koppers Building',
    at: [547.1, -123.4],
    r: 40,
    h: 145,
    shell: 0.76,
    tiers: [[0.6, 0], [0.68, 4], [1, 3]],
    crown: 'chateau',
  },
  // 485 ft, 40 floors. The mast carries an aviation beacon that still spells
  // PITTSBURGH in Morse code.
  {
    n: 'Grant Building',
    at: [377.7, 373.0],
    r: 40,
    h: 148,
    shell: 0.9,
    tiers: [[0.66, 0], [0.8, 4], [0.87, 3.5], [1, 3]],
    crown: 'beacon',
  },
  // Burnham, 1902: 330 ft of granite under one very deep cornice.
  { n: 'Frick Building', at: [395.3, 207.4], r: 40, h: 100, shell: 0.93, crown: 'classicalAttic' },
  { n: 'Pittsburgh City-County Building', at: [436.0, 321.7], r: 45, h: 43.9, shell: 0.88, crown: 'classicalAttic' },
  // 535 ft, 42 floors of late Gothic Revival over a four-storey Commons Room
  // block; buttressed piers run the shaft and burst into pinnacles at the top.
  {
    n: 'Cathedral of Learning',
    at: [4135.4, -368.4],
    r: 55,
    h: 163,
    shell: 0.88,
    // the Commons Room block, then the tower stepping in at roughly the 15th,
    // 25th and 36th floors
    tiers: [[0.16, 0], [0.5, 15], [0.74, 3], [1, 2.5]],
    crown: 'gothicCrown',
  },
  // Fleche tip 256 ft above ground over a 100 ft nave roof (Univ. of Pittsburgh).
  { n: 'Heinz Memorial Chapel', at: [4247.7, -475.2], r: 40, h: 78, shell: 0.28, crown: 'chapelFleche' },
  // The Carnegie Institute group: four monumental storeys behind one cornice,
  // roughly 26 m, against the 14 m default the dataset gives an untagged
  // building. Low hipped roofs over a deep attic.
  { n: 'Carnegie Museum of Art', at: [4476.7, -299.8], r: 55, h: 26, shell: 0.8, crown: 'beauxArts' },
  { n: 'Carnegie Museum of Natural History', at: [4397.5, -234.9], r: 60, h: 28, shell: 0.8, crown: 'beauxArts' },
  { n: 'Carnegie Library, Oakland', at: [4358.7, -198.8], r: 50, h: 26, shell: 0.8, crown: 'beauxArts' },
  { n: 'Carnegie Music Hall', at: [4319.7, -257.0], r: 45, h: 29, shell: 0.78, crown: 'beauxArts' },
  // Hornbostel, 1910, again after the Mausoleum: a colonnaded block under a
  // stepped pyramid whose apex stands 150 ft above the ground.
  { n: 'Soldiers and Sailors Memorial Hall', at: [3860.5, -450.4], r: 50, h: 46, shell: 0.5, crown: 'mausoleum' },
  // Eight floors of a 1911 terminal warehouse, not the 14 m default.
  { n: 'The Andy Warhol Museum', at: [-42.6, -821.0], r: 35, h: 30, shell: 0.9, crown: 'classicalAttic' },
  // Carnegie Science Center, renamed Kamin in 2023; the Buhl Planetarium dome
  // is the only thing that identifies it from the far bank.
  { n: 'Kamin Science Center', at: [-1350.1, -513.3], r: 60, h: 20, shell: 0.75, crown: 'planetarium' },
  // Vinoly's cable-stayed roof sweeps up from Penn Avenue and cantilevers out
  // over Fort Duquesne Boulevard, echoing the suspension bridges beyond it.
  {
    n: 'David L. Lawrence Convention Center',
    at: [488.7, -515.2],
    r: 90,
    h: 48,
    shell: 0.42,
    tiers: [[0.46, 0]],
    crown: 'cableRoof',
  },
  // 545 ft; the shaft is sheared off at an angle above the double-skin facade.
  {
    n: 'Tower at PNC Plaza',
    at: [152.8, 82.7],
    r: 40,
    h: 166,
    shell: 0.9,
    tiers: [[0.88, 0], [1, 2.5]],
    crown: 'shearedCap',
  },
];

/** Area centroid, which unlike the vertex mean does not drift when a ring is re-simplified. */
function ringAreaCentroid(ring) {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % n];
    const cr = x0 * z1 - x1 * z0;
    a += cr;
    cx += (x0 + x1) * cr;
    cz += (z0 + z1) * cr;
  }
  if (Math.abs(a) < EPS) return ringCentroid(ring);
  return [cx / (3 * a), cz / (3 * a)];
}

function landmarkFor(ring) {
  if (!ring || ring.length < 3) return null;
  const [cx, cz] = ringAreaCentroid(ring);
  for (let i = 0; i < LANDMARKS.length; i++) {
    const lm = LANDMARKS[i];
    const dx = cx - lm.at[0];
    if (dx > lm.r || dx < -lm.r) continue;
    const dz = cz - lm.at[1];
    if (dz > lm.r || dz < -lm.r) continue;
    if (dx * dx + dz * dz > lm.r * lm.r) continue;
    if (pointInRing(lm.at[0], lm.at[1], ring)) return lm;
  }
  return null;
}

/**
 * The landmark's setback programme, in the shape the tier loop consumes.
 *
 * The walled shell stops at `lm.shell` of the total height and the crown fills
 * the rest: a chateau roof or a ziggurat is a third of what people see of the
 * building, and it cannot be modelled in the metre of headroom left over when
 * the shaft is run all the way to the stated height.
 */
function landmarkTiers(lm, base, h) {
  const shellH = h * clamp(lm.shell ?? 1, 0.08, 1);
  const steps = lm.tiers;
  if (!steps || !steps.length) {
    return [{ ring: base, y0: 0, y1: shellH, archetype: 'landmark', index: 0, top: true }];
  }
  const tiers = [];
  let ring = base;
  let y0 = 0;
  for (let i = 0; i < steps.length; i++) {
    const [frac, inset] = steps[i];
    const last = i === steps.length - 1;
    const y1 = last ? shellH : clamp(h * frac, y0 + 3, shellH - 3);
    if (y1 - y0 < 2.5) continue;
    if (inset > 0.05) ring = insetRing(ring, inset) || ring;
    tiers.push({ ring, y0, y1, archetype: 'landmark', index: tiers.length, top: false });
    y0 = y1;
  }
  if (!tiers.length) {
    return [{ ring: base, y0: 0, y1: shellH, archetype: 'landmark', index: 0, top: true }];
  }
  tiers[tiers.length - 1].y1 = shellH;
  tiers[tiers.length - 1].top = true;
  return tiers;
}

/* -- crown primitives ---------------------------------------------- */

function pyramidUp(b, ring, y0, apexY, pin) {
  const [cx, cz] = ringCentroid(ring);
  coneUp(b, ring, y0, cx, apexY, cz, null, pin);
}

/** Ziggurat: `steps` shrinking prisms between y0 and y1. Returns the top ring. */
function steppedUp(b, ring, y0, y1, steps, inset, pin) {
  let cur = ring;
  const dy = (y1 - y0) / steps;
  let y = y0;
  for (let i = 0; i < steps; i++) {
    band(b, cur, y, cur, y + dy, null, pin);
    y += dy;
    const next = insetRing(cur, inset, 0.02);
    if (!next) {
      capUp(b, cur, y, null, pin);
      return { ring: cur, y };
    }
    band(b, cur, y, next, y, null, pin);
    cur = next;
  }
  return { ring: cur, y };
}

/** Square spire: a short prism dying into a four-sided point. */
function pinnacle(b, x, z, r, y0, height, ang, pin) {
  const foot = regularRing(x, z, r, 4, ang);
  const neck = y0 + height * 0.4;
  band(b, foot, y0, foot, neck, null, pin);
  coneUp(b, foot, neck, x, y0 + height, z, null, pin);
}

/** Hemispherical dome on `segs` meridians and `rings` parallels. */
function domeUp(b, cx, cz, r, y0, rise, segs, rings, pin) {
  let lower = regularRing(cx, cz, r, segs, 0);
  let lowerY = y0;
  for (let i = 1; i <= rings; i++) {
    const t = i / rings;
    const a = t * Math.PI * 0.5;
    const ry = Math.max(0.15, r * Math.cos(a));
    const y = y0 + rise * Math.sin(a);
    const upper = regularRing(cx, cz, ry, segs, 0);
    band(b, lower, lowerY, upper, y, null, pin);
    lower = upper;
    lowerY = y;
  }
  capUpConvex(b, lower, lowerY, null, pin);
}

/** Tapered mast, optionally with a lit finial ball at the tip. */
function mastUp(b, x, z, r, y0, y1, ang, pin, ball = 0) {
  const foot = regularRing(x, z, r, 6, ang);
  const tip = scaleRing(foot, x, z, 0.34);
  band(b, foot, y0, tip, y1, null, pin);
  if (ball > 0) domeUp(b, x, z, ball, y1, ball * 1.6, 8, 3, pin);
  else capUpConvex(b, tip, y1, null, pin);
}

/** Walk a ring's edges dropping a callback every `spacing` metres. */
function alongRing(ring, spacing, fn) {
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const bb = ring[(i + 1) % n];
    const dx = bb[0] - a[0];
    const dz = bb[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < spacing * 0.4) continue;
    const count = Math.max(1, Math.round(len / spacing));
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count;
      fn(a[0] + dx * t, a[1] + dz * t, Math.atan2(dz, dx), len);
    }
  }
}

/** Corners of a ring, taken as the vertices that turn hardest. */
function ringCorners(ring, want) {
  const n = ring.length;
  const turns = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n];
    const q = ring[i];
    const r = ring[(i + 1) % n];
    const a0 = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const a1 = Math.atan2(r[1] - q[1], r[0] - q[0]);
    let d = Math.abs(a1 - a0);
    if (d > Math.PI) d = Math.PI * 2 - d;
    turns.push({ p: q, d });
  }
  turns.sort((a, b) => b.d - a.d);
  return turns.slice(0, want).map((t) => t.p);
}

/* -- crowns --------------------------------------------------------- */

const CROWNS = {
  /**
   * Recessed mechanical top hat plus the corner columns. The columns are the
   * whole point of the building: they carry the frame outside the glass, so
   * they read as three sharp vertical arrises from anywhere in the Triangle.
   */
  usSteel(c) {
    const { wall, trim, ring, deck, y, capY } = c;
    for (const [px, pz] of ringCorners(ring, 3)) {
      const col = regularRing(px, pz, 3.4, 4, c.ang);
      band(trim, col, c.baseY, col, capY + 3, null, PIN_STONE);
      capUpConvex(trim, col, capY + 3, null, PIN_STONE);
    }
    const hat = insetRing(deck, 7) || deck;
    band(trim, hat, y, hat, y + 5.5, null, PIN_STONE);
    capUp(wall, hat, y + 5.5, null, PIN_DARK);
    const [cx, cz] = ringCentroid(hat);
    mastUp(trim, cx, cz, 1.1, y + 5.5, y + 22, c.ang, PIN_STONE);
  },

  /** Two shrinking mechanical decks, the modern flat-top crown. */
  steppedCap(c) {
    const { wall, trim, deck, y } = c;
    const step = steppedUp(trim, deck, y, y + c.h * 0.035, 2, 3.2, PIN_STONE);
    capUp(wall, step.ring, step.y, null, PIN_DARK);
    const [cx, cz] = ringCentroid(step.ring);
    mastUp(trim, cx, cz, 1.2, step.y, step.y + c.h * 0.06, c.ang, PIN_STONE);
  },

  /** Shaft sheared off on the diagonal above the double-skin facade. */
  shearedCap(c) {
    const { wall, trim, deck, y } = c;
    const ext = planExtent(deck, c.ang);
    const rise = Math.max(6, ext.across * 0.5);
    const ca = Math.cos(c.ang);
    const sa = Math.sin(c.ang);
    const [cx, cz] = ringCentroid(deck);
    const lift = deck.map(([x, z]) => {
      const v = (z - cz) * ca - (x - cx) * sa;
      return [x, z, y + clamp(0.5 + (v / Math.max(1, ext.across) + 0.5) * rise, 0.4, rise)];
    });
    for (let i = 0, n = lift.length; i < n; i++) {
      const a = lift[i];
      const b = lift[(i + 1) % n];
      wall.quad([a[0], y, a[1]], [a[0], a[2], a[1]], [b[0], b[2], b[1]], [b[0], y, b[1]], null, PIN_NONE);
    }
    const top = lift.map(([x, , z]) => [x, z]);
    const faces = triangulateRing(top);
    if (faces) {
      for (const f of faces) {
        const p0 = lift[f[0]];
        const p1 = lift[f[1]];
        const p2 = lift[f[2]];
        if (!p0 || !p1 || !p2) continue;
        trim.tri([p0[0], p0[2], p0[1]], [p2[0], p2[2], p2[1]], [p1[0], p1[2], p1[1]], null, PIN_STONE);
        trim.tri([p0[0], p0[2], p0[1]], [p1[0], p1[2], p1[1]], [p2[0], p2[2], p2[1]], null, PIN_STONE);
      }
    }
  },

  /**
   * Neo-gothic crown: a turret on each corner, a taller central spire, and
   * pinnacles marching round the parapet.
   */
  ppgTower(c) {
    const { trim, ring, deck, y, capY } = c;
    const w = Math.sqrt(polygonArea(deck));
    alongRing(ring, 7.5, (x, z) => pinnacle(trim, x, z, 0.85, capY, 6.5, c.ang, PIN_STONE));
    for (const [px, pz] of ringCorners(deck, 4)) {
      const turret = regularRing(px, pz, w * 0.11, 4, c.ang);
      band(trim, turret, y, turret, y + c.h * 0.05, null, PIN_STONE);
      alongRing(turret, 3.2, (x, z) =>
        pinnacle(trim, x, z, 0.7, y + c.h * 0.05, 5, c.ang, PIN_STONE));
      pyramidUp(trim, turret, y + c.h * 0.05, y + c.h * 0.115, PIN_STONE);
    }
    const [cx, cz] = ringCentroid(deck);
    const core = regularRing(cx, cz, w * 0.2, 4, c.ang);
    band(trim, core, y, core, y + c.h * 0.055, null, PIN_STONE);
    pyramidUp(trim, core, y + c.h * 0.055, c.baseY + c.h, PIN_STONE);
  },

  /** The low blocks of the complex carry the same pinnacled parapet. */
  ppgSpires(c) {
    const { trim, ring, capY } = c;
    alongRing(ring, 6.5, (x, z) => pinnacle(trim, x, z, 0.7, capY, 5, c.ang, PIN_STONE));
    for (const [px, pz] of ringCorners(ring, 4)) {
      pinnacle(trim, px, pz, 1.15, capY, 9.5, c.ang, PIN_STONE);
    }
  },

  /** Tapered setbacks dying into a slender finial. */
  obelisk(c) {
    const { wall, trim, deck, y } = c;
    const step = steppedUp(trim, deck, y, y + c.h * 0.045, 4, 2.4, PIN_STONE);
    capUp(wall, step.ring, step.y, null, PIN_DARK);
    const [cx, cz] = ringCentroid(step.ring);
    const w = Math.sqrt(polygonArea(step.ring));
    const shaft = regularRing(cx, cz, w * 0.2, 4, c.ang);
    band(trim, shaft, step.y, shaft, step.y + c.h * 0.03, null, PIN_STONE);
    pyramidUp(trim, shaft, step.y + c.h * 0.03, c.baseY + c.h * 1.06, PIN_STONE);
  },

  /**
   * Five octagons of stepped height on one podium. The dataset holds a single
   * ring for the whole site, so the towers are laid out across its own frame:
   * the tall one over the centre, the rest stepping down to the corners.
   */
  oxford(c) {
    const { wall, trim, deck, y } = c;
    const ext = planExtent(deck, c.ang);
    const [cx, cz] = ringCentroid(deck);
    const ca = Math.cos(c.ang);
    const sa = Math.sin(c.ang);
    const r = Math.min(ext.along, ext.across) * 0.29;
    const towers = [
      [0, 0, 1, 1],
      [-ext.along * 0.26, ext.across * 0.1, 0.62, 0.72],
      [ext.along * 0.27, -ext.across * 0.08, 0.55, 0.66],
      [ext.along * 0.05, ext.across * 0.3, 0.42, 0.58],
      [-ext.along * 0.3, -ext.across * 0.24, 0.34, 0.5],
    ];
    for (const [u, v, rs, hs] of towers) {
      const x = cx + u * ca - v * sa;
      const z = cz + u * sa + v * ca;
      const ring = regularRing(x, z, r * rs + 6, 8, c.ang);
      const top = y + (c.baseY + c.h - y) * hs;
      band(wall, ring, c.baseY + 2, ring, top - 2.2, null, PIN_NONE);
      band(trim, ring, top - 2.2, ring, top, null, PIN_STONE);
      capUp(wall, ring, top, null, PIN_DARK);
    }
  },

  /** Stepped pyramid crown, glazed lantern at the apex. */
  ziggurat(c) {
    const { wall, trim, deck, y } = c;
    const top = c.baseY + c.h;
    const step = steppedUp(trim, deck, y, y + (top - y) * 0.72, 7, 2.6, PIN_STONE);
    const [cx, cz] = ringCentroid(step.ring);
    const w = Math.sqrt(polygonArea(step.ring));
    const lantern = regularRing(cx, cz, Math.max(3, w * 0.34), 4, c.ang);
    band(wall, lantern, step.y, lantern, step.y + (top - step.y) * 0.45, null, PIN_NONE);
    pyramidUp(trim, lantern, step.y + (top - step.y) * 0.45, top, PIN_STONE);
  },

  /** Steep dormered pyramid: the copper chateau roof, plus its lantern. */
  chateau(c) {
    const { wall, trim, deck, y } = c;
    const top = c.baseY + c.h;
    const eave = y + 1.5;
    const skirt = insetRing(deck, -1.2, 0.02) || deck;
    band(trim, deck, y, skirt, eave, null, PIN_STONE);
    const ridge = insetRing(skirt, Math.sqrt(polygonArea(skirt)) * 0.34, 0.05);
    const ridgeY = eave + (top - eave) * 0.78;
    if (ridge) {
      band(wall, skirt, eave, ridge, ridgeY, null, PIN_DARK);
      // dormers, one to a face, sitting on the lower third of the pitch
      alongRing(skirt, 11, (x, z, edgeAng) => {
        const t = 0.3;
        const dx = (ringCentroid(skirt)[0] - x) * t;
        const dz = (ringCentroid(skirt)[1] - z) * t;
        const dorm = rectRing(x + dx * 0.25, z + dz * 0.25, 3.4, 2.6, Math.cos(edgeAng), Math.sin(edgeAng));
        const dy = eave + (ridgeY - eave) * 0.22;
        band(trim, dorm, dy, dorm, dy + 3.2, null, PIN_STONE);
        pyramidUp(trim, dorm, dy + 3.2, dy + 5.4, PIN_STONE);
      });
      const [lx, lz] = ringCentroid(ridge);
      const lantern = regularRing(lx, lz, Math.max(2, Math.sqrt(polygonArea(ridge)) * 0.3), 4, c.ang);
      band(trim, lantern, ridgeY, lantern, ridgeY + (top - ridgeY) * 0.5, null, PIN_STONE);
      pyramidUp(trim, lantern, ridgeY + (top - ridgeY) * 0.5, top, PIN_STONE);
    } else {
      pyramidUp(wall, skirt, eave, top, PIN_DARK);
    }
  },

  /** Setback crown carrying the beacon mast. */
  beacon(c) {
    const { wall, trim, deck, y } = c;
    const step = steppedUp(trim, deck, y, y + c.h * 0.03, 2, 2.6, PIN_STONE);
    capUp(wall, step.ring, step.y, null, PIN_DARK);
    const [cx, cz] = ringCentroid(step.ring);
    mastUp(trim, cx, cz, 2.2, step.y, c.baseY + c.h, c.ang, PIN_STONE, 2.4);
  },

  /** Deep cornice, blind attic storey and a balustrade: the Burnham top. */
  classicalAttic(c) {
    const { wall, trim, deck, y } = c;
    const atticH = clamp(c.h * 0.045, 1.8, 4.5);
    const flare = insetRing(deck, -1.1, 0.02) || deck;
    band(trim, deck, y, flare, y + atticH * 0.4, null, PIN_STONE);
    band(trim, flare, y + atticH * 0.4, deck, y + atticH * 0.75, null, PIN_STONE);
    band(trim, deck, y + atticH * 0.75, deck, y + atticH, null, PIN_STONE);
    capUp(wall, deck, y + atticH, null, PIN_DARK);
    alongRing(deck, 9, (x, z, edgeAng) => {
      const post = rectRing(x, z, 1.4, 0.7, Math.cos(edgeAng), Math.sin(edgeAng));
      extrudeConvex(trim, post, y + atticH, y + atticH + 1.3, null, PIN_STONE);
    });
  },

  /**
   * The Cathedral's crown: buttress piers carried up off the top setback and
   * breaking into pinnacles, with a traceried lantern over the middle. The
   * setbacks themselves are the shell's, so they keep the limestone facade.
   */
  gothicCrown(c) {
    const { wall, trim, ring, deck, y, capY } = c;
    const top = c.baseY + c.h;
    const span = top - y;
    alongRing(ring, 7, (x, z, edgeAng) => {
      const pier = rectRing(x, z, 2.4, 1.6, Math.cos(edgeAng), Math.sin(edgeAng));
      band(trim, pier, capY - span * 1.4, pier, capY + span * 0.14, null, PIN_STONE);
      pinnacle(trim, x, z, 1.2, capY + span * 0.14, span * 0.4, edgeAng, PIN_STONE);
    });
    for (const [px, pz] of ringCorners(ring, 4)) {
      pinnacle(trim, px, pz, 2.4, capY, span * 0.78, c.ang, PIN_STONE);
    }
    // The real crown is flat-topped tracery, not a spire: a lantern stage that
    // steps in twice and stops.
    const lantern = insetRing(deck, Math.sqrt(polygonArea(deck)) * 0.16, 0.05) || deck;
    band(wall, lantern, y, lantern, y + span * 0.5, null, PIN_NONE);
    alongRing(lantern, 5.5, (x, z) => pinnacle(trim, x, z, 0.9, y + span * 0.5, span * 0.34, c.ang, PIN_STONE));
    const cap = steppedUp(trim, lantern, y + span * 0.5, top, 2, 2.2, PIN_STONE);
    capUp(wall, cap.ring, cap.y, null, PIN_DARK);
  },

  /**
   * Steep slate nave roof with the octagonal lead fleche over the crossing.
   * The fleche is what makes the chapel legible from Oakland, and it stands
   * more than twice as high as the ridge it springs from.
   */
  chapelFleche(c) {
    const { wall, trim, deck, y } = c;
    const top = c.baseY + c.h;
    const ridgeY = c.baseY + c.h * 0.385;
    const ridge = insetRing(deck, planExtent(deck, c.ang).across * 0.42, 0.02);
    let crossing = deck;
    if (ridge) {
      band(wall, deck, y, ridge, ridgeY, null, PIN_DARK);
      capUp(wall, ridge, ridgeY, null, PIN_DARK);
      crossing = ridge;
    } else {
      pyramidUp(wall, deck, y, ridgeY, PIN_DARK);
    }
    alongRing(deck, 7, (x, z) => pinnacle(trim, x, z, 0.8, y, 5, c.ang, PIN_STONE));
    const [cx, cz] = ringCentroid(crossing);
    const r = Math.max(2.6, Math.sqrt(polygonArea(deck)) * 0.14);
    const base = regularRing(cx, cz, r, 8, 0);
    const neck = ridgeY + (top - ridgeY) * 0.3;
    band(trim, base, ridgeY - 2, base, neck, null, PIN_STONE);
    alongRing(base, 2.6, (x, z) => pinnacle(trim, x, z, 0.42, neck, 3, 0, PIN_STONE));
    coneUp(trim, scaleRing(base, cx, cz, 0.82), neck, cx, top, cz, null, PIN_STONE);
  },

  /** Deep attic over the cornice, then a low hipped roof, Beaux-Arts fashion. */
  beauxArts(c) {
    const { wall, trim, deck, y } = c;
    const atticH = 3.4;
    const flare = insetRing(deck, -1.3, 0.02) || deck;
    band(trim, deck, y, flare, y + 1.4, null, PIN_STONE);
    band(trim, flare, y + 1.4, deck, y + atticH, null, PIN_STONE);
    const ridge = insetRing(deck, planExtent(deck, c.ang).across * 0.3, 0.03);
    if (ridge) {
      band(wall, deck, y + atticH, ridge, y + atticH + 4.5, null, PIN_DARK);
      capUp(wall, ridge, y + atticH + 4.5, null, PIN_DARK);
    } else {
      capUp(wall, deck, y + atticH, null, PIN_DARK);
    }
  },

  /**
   * Colonnaded storey under a stepped pyramid, after the Mausoleum at
   * Halicarnassus: 24 steps on the original, and the apex here lands at the
   * 150 ft the Memorial's own history gives for its roof.
   */
  mausoleum(c) {
    const { wall, trim, deck, y } = c;
    const top = c.baseY + c.h;
    const colH = (top - y) * 0.36;
    const colonnade = insetRing(deck, 1.6, 0.1) || deck;
    alongRing(colonnade, 4.4, (x, z) => {
      const col = regularRing(x, z, 1.2, 6, 0);
      band(trim, col, y, col, y + colH, null, PIN_STONE);
    });
    const attic = insetRing(deck, 3.4, 0.08) || deck;
    band(wall, attic, y, attic, y + colH, null, PIN_NONE);
    band(trim, attic, y + colH, deck, y + colH + 1.6, null, PIN_STONE);
    const step = steppedUp(trim, deck, y + colH + 1.6, top - (top - y) * 0.1, 10, 1.5, PIN_STONE);
    pyramidUp(trim, step.ring, step.y, top, PIN_STONE);
  },

  /** Buhl Planetarium dome over the riverfront block. */
  planetarium(c) {
    const { wall, trim, deck, y } = c;
    capUp(wall, deck, y, null, PIN_DARK);
    const [cx, cz] = ringAreaCentroid(deck);
    // a 127 x 74 m riverfront bar: the drum can only be as wide as the
    // clearance it has where it stands, or it cantilevers off the long side
    const room = pointInRing(cx, cz, deck) ? distToRing(cx, cz, deck) - 0.8 : 0;
    const r = Math.min(clamp(Math.sqrt(polygonArea(deck)) * 0.2, 5, 14), room);
    if (r < 3) return;
    const drum = regularRing(cx, cz, r, 14, 0);
    band(trim, drum, y, drum, y + 2.4, null, PIN_STONE);
    domeUp(trim, cx, cz, r, y + 2.4, r * 0.85, 14, 5, PIN_STONE);
  },

  /**
   * The suspended roof: a shell that springs off the Penn Avenue edge, peaks
   * about two thirds of the way across and cantilevers over Fort Duquesne
   * Boulevard, carried on a row of masts and back-stay cables.
   */
  cableRoof(c) {
    const { wall, trim, deck, y } = c;
    const ext = planExtent(deck, c.ang);
    const [cx, cz] = ringCentroid(deck);
    const ca = Math.cos(c.ang);
    const sa = Math.sin(c.ang);
    // travel across the plan toward the river, which is north (-Z) of the site
    const across = [-sa, ca];
    const sign = across[1] > 0 ? -1 : 1;
    const half = ext.across * 0.5;
    const halfU = ext.along * 0.5;
    const rise = c.h * 0.72;
    const segs = 14;
    const at = (u, t) => {
      const v = (t - 0.5) * ext.across * sign;
      return [cx + u * ca - v * sa, cz + u * sa + v * ca];
    };
    // parabola peaking at t = 0.66, still 40% up at the cantilevered lip
    const profile = (t) => y + Math.max(0.6, rise * (1 - ((t - 0.66) / 0.72) ** 2));
    const thick = 1.8;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const y0 = profile(t0);
      const y1 = profile(t1);
      const a0 = at(-halfU, t0);
      const b0 = at(halfU, t0);
      const a1 = at(-halfU, t1);
      const b1 = at(halfU, t1);
      wall.quad([a0[0], y0, a0[1]], [b0[0], y0, b0[1]], [b1[0], y1, b1[1]], [a1[0], y1, a1[1]], null, PIN_DARK);
      trim.quad(
        [a0[0], y0 - thick, a0[1]],
        [a1[0], y1 - thick, a1[1]],
        [b1[0], y1 - thick, b1[1]],
        [b0[0], y0 - thick, b0[1]],
        null,
        PIN_STONE,
      );
      trim.quad(
        [a0[0], y0, a0[1]],
        [a1[0], y1, a1[1]],
        [a1[0], y1 - thick, a1[1]],
        [a0[0], y0 - thick, a0[1]],
        null,
        PIN_STONE,
      );
      trim.quad(
        [b0[0], y0 - thick, b0[1]],
        [b1[0], y1 - thick, b1[1]],
        [b1[0], y1, b1[1]],
        [b0[0], y0, b0[1]],
        null,
        PIN_STONE,
      );
    }
    // glazed end walls under the sweep
    for (const u of [-halfU, halfU]) {
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs;
        const t1 = (i + 1) / segs;
        const p0 = at(u, t0);
        const p1 = at(u, t1);
        wall.quad(
          [p0[0], y, p0[1]],
          [p0[0], profile(t0) - thick, p0[1]],
          [p1[0], profile(t1) - thick, p1[1]],
          [p1[0], y, p1[1]],
          null,
          PIN_NONE,
        );
      }
    }
    // masts along the springing edge, with a stay running back to the peak
    const peak = profile(0.66);
    for (let i = 0; i < 5; i++) {
      const u = (i / 4 - 0.5) * ext.along * 0.86;
      const foot = at(u, 0.06);
      const head = at(u, 0.1);
      mastUp(trim, foot[0], foot[1], 1.1, y - c.h * 0.4, peak + c.h * 0.24, c.ang, PIN_STONE);
      const anchor = at(u, 0.66);
      const cable = [
        [head[0], peak + c.h * 0.22, head[1]],
        [anchor[0], profile(0.66), anchor[1]],
      ];
      const w = 0.35;
      trim.quad(
        [cable[0][0] - w, cable[0][1], cable[0][2]],
        [cable[1][0] - w, cable[1][1], cable[1][2]],
        [cable[1][0] + w, cable[1][1], cable[1][2]],
        [cable[0][0] + w, cable[0][1], cable[0][2]],
        null,
        PIN_STONE,
      );
    }
    capUp(wall, deck, y, null, PIN_DARK);
  },
};

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
 * @param {number} [opts.floorH=3.5] metres per storey (family spec)
 * @param {number} [opts.windowW=3.2] metres per window bay (family spec)
 * @param {number} [opts.skirt=0] extra metres of wall below baseY, hides gaps on slopes
 * @param {boolean} [opts.indexed=false] emit indexed geometry. Leave false to stay
 *   mergeable with `THREE.ExtrudeGeometry` (which is non-indexed); set true, on
 *   every building, once nothing else feeds the same merge bucket - it saves
 *   about a third of the vertex buffer.
 * @returns {{wall: THREE.BufferGeometry|null, trim: THREE.BufferGeometry|null,
 *            tier: 0|1|2, triangles: number,
 *            roofRing: Array<[number,number]>|null, roofY: number}}
 *   `wall` carries the shaft, storefronts, soffits and roof decks; `trim`
 *   carries the base course, belt courses, piers, cornices, parapets and the
 *   masonry rooftop housings. Both use the SAME facade material; keep them
 *   apart only so the caller can tint the trim differently. Both carry
 *   position/normal/uv, ready for `tintGeometry()` and `mergeGeometries()`.
 *   `roofRing`/`roofY` describe the deck that `buildRoofscape()` stands its
 *   plant on, and are null/ridge height for a pitched roof.
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

  const lm = landmarkFor(raw);
  const h = clamp(finite(lm ? lm.h : height, 10), 2, 800);
  const s = Number.isFinite(seed) ? seed : footprintSeed(footprint);
  const det = lm ? 2 : tier === 0 || tier === 1 || tier === 2 ? tier : tierForRing(raw, h);
  const y0 = baseY - Math.max(0, skirt);
  const grid = FACADE_GRID[style] || DEFAULT_GRID;

  const wall = new Builder({ pins: true, indexed });
  const trim = new Builder({ pins: true, indexed });

  const finish = (roofRing, roofY) => {
    const wallGeom = wall.geometry();
    const trimGeom = trim.geometry();
    if (wallGeom) applyArchitectureUVs(wallGeom, wall, floorH, windowW, baseY, grid);
    if (trimGeom) applyArchitectureUVs(trimGeom, trim, floorH, windowW, baseY, grid);
    return {
      wall: wallGeom,
      trim: trimGeom,
      tier: det,
      triangles: wall.triangles + trim.triangles,
      roofRing,
      roofY,
    };
  };

  if (det === 0) {
    const ring = simplifyRing(raw, SIMPLIFY_TOL, MAX_RING_VERTS[0]);
    band(wall, ring, y0, ring, baseY + h, null, PIN_NONE);
    capUp(wall, ring, baseY + h, null, PIN_DARK);
    capDown(wall, ring, y0, null, PIN_DARK);
    return finish(null, baseY + h);
  }

  const tiers = lm
    ? landmarkTiers(lm, simplifyRing(raw, SIMPLIFY_TOL, MAX_RING_VERTS[2]), h)
    : massingProfile(footprint, h, s, { style, maxVerts: MAX_RING_VERTS[det] });
  if (!tiers.length) return empty;

  const baseRing = tiers[0].ring;
  const prog = buildingProgram(baseRing, h, s, style);
  // a landmark's silhouette is the crown's business, never a hashed hip roof
  if (lm) prog.roof = { form: 'flat', rise: 0 };
  const p = trimProportions(s, style, h, prog.typ);
  const budget = lm ? 2600 : det === 2 ? 1900 : 420;
  let deck = null;
  let pitch = null;

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const ring = t.ring;
    const ty0 = i === 0 ? y0 : baseY + t.y0;
    const shaft = insetRing(ring, p.reveal) || ring;
    const pitched = t.top && prog.roof.form === 'hip';
    const ty1 = baseY + t.y1 - (pitched ? prog.roof.rise : 0);
    if (ty1 - ty0 < 1.2) {
      band(wall, ring, ty0, ring, baseY + t.y1, null, PIN_NONE);
      capUp(wall, ring, baseY + t.y1, null, PIN_DARK);
      deck = { ring, y: baseY + t.y1 };
      continue;
    }

    // the base course belongs to the ground tier only
    const wantBase =
      i === 0 && shaft !== ring && ty1 - ty0 > p.baseH + p.sillH + p.corniceH + 2.2;
    const sy0 = wantBase ? emitBase(wall, trim, ring, shaft, ty0, p) : ty0;
    const shaftRing = wantBase ? shaft : ring;

    if (pitched) {
      const friezeY = Math.max(sy0 + 0.3, ty1 - p.corniceH);
      emitShaft(wall, trim, shaftRing, sy0, friezeY, p, 0);
      band(trim, shaftRing, friezeY, ring, ty1, null, PIN_STONE);
      deck = emitPitchedRoof(wall, ring, ty1, prog.roof.rise, prog.ang);
      if (deck) pitch = { ring, eaveY: ty1 };
      else {
        // the ridge collapsed; fall back to a parapet so the shell stays closed
        deck = emitCrown(wall, trim, ring, ring, ty1, baseY + t.y1, p, 'deck', p.corniceH);
      }
      continue;
    }

    const mode = t.top ? 'deck' : 'cap';
    const crownH = mode === 'cap' ? p.corniceH : p.parapetH + p.corniceH;
    const shaftTop = Math.max(sy0 + 0.4, ty1 - crownH);
    const ch = clamp(p.corniceH, 0.3, (ty1 - shaftTop) * 0.7);
    emitShaft(wall, trim, shaftRing, sy0, shaftTop, p, courseCount(prog.typ, det, shaftTop - sy0));

    const room = Math.floor((budget - wall.triangles - trim.triangles) / 6);
    const piers = Math.min(pierCount(prog.typ, det, ringPerimeter(shaftRing)), room);
    if (piers > 1 && shaftRing !== ring && shaftTop - sy0 > 6) {
      // die into the cornice flare rather than stopping short: the flare closes
      // over the pier, so its top never needs capping and never reaches the
      // parapet plane, where it would fight for depth with the parapet face
      emitPiers(trim, shaftRing, ring, sy0, shaftTop + ch * 0.5, p, piers);
    }

    const crown = emitCrown(wall, trim, ring, shaftRing, shaftTop, ty1, p, mode, ch);
    if (t.top) deck = crown;
  }

  // closed underside: shadow maps render back faces, and on a slope the
  // downhill side of a footprint sits above the terrain
  capDown(wall, baseRing, y0, null, PIN_DARK);

  if (lm && deck && CROWNS[lm.crown]) {
    const last = tiers[tiers.length - 1];
    try {
      CROWNS[lm.crown]({
        wall,
        trim,
        ring: last.ring,
        deck: deck.ring,
        y: deck.y,
        capY: baseY + last.y1,
        baseY,
        h,
        ang: prog.ang,
        s,
      });
    } catch {
      /* a crown that cannot be built leaves the plain shell standing */
    }
    return finish(null, deck.y);
  }

  if (pitch) {
    // brick stack, sized to clear the ridge wherever on the pitch it lands
    if (h01(s, 9) < 0.72) {
      const sx = 0.9 + h01(s, 10) * 0.4;
      const pt = makePlacer(pitch.ring, s, prog.ang)(sx, 0.75, 8);
      if (pt) {
        extrudeConvex(
          trim,
          rectRing(pt[0], pt[1], sx, 0.75, Math.cos(prog.ang), Math.sin(prog.ang)),
          pitch.eaveY,
          deck.y + 0.7 + h01(s, 13) * 1.2,
          null,
          PIN_STONE,
        );
      }
    }
  } else if (deck && wall.triangles + trim.triangles < budget) {
    const rp = roofStructures(deck.ring, h, prog.typ, s, det);
    for (const b of rp.boxes) {
      if (wall.triangles + trim.triangles >= budget) break;
      extrudeConvex(
        trim,
        rectRing(b.x, b.z, b.sx, b.sz, rp.ca, rp.sa),
        deck.y,
        deck.y + b.sy,
        null,
        PIN_STONE,
      );
    }
  }

  return finish(pitch ? null : deck && deck.ring, deck ? deck.y : baseY + h);
}

/* ------------------------------------------------------------------ */
/* roofscape                                                           */
/* ------------------------------------------------------------------ */

const ROOF_COLORS = {
  duct: [0.46, 0.47, 0.5],
  metal: [0.52, 0.53, 0.55],
  rail: [0.24, 0.25, 0.27],
  tank: [0.32, 0.26, 0.2],
};

function tinted(base, k) {
  return [clamp(base[0] * k, 0, 1), clamp(base[1] * k, 0, 1), clamp(base[2] * k, 0, 1)];
}

/**
 * Mechanical plant for one roof: chillers with fan cowls, ducts, a guardrail,
 * vents, the odd water tower or mast. The masonry housings those stand between
 * come from the shell instead, and this reuses their footprint reservations so
 * nothing overlaps. Everything is placed strictly inside an inset of the deck.
 *
 * @param {object} opts
 * @param {Array<[number, number]>} opts.footprint ring of [x, z]
 * @param {number} opts.height building height in metres
 * @param {number} [opts.baseY=0] world Y of the building base
 * @param {number} [opts.seed] deterministic seed in [0,1); defaults to centroid hash
 * @param {0|1|2} [opts.tier] LOD gate; tier 0 returns null
 * @param {string} [opts.style] facade family, only used to reproduce the massing
 * @param {Array<[number,number]>} [opts.roofRing] deck ring from
 *   `buildArticulatedBuilding()`; null means a pitched roof and no plant
 * @param {number} [opts.roofY] world Y of the roof deck; defaults to baseY + height
 * @param {number} [opts.maxTriangles] hard cap (tier 1: 110, tier 2: 480)
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

  const raw = ringFromFootprint(footprint);
  if (!raw) return null;
  // a landmark's roof is its crown; generic plant would sit inside the spire
  if (landmarkFor(raw)) return null;
  const h = clamp(finite(height, 10), 2, 800);
  const s = Number.isFinite(seed) ? seed : footprintSeed(footprint);
  const det = tier === 0 || tier === 1 || tier === 2 ? tier : tierForRing(raw, h);
  if (det === 0) return null;

  let ring = roofRing;
  let deckY = roofY;
  const tiers = massingProfile(footprint, h, s, { style, maxVerts: MAX_RING_VERTS[det] });
  if (!tiers.length) return null;
  const prog = buildingProgram(tiers[0].ring, h, s, style);
  if (prog.roof.form === 'hip') return null;
  if (!ring) {
    const top = tiers[tiers.length - 1];
    ring = insetRing(top.ring, 0.5) || top.ring;
    if (deckY === null) deckY = baseY + top.y1;
  }
  if (!ring || ring.length < 3) return null;
  if (deckY === null || !Number.isFinite(deckY)) deckY = baseY + h;

  const rp = roofStructures(ring, h, prog.typ, s, det);
  const inner = rp.inner;
  const area = rp.area;
  if (!(area > 20)) return null;
  // a small low roof is never seen from above; the housings in the shell are
  // silhouette enough
  if (det === 1 && (area < 130 || h < 10)) return null;

  const w = Math.sqrt(area);
  const ca = rp.ca;
  const sa = rp.sa;
  const ang = rp.ang;
  const rich = det === 2;
  const budget = maxTriangles ?? (rich ? 480 : 110);
  const b = new Builder({ colors: true, indexed });
  const place = makePlacer(inner, s, ang, rp.taken);

  const boxAt = (x, z, sx, sz, sy, color) => {
    extrudeConvex(b, rectRing(x, z, sx, sz, ca, sa), deckY, deckY + sy, color, PIN_NONE);
  };

  // 1. cooling units, half of them with a fan cowl
  const chillers = clamp(Math.floor(area / 190), 1, rich ? 7 : 2);
  for (let i = 0; i < chillers && b.triangles < budget; i++) {
    const r = h01(s, 50 + i);
    const sx = 2 + r * 1.8;
    const sz = 1.6 + h01(s, 60 + i) * 1.5;
    const sy = 1.2 + r * 0.9;
    const pt = place(sx, sz);
    if (!pt) continue;
    boxAt(pt[0], pt[1], sx, sz, sy, tinted(ROOF_COLORS.duct, 0.9 + r * 0.2));
    if (r > 0.5) {
      const cowl = regularRing(pt[0], pt[1], Math.min(sx, sz) * 0.36, 6, ang);
      extrudeConvex(b, cowl, deckY + sy, deckY + sy + 0.4 + r * 0.3, ROOF_COLORS.metal, PIN_NONE);
    }
  }

  // 2. duct runs between the housings
  if (rich && area > 320 && b.triangles < budget) {
    const r = h01(s, 45);
    const len = clamp(w * (0.3 + r * 0.25), 4, 26);
    const pt = place(len, 0.9 + r * 0.5, 10);
    if (pt) boxAt(pt[0], pt[1], len, 0.9 + r * 0.5, 0.8 + r * 0.4, ROOF_COLORS.metal);
  }

  // 3. guardrail set back from the parapet
  if (rich && area > 260 && b.triangles + inner.length * 4 < budget) {
    const railRing = insetRing(inner, 0.9);
    if (railRing) {
      const ry0 = deckY + 0.75;
      const ry1 = deckY + 1.15;
      band(b, railRing, ry0, railRing, ry1, ROOF_COLORS.rail, PIN_NONE);
      band(b, railRing, ry1, railRing, ry0, ROOF_COLORS.rail, PIN_NONE);
    }
  }

  // 4. mast / antenna on the tall ones
  if (h > 85 || (h > 55 && h01(s, 70) < 0.3)) {
    const pt = place(3.4, 1.9);
    if (pt) {
      const mh = clamp(h * 0.1, 6, 26);
      const foot = rectRing(pt[0], pt[1], 1.1, 1.1, ca, sa);
      const tip = scaleRing(foot, pt[0], pt[1], 0.3);
      band(b, foot, deckY, tip, deckY + mh, ROOF_COLORS.metal, PIN_NONE);
      capUpConvex(b, tip, deckY + mh, ROOF_COLORS.metal, PIN_NONE);
      const bar = rectRing(pt[0], pt[1], 3.4, 0.28, ca, sa);
      extrudeConvex(b, bar, deckY + mh * 0.62, deckY + mh * 0.62 + 0.24, ROOF_COLORS.metal, PIN_NONE);
    }
  }

  // 5. vents
  const vents = rich ? clamp(Math.floor(area / 140), 1, 9) : clamp(Math.floor(area / 320), 0, 3);
  for (let i = 0; i < vents && b.triangles < budget; i++) {
    const r = h01(s, 80 + i);
    const sx = 0.5 + r * 0.6;
    const pt = place(sx, sx, 8);
    if (!pt) continue;
    boxAt(pt[0], pt[1], sx, sx, 0.6 + r * 0.9, tinted(ROOF_COLORS.metal, 0.85 + r * 0.3));
  }

  // 6. the occasional water tower
  if (rich && area > 220 && h01(s, 90) < 0.16) {
    const r = h01(s, 91);
    const rad = clamp(w * 0.11, 1.6, 3.4);
    const pt = place(rad * 2.2, rad * 2.2);
    if (pt) {
      const legH = 2.6 + r * 1.8;
      for (let i = 0; i < 4; i++) {
        const a = ang + Math.PI * 0.25 + (i / 4) * Math.PI * 2;
        const lx = pt[0] + Math.cos(a) * rad * 0.72;
        const lz = pt[1] + Math.sin(a) * rad * 0.72;
        const leg = rectRing(lx, lz, 0.26, 0.26, ca, sa);
        band(b, leg, deckY, leg, deckY + legH, ROOF_COLORS.rail, PIN_NONE);
      }
      const tank = regularRing(pt[0], pt[1], rad, 8, ang);
      const tankTop = deckY + legH + 3 + r * 1.4;
      band(b, tank, deckY + legH, tank, tankTop, ROOF_COLORS.tank, PIN_NONE);
      coneUp(b, tank, tankTop, pt[0], tankTop + rad * 0.55, pt[1], ROOF_COLORS.tank, PIN_NONE);
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
