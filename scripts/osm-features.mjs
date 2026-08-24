/**
 * Feature-level Overpass helpers shared by the audit and repair scripts.
 *
 * Two things are needed everywhere and are easy to get subtly wrong:
 *
 *   1. Relation footprints. `out geom` on a relation comes back from the public
 *      Overpass instances with `members: []` — no member geometry at all — so a
 *      multipolygon building (the County Courthouse, Union Trust, Highmark) looks
 *      like it does not exist. Only a `foreach` that emits the relation and then
 *      its member ways returns usable geometry.
 *
 *   2. Matching a dataset record to an OSM record. Matching on name alone pairs
 *      our downtown Giant Eagle with one in Brighton Heights 11 km away, which
 *      is how the previous audit produced 12.7 km "offsets". Every match here is
 *      therefore name *and* proximity, nearest candidate wins.
 */
import { largestRing, overpass, ringArea, ringFromGeometry } from './osm.mjs';

/** Scene bbox used by every audit query, so they all share one cache lineage. */
export const AUDIT_BBOX = '40.400,-80.090,40.490,-79.880';

/**
 * Every named building in the bbox as `{ name, ring, area, c, tags, kind }`.
 * Ways and relations are fetched separately because of the `out geom` quirk
 * above; duplicates are left in place so callers can pick by proximity.
 */
export async function fetchNamedBuildings(bbox = AUDIT_BBOX, opts = {}) {
  const ways = await overpass(
    'geo-named-ways',
    `[out:json][timeout:240];way["building"]["name"](${bbox});out geom tags;`,
    opts,
  );
  const rels = await overpass(
    'geo-named-rels',
    `[out:json][timeout:240];rel["building"]["name"](${bbox})->.r;foreach.r->.x(.x out tags;way(r.x);out geom;);`,
    opts,
  );

  const out = [];
  for (const el of ways.elements) {
    const ring = ringFromGeometry(el.geometry);
    if (!ring || !el.tags?.name) continue;
    out.push(feature(el.tags.name, ring, el.tags, 'way', el.id));
  }
  for (const f of groupRelationWays(rels.elements)) {
    const ring = largestRing({ type: 'relation', members: f.ways.map((w) => ({ role: 'outer', geometry: w.geometry })) });
    if (!ring || !f.tags?.name) continue;
    out.push(feature(f.tags.name, ring, f.tags, 'relation', f.id));
  }
  return out;
}

/**
 * Named buildings plus the named non-building features a landmark can be mapped
 * as: a museum boundary, a historic site, a station area.
 *
 * The tag list is deliberately narrow. A blanket `way["name"]` / `rel["name"]`
 * pair pulls every street and every bus-route relation in the city — 60 MB of
 * response for a few dozen extra polygons, in a cache directory that is under
 * version control.
 */
export async function fetchNamedFeatures(bbox = AUDIT_BBOX, opts = {}) {
  const buildings = await fetchNamedBuildings(bbox, opts);
  const extra = await overpass(
    'geo-named-sites',
    `[out:json][timeout:240];(
       way["name"]["tourism"](${bbox});
       way["name"]["historic"](${bbox});
       way["name"]["man_made"](${bbox});
       way["name"]["amenity"~"^(hospital|university|college|theatre|arts_centre|place_of_worship)$"](${bbox});
     );out geom tags;`,
    opts,
  );
  const out = [...buildings];
  for (const el of extra.elements) {
    if (!el.tags?.name) continue;
    const ring = ringFromGeometry(el.geometry);
    if (ring) out.push(feature(el.tags.name, ring, el.tags, 'way', el.id));
  }
  return out;
}

function feature(name, ring, tags, kind, id) {
  return { name, ring, area: Math.abs(ringArea(ring)), c: areaCentroid(ring), tags, kind, id };
}

/** Re-pair the `foreach` output stream: a relation, then the ways that belong to it. */
export function groupRelationWays(elements) {
  const groups = [];
  let current = null;
  for (const el of elements) {
    if (el.type === 'relation') {
      current = { id: el.id, tags: el.tags || {}, ways: [] };
      groups.push(current);
    } else if (el.type === 'way' && el.geometry && current) {
      current.ways.push(el);
    }
  }
  return groups.filter((g) => g.ways.length);
}

/** Loose name key: case, punctuation and the "St/Saint" split all vary in OSM. */
export function nameKey(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\bst\.?\b/g, 'saint')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Index features by loose name for proximity matching.
 * Values are arrays because Pittsburgh has 20 Giant Eagles.
 */
export function indexByName(features) {
  const idx = new Map();
  for (const f of features) {
    const k = nameKey(f.name);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(f);
  }
  return idx;
}

/** Nearest same-named feature to `[x, z]`, or null beyond `maxDist`. */
export function nearestByName(idx, name, x, z, maxDist = 400) {
  const cands = idx.get(nameKey(name));
  if (!cands) return null;
  let best = null;
  let bd = maxDist;
  for (const f of cands) {
    const d = Math.hypot(f.c[0] - x, f.c[1] - z);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best ? { f: best, d: bd } : null;
}

// --------------------------------------------------------------- geometry

/**
 * Area centroid of a closed ring.
 *
 * The vertex mean that `ringCentroid` computes drifts toward whichever end of an
 * elongated footprint carries more nodes, so comparing a dense OSM ring against
 * our simplified one that way reports tens of metres of "offset" for footprints
 * that overlay each other within 3 m. Every placement comparison uses this.
 */
export function areaCentroid(ring) {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[i + 1];
    const cr = x0 * z1 - x1 * z0;
    a += cr;
    cx += (x0 + x1) * cr;
    cz += (z0 + z1) * cr;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length - 1;
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < n; i++) {
      sx += ring[i][0];
      sz += ring[i][1];
    }
    return [sx / n, sz / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

/** Distance from a point to a segment, in the x/z plane. */
export function pointSegDist(p, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

/** Distance from a point to the nearest edge of a ring or polyline. */
export function pointRingDist(p, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const d = pointSegDist(p, ring[i], ring[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Symmetric Hausdorff distance between two rings, measured vertex-to-edge so a
 * dense OSM ring is not penalised against a simplified dataset ring.
 */
export function hausdorff(a, b) {
  let m = 0;
  for (const p of a) m = Math.max(m, pointRingDist(p, b));
  for (const p of b) m = Math.max(m, pointRingDist(p, a));
  return m;
}

export function bbox(ring) {
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
  return { minX, maxX, minZ, maxZ };
}
