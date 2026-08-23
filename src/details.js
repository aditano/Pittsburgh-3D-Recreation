/**
 * Procedural architectural detail for the extruded OSM building prisms.
 *
 * `buildingDetails()` takes one footprint and returns a list of extra
 * BufferGeometries in world space (parapets, cornices, hipped roofs, rooftop
 * mechanicals, stepped crowns, spires). Every geometry it returns is:
 *
 * - non-indexed with exactly {position, normal, uv, color}, so it merges into
 *   the same family bucket as the building it belongs to (`mergeGeometries`
 *   requires a matching attribute set and index-ness). No extra draw calls,
 *   no extra materials.
 * - UV-mapped either onto the family facade (crowns keep real window rows,
 *   aligned to the building's own floor grid) or onto one of the solid atlas
 *   texels: TRIM_UV for windowless cladding (parapets/cornices/mechanicals)
 *   and ROOF_UV for dark roof surfaces (hipped roofs, masts).
 * - vertex-tinted with the parent building's tint so detail never reads as a
 *   different color than the mass it sits on.
 *
 * Everything is driven by a PRNG seeded from the footprint centroid, so a given
 * building looks identical on every reload, and detail is gated by height and
 * footprint size to keep the added triangle budget small (see README of the
 * gates inline below).
 */
import * as THREE from 'three';
import { pointInPoly } from './geo.js';
import {
  ROOF_UV,
  TRIM_UV,
  applyFacadeUVs,
  applyUniformUVs,
  tintGeometry,
} from './textures.js';

/** Footprints with more vertices than this are left plain (cost guard). */
const MAX_RING = 48;

/**
 * Cap on how far a mitered corner may travel, in multiples of the offset
 * distance. Bounds how far an outward cornice can stick out at an acute corner.
 */
const MITER_LIMIT = 1.6;

/** Largest outward cornice offset, in meters (see CORNICE_OVERHANG use). */
const CORNICE_OVERHANG = 0.55;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Deterministic per-building PRNG (mulberry32) seeded from the centroid. */
function seededRand(x, z) {
  let a =
    (Math.imul(Math.round(x * 8) | 0, 0x27d4eb2d) ^
      Math.imul(Math.round(z * 8) | 0, 0x165667b1)) >>>
    0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Footprint -> open ring (closing vertex and duplicates removed). */
function openRing(footprint) {
  const ring = [];
  for (const p of footprint) {
    const last = ring[ring.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-4 && Math.abs(last[1] - p[1]) < 1e-4) continue;
    ring.push([p[0], p[1]]);
  }
  while (ring.length > 2) {
    const f = ring[0];
    const l = ring[ring.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-4 && Math.abs(f[1] - l[1]) < 1e-4) ring.pop();
    else break;
  }
  return ring;
}

/** Signed area in the XZ plane; positive == counter-clockwise. */
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

function toCcw(ring) {
  return ringArea(ring) < 0 ? ring.slice().reverse() : ring;
}

function ringBounds(ring) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    w: maxX - minX,
    d: maxZ - minZ,
    minDim: Math.min(maxX - minX, maxZ - minZ),
  };
}

