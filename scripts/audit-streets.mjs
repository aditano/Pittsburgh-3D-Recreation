/**
 * Street alignment spot-check against OSM.
 *
 * The dataset stores streets as `{ c: [[x,z],...], r: rank }` with no name on
 * any of the 6852 polylines, so this cannot be a name-matched comparison. It is
 * geometric instead: fetch the real centreline for each named street, walk it at
 * 10 m intervals, and measure how far each sample is from the nearest dataset
 * polyline. A street that is present and correctly aligned scores a couple of
 * metres; one that is displaced scores its displacement; one that is absent
 * scores tens of metres and shows up as uncovered samples.
 *
 * `covered` counts samples within 12 m, which is about one carriageway width —
 * close enough that the drawn street lands on the real one. Sampling the OSM
 * line rather than ours is deliberate: it answers "is the real street there",
 * which is the question, and it does not penalise the dataset for also
 * containing the alleys and service roads that OSM names differently.
 *
 * Read-only. Run: node scripts/audit-streets.mjs
 */
import { inScene, overpass, readData } from './osm.mjs';
import { AUDIT_BBOX, percentile, pointSegDist } from './osm-features.mjs';
import { STREET_SPOTS } from './landmark-checklist.mjs';
import { project } from './osm.mjs';

const fmt = (n, d = 1) => Number(n).toFixed(d);

/** One sample every 10 m along the centreline; a city block is 80-120 m. */
const STEP = 10;
/** Within one carriageway width the drawn street is on the real street. */
const NEAR = 12;

const names = new Set();
for (const spec of STREET_SPOTS) for (const nm of [spec.n, ...(spec.alt || [])]) names.add(nm);

const clause = [...names]
  .map((n) => `  way["highway"]["name"="${n}"](${AUDIT_BBOX});`)
  .join('\n');
const res = await overpass(
  'streets-spotcheck',
  `[out:json][timeout:240];(\n${clause}\n);out geom;`,
);

const byName = new Map();
for (const el of res.elements) {
  const nm = el.tags?.name;
  if (!nm || !el.geometry) continue;
  const line = el.geometry.map((g) => project(g.lat, g.lon)).filter(([x, z]) => inScene(x, z));
  if (line.length < 2) continue;
  if (!byName.has(nm)) byName.set(nm, []);
  byName.get(nm).push(line);
}

// ------------------------------------------------------- dataset street index

const data = readData();
const CELL = 100;
const grid = new Map();

/**
 * The street layer's own extent, which is NOT the scene box: streets reach
 * x=7630 where the water and terrain are authored out to x=8600. Forbes Avenue
 * in Point Breeze and Washington Boulevard in Highland Park both run past that
 * edge, and calling them misaligned when they were never imported confuses a
 * bounds mismatch with a placement error.
 */
const layer = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
for (const s of data.streets) {
  for (const [x, z] of s.c || []) {
    if (x < layer.minX) layer.minX = x;
    if (x > layer.maxX) layer.maxX = x;
    if (z < layer.minZ) layer.minZ = z;
    if (z > layer.maxZ) layer.maxZ = z;
  }
}
const inLayer = ([x, z]) =>
  x >= layer.minX && x <= layer.maxX && z >= layer.minZ && z <= layer.maxZ;

for (const s of data.streets) {
  const pts = s.c;
  if (!pts || pts.length < 2) continue;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    // A segment can span several cells, so it is registered in every cell its
    // bounding box touches or a long straight run goes missing from the index.
    const x0 = Math.floor(Math.min(a[0], b[0]) / CELL);
    const x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    const z0 = Math.floor(Math.min(a[1], b[1]) / CELL);
    const z1 = Math.floor(Math.max(a[1], b[1]) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const k = `${gx},${gz}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push([a, b]);
      }
    }
  }
}

function nearestStreet(p) {
  const gx = Math.floor(p[0] / CELL);
  const gz = Math.floor(p[1] / CELL);
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const [a, b] of grid.get(`${gx + dx},${gz + dz}`) || []) {
        const d = pointSegDist(p, a, b);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** Samples every STEP metres along a polyline, endpoints included. */
function walk(line) {
  const out = [];
  let carry = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, az] = line[i];
    const [bx, bz] = line[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    for (let t = carry; t < len; t += STEP) {
      out.push([ax + ((bx - ax) * t) / len, az + ((bz - az) * t) / len]);
    }
    carry = (carry - len) % STEP;
    if (carry < 0) carry += STEP;
  }
  out.push(line[line.length - 1]);
  return out;
}

// ------------------------------------------------------------------- report

console.log(`dataset ${data.streets.length} street polylines, none named`);
console.log(
  `street layer extent: x ${fmt(layer.minX, 0)}..${fmt(layer.maxX, 0)}  z ${fmt(layer.minZ, 0)}..${fmt(layer.maxZ, 0)}\n`,
);
console.log('  street                            samples  median    p90    max  covered  off-layer');

const worst = [];
let totalSamples = 0;
let totalCovered = 0;

for (const spec of STREET_SPOTS) {
  const lines = [];
  for (const nm of [spec.n, ...(spec.alt || [])]) lines.push(...(byName.get(nm) || []));
  if (!lines.length) {
    console.log(`  ${spec.n.padEnd(32)}  no OSM way of that name inside the scene box`);
    continue;
  }
  const ds = [];
  const adrift = [];
  let offLayer = 0;
  for (const line of lines) {
    for (const p of walk(line)) {
      if (!inLayer(p)) {
        offLayer++;
        continue;
      }
      const d = nearestStreet(p);
      ds.push(d);
      if (d > NEAR) adrift.push(p);
    }
  }
  if (!ds.length) {
    console.log(`  ${spec.n.padEnd(32)} entirely beyond the street layer extent (${offLayer} samples)`);
    continue;
  }
  const covered = ds.length - adrift.length;
  totalSamples += ds.length;
  totalCovered += covered;
  const pct = (covered / ds.length) * 100;
  const med = percentile(ds, 50);
  console.log(
    `  ${spec.n.padEnd(32)} ${String(ds.length).padStart(7)} ${fmt(med).padStart(7)} ` +
      `${fmt(percentile(ds, 90)).padStart(6)} ${fmt(Math.max(...ds)).padStart(6)} ${fmt(pct, 1).padStart(7)}% ` +
      `${String(offLayer).padStart(10)}`,
  );
  if (pct < 98 || med > 6) worst.push({ n: spec.n, med, pct, adrift });
}

console.log(
  `\n  ${totalSamples} samples inside the street layer over ${STREET_SPOTS.length} streets: ` +
    `${fmt((totalCovered / totalSamples) * 100, 2)}% within ${NEAR}m of a dataset polyline`,
);

if (worst.length) {
  console.log('\n=== streets worth a look ===');
  worst.sort((a, b) => a.pct - b.pct);
  for (const w of worst) {
    // The layer's bounding box is a rectangle but its contents are not, so a
    // sample can sit inside the box with no network imported anywhere near it.
    // That is a different fault from a street the dataset has and has misplaced,
    // and only the second one is a placement error.
    let barren = 0;
    for (const p of w.adrift) if (nearestStreet(p) > 300) barren++;
    const sample = w.adrift.slice(0, 3).map(([x, z]) => `(${fmt(x, 0)},${fmt(z, 0)})`).join(' ');
    console.log(
      `  ${w.n.padEnd(32)} median ${fmt(w.med)}m, ${fmt(w.pct, 1)}% covered, ${w.adrift.length} adrift ` +
        `(${barren} with no network within 300m)${sample ? `  eg ${sample}` : ''}`,
    );
  }
}

console.log('\ndone');
