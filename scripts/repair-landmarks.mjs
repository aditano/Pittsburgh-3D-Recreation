/**
 * Two data repairs, both driven off OSM tags rather than hand-typed values.
 *
 * 1. Insert landmarks that are missing from the dataset entirely. They were
 *    dropped because they are mapped as multipolygon relations, or under a name
 *    the original build did not look for, so an ornate downtown block like the
 *    Union Trust Building simply was not in the city.
 *
 * 2. Refresh heights for named buildings from OSM `height` / `building:levels`.
 *    A lot of the stock still carries the default 14 m, which turns genuinely
 *    tall landmarks into flat slabs - the Warhol Museum is seven storeys, not
 *    one. Matching is by exact name *and* centroid proximity so the many
 *    same-named chain stores cannot pull a height across town, and a slenderness
 *    guard rejects any result that would make a small footprint implausibly tall.
 */
import { overpass, readData, writeData, largestRing, ringCentroid, ringArea } from './osm.mjs';

const BBOX = '40.410,-80.075,40.475,-79.890';

/**
 * Landmarks to insert if absent. `h` falls back to this when OSM carries no
 * height or level tags; the notes cite the real structure.
 */
const MISSING = [
  // 11 storeys of Flemish Gothic with a steep ornamented roof, 1917.
  { osm: 'Union Trust Building', h: 72, style: 'gothic' },
  // Lord & Burnham glasshouse, 1893; the Palm Court dome is the tall point.
  { osm: 'Phipps Conservatory', h: 20, style: 'glass' },
  // H. H. Richardson's Romanesque courthouse, 1888.
  { osm: 'Allegheny County Courthouse', h: 30.5, style: 'stone' },
  { osm: 'Pittsburgh City-County Building', n: 'City-County Building', h: 43.9, style: 'stone' },
];

/** Named buildings whose OSM tags are silent but which are plainly not 14 m. */
const CITED_HEIGHTS = [
  // Domed 1910 memorial hall in Oakland.
  { match: /^soldiers and sailors memorial hall$/i, h: 34 },
  // Seven floors of the former Volkwein building on the North Shore.
  { match: /^the andy warhol museum$/i, h: 26 },
  // Renamed from Carnegie Science Center in 2023.
  { match: /^kamin science center$/i, h: 20 },
];

/**
 * Returns the height and whether it came from an explicit tag. A storey count is
 * only an estimate: 3.6 m per level puts PPG Place at 166 m against its real
 * 194 m and the Cathedral of Learning at 152 m against 163 m, so the caller must
 * not let an estimate overwrite a height that is already specific.
 */
function parseHeight(tags = {}) {
  const raw = tags.height ?? tags['building:height'];
  if (raw != null) {
    const m = /([\d.]+)\s*(m|ft|')?/i.exec(String(raw));
    if (m) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v) && v > 2) {
        return { h: /ft|'/i.test(m[2] || '') ? v * 0.3048 : v, exact: true };
      }
    }
  }
  const lv = parseFloat(tags['building:levels']);
  if (Number.isFinite(lv) && lv >= 1) return { h: lv * 3.6 + 1.2, exact: false };
  return null;
}

/** Shortest width of the footprint, used to reject implausibly slender towers. */
function narrowestExtent(ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = ring[i + 1][0] - ring[i][0];
    const dz = ring[i + 1][1] - ring[i][1];
    const len = Math.hypot(dx, dz);
    if (len < 1) continue;
    const ux = dx / len;
    const uz = dz / len;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, z] of ring) {
      const t = -x * uz + z * ux;
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    best = Math.min(best, hi - lo);
  }
  return Number.isFinite(best) ? best : 0;
}

const res = await overpass(
  'lm-audit',
  `[out:json][timeout:240];(way["name"](${BBOX});relation["name"](${BBOX}););out geom tags;`,
);

const osm = new Map();
for (const el of res.elements) {
  const n = el.tags?.name;
  if (!n) continue;
  const ring = largestRing(el);
  if (!ring) continue;
  const key = n.toLowerCase();
  const a = Math.abs(ringArea(ring));
  const prev = osm.get(key);
  if (!prev || a > prev.a) osm.set(key, { n, ring, a, c: ringCentroid(ring), tags: el.tags });
}

/**
 * Overpass sometimes returns a relation with no members under `out geom`, which
 * is how the County Courthouse went missing. Recurse to the member ways for
 * anything still unresolved and stitch those into a ring.
 */
