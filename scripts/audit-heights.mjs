/**
 * Height audit for the named building stock, against three sources of differing
 * authority.
 *
 *   1. A cited roof height from scripts/landmark-checklist.mjs. Published,
 *      spire-excluded, and the last word where it exists.
 *   2. An OSM `height` tag. Somebody measured it; authoritative for everything
 *      without a citation.
 *   3. An OSM `building:levels` count. An ESTIMATE at 3.6 m per floor plus a
 *      1.2 m parapet, and the reason this audit exists as its own script: naive
 *      application of storey counts drags real towers down. One PPG Place is
 *      tagged 33 levels, which is 120 m against its real 194 m, because the
 *      tag counts the office floors and not the 74 m of gothic crown above
 *      them. A levels estimate may therefore only RAISE a height, never lower
 *      one, and never touch a building carrying an authored landmark mesh.
 *
 * A slenderness guard rejects any candidate that would make a footprint taller
 * than six times its own narrowest width: OSM carries `building:levels=23` on a
 * 166 m2 plan in the Strip, and honouring it puts an 84 m needle on a garage.
 *
 * Read-only. Run: node scripts/audit-heights.mjs
 */
import { readData, ringArea } from './osm.mjs';
import { areaCentroid, fetchNamedBuildings, indexByName, nearestByName } from './osm-features.mjs';
import { CHECKLIST } from './landmark-checklist.mjs';
import { heightFromTags, narrowestExtent, plausible } from './height-rules.mjs';

const fmt = (n, d = 1) => Number(n).toFixed(d);

const data = readData();
const osm = await fetchNamedBuildings();
const idx = indexByName(osm);

const cited = new Map();
for (const spec of CHECKLIST) {
  if (spec.h == null) continue;
  for (const nm of [spec.n, ...(spec.alt || [])]) cited.set(nm.toLowerCase(), spec.h);
}

// ------------------------------------------------- 1. against cited heights

console.log('=== 1. cited roof heights (published figures) ===');
let citedBad = 0;
for (const b of data.buildings) {
  if (!b.n) continue;
  const want = cited.get(b.n.toLowerCase());
  if (want == null) continue;
  const err = (b.h - want) / want;
  if (Math.abs(err) <= 0.1) continue;
  citedBad++;
  console.log(
    `  ${b.n.padEnd(36)} h=${String(b.h).padStart(6)}m  cited ${fmt(want)}m  ${err > 0 ? '+' : ''}${fmt(err * 100, 1)}%`,
  );
}
console.log(`  ${cited.size} cited figures, ${citedBad} out by more than 10%`);

// -------------------------------------------------- 2. against OSM tagging

console.log('\n=== 2. OSM height / building:levels ===');
const rows = [];
for (const b of data.buildings) {
  if (!b.n || !b.f || b.f.length < 4) continue;
  const c = areaCentroid(b.f);
  const hit = nearestByName(idx, b.n, c[0], c[1], 120);
  if (!hit) continue;
  const tag = heightFromTags(hit.f.tags);
  if (!tag) continue;
  const err = (b.h - tag.h) / tag.h;
  // A relative test alone reports every single-storey shop, where the whole
  // disagreement is 4.3 m against 4.8 m and nobody can see it. Both thresholds
  // have to trip for a difference to be worth acting on.
  if (Math.abs(err) <= 0.1 || Math.abs(b.h - tag.h) < 2) continue;
  rows.push({ b, tag, err, area: Math.abs(ringArea(b.f)), narrow: narrowestExtent(b.f) });
}

rows.sort((a, b) => Math.abs(b.err) - Math.abs(a.err));
let actionable = 0;
for (const r of rows) {
  const verdict = plausible(r.b, r.tag, cited.has((r.b.n || '').toLowerCase()));
  if (verdict.apply) actionable++;
  console.log(
    `  ${verdict.apply ? 'FIX ' : 'keep'} ${(r.b.n || '').padEnd(40)} h=${String(r.b.h).padStart(6)}m  ` +
      `osm ${fmt(r.tag.h).padStart(6)}m (${r.tag.source})  ${r.err > 0 ? '+' : ''}${fmt(r.err * 100, 0).padStart(5)}%  ${verdict.why}`,
  );
}
console.log(`  ${rows.length} disagree by more than 10%, ${actionable} of them actionable`);

// ------------------------------------------- 3. the shape of the whole stock

console.log('\n=== 3. height distribution ===');
const named = data.buildings.filter((b) => b.n);
const atDefault = data.buildings.filter((b) => b.h === 14).length;
console.log(`  buildings ${data.buildings.length} (${named.length} named)`);
console.log(
  `  still at the 14 m build default: ${atDefault} (${fmt((atDefault / data.buildings.length) * 100)}%)`,
);
for (const [lo, hi] of [[0, 8], [8, 20], [20, 50], [50, 100], [100, 200], [200, 300]]) {
  const n = data.buildings.filter((b) => b.h >= lo && b.h < hi).length;
  console.log(`  ${String(lo).padStart(3)}-${String(hi).padStart(3)}m  ${String(n).padStart(5)}`);
}

console.log('\ndone');
