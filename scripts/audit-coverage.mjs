/**
 * Building-stock coverage audit.
 *
 * Only 1370 of the 7474 dataset buildings carry a name, so a name-matched audit
 * says nothing about the other 6104 — and those are the bulk of what a viewer
 * actually sees. This checks the whole layer geometrically instead:
 *
 *   - for every dataset building, the distance to the nearest OSM building
 *     centroid (is anything in the dataset standing where no building exists?)
 *   - for every OSM building, the distance to the nearest dataset building
 *     (which real blocks are simply absent?)
 *   - the same, per neighbourhood tile, so a hole in one district cannot be
 *     hidden by a good average across the city
 *
 * Centroids are fetched with `out center`, which is two orders of magnitude
 * smaller than `out geom` for ~40k footprints and is all a placement test needs.
 *
 * Read-only. Run: node scripts/audit-coverage.mjs
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { overpass, project, readData, ringArea, ROOT } from './osm.mjs';
import { areaCentroid, percentile } from './osm-features.mjs';

const fmt = (n, d = 1) => Number(n).toFixed(d);

/** The extent the dataset was built for; OSM outside it is not a dataset fault. */
const SCENE = { minX: -4600, maxX: 8600, minZ: -4000, maxZ: 4600 };
const BBOX = '40.400,-80.090,40.490,-79.880';

const inScene = ([x, z]) => x > SCENE.minX && x < SCENE.maxX && z > SCENE.minZ && z < SCENE.maxZ;

/** Uniform grid index; the scene is 13 km x 8.6 km so a 200 m cell is ample. */
function grid(points, cell = 200) {
  const map = new Map();
  points.forEach((p, i) => {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  });
  return {
    nearest(x, z, maxRings = 6) {
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      let best = Infinity;
      let bi = -1;
      for (let r = 0; r <= maxRings; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            for (const i of map.get(`${cx + dx},${cz + dz}`) || []) {
              const d = Math.hypot(points[i][0] - x, points[i][1] - z);
              if (d < best) {
                best = d;
                bi = i;
              }
            }
          }
        }
        // One more ring after the first hit, because a diagonal neighbour cell
        // can hold something closer than a straight-ahead one.
        if (bi >= 0 && best <= r * cell) break;
      }
      return { d: best, i: bi };
    },
  };
}

/**
 * Fetch the whole stock as centres, then keep only a projected digest.
 *
 * `out geom tags` over 86k footprints is a 60 MB response and even `out ids
 * center` is 10 MB, which does not belong in scripts/osm-cache — that directory
 * is under version control. So the raw response is reduced to `[x, z]` pairs at
 * 0.1 m and the raw cache entry is dropped; re-running reuses the digest.
 */
async function fetchStockDigest() {
  const digestPath = join(ROOT, 'scripts/osm-cache/coverage-digest.json');
  if (existsSync(digestPath)) return JSON.parse(readFileSync(digestPath, 'utf8'));

  const res = await overpass(
    'coverage-centres',
    `[out:json][timeout:300];(way["building"](${BBOX});relation["building"](${BBOX}););out ids center;`,
  );
  const named = await overpass(
    'coverage-named-centres',
    `[out:json][timeout:240];(way["building"]["name"](${BBOX});relation["building"]["name"](${BBOX}););out ids center tags;`,
  );
  const namesById = new Map();
  for (const el of named.elements) {
    if (el.tags?.name) namesById.set(`${el.type}/${el.id}`, el.tags.name);
  }

  const pts = [];
  const names = [];
  for (const el of res.elements) {
    const c = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!c) continue;
    const p = project(c.lat, c.lon);
    if (!inScene(p)) continue;
    pts.push([+p[0].toFixed(1), +p[1].toFixed(1)]);
    names.push(namesById.get(`${el.type}/${el.id}`) || null);
  }
  const digest = { pts, names };
  writeFileSync(digestPath, JSON.stringify(digest));
  for (const stale of ['coverage-centres.json', 'coverage-named-centres.json']) {
    const p = join(ROOT, 'scripts/osm-cache', stale);
    if (existsSync(p)) rmSync(p);
  }
  return digest;
}

const digest = await fetchStockDigest();
const osm = digest.pts;
const osmMeta = digest.names.map((name) => ({ name }));

const data = readData();
const ours = [];
const oursMeta = [];
for (const b of data.buildings) {
  if (!b.f || b.f.length < 4) continue;
  const c = areaCentroid(b.f);
  if (!inScene(c)) continue;
  ours.push(c);
  oursMeta.push(b);
}

console.log(`OSM buildings in scene:     ${osm.length}`);
console.log(`dataset buildings in scene: ${ours.length}`);
console.log(`dataset / OSM:              ${fmt((ours.length / osm.length) * 100)}%`);

const gOsm = grid(osm);
const gOurs = grid(ours);

// ------------------------------------- 1. is every dataset building justified?

