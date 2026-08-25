/**
 * Shared Overpass fetch + local-frame projection helpers.
 *
 * The local frame is the one the shipped dataset already lives in (+X east,
 * +Y up, +Z south, origin near the Point). `PROJECTION` was solved by
 * least-squares against 300+ named OSM buildings that appear in both the
 * dataset and Overpass — see scripts/calibrate-projection.mjs. Fetching new
 * OSM geometry through `project()` therefore lands it exactly on top of the
 * existing buildings and streets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_PATH = join(ROOT, 'public/data/pittsburgh.json');
const CACHE_DIR = join(ROOT, 'scripts/osm-cache');

/**
 * Equirectangular projection about the Point, using a spherical earth where one
 * degree spans 111320 m. Recovered by least-squares against 1256 named OSM
 * buildings present in both Overpass and the shipped dataset: median residual
 * 2.98 m, p90 9.8 m (the spread is OSM footprint churn since the dataset was
 * first built, not projection error).
 */
const DEG = 111320;
export const PROJECTION = {
  lat0: 40.441,
  lon0: -80.002,
  mPerDegLon: DEG * Math.cos((40.441 * Math.PI) / 180),
  mPerDegLat: DEG,
};

export function project(lat, lon, p = PROJECTION) {
  return [(lon - p.lon0) * p.mPerDegLon, -(lat - p.lat0) * p.mPerDegLat];
}

/**
 * The extent the dataset is authored for: 13.2 km east-west by 8.6 km
 * north-south, the box the river surfaces and the terrain grid are clipped to.
 * OSM geometry outside it is out of frame, not missing, and every audit has to
 * agree on where that edge is or they contradict each other.
 */
export const SCENE = { minX: -4600, maxX: 8600, minZ: -4000, maxZ: 4600 };

export const inScene = (x, z) =>
  x > SCENE.minX && x < SCENE.maxX && z > SCENE.minZ && z < SCENE.maxZ;

export function unproject(x, z, p = PROJECTION) {
  return [p.lat0 - z / p.mPerDegLat, p.lon0 + x / p.mPerDegLon];
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Query Overpass with on-disk caching and endpoint failover. */
export async function overpass(name, query, { refresh = false } = {}) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `${name}.json`);
  if (!refresh && existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }

  let lastErr = null;
  for (let attempt = 0; attempt < ENDPOINTS.length * 2; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'pittsburgh-3d-recreation/1.0 (map fidelity build script)',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (!json.elements) throw new Error('no elements in response');
      writeFileSync(cachePath, JSON.stringify(json));
      console.log(`  ${name}: ${json.elements.length} elements (${url.split('/')[2]})`);
      return json;
    } catch (err) {
      lastErr = err;
      console.log(`  ${name}: ${url.split('/')[2]} failed (${err.message}), retrying`);
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error(`Overpass failed for ${name}: ${lastErr?.message}`);
}

export function readData() {
  return JSON.parse(readFileSync(DATA_PATH, 'utf8'));
}

export function writeData(data) {
  writeFileSync(DATA_PATH, JSON.stringify(data));
}

/** Ring of local [x, z] from an Overpass `out geom` way, closed and rounded. */
export function ringFromGeometry(geometry, p = PROJECTION) {
  if (!geometry || geometry.length < 3) return null;
  const ring = geometry.map((g) => {
    const [x, z] = project(g.lat, g.lon, p);
    return [+x.toFixed(2), +z.toFixed(2)];
  });
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01) ring.push([a[0], a[1]]);
  return ring.length >= 4 ? ring : null;
}

/**
 * Stitch open polylines into closed rings by matching endpoints.
 *
 * OSM multipolygon members are usually *open* segments, so treating a member as
 * a ring on its own collapses it into a sliver. Anything already closed passes
 * through; anything that will not close is returned in `open`.
 */
export function stitchRings(ways, precision = 2) {
  const key = (p) => `${p[0].toFixed(precision)},${p[1].toFixed(precision)}`;
  const rings = [];
  const open = [];
  const pool = [];

  for (const w of ways) {
    if (!w || w.length < 2) continue;
    if (key(w[0]) === key(w[w.length - 1]) && w.length >= 4) rings.push(w);
    else pool.push(w.slice());
  }

  const used = new Uint8Array(pool.length);
  const ends = new Map();
  const addEnd = (k, i) => {
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k).push(i);
  };
  pool.forEach((w, i) => {
    addEnd(key(w[0]), i);
    addEnd(key(w[w.length - 1]), i);
  });

  for (let i = 0; i < pool.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = pool[i].slice();
    for (let guard = 0; guard < pool.length + 4; guard++) {
      const tail = key(chain[chain.length - 1]);
      if (tail === key(chain[0])) break;
      let next = -1;
      for (const c of ends.get(tail) || []) {
        if (!used[c]) {
          next = c;
          break;
        }
      }
      if (next < 0) break;
      used[next] = 1;
      const w = pool[next];
      chain = key(w[0]) === tail ? chain.concat(w.slice(1)) : chain.concat(w.slice(0, -1).reverse());
    }
    if (key(chain[0]) === key(chain[chain.length - 1]) && chain.length >= 4) rings.push(chain);
    else open.push(chain);
  }

  return { rings, open };
}

/**
 * Largest outer ring of an Overpass `out geom` element, stitching relation
 * members when they arrive as open segments.
 */
export function largestRing(el, p = PROJECTION) {
  if (el.type === 'way') return ringFromGeometry(el.geometry, p);
  const ways = [];
  for (const m of el.members || []) {
    if (m.role === 'inner' || !m.geometry) continue;
    ways.push(m.geometry.map((g) => project(g.lat, g.lon, p)));
  }
  if (!ways.length) return null;
  const { rings } = stitchRings(ways);
  let best = null;
  for (const r of rings) {
    const closed = r.slice();
    const a = closed[0];
    const b = closed[closed.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01) closed.push([a[0], a[1]]);
    if (closed.length < 4) continue;
    if (!best || Math.abs(ringArea(closed)) > Math.abs(ringArea(best))) best = closed;
  }
  return best ? best.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]) : null;
}

export function ringCentroid(ring) {
  let cx = 0;
  let cz = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    cx += ring[i][0];
    cz += ring[i][1];
  }
  return [cx / n, cz / n];
}

/** Signed area (positive = counter-clockwise in x/z). */
export function ringArea(ring) {
  let a = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % n];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/** Douglas-Peucker simplification that always keeps ring closure. */
export function simplify(ring, tolerance = 3) {
  if (ring.length <= 4) return ring;
  const closed =
    Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.01;
  const pts = closed ? ring.slice(0, -1) : ring.slice();
  if (pts.length <= 3) return ring;

  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let far = -1;
    let best = tolerance;
    const [ax, az] = pts[lo];
    const [bx, bz] = pts[hi];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs(dx * (az - pts[i][1]) - dz * (ax - pts[i][0])) / len;
      if (d > best) {
        best = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }

  const out = pts.filter((_, i) => keep[i]);
  if (out.length < 3) return ring;
  out.push([out[0][0], out[0][1]]);
  return out;
}
