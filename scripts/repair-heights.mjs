/**
 * Refresh building heights from OSM tags across the WHOLE stock, not just the
 * named part.
 *
 * Half the footprints in the dataset still carry the 14 m build default, and the
 * existing height pass only ever looked at named buildings — it matched on name,
 * so 6000 unnamed footprints could never be reached even where OSM measures them
 * precisely. 3890 OSM buildings inside the scene box carry `height` or
 * `building:levels`; this matches them geometrically instead.
 *
 * Matching is deliberately strict. Footprints in this city sit 3 m apart, so a
 * loose radius hands a rowhouse the height of the warehouse behind it: the OSM
 * record has to sit within 12 m of ours AND agree on bounding-box size to within
 * a factor of 1.6, or it is not the same building. `out bb` is two orders of
 * magnitude smaller than `out geom` and gives both the centre and the size; the
 * dataset side is reduced to its own bounding box so the two are comparable.
 *
 * All the authority rules live in scripts/height-rules.mjs, so this script and
 * scripts/audit-heights.mjs cannot disagree about what may overwrite what.
 *
 * Run: node scripts/repair-heights.mjs
 */
import { inScene, overpass, project, readData, ringArea, writeData } from './osm.mjs';
import { AUDIT_BBOX, bbox } from './osm-features.mjs';
import { CHECKLIST } from './landmark-checklist.mjs';
import { heightFromTags, plausible } from './height-rules.mjs';

const fmt = (n, d = 1) => Number(n).toFixed(d);

/** Only records that actually carry a height; ~4300 elements, not 86000. */
const res = await overpass(
  'height-tagged-all',
  `[out:json][timeout:300];(way["building"][~"^(height|building:levels)$"~"."](${AUDIT_BBOX}););out ids bb tags;`,
);

const tagged = [];
for (const el of res.elements) {
  if (!el.bounds) continue;
  const tag = heightFromTags(el.tags);
  if (!tag) continue;
  const lo = project(el.bounds.minlat, el.bounds.minlon);
  const hi = project(el.bounds.maxlat, el.bounds.maxlon);
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  if (!inScene(c[0], c[1])) continue;
  tagged.push({
    c,
    w: Math.abs(hi[0] - lo[0]),
    d: Math.abs(hi[1] - lo[1]),
    tag,
    name: el.tags.name || null,
  });
}
console.log(`OSM footprints in scene carrying a height: ${tagged.length}`);

const CELL = 60;
const grid = new Map();
for (const t of tagged) {
  const k = `${Math.floor(t.c[0] / CELL)},${Math.floor(t.c[1] / CELL)}`;
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(t);
}

/** Nearest tagged OSM record that agrees on size, within 12 m. */
function match(centre, w, d) {
  const gx = Math.floor(centre[0] / CELL);
  const gz = Math.floor(centre[1] / CELL);
  let best = null;
  let bd = 12;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const t of grid.get(`${gx + dx},${gz + dz}`) || []) {
        const dist = Math.hypot(t.c[0] - centre[0], t.c[1] - centre[1]);
        if (dist >= bd) continue;
        const rw = Math.max(t.w, w) / Math.max(1, Math.min(t.w, w));
        const rd = Math.max(t.d, d) / Math.max(1, Math.min(t.d, d));
        if (rw > 1.6 || rd > 1.6) continue;
        bd = dist;
        best = t;
      }
    }
  }
  return best;
}

const citedNames = new Set();
for (const spec of CHECKLIST) {
  if (spec.h == null) continue;
  for (const nm of [spec.n, ...(spec.alt || [])]) citedNames.add(nm.toLowerCase());
}

const data = readData();
let matched = 0;
let changed = 0;
let raised = 0;
let lowered = 0;
const held = new Map();
const notable = [];

for (const b of data.buildings) {
  if (!b.f || b.f.length < 4) continue;
  const bb = bbox(b.f);
  const centre = [(bb.minX + bb.maxX) / 2, (bb.minZ + bb.maxZ) / 2];
  const hit = match(centre, bb.maxX - bb.minX, bb.maxZ - bb.minZ);
  if (!hit) continue;
  matched++;
  const verdict = plausible(b, hit.tag, citedNames.has((b.n || '').toLowerCase()));
  if (!verdict.apply) {
    held.set(verdict.why, (held.get(verdict.why) || 0) + 1);
    continue;
  }
  const next = +hit.tag.h.toFixed(1);
  if (Math.abs(next - (b.h ?? 0)) < 0.6) continue;
  // Anything over 12 m of change on a large footprint is a visible silhouette
  // change and worth naming in the log rather than counting.
  if (Math.abs(next - (b.h ?? 0)) > 12 && Math.abs(ringArea(b.f)) > 600) {
    notable.push({ n: b.n || hit.name || '(unnamed)', from: b.h, to: next, src: hit.tag.source, c: centre });
  }
  if (next > (b.h ?? 0)) raised++;
  else lowered++;
  b.h = next;
  changed++;
}

console.log(`matched ${matched} dataset footprints to a tagged OSM record`);
console.log(`  heights changed: ${changed} (${raised} raised, ${lowered} lowered)`);
for (const [why, n] of [...held].sort((a, b) => b[1] - a[1])) console.log(`  held back ${n}: ${why}`);

if (notable.length) {
  console.log('\nlargest silhouette changes:');
  notable.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  for (const r of notable.slice(0, 30)) {
    console.log(
      `  ${r.n.padEnd(42)} ${String(r.from).padStart(6)}m -> ${String(r.to).padStart(6)}m  (${r.src}) at (${fmt(r.c[0], 0)},${fmt(r.c[1], 0)})`,
    );
  }
}

const atDefault = data.buildings.filter((b) => b.h === 14).length;
console.log(
  `\nstill at the 14 m build default: ${atDefault} of ${data.buildings.length} (${fmt((atDefault / data.buildings.length) * 100)}%)`,
);

data.meta.heightSource = 'OSM height and building:levels tags, matched geometrically over the whole stock';
writeData(data);