const dOurs = ours.map(([x, z]) => gOsm.nearest(x, z).d);
console.log('\n=== dataset building -> nearest OSM building ===');
console.log(
  `  median ${fmt(percentile(dOurs, 50))}m  p90 ${fmt(percentile(dOurs, 90))}m  p99 ${fmt(percentile(dOurs, 99))}m  max ${fmt(percentile(dOurs, 100))}m`,
);
const invented = dOurs.map((d, i) => ({ d, b: oursMeta[i], c: ours[i] })).filter((r) => r.d > 25);
console.log(`  further than 25 m from any OSM building: ${invented.length} (${fmt((invented.length / ours.length) * 100, 2)}%)`);
invented.sort((a, b) => b.d - a.d);
for (const r of invented.slice(0, 20)) {
  console.log(
    `    ${fmt(r.d).padStart(7)}m  ${fmt(Math.abs(ringArea(r.b.f)), 0).padStart(7)}m2  h=${String(r.b.h).padStart(5)}  ${(r.b.n || '(unnamed)').padEnd(38)} (${fmt(r.c[0], 0)},${fmt(r.c[1], 0)})`,
  );
}

// ------------------------------------------- 2. which real buildings are gone?

const dOsm = osm.map(([x, z]) => gOurs.nearest(x, z).d);
// The grid search gives up past 6 cells; beyond that the answer is only ever
// "nothing anywhere near", so it is reported as a bucket rather than a distance.
const SEARCH_LIMIT = 1200;
const beyond = dOsm.filter((d) => !Number.isFinite(d) || d > SEARCH_LIMIT).length;
console.log('\n=== OSM building -> nearest dataset building ===');
console.log(
  `  median ${fmt(percentile(dOsm.filter(Number.isFinite), 50))}m  p90 ${fmt(percentile(dOsm.filter(Number.isFinite), 90))}m` +
    `  beyond ${SEARCH_LIMIT}m of anything in the dataset: ${beyond} (${fmt((beyond / osm.length) * 100, 1)}%)`,
);
const absent = dOsm.map((d, i) => ({ d, m: osmMeta[i], c: osm[i] })).filter((r) => r.d > 25);
console.log(`  further than 25 m from any dataset building: ${absent.length} (${fmt((absent.length / osm.length) * 100, 2)}%)`);
const namedAbsent = absent.filter((r) => r.m.name);
const namedFar = namedAbsent.filter((r) => !Number.isFinite(r.d) || r.d > SEARCH_LIMIT);
console.log(`  of which named: ${namedAbsent.length} (${namedFar.length} of them out past the built-up edge of the scene)`);
namedAbsent
  .filter((r) => Number.isFinite(r.d) && r.d <= SEARCH_LIMIT)
  .sort((a, b) => b.d - a.d)
  .slice(0, 25)
  .forEach((r) => {
    console.log(`    ${fmt(r.d).padStart(7)}m  ${r.m.name.padEnd(46)} (${fmt(r.c[0], 0)},${fmt(r.c[1], 0)})`);
  });

// -------------------------------------------------- 3. per-district breakdown

/** Tiles named for what they cover, so a hole is reported where people look. */
const DISTRICTS = [
  { n: 'Golden Triangle', minX: -800, maxX: 900, minZ: -600, maxZ: 700 },
  { n: 'North Shore / Allegheny', minX: -1800, maxX: 900, minZ: -1900, maxZ: -600 },
  { n: 'Strip District', minX: 900, maxX: 2600, minZ: -1500, maxZ: -300 },
  { n: 'Hill District', minX: 900, maxX: 3000, minZ: -300, maxZ: 900 },
  { n: 'Oakland', minX: 3000, maxX: 5200, minZ: -900, maxZ: 600 },
  { n: 'South Side Flats', minX: 600, maxX: 3400, minZ: 900, maxZ: 2000 },
  { n: 'Mount Washington', minX: -1600, maxX: 600, minZ: 600, maxZ: 1800 },
  { n: 'Lawrenceville', minX: 1800, maxX: 3800, minZ: -3200, maxZ: -1200 },
  { n: 'Shadyside / E Liberty', minX: 5000, maxX: 7200, minZ: -2800, maxZ: -600 },
  { n: 'Squirrel Hill', minX: 5200, maxX: 7600, minZ: 0, maxZ: 2000 },
  { n: 'West End / McKees Rocks', minX: -4600, maxX: -1800, minZ: -1000, maxZ: 1600 },
];

console.log('\n=== per district ===');
console.log('  district                      OSM  ours   ratio   OSM>25m from ours');
for (const d of DISTRICTS) {
  const inBox = (p) => p[0] >= d.minX && p[0] <= d.maxX && p[1] >= d.minZ && p[1] <= d.maxZ;
  const o = osm.filter(inBox).length;
  const u = ours.filter(inBox).length;
  const gaps = absent.filter((r) => inBox(r.c)).length;
  console.log(
    `  ${d.n.padEnd(26)} ${String(o).padStart(5)} ${String(u).padStart(5)}   ${o ? fmt((u / o) * 100).padStart(5) : '   - '}%   ${String(gaps).padStart(5)} (${o ? fmt((gaps / o) * 100, 1) : '0'}%)`,
  );
}

console.log('\ndone');
