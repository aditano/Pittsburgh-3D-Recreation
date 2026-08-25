/**
 * Verify public/data/fabric.json.
 *
 * Read-only and offline: the OSM side comes from the gzipped tile digests
 * scripts/build-fabric.mjs left in scripts/osm-cache, so this audit measures the
 * same stock the build measured and can be re-run without hitting Overpass.
 *
 * Six questions, in the order they can invalidate the layer:
 *
 *   1. Coverage. Per district, how much of the OSM building stock the dataset
 *      alone holds and how much dataset + fabric holds. Districts are the boxes
 *      scripts/audit-coverage.mjs uses and counting is by bounding-box centre,
 *      which is what Overpass `out center` returns, so the OSM column here is
 *      directly comparable with that audit's.
 *   2. Duplication. No fabric footprint may stand on a dataset footprint, or the
 *      two extrusions z-fight. Measured independently of the build, by area
 *      overlap rather than by the build's own matcher.
 *   3. Self-duplication, the same test inside the fabric layer.
 *   4. Water. Nothing extruded out of the river, tested against the dataset's own
 *      water rings the way scripts/verify-water.mjs does.
 *   5. Placement. Every fabric footprint should sit on the OSM footprint it was
 *      projected from, so the median offset to the nearest OSM centre is a check
 *      that the shared projection was used and nothing is shifted.
 *   6. Budget. Vertex counts, height provenance, raw and gzipped size.
 *
 * Run: node scripts/audit-fabric.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import polygonClipping from 'polygon-clipping';
import { inScene, ringArea, ROOT } from './osm.mjs';
import { areaCentroid, bbox, percentile } from './osm-features.mjs';
import { pointInRing } from './renderer-refs.mjs';

const CACHE = join(ROOT, 'scripts/osm-cache');
const fmt = (n, d = 1) => Number(n).toFixed(d);
const absArea = (r) => Math.abs(ringArea(r));
const bbCentre = (r) => {
  const b = bbox(r);
  return [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
};

/** Same boxes and same priorities as scripts/build-fabric.mjs. */
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
  { n: 'Outer neighbourhoods', minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity },
];
const districtAt = (x, z) =>
  DISTRICTS.find((d) => x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ);