/** Do two segments cross? Conservative: touching counts as crossing. */
function segmentsCross(p1, p2, p3, p4) {
  const d = (ax, az, bx, bz, cx2, cz2) => (bx - ax) * (cz2 - az) - (bz - az) * (cx2 - ax);
  const o1 = d(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  const o2 = d(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
  const o3 = d(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
  const o4 = d(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
  return o1 * o2 <= 0 && o3 * o4 <= 0;
}

/**
 * Is the ring a simple polygon (no non-adjacent edge crossings)? O(n^2), but
 * footprints top out at MAX_RING vertices so this stays cheap — and it is the
 * check that catches an inward offset folding a narrow wing back through the
 * opposite wall, which would otherwise produce inside-out walls.
 */
function isSimpleRing(ring) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent (shares a vertex)
      if (segmentsCross(a1, a2, ring[j], ring[(j + 1) % n])) return false;
    }
  }
  return true;
}

/**
 * Miter-offset a CCW ring by `dist` meters (positive = inward, negative =
 * outward). Returns null on razor-thin corners where the miter would explode.
 * Miter length is capped (as stroke rendering does) so an acute corner cannot
 * shoot a long spike out past the footprint.
 */
function offsetRing(ring, dist) {
  const n = ring.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    let d1x = cur[0] - prev[0];
    let d1z = cur[1] - prev[1];
    const l1 = Math.hypot(d1x, d1z);
    let d2x = next[0] - cur[0];
    let d2z = next[1] - cur[1];
    const l2 = Math.hypot(d2x, d2z);
    if (l1 < 1e-4 || l2 < 1e-4) return null;
    d1x /= l1;
    d1z /= l1;
    d2x /= l2;
    d2z /= l2;
    // Inward normal of a CCW edge (dx,dz) is (-dz, dx).
    const n1x = -d1z;
    const n1z = d1x;
    let bx = n1x + -d2z;
    let bz = n1z + d2x;
    const bl = Math.hypot(bx, bz);
    if (bl < 1e-3) return null;
    bx /= bl;
    bz /= bl;
    const cosHalf = bx * n1x + bz * n1z;
    if (cosHalf < 0.26) return null; // spike: miter length would blow up
    const miter = Math.sign(dist) * Math.min(Math.abs(dist) / cosHalf, Math.abs(dist) * MITER_LIMIT);
    out.push([cur[0] + bx * miter, cur[1] + bz * miter]);
  }
  return out;
}

/**
 * Reject offsets that self-intersect or collapse. Cheap heuristics only:
 * area sign/magnitude, per-edge direction and length, and (inward only) each
 * offset vertex must still lie inside the source polygon.
 */
function offsetIsSane(ring, off, inward) {
  if (!off) return false;
  const a0 = ringArea(ring);
  const a1 = ringArea(off);
  if (!Number.isFinite(a1)) return false;
  if (inward) {
    if (a1 <= a0 * 0.1 || a1 >= a0 * 0.99) return false;
  } else if (a1 <= a0 * 1.001) return false;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const ox = off[j][0] - off[i][0];
    const oz = off[j][1] - off[i][1];
    if (Math.hypot(ox, oz) < 0.3) return false;
    if (ox * (ring[j][0] - ring[i][0]) + oz * (ring[j][1] - ring[i][1]) <= 0) return false;
  }
  if (inward) {
    for (const p of off) {
      if (!pointInPoly(p[0], p[1], ring)) return false;
    }
  }
  return isSimpleRing(off);
}

/**
 * Offset inward, backing off to smaller distances when the full offset folds
 * the polygon (narrow wings, deep notches). Returns null if none survive, in
 * which case the caller simply skips that piece of detail.
 */
function shrinkRing(ring, dist) {
  for (const scale of [1, 0.6, 0.35]) {
    const off = offsetRing(ring, dist * scale);
    if (offsetIsSane(ring, off, true)) return off;
  }
  return null;
}

/* ---------------------------------------------------------------- geometry --
 * Triangle winding below assumes CCW-in-XZ rings, which makes wall quads face
 * outward and cap quads face +Y (verified by scripts/verify-details.mjs).
 */

function tri(arr, a, b, c) {
  arr.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

/** Quad spanning bottom edge a0->b0 and top edge a1->b1; faces outward. */
function quad(arr, a0, b0, b1, a1) {
  tri(arr, a0, b1, b0);
  tri(arr, a0, a1, b1);
}

/** Horizontal ring quad between an outer edge and an inner edge; faces +Y. */
function capQuad(arr, ao, bo, ai, bi) {
  tri(arr, ao, bi, bo);
  tri(arr, ao, ai, bi);
}

function geomFromTris(pos) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geom;
}

/** THREE.Shape in the extruder's flipped 2D space (world XZ -> (x, -z)). */
function ringShape(ring) {
  const shape = new THREE.Shape();
  shape.moveTo(ring[0][0], -ring[0][1]);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i][0], -ring[i][1]);
  shape.closePath();
  return shape;
}