const unresolved = MISSING.filter((s) => !osm.has(s.osm.toLowerCase()));
if (unresolved.length) {
  const clauses = unresolved
    .map((s) => `  rel["name"="${s.osm}"](${BBOX});`)
    .join('\n');
  const rec = await overpass(
    'lm-relations',
    `[out:json][timeout:240];\n(\n${clauses}\n)->.r;\n.r out tags;\nway(r.r);\nout geom;`,
  );
  const relTags = new Map();
  const relWays = new Map();
  let current = null;
  for (const el of rec.elements) {
    if (el.type === 'relation') {
      current = el.tags?.name || null;
      if (current) relTags.set(current, el.tags);
    } else if (el.type === 'way' && el.geometry && current) {
      if (!relWays.has(current)) relWays.set(current, []);
      relWays.get(current).push(el);
    }
  }
  for (const spec of unresolved) {
    const ways = relWays.get(spec.osm);
    if (!ways || !ways.length) continue;
    const ring = largestRing({ type: 'relation', members: ways.map((w) => ({ role: 'outer', geometry: w.geometry })) });
    if (!ring) continue;
    osm.set(spec.osm.toLowerCase(), {
      n: spec.osm,
      ring,
      a: Math.abs(ringArea(ring)),
      c: ringCentroid(ring),
      tags: relTags.get(spec.osm) || {},
    });
    console.log(`  (recovered ${spec.osm} from relation members)`);
  }
}

const data = readData();

// ------------------------------------------------------- 1. insert missing

let inserted = 0;
for (const spec of MISSING) {
  const hit = osm.get(spec.osm.toLowerCase());
  if (!hit) {
    console.log(`  ! ${spec.osm}: not found in OSM`);
    continue;
  }
  const name = spec.n || hit.n;
  if (data.buildings.some((b) => b.n && b.n.toLowerCase() === name.toLowerCase())) {
    console.log(`  = ${name}: already present`);
    continue;
  }
  // Clear whatever generic stock already occupies the footprint.
  const before = data.buildings.length;
  data.buildings = data.buildings.filter((b) => {
    const c = ringCentroid(b.f);
    if (Math.hypot(c[0] - hit.c[0], c[1] - hit.c[1]) > 30) return true;
    return Math.abs(ringArea(b.f)) > hit.a * 1.6;
  });
  const removed = before - data.buildings.length;

  const tagged = parseHeight(hit.tags);
  const h = tagged?.exact ? tagged.h : spec.h;
  const rec = { f: hit.ring, h: +h.toFixed(1), n: name };
  if (spec.style) rec.style = spec.style;
  data.buildings.push(rec);
  inserted++;
  console.log(
    `  + ${name}: h=${rec.h}m area ${hit.a.toFixed(0)}m2 at (${hit.c[0].toFixed(0)},${hit.c[1].toFixed(0)}), replaced ${removed} generic`,
  );
}

// ------------------------------------------------------ 2. refresh heights

let changed = 0;
let rejected = 0;
for (const b of data.buildings) {
  if (!b.n) continue;
  const hit = osm.get(b.n.toLowerCase());
  if (!hit) continue;
  const c = ringCentroid(b.f);
  if (Math.hypot(c[0] - hit.c[0], c[1] - hit.c[1]) > 40) continue;
  const tagged = parseHeight(hit.tags);
  if (tagged == null) continue;
  const h = tagged.h;
  if (Math.abs(h - (b.h ?? 0)) < 1.5) continue;
  // A storey-count estimate may only raise a height, never trim one that is
  // already specific, or it drags the real towers down to a 3.6 m-per-floor guess.
  if (!tagged.exact && h <= (b.h ?? 0)) continue;
  // Buildings carrying a bespoke mesh or roof were authored against a cited
  // architectural height, which often exceeds the roof height OSM records
  // (One PPG Place is 166 m to the roof and 194 m over the spires). Leave them.
  if ((b.landmarkMesh || b.roof) && h < (b.h ?? 0)) continue;
  const narrow = narrowestExtent(b.f);
  if (h > 25 && narrow > 0 && h > narrow * 6) {
    rejected++;
    continue;
  }
  console.log(`  ~ ${b.n}: ${b.h} -> ${h.toFixed(1)}m`);
  b.h = +h.toFixed(1);
  changed++;
}

let cited = 0;
for (const b of data.buildings) {
  if (!b.n) continue;
  const spec = CITED_HEIGHTS.find((s) => s.match.test(b.n));
  if (!spec || Math.abs(spec.h - (b.h ?? 0)) < 1.5) continue;
  console.log(`  ~ ${b.n}: ${b.h} -> ${spec.h}m (cited)`);
  b.h = spec.h;
  cited++;
}

data.meta.landmarkRepair = 'missing landmarks inserted and named-building heights refreshed from OSM tags';
writeData(data);
console.log(
  `\ninserted ${inserted}, heights refreshed ${changed} from tags + ${cited} cited, ${rejected} rejected as too slender`,
);
console.log(`buildings now ${data.buildings.length}`);