function centroidGrid(cell = 60) {
  const map = new Map();
  return {
    add(item) {
      const k = `${Math.floor(item.c[0] / cell)},${Math.floor(item.c[1] / cell)}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(item);
    },
    near(x, z, radius) {
      const span = Math.ceil(radius / cell);
      const gx = Math.floor(x / cell);
      const gz = Math.floor(z / cell);
      const out = [];
      for (let dx = -span; dx <= span; dx++) {
        for (let dz = -span; dz <= span; dz++) {
          const bucket = map.get(`${gx + dx},${gz + dz}`);
          if (bucket) out.push(...bucket);
        }
      }
      return out;
    },
  };
}

const bbDisjoint = (a, b) => a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ;

function overlapFraction(a, b) {
  let inter;
  try {
    inter = polygonClipping.intersection([[a]], [[b]]);
  } catch {
    return 0;
  }
  if (!inter?.length) return 0;
  let area = 0;
  for (const poly of inter) {
    area += absArea(poly[0]);
    for (let i = 1; i < poly.length; i++) area -= absArea(poly[i]);
  }
  return area / Math.min(absArea(a), absArea(b));
}

// ------------------------------------------------------------------- inputs

const fabricPath = join(ROOT, 'public/data/fabric.json');
if (!existsSync(fabricPath)) {
  console.error('public/data/fabric.json is missing — run: node scripts/build-fabric.mjs');
  process.exit(1);
}
const fabric = JSON.parse(readFileSync(fabricPath, 'utf8'));
const data = JSON.parse(readFileSync(join(ROOT, 'public/data/pittsburgh.json'), 'utf8'));

// The OSM side comes from the build's tile digests. They are only needed by the
// coverage and placement checks, so if the cache has been cleared the rest of
// the audit still runs rather than refusing to say anything.
const digests = existsSync(CACHE)
  ? readdirSync(CACHE).filter((f) => /^fabric-digest-.*\.json\.gz$/.test(f))
  : [];
const haveStock = digests.length > 0;
const seen = new Set();
const stock = [];
for (const f of digests) {
  for (const e of JSON.parse(gunzipSync(readFileSync(join(CACHE, f))).toString('utf8'))) {
    if (seen.has(e.i)) continue;
    seen.add(e.i);
    stock.push(e);
  }
}

console.log(`fabric.json   ${fabric.buildings.length} buildings, generated ${fabric.meta?.generated}`);
console.log(`pittsburgh.json ${data.buildings.length} buildings`);
console.log(
  haveStock
    ? `OSM stock from ${digests.length} tile digests: ${stock.length} footprints in scene`
    : 'no fabric tile digests in scripts/osm-cache — coverage and placement skipped ' +
      '(regenerate them with: node scripts/build-fabric.mjs)',
);

// ------------------------------------------------------------- 1. coverage

const osmPts = stock.map((e) => bbCentre(e.r));
const datasetPts = [];
for (const b of data.buildings) {
  if (!b.f || b.f.length < 4) continue;
  const c = bbCentre(b.f);
  if (inScene(c[0], c[1])) datasetPts.push(c);
}
const fabricPts = fabric.buildings.map((b) => bbCentre(b.f));

if (haveStock) {
console.log('\n=== 1. coverage per district (count by bounding-box centre) ===');
console.log('  district                      OSM  dataset  fabric   before    after');
const bucket = (pts) => {
  const m = new Map();
  for (const p of pts) {
    const d = districtAt(p[0], p[1]);
    m.set(d.n, (m.get(d.n) || 0) + 1);
  }
  return m;
};
const bOsm = bucket(osmPts);
const bData = bucket(datasetPts);
const bFab = bucket(fabricPts);
for (const d of DISTRICTS) {
  const o = bOsm.get(d.n) || 0;
  const u = bData.get(d.n) || 0;
  const f = bFab.get(d.n) || 0;
  console.log(
    `  ${d.n.padEnd(26)} ${String(o).padStart(5)} ${String(u).padStart(8)} ${String(f).padStart(7)}   ` +
      `${o ? fmt((u / o) * 100).padStart(5) : '   - '}%   ${o ? fmt(((u + f) / o) * 100).padStart(5) : '   - '}%`,
  );
}
console.log(
  `  ${'TOTAL'.padEnd(26)} ${String(osmPts.length).padStart(5)} ${String(datasetPts.length).padStart(8)} ${String(fabricPts.length).padStart(7)}   ` +
    `${fmt((datasetPts.length / osmPts.length) * 100).padStart(5)}%   ${fmt(((datasetPts.length + fabricPts.length) / osmPts.length) * 100).padStart(5)}%`,
);

// How far a real building now is from anything modelled — the measure
// audit-coverage.mjs reports, recomputed against dataset + fabric.
const modelled = centroidGrid(60);
for (const p of datasetPts) modelled.add({ c: p });
for (const p of fabricPts) modelled.add({ c: p });
const nearest = (x, z) => {
  for (const radius of [60, 120, 300, 900]) {
    let best = Infinity;
    for (const it of modelled.near(x, z, radius)) {
      const d = Math.hypot(it.c[0] - x, it.c[1] - z);
      if (d < best) best = d;
    }
    if (best <= radius) return best;
  }
  return Infinity;
};
const dOsm = osmPts.map((p) => nearest(p[0], p[1]));
const finite = dOsm.filter(Number.isFinite);
const far = dOsm.filter((d) => !(d <= 25)).length;
console.log(
  `\n  OSM building -> nearest modelled building: median ${fmt(percentile(finite, 50))}m  p90 ${fmt(percentile(finite, 90))}m` +
    `  further than 25 m: ${far} (${fmt((far / osmPts.length) * 100, 2)}%)`,
);
}

// -------------------------------------------- 2 & 3. duplicates and overlaps

const datasetGrid = centroidGrid(60);
for (const b of data.buildings) {
  if (!b.f || b.f.length < 4) continue;
  datasetGrid.add({ ring: b.f, c: areaCentroid(b.f), bb: bbox(b.f), area: absArea(b.f), n: b.n });
}

console.log('\n=== 2. fabric against pittsburgh.json (area overlap) ===');
let hard = 0;
let soft = 0;
const worst = [];
for (const b of fabric.buildings) {
  const c = areaCentroid(b.f);
  const bb = bbox(b.f);
  const area = absArea(b.f);
  let top = 0;
  let topOther = null;
  for (const other of datasetGrid.near(c[0], c[1], Math.max(30, Math.sqrt(area)))) {
    if (bbDisjoint(bb, other.bb)) continue;
    const f = overlapFraction(b.f, other.ring);
    if (f > top) {
      top = f;
      topOther = other;
    }
  }
  if (top >= 0.4) hard++;
  else if (top >= 0.15) soft++;
  if (top > 0.15) worst.push({ f: top, b, other: topOther, c });
}
worst.sort((a, b) => b.f - a.f);
console.log(`  overlapping a dataset footprint by >=40% of the smaller (a duplicate): ${hard}`);
console.log(`  overlapping by 15-40% (adjacent or nested, not a duplicate):          ${soft}`);

for (const w of worst.slice(0, 10)) {
  console.log(
    `    ${fmt(w.f * 100, 0).padStart(3)}%  ${fmt(absArea(w.b.f), 0).padStart(6)}m2 h=${String(w.b.h).padStart(5)} ` +
      `${(w.b.n || '(unnamed)').padEnd(30)} over ${(w.other?.n || '(unnamed)').padEnd(30)} (${fmt(w.c[0], 0)},${fmt(w.c[1], 0)})`,
  );
}

// A bespoke landmark mesh occupies more than its stored footprint — PNC Park's
// stands are modelled well outside the ring the dataset keeps for it — so a
// fabric building merely near one can end up inside the model even though the
// overlap test above is happy. Reported separately rather than folded into the
// duplicate count, because the fix is a footprint decision, not a dedup bug.
const meshes = data.buildings.filter((b) => (b.landmarkMesh || b.landmark) && b.f?.length > 3);
let intruders = 0;
for (const b of fabric.buildings) {
  const c = areaCentroid(b.f);
  const host = meshes.find((m) => pointInRing(c[0], c[1], m.f));
  if (!host) continue;
  intruders++;
  if (intruders <= 8) {
    console.log(`    inside landmark ${host.n}: ${fmt(absArea(b.f), 0)}m2 h=${b.h} at (${fmt(c[0], 0)},${fmt(c[1], 0)})`);
  }
}
console.log(`  standing inside a dataset landmark footprint: ${intruders}`);

console.log('\n=== 3. fabric against itself ===');
const selfGrid = centroidGrid(60);
const items = fabric.buildings.map((b) => ({
  ring: b.f,
  c: areaCentroid(b.f),
  bb: bbox(b.f),
  area: absArea(b.f),
  n: b.n,
}));
for (const it of items) selfGrid.add(it);
let selfDup = 0;
const selfWorst = [];
for (const it of items) {
  let top = 0;
  for (const other of selfGrid.near(it.c[0], it.c[1], Math.max(30, Math.sqrt(it.area)))) {
    if (other === it || bbDisjoint(it.bb, other.bb)) continue;
    const f = overlapFraction(it.ring, other.ring);
    if (f > top) top = f;
  }
  if (top >= 0.4) {
    selfDup++;
    selfWorst.push({ f: top, it });
  }
}
selfWorst.sort((a, b) => b.f - a.f);
console.log(`  pairs where one covers >=40% of the other: ${selfDup} footprints involved`);
for (const w of selfWorst.slice(0, 8)) {
  console.log(
    `    ${fmt(w.f * 100, 0).padStart(3)}%  ${fmt(w.it.area, 0).padStart(6)}m2 ${(w.it.n || '(unnamed)').padEnd(30)} (${fmt(w.it.c[0], 0)},${fmt(w.it.c[1], 0)})`,
  );
}

// ---------------------------------------------------------------- 4. water

console.log('\n=== 4. nothing standing in the river ===');
const wet = (x, z) => {
  for (const w of data.water || []) {
    if (!pointInRing(x, z, w.f)) continue;
    if ((w.holes || []).some((h) => pointInRing(x, z, h))) continue;
    return true;
  }
  return false;
};
let centreWet = 0;
let edgeWet = 0;
const wetList = [];
for (const b of fabric.buildings) {
  const c = areaCentroid(b.f);
  const cw = wet(c[0], c[1]);
  let verts = 0;
  for (let i = 0; i < b.f.length - 1; i++) if (wet(b.f[i][0], b.f[i][1])) verts++;
  if (cw) {
    centreWet++;
    wetList.push({ b, c, verts });
  } else if (verts) edgeWet++;
}
console.log(`  centroid in water (bad):        ${centreWet}`);
console.log(`  only an edge vertex in water:   ${edgeWet}  (river bank rings overshoot the shoreline slightly)`);
for (const w of wetList.slice(0, 10)) {
  console.log(
    `    IN WATER ${fmt(absArea(w.b.f), 0)}m2 h=${w.b.h} ${(w.b.n || '(unnamed)').padEnd(28)} (${fmt(w.c[0], 0)},${fmt(w.c[1], 0)}) ${w.verts}/${w.b.f.length - 1} verts wet`,
  );
}

// ------------------------------------------------------------ 5. placement

console.log('\n=== 5. placement against the OSM stock it came from ===');
const osmGrid = centroidGrid(60);
stock.forEach((e, i) => osmGrid.add({ c: osmPts[i], i }));
const offsets = [];
let outside = 0;
for (const b of fabric.buildings) {
  const c = bbCentre(b.f);
  if (!inScene(c[0], c[1])) outside++;
  if (!haveStock) continue;
  let best = Infinity;
  for (const it of osmGrid.near(c[0], c[1], 60)) {
    const d = Math.hypot(it.c[0] - c[0], it.c[1] - c[1]);
    if (d < best) best = d;
  }
  if (Number.isFinite(best)) offsets.push(best);
}
if (haveStock) {
  console.log(
    `  fabric footprint -> nearest OSM centre: median ${fmt(percentile(offsets, 50), 2)}m  p90 ${fmt(percentile(offsets, 90), 2)}m` +
      `  p99 ${fmt(percentile(offsets, 99), 2)}m  max ${fmt(percentile(offsets, 100), 2)}m` +
      `  (non-zero only where simplification had to drop a corner to fit the vertex cap)`,
  );
}
console.log(`  outside the scene box: ${outside}`);

// --------------------------------------------------------------- 6. budget

console.log('\n=== 6. budget ===');
const verts = fabric.buildings.map((b) => b.f.length - 1);
const areas = fabric.buildings.map((b) => absArea(b.f));
const heights = fabric.buildings.map((b) => b.h);
const src = { t: 0, l: 0, i: 0, other: 0 };
for (const b of fabric.buildings) {
  if (src[b.hs] == null) src.other++;
  else src[b.hs]++;
}
const raw = statSync(fabricPath).size;
const gz = gzipSync(readFileSync(fabricPath)).length;
console.log(`  raw ${fmt(raw / 1048576, 2)} MB   gzipped ${fmt(gz / 1048576, 2)} MB   ${fmt(raw / fabric.buildings.length, 0)} bytes per building`);
console.log(
  `  vertices  median ${percentile(verts, 50)}  p90 ${percentile(verts, 90)}  p99 ${percentile(verts, 99)}  max ${percentile(verts, 100)}  total ${verts.reduce((a, b) => a + b, 0)}`,
);
console.log(
  `  areas     min ${fmt(percentile(areas, 0), 0)}m2  median ${fmt(percentile(areas, 50), 0)}m2  p99 ${fmt(percentile(areas, 99), 0)}m2  max ${fmt(percentile(areas, 100), 0)}m2`,
);
console.log(
  `  heights   ${src.t} measured (OSM height tag), ${src.l} from building:levels, ${src.i} inferred` +
    (src.other ? `, ${src.other} with no source recorded` : ''),
);
console.log(
  `            p10 ${fmt(percentile(heights, 10))}m  median ${fmt(percentile(heights, 50))}m  p90 ${fmt(percentile(heights, 90))}m  max ${fmt(percentile(heights, 100))}m`,
);
// A single dominant height is the failure this layer exists to avoid, so the
// most common value is reported outright rather than hidden in a percentile.
const tally = new Map();
for (const h of heights) tally.set(h, (tally.get(h) || 0) + 1);
const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(
  `  most common heights: ${top.map(([h, n]) => `${h}m x${n} (${fmt((n / heights.length) * 100)}%)`).join(', ')}`,
);
console.log(`  distinct heights: ${tally.size}`);

const bad = fabric.buildings.filter(
  (b) =>
    !Array.isArray(b.f) ||
    b.f.length < 4 ||
    b.f[0][0] !== b.f[b.f.length - 1][0] ||
    b.f[0][1] !== b.f[b.f.length - 1][1] ||
    !(b.h > 0),
).length;
console.log(`  malformed records (unclosed ring, <3 corners or non-positive height): ${bad}`);

const verdict = [];
if (hard) verdict.push(`${hard} duplicates of dataset buildings`);
if (intruders) verdict.push(`${intruders} inside a landmark footprint`);
if (selfDup) verdict.push(`${selfDup} self-duplicates`);
if (centreWet) verdict.push(`${centreWet} in the river`);
if (outside) verdict.push(`${outside} outside the scene box`);
if (bad) verdict.push(`${bad} malformed`);
console.log(`\n${verdict.length ? `FAIL: ${verdict.join(', ')}` : 'PASS: no duplicates, nothing in the river, nothing malformed'}`);