/** Solid vertical prism over `ring` between world heights y0 and y1. */
function prism(ring, y0, y1) {
  const geom = new THREE.ExtrudeGeometry(ringShape(ring), {
    depth: y1 - y0,
    bevelEnabled: false,
  });
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, y0, 0);
  return geom;
}

/** Flat, upward-facing polygon cap over `ring` at height y. */
function cap(ring, y) {
  const indexed = new THREE.ShapeGeometry(ringShape(ring));
  indexed.rotateX(-Math.PI / 2);
  indexed.translate(0, y, 0);
  const geom = indexed.toNonIndexed();
  indexed.dispose();
  return geom;
}

/** Raised rim around a roof edge: outer face, inner face and top ledge. */
function parapetRing(outer, inner, y0, y1) {
  const pos = [];
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    const ao = outer[i];
    const bo = outer[j];
    const ai = inner[i];
    const bi = inner[j];
    const ao0 = [ao[0], y0, ao[1]];
    const bo0 = [bo[0], y0, bo[1]];
    const ao1 = [ao[0], y1, ao[1]];
    const bo1 = [bo[0], y1, bo[1]];
    const ai0 = [ai[0], y0, ai[1]];
    const bi0 = [bi[0], y0, bi[1]];
    const ai1 = [ai[0], y1, ai[1]];
    const bi1 = [bi[0], y1, bi[1]];
    quad(pos, ao0, bo0, bo1, ao1); // outer face, flush with the facade
    quad(pos, bi0, ai0, ai1, bi1); // inner face (reversed edge -> faces in)
    capQuad(pos, ao1, bo1, ai1, bi1); // top ledge
  }
  return geomFromTris(pos);
}

/** Hipped/pitched roof: sloped skirt from the eaves up to an inset ridge ring. */
function hipRoof(eaves, ridge, y0, y1) {
  const pos = [];
  for (let i = 0; i < eaves.length; i++) {
    const j = (i + 1) % eaves.length;
    quad(
      pos,
      [eaves[i][0], y0, eaves[i][1]],
      [eaves[j][0], y0, eaves[j][1]],
      [ridge[j][0], y1, ridge[j][1]],
      [ridge[i][0], y1, ridge[i][1]],
    );
  }
  return geomFromTris(pos);
}

function box(cx, cz, w, d, y0, h) {
  const geom = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  geom.translate(cx, y0 + h * 0.5, cz);
  return geom;
}

function cylinder(cx, cz, rTop, rBottom, h, sides, y0) {
  const geom = new THREE.CylinderGeometry(rTop, rBottom, h, sides, 1, false).toNonIndexed();
  geom.translate(cx, y0 + h * 0.5, cz);
  return geom;
}

/* ------------------------------------------------------------- generator -- */

/**
 * @param {object} o
 * @param {Array<[number,number]>} o.footprint OSM ring in local meters (x, z)
 * @param {number} o.height  extruded building height in meters
 * @param {number} o.base    terrain height the building stands on
 * @param {number} o.cx      footprint centroid x (PRNG seed)
 * @param {number} o.cz      footprint centroid z (PRNG seed)
 * @param {string} o.family  material family name
 * @param {object} o.spec    materials.families[family] (floorH / windowW)
 * @param {THREE.Color} o.tint per-building vertex tint
 * @param {boolean} o.landmark
 * @returns {THREE.BufferGeometry[]} detail geometry for the family bucket
 */
