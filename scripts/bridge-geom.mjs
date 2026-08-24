/**
 * Shared bridge geometry, so the solver and the audit cannot disagree about what
 * a bridge is.
 *
 * Both had to learn the same three lessons the hard way:
 *
 *   - a named crossing owns its interchange ramps, and fitting an axis through
 *     all of them lands it degrees off the real deck
 *   - a crossing is often mapped a second time as a `man_made=bridge` *area*,
 *     whose outline runs hundreds of metres along the bank and is not an
 *     alignment at all
 *   - OSM carries a bridge's approach viaducts under the bridge's own name, so
 *     way length is not span length
 */
import { overpass, project } from './osm.mjs';

/** The extent the dataset is authored for; see scripts/rebuild-water.mjs. */
export const SCENE = { minX: -4600, maxX: 8600, minZ: -4000, maxZ: 4600 };

export const inScene = (x, z) =>
  x > SCENE.minX && x < SCENE.maxX && z > SCENE.minZ && z < SCENE.maxZ;

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function makeWetTest(water) {
  return (x, z) => {
    for (const w of water) {
      if (!pointInRing(x, z, w.f)) continue;
      let hole = false;
      for (const h of w.holes || []) {
        if (pointInRing(x, z, h)) {
          hole = true;
          break;
        }
      }
      if (!hole) return true;
    }
    return false;
  };
}

/** Every name a bridge way may answer to; `bridge:name` can be semicolon-joined. */
export function tagNames(tags = {}) {
  return [tags.name, tags['bridge:name'], tags.alt_name, tags.old_name]
    .filter(Boolean)
    .flatMap((v) => String(v).split(';'))
    .map((v) => v.trim());
}

export async function fetchBridgeWays(bbox = '40.390,-80.090,40.480,-79.880', opts = {}) {
  return overpass(
    'bridges-carriageways',
    `[out:json][timeout:240];(
     way["bridge"]["name"](${bbox});
     way["bridge"]["bridge:name"](${bbox});
     way["bridge"]["railway"](${bbox});
   );out geom tags;`,
    opts,
  );
}

/**
 * Projected polylines for the ways matching `match`, restricted to alignments
 * that actually carry traffic. A `man_made=bridge` outline carries none.
 */
export function alignmentsFor(elements, match) {
  const lines = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    if (!el.tags?.highway && !el.tags?.railway) continue;
    if (!tagNames(el.tags).some((n) => match.test(n))) continue;
    lines.push(el.geometry.map((g) => project(g.lat, g.lon)));
  }
  return lines;
}

export function segmentsOf(lines) {
  const segs = [];
  for (const pts of lines) {
    for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
  }
  return segs;
}

/** Segment bearing folded to [0, 180): a deck and its opposite carriageway agree. */
export function bearing180(a, b) {
  const d = (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI;
  return ((d % 180) + 180) % 180;
}

export function bearing360(a, b) {
  return (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI;
}

export function angleGap(p, q) {
  const d = Math.abs(p - q) % 180;
  return Math.min(d, 180 - d);
}

/** Bearings within this many degrees (mod 180) belong to the same alignment. */
export const BEARING_TOL = 16;

/**
 * The bearing group carrying the most total length. The main deck of a crossing
 * is always the longest thing pointing one way; the ramps point elsewhere by
 * definition, or they would not be ramps.
 */
export function dominantBearingCluster(segments) {
  const groups = [];
  for (const seg of segments) {
    const [a, b] = seg;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1) continue;
    const ang = bearing180(a, b);
    let g = groups.find((h) => angleGap(h.ang, ang) <= BEARING_TOL);
    if (!g) {
      g = { ang, len: 0, segs: [] };
      groups.push(g);
    }
    // Length-weighted, so a long deck outvotes a short ramp stub.
    g.ang = (g.ang * g.len + ang * len) / (g.len + len);
    g.len += len;
    g.segs.push(seg);
  }
  groups.sort((a, b) => b.len - a.len);
  return groups[0] || null;
}

/** Principal axis of a point set, through its mean. */
export function principalAxis(pts) {
  let cx = 0;
  let cz = 0;
  for (const [x, z] of pts) {
    cx += x;
    cz += z;
  }
  cx /= pts.length;
  cz /= pts.length;
  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (const [x, z] of pts) {
    xx += (x - cx) ** 2;
    zz += (z - cz) ** 2;
    xz += (x - cx) * (z - cz);
  }
  const a = 0.5 * Math.atan2(2 * xz, xx - zz);
  return { mid: [cx, cz], dir: [Math.cos(a), Math.sin(a)] };
}

/**
 * Where an axis enters and leaves the water, plus `abutment` metres of bank at
 * each end. Sampling the axis against the bank polygons gives the same answer
 * however OSM happens to have split the ways.
 *
 * The run chosen is the one the alignment itself sits on — the one spanning
 * t = 0 — and not the widest run within reach. At the Point those are different
 * rivers: extended far enough south, the Fort Duquesne Bridge's axis crosses the
 * Allegheny at 250 m and then the Monongahela at 339 m, and picking the wider
 * run moved its deck 771 m down to Station Square.
 *
 * Runs separated by less than `bridgePier` of dry ground are joined, so a pier,
 * a wharf or a mid-channel island cannot cut one crossing into two.
 */
export function waterCrossing(
  origin,
  dir,
  wet,
  { reach = 900, step = 3, abutment = 26, bridgePier = 30 } = {},
) {
  const runs = [];
  let lo = null;
  for (let t = -reach; t <= reach + step; t += step) {
    const isWet = t <= reach && wet(origin[0] + dir[0] * t, origin[1] + dir[1] * t);
    if (isWet) {
      if (lo === null) lo = t;
    } else if (lo !== null) {
      runs.push([lo, t - step]);
      lo = null;
    }
  }
  if (!runs.length) return null;

  const merged = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const last = merged[merged.length - 1];
    if (runs[i][0] - last[1] <= bridgePier) last[1] = runs[i][1];
    else merged.push(runs[i]);
  }

  let pick = merged.find(([a, b]) => a <= 0 && b >= 0);
  if (!pick) {
    pick = merged.reduce((best, r) => {
      const d = Math.min(Math.abs(r[0]), Math.abs(r[1]));
      const bd = Math.min(Math.abs(best[0]), Math.abs(best[1]));
      return d < bd ? r : best;
    });
  }
  return { lo: pick[0] - abutment, hi: pick[1] + abutment, wetLen: pick[1] - pick[0] };
}

/**
 * Solve a deck from the OSM alignments and the water polygons: the dominant
 * bearing cluster of the over-water segments, cut to the channel.
 */
export function solveDeck(lines, wet, opts = {}) {
  const segments = segmentsOf(lines);
  if (!segments.length) return { error: 'no OSM carriageway by this name' };
  const overWater = segments.filter(([a, b]) => wet((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
  if (!overWater.length) return { error: 'no segment over water', segments: segments.length };
  const cluster = dominantBearingCluster(overWater);
  if (!cluster) return { error: 'no usable alignment' };
  const pts = [];
  for (const [a, b] of cluster.segs) pts.push(a, b);
  const { mid, dir } = principalAxis(pts);
  const cross = waterCrossing(mid, dir, wet, opts);
  if (!cross) return { error: 'axis never crosses water' };
  return {
    a: [mid[0] + dir[0] * cross.lo, mid[1] + dir[1] * cross.lo],
    b: [mid[0] + dir[0] * cross.hi, mid[1] + dir[1] * cross.hi],
    channel: cross.wetLen,
    segments: segments.length,
    overWater: overWater.length,
    cluster: cluster.segs.length,
  };
}