export function buildingDetails({
  footprint,
  height,
  base,
  cx,
  cz,
  family,
  spec,
  tint,
  landmark = false,
}) {
  const geoms = [];
  if (!Number.isFinite(height) || !Number.isFinite(base)) return geoms;

  const ring = toCcw(openRing(footprint));
  if (ring.length < 3 || ring.length > MAX_RING) return geoms;
  if (!isSimpleRing(ring)) return geoms; // self-overlapping OSM footprint

  const bb = ringBounds(ring);
  if (!(bb.minDim > 3)) return geoms;

  const roofY = base + height;
  const rand = seededRand(cx, cz);
  // Detail may never grow a building by more than this, so crowns and masts
  // stay a silhouette accent instead of restating the tower's height. Small
  // buildings get a floor of 6 m because a real pitched roof on a house is a
  // large fraction of its wall height.
  const topLimit = roofY + Math.min(Math.max(6, height * 0.22), 46);

  // Push helpers: each finishes a geometry so it can merge straight into the
  // family bucket (UVs + normals + vertex tint, matching attribute set).
  const facade = (geom) => {
    applyFacadeUVs(geom, spec.floorH, spec.windowW, base);
    tintGeometry(geom, tint);
    geoms.push(geom);
  };
  const trim = (geom) => {
    applyUniformUVs(geom, TRIM_UV);
    tintGeometry(geom, tint);
    geoms.push(geom);
  };
  const roof = (geom) => {
    applyUniformUVs(geom, ROOF_UV);
    tintGeometry(geom, tint);
    geoms.push(geom);
  };

  const masonry =
    family === 'lowrise' || family === 'brick' || family === 'limestone' || family === 'gothic';

  // 1. Small houses/shops get a real pitched (hipped) roof instead of a slab.
  let pitched = false;
  if (height <= 17 && bb.minDim <= 28 && (family === 'lowrise' || family === 'brick')) {
    if (rand() < 0.62) {
      const ridge = shrinkRing(ring, clamp(bb.minDim * (0.24 + rand() * 0.1), 0.9, 5));
      if (ridge) {
        const rise = Math.min(
          clamp(1.3 + bb.minDim * 0.085 + rand() * 1.1, 1.3, 5),
          topLimit - roofY,
        );
        roof(hipRoof(ring, ridge, roofY, roofY + rise));
        roof(cap(ridge, roofY + rise));
        pitched = true;
      }
    }
  }

  // 2. Cornice: a thin outset ledge just under the roofline of masonry
  //    mid-rises, which catches the sun and reads as a shadow line.
  if (!pitched && masonry && height >= 16 && bb.minDim >= 9 && rand() < 0.85) {
    const outward = offsetRing(ring, -clamp(bb.minDim * 0.02, 0.22, CORNICE_OVERHANG));
    if (offsetIsSane(ring, outward, false)) {
      const ch = clamp(0.8 + height * 0.01, 0.8, 1.9);
      trim(prism(outward, roofY - 0.3 - ch, roofY - 0.3));
    }
  }

  // 3. Stepped crown / setbacks: tall towers taper toward the top instead of
  //    ending in a flat slab. Each step is a scaled-down copy of the footprint
  //    offset inward, extruded higher, keeping real window rows on its walls.
  let deckRing = ring;
  let deckBB = bb;
  let deckY = roofY;
  const parapetH = clamp(0.75 + height * 0.012, 0.75, 2.8);

  const addParapet = (r, rBB, y) => {
    if (rBB.minDim < 6.5) return false;
    const rise = Math.min(parapetH, topLimit - y);
    if (rise < 0.3) return false;
    const inner = shrinkRing(r, clamp(rBB.minDim * 0.05, 0.4, 1.1));
    if (!inner) return false;
    trim(parapetRing(r, inner, y, y + rise));
    return true;
  };

  if (!pitched) {
    const steps = height >= 115 ? 2 : height >= 70 ? 1 : 0;
    // Keep roughly half of the height allowance for the mast/penthouse above.
    const crownCeiling = roofY + (topLimit - roofY) * 0.55;
    for (let s = 0; s < steps; s++) {
      if (deckBB.minDim < 14) break;
      const next = shrinkRing(deckRing, clamp(deckBB.minDim * (0.1 + rand() * 0.06), 1.6, 8));
      if (!next) break;
      const rise = Math.min(clamp(height * (0.03 + rand() * 0.025), 3.5, 11), crownCeiling - deckY);
      if (rise < 2.5) break;
      // Terrace rim on the level we are leaving, then the setback volume.
      addParapet(deckRing, deckBB, deckY);
      facade(prism(next, deckY - 0.5, deckY + rise));
      deckRing = next;
      deckBB = ringBounds(next);
      deckY += rise;
    }
    addParapet(deckRing, deckBB, deckY);
  }

  // 4. Rooftop mechanicals on the topmost deck: HVAC boxes, an elevator /
  //    stair penthouse, the occasional water tank. Placement is rejection
  //    sampled inside the deck polygon (inset by the parapet) so nothing
  //    overhangs the roof edge.
  if (!pitched && deckBB.minDim >= 12 && height >= 8) {
    const deckArea = deckBB.w * deckBB.d;
    const maxUnits = deckArea > 6000 ? 4 : deckArea > 2400 ? 3 : deckArea > 800 ? 2 : 1;
    const units = 1 + Math.floor(rand() * maxUnits);
    const margin = clamp(deckBB.minDim * 0.05, 0.4, 1.1) + 0.7;
    const fits = (px, pz, w, d) => {
      const hw = w * 0.5 + margin;
      const hd = d * 0.5 + margin;
      return (
        pointInPoly(px - hw, pz - hd, deckRing) &&
        pointInPoly(px + hw, pz - hd, deckRing) &&
        pointInPoly(px + hw, pz + hd, deckRing) &&
        pointInPoly(px - hw, pz + hd, deckRing)
      );
    };

    for (let i = 0; i < units; i++) {
      const penthouse = i === 0 && height >= 26 && rand() < 0.5;
      const tank = !penthouse && deckBB.minDim >= 20 && rand() < 0.22;
      const w = clamp(deckBB.minDim * (0.12 + rand() * 0.2), 2.4, 16);
      const d = clamp(deckBB.minDim * (0.12 + rand() * 0.2), 2.4, 16);
      const size = tank ? clamp(deckBB.minDim * 0.12, 2.4, 6.4) : Math.max(w, d);
      const unitH = Math.min(
        penthouse
          ? clamp(3.2 + height * 0.03 + rand() * 2.4, 3.2, 9)
          : tank
            ? 2.8 + rand() * 3
            : 1.6 + rand() * 2.4,
        Math.max(1, topLimit - deckY),
      );

      for (let attempt = 0; attempt < 5; attempt++) {
        const px =
          deckBB.minX +
          margin +
          size * 0.5 +
          rand() * Math.max(0, deckBB.w - 2 * margin - size);
        const pz =
          deckBB.minZ +
          margin +
          size * 0.5 +
          rand() * Math.max(0, deckBB.d - 2 * margin - size);
        if (tank) {
          if (!fits(px, pz, size, size)) continue;
          roof(cylinder(px, pz, size * 0.5, size * 0.5, unitH, 8, deckY));
        } else if (!fits(px, pz, w, d)) {
          continue;
        } else if (penthouse && unitH >= 5) {
          // Tall enough to read as occupied space, so keep window rows.
          facade(box(px, pz, w, d, deckY, unitH));
        } else {
          trim(box(px, pz, w, d, deckY, unitH));
        }
        break;
      }
    }
  }

  // 5. Spire / antenna mast so the tallest towers and landmarks put points on
  //    the skyline instead of flat slabs.
  if (!pitched && (height >= 115 || (landmark && height >= 60)) && deckBB.minDim >= 6) {
    const mx = (deckBB.minX + deckBB.maxX) * 0.5;
    const mz = (deckBB.minZ + deckBB.maxZ) * 0.5;
    if (pointInPoly(mx, mz, deckRing)) {
      const padW = clamp(deckBB.minDim * 0.22, 2.5, 8);
      const padH = Math.min(1.6 + rand() * 2, Math.max(0.8, topLimit - deckY));
      trim(box(mx, mz, padW, padW, deckY, padH));
      const mastH = Math.min(clamp(height * 0.09, 7, 26), topLimit - (deckY + padH));
      if (mastH >= 4) roof(cylinder(mx, mz, 0.28, 0.95, mastH, 6, deckY + padH));
    }
  }

  return geoms;
}
