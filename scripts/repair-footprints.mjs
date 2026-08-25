/**
 * Make the building footprints agree with OSM, in four passes.
 *
 * 1. RE-SEAT  A named footprint whose OSM twin sits somewhere else is replaced
 *    by the projected OSM ring. Tolerance is the same one scripts/audit-
 *    geography.mjs reports on, so anything the audit flags is what gets fixed.
 *
 * 2. INSERT   Substantial named OSM buildings with no counterpart in the
 *    dataset — a 21,600 m2 UPMC Presbyterian missing from the middle of Oakland,
 *    among others.
 *
 * 3. NAME     A footprint that carries no name because OSM does not name the
 *    building, only the site it stands on. Every big hospital in the city is
 *    mapped this way: an `amenity=hospital` area holding the name, with unnamed
 *    `building=*` wards inside it. The dataset had the wards and could not label
 *    any of them.
 *
 * 4. PRUNE    Footprints buried inside a bespoke landmark mesh, and unnamed
 *    twins of named footprints. PNC Park's own `building=grandstand` polygon is
 *    real OSM data, but extruding it as generic stock on top of the modelled
 *    ballpark puts a 17,200 m2 slab across the infield and a 47.6 m tower on the
 *    third-base line. Sixteen footprints stood inside PNC Park, Acrisure Stadium
 *    and the Convention Center that way.
 *
 * Every pass preserves `style`, `landmark`, `landmarkMesh`, `roof` and `field`:
 * those wire a footprint to src/textures.js and src/landmarks.js, and dropping
 * one turns a landmark back into generic stock.
 *
 * Run: node scripts/repair-footprints.mjs
 */
import polygonClipping from 'polygon-clipping';
import {
  inScene,
  overpass,
  readData,
  ringArea,
  ringFromGeometry,
  simplify,
  writeData,
} from './osm.mjs';
import {
  areaCentroid,
  AUDIT_BBOX,
  fetchNamedBuildings,
  hausdorff,
  indexByName,
  nameKey,
  nearestByName,
} from './osm-features.mjs';
import { anchorBinds, pointInRing, readRendererLandmarks } from './renderer-refs.mjs';
import { heightFromTags, plausible } from './height-rules.mjs';

const fmt = (n, d = 1) => Number(n).toFixed(d);
const absArea = (r) => Math.abs(ringArea(r));

/** File convention: footprints are stored at 0.1 m. */
function round(ring) {
  const out = ring.map(([x, z]) => [+x.toFixed(1), +z.toFixed(1)]);
  const a = out[0];
  const b = out[out.length - 1];
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01) out.push([a[0], a[1]]);
  return out;
}

/**
 * 3 m matches the resolution the rest of the file is already stored at — the
 * shipped footprints sit within 3.0 m Hausdorff of their OSM rings and 99% of
 * them are under 22 vertices. Importing raw OSM geometry instead put a
 * 111-vertex ring on Phipps Conservatory against a file maximum of 54, which
 * buys no visible accuracy and breaks the LOD budget's assumptions.
 */
const prepare = (ring) => round(simplify(ring, 3));

/**
 * Centroid grid over the dataset. The overlap tests below are O(footprints)
 * each and polygon clipping is not cheap; 7474 x every candidate is minutes of
 * wall clock for an answer that can only involve neighbours.
 */
function centroidGrid(buildings, cell) {
  const map = new Map();
  const grid = {
    add(b) {
      if (!b.f || b.f.length < 4) return;
      const c = areaCentroid(b.f);
      const k = `${Math.floor(c[0] / cell)},${Math.floor(c[1] / cell)}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ b, c });
    },
    near(x, z, radius = cell) {
      const span = Math.ceil(radius / cell);
      const out = [];
      const gx = Math.floor(x / cell);
      const gz = Math.floor(z / cell);
      for (let dx = -span; dx <= span; dx++) {
        for (let dz = -span; dz <= span; dz++) out.push(...(map.get(`${gx + dx},${gz + dz}`) || []));
      }
      return out;
    },
  };
  for (const b of buildings) grid.add(b);
  return grid;
}

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

/**
 * Named sites whose name belongs on the building standing inside them.
 *
 * These are the city's big hospitals, and OSM maps every one of them the same
 * way: an `amenity=hospital` AREA carrying the name, with the wards inside it as
 * unnamed `building=*`. There is nothing for a name match to find, so the
 * dataset had the buildings and could not label any of them. Inserting the site
 * polygon instead would extrude a whole 3.4 ha campus as one slab, so the name
 * goes onto the largest footprint standing inside it.
 *
 * `h` is a floor count times storey height, not a published figure, so it is
 * logged as an estimate.
 */
const SITES = [
  { name: 'Allegheny General Hospital', h: 84, why: 'the 20-floor Snyder Pavilion tower' },
  { name: 'UPMC Mercy', h: 47, why: '11 floors over the Uptown bluff' },
  { name: 'UPMC Magee-Womens Hospital', h: 44, why: '10 floors on Halket Street' },
];

/** Smallest named OSM building worth inserting on its own. */
const INSERT_MIN_AREA = 1500;

/**
 * An insert has to land in fabric the dataset already models.
 *
 * The dataset carries 8.7% of the OSM building stock, so most of the city's
 * ground is empty in the scene. Dropping a 17,000 m2 Lowe's into the middle of
 * that emptiness does not make the model more accurate-looking, it makes the
 * store read as a mistake: one lit box alone on bare terrain. Requiring
 * neighbours keeps this pass a densification of the modelled city rather than a
 * sprawl of isolated big-box stores across Homestead and the Waterfront.
 */
const INSERT_NEIGHBOURS = 6;
const INSERT_NEIGHBOUR_RADIUS = 400;

/**
 * Heights for inserted buildings that OSM leaves untagged. Floor counts, not
 * published heights, so they are estimates and are marked as such in the log.
 */
const INSERT_HEIGHTS = [
  { match: /^upmc presbyterian hospital$/i, h: 50, why: '12 floors of the main hospital block' },
];

/**
 * Fallback height by `building=` value, for footprints OSM names but does not
 * measure. The dataset-wide default of 14 m is a three-storey street wall and
 * is badly wrong for the two shapes that dominate this list: a 2800 m2 big-box
 * store is one tall storey, and a warehouse is a shed. Getting these wrong is
 * visible from anywhere in the scene, because the mass is large.
 */
const TYPE_HEIGHTS = [
  [/^(retail|supermarket|warehouse|industrial|commercial|kiosk|garage|garages|hangar)$/, 8],
  [/^(school|college|university|public|civic|government|hospital|hotel)$/, 12],
  [/^(church|cathedral|chapel|mosque|synagogue|temple|religious)$/, 12],
  [/^(house|detached|semidetached_house|bungalow)$/, 7],
  [/^(apartments|residential|dormitory)$/, 14],
];

/**
 * Height for a footprint OSM names, in falling order of authority: whatever the
 * OSM tags support, then a hand-checked figure, then the building type. The tag
 * parse is shared with scripts/height-rules.mjs so an inserted building is
 * measured the same way as one already in the file.
 */
function insertHeight(f) {
  const tag = heightFromTags(f.tags);
  if (tag) return { h: Math.max(4, tag.h), why: tag.source };
  const est = INSERT_HEIGHTS.find((s) => s.match.test(f.name));
  if (est) return { h: est.h, why: `estimate, ${est.why}` };
  const type = String(f.tags?.building || '');
  for (const [re, h] of TYPE_HEIGHTS) if (re.test(type)) return { h, why: `building=${type}` };
  return { h: 11, why: 'untyped default' };
}

const data = readData();
const osm = await fetchNamedBuildings();
const idx = indexByName(osm);
console.log(`dataset ${data.buildings.length} buildings, OSM ${osm.length} named footprints`);

// ------------------------------------------------------------- 1. re-seat

console.log('\n=== 1. re-seat footprints that disagree with OSM ===');
let reseated = 0;
for (const b of data.buildings) {
  if (!b.n || !b.f || b.f.length < 4) continue;
  const c = areaCentroid(b.f);
  const hit = nearestByName(idx, b.n, c[0], c[1], 400);
  if (!hit) continue;
  const ourA = absArea(b.f);
  if (ourA < 20 || hit.f.area < 20) continue;
  const d = Math.hypot(hit.f.c[0] - c[0], hit.f.c[1] - c[1]);
  const ratio = ourA / hit.f.area;
  const haus = hausdorff(b.f, hit.f.ring);
  const span = Math.sqrt(hit.f.area);
  if (d <= Math.max(10, span * 0.25) && haus <= 12 && ratio >= 0.6 && ratio <= 1.6) continue;

  const next = prepare(hit.f.ring);
  const nc = areaCentroid(next);
  console.log(
    `  ~ ${b.n}: centroid (${fmt(c[0], 0)},${fmt(c[1], 0)}) -> (${fmt(nc[0], 0)},${fmt(nc[1], 0)}), moved ${fmt(d)}m; ` +
      `area ${fmt(ourA, 0)} -> ${fmt(hit.f.area, 0)}m2; hausdorff was ${fmt(haus)}m; verts ${b.f.length - 1} -> ${next.length - 1}`,
  );
  b.f = next;
  reseated++;
}
console.log(`  ${reseated} re-seated`);

// -------------------------------------------------------------- 2. insert

console.log('\n=== 2. insert substantial named OSM buildings that are absent ===');
const datasetByKey = new Map();
for (const b of data.buildings) {
  if (!b.n) continue;
  const k = nameKey(b.n);
  if (!datasetByKey.has(k)) datasetByKey.set(k, []);
  datasetByKey.get(k).push(b);
}

let inserted = 0;
let skippedBare = 0;
const insertGrid = centroidGrid(data.buildings, 150);
const accepted = centroidGrid([], 150);
const candidates = osm
  .filter((f) => f.area >= INSERT_MIN_AREA && inScene(f.c[0], f.c[1]))
  .sort((a, b) => b.area - a.area);
for (const f of candidates) {
  const k = nameKey(f.name);
  const twins = datasetByKey.get(k) || [];
  if (twins.some((b) => Math.hypot(areaCentroid(b.f)[0] - f.c[0], areaCentroid(b.f)[1] - f.c[1]) < 400)) continue;
  // A footprint already covering this ground under another name is the same
  // building mapped differently, not a gap.
  const reach = Math.sqrt(f.area) + 150;
  const neighbourhood = insertGrid.near(f.c[0], f.c[1], Math.max(INSERT_NEIGHBOUR_RADIUS, reach));
  const neighbours = neighbourhood.filter(
    ({ c }) => Math.hypot(c[0] - f.c[0], c[1] - f.c[1]) <= INSERT_NEIGHBOUR_RADIUS,
  ).length;
  if (neighbours < INSERT_NEIGHBOURS) {
    skippedBare++;
    continue;
  }
  const covered = neighbourhood.some(({ b }) => overlapFraction(b.f, f.ring) > 0.5);
  if (covered) continue;

  // OSM often names one physical building twice — "Colfax Elementary School"
  // and "Pittsburgh Colfax K-8" are the same block under its old and new names.
  // Candidates are walked largest-first, so the first one wins the ground.
  if (accepted.near(f.c[0], f.c[1], reach).some(({ b }) => overlapFraction(b.f, f.ring) > 0.5)) {
    continue;
  }

  const ring = prepare(f.ring);
  const { h, why } = insertHeight(f);
  const rec = { f: ring, h: +h.toFixed(1), n: f.name };
  data.buildings.push(rec);
  accepted.add(rec);
  datasetByKey.set(k, [...twins, rec]);
  inserted++;
  console.log(
    `  + ${f.name}: ${fmt(f.area, 0)}m2 at (${fmt(f.c[0], 0)},${fmt(f.c[1], 0)}) h=${rec.h}m (${why})`,
  );
}
console.log(
  `  ${inserted} inserted, ${skippedBare} skipped for standing on ground the dataset does not model`,
);

// ---------------------------------------------------------------- 3. name

console.log('\n=== 3. name footprints that only their site names in OSM ===');
let named = 0;
for (const site of SITES) {
  if (data.buildings.some((b) => b.n && nameKey(b.n) === nameKey(site.name))) {
    console.log(`  = ${site.name}: already named`);
    continue;
  }
  const res = await overpass(
    `site-${site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    `[out:json][timeout:120];way["amenity"="hospital"]["name"="${site.name}"](${AUDIT_BBOX});out geom tags;`,
  );
  const el = res.elements.find((e) => e.geometry?.length > 3);
  if (!el) {
    console.log(`  ! ${site.name}: site polygon not found in OSM`);
    continue;
  }
  const ring = ringFromGeometry(el.geometry);
  if (!ring) {
    console.log(`  ! ${site.name}: site polygon has no usable ring`);
    continue;
  }
  // The site's identity belongs on the largest building standing in it, but only
  // if that building really is the institution. OSM maps the Magee campus
  // boundary and no building inside it at all, so the largest footprint there is
  // a 285 m2 outbuilding; putting a 44 m hospital height on it would stand a
  // needle in Oakland. The pass declines rather than guess, and says so — a gap
  // in OSM is not something the dataset can be repaired out of.
  const siteArea = absArea(ring);
  let best = null;
  for (const b of data.buildings) {
    if (b.n || !b.f || b.f.length < 4) continue;
    const c = areaCentroid(b.f);
    if (!pointInRing(c[0], c[1], ring)) continue;
    if (!best || absArea(b.f) > absArea(best.f)) best = b;
  }
  if (!best) {
    console.log(`  ! ${site.name}: no unnamed footprint inside the site polygon`);
    continue;
  }
  const area = absArea(best.f);
  const c = areaCentroid(best.f);
  const verdict = plausible({ ...best, h: 0 }, { h: site.h, exact: false }, false);
  if (area < Math.min(4000, siteArea * 0.1) || !verdict.apply) {
    console.log(
      `  ! ${site.name}: largest unnamed footprint in the ${fmt(siteArea, 0)}m2 site is only ` +
        `${fmt(area, 0)}m2 at (${fmt(c[0], 0)},${fmt(c[1], 0)})` +
        `${verdict.apply ? '' : ` — ${verdict.why}`}; left unnamed`,
    );
    continue;
  }
  console.log(
    `  ~ ${site.name}: named the ${fmt(area, 0)}m2 footprint at (${fmt(c[0], 0)},${fmt(c[1], 0)}), ` +
      `h ${best.h} -> ${site.h}m (estimate, ${site.why})`,
  );
  best.n = site.name;
  best.h = site.h;
  named++;
}
console.log(`  ${named} named`);

// --------------------------------------------------------------- 4. prune

console.log('\n=== 4. prune footprints buried inside another ===');
const meshHosts = data.buildings.filter((b) => b.landmarkMesh && b.f && b.f.length > 3);
const drop = new Set();

for (const host of meshHosts) {
  for (const b of data.buildings) {
    if (b === host || drop.has(b) || !b.f || b.f.length < 4) continue;
    if (b.landmarkMesh || b.landmark) continue;
    if (absArea(b.f) >= absArea(host.f)) continue;
    if (overlapFraction(b.f, host.f) < 0.85) continue;
    drop.add(b);
    console.log(
      `  - ${fmt(absArea(b.f), 0).padStart(7)}m2 h=${String(b.h).padStart(5)} ${(b.n || '(unnamed)').padEnd(30)} inside ${host.n}`,
    );
  }
}

// Unnamed twins of a named footprint: the same building mapped twice.
const sorted = [...data.buildings]
  .filter((b) => b.f && b.f.length > 3 && !drop.has(b))
  .sort((a, b) => absArea(b.f) - absArea(a.f));
const CELL = 120;
const grid = new Map();
for (const b of sorted) {
  const c = areaCentroid(b.f);
  const k = `${Math.floor(c[0] / CELL)},${Math.floor(c[1] / CELL)}`;
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push({ b, c });
}
let twinned = 0;
for (const b of sorted) {
  if (drop.has(b) || !b.n) continue;
  const c = areaCentroid(b.f);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const q of grid.get(`${Math.floor(c[0] / CELL) + dx},${Math.floor(c[1] / CELL) + dz}`) || []) {
        const o = q.b;
        if (o === b || drop.has(o) || o.landmarkMesh || o.landmark) continue;
        // Only an unnamed twin, or a same-named duplicate, is redundant. Two
        // differently named buildings nested in each other are real: OSM maps
        // the Wightman School inside the Carriage House complex.
        const sameName = o.n && nameKey(o.n) === nameKey(b.n);
        if (o.n && !sameName) continue;
        if (overlapFraction(b.f, o.f) < 0.85) continue;
        if (absArea(o.f) > absArea(b.f)) continue;
        drop.add(o);
        twinned++;
        console.log(
          `  - ${fmt(absArea(o.f), 0).padStart(7)}m2 h=${String(o.h).padStart(5)} ${(o.n || '(unnamed)').padEnd(30)} duplicate of ${b.n}`,
        );
      }
    }
  }
}

const before = data.buildings.length;
data.buildings = data.buildings.filter((b) => !drop.has(b));
console.log(`  ${before - data.buildings.length} pruned (${drop.size - twinned} inside a landmark mesh, ${twinned} duplicates)`);

// ----------------------------------------------------- renderer coordinates

/**
 * src/architecture.js LANDMARKS and src/landmarks.js INCLINES hard-code
 * positions, and a landmark's crown only binds when its anchor lands inside the
 * footprint. Moving a footprint can therefore silently un-model a landmark, so
 * any anchor left stranded is reported here rather than edited: those files
 * belong to the rendering side.
 */
console.log('\n=== renderer anchors after the repair ===');
const anchors = readRendererLandmarks();
let broken = 0;
for (const lm of anchors) {
  const claimants = data.buildings.filter(
    (b) => b.f && b.f.length > 3 && anchorBinds(lm, b.f, areaCentroid(b.f)) != null,
  );
  if (claimants.length) continue;
  broken++;
  // Report the footprint that should own it so the fix is a coordinate, not a search.
  const owner = data.buildings
    .filter((b) => b.n && nameKey(b.n) === nameKey(lm.n) && b.f?.length > 3)
    .sort((a, b) => absArea(b.f) - absArea(a.f))[0];
  const c = owner ? areaCentroid(owner.f) : null;
  console.log(
    `  UNBOUND ${lm.n}: anchor (${lm.at[0]},${lm.at[1]}) r=${lm.r}` +
      (c
        ? ` -> set at: [${fmt(c[0])}, ${fmt(c[1])}] (area centroid of the ${fmt(absArea(owner.f), 0)}m2 footprint)`
        : ' -> no footprint of that name in the dataset'),
  );
}
console.log(`  ${anchors.length} anchors, ${broken} unbound`);

data.meta.footprintRepair =
  'named footprints re-seated on their OSM rings, absent named buildings inserted, footprints buried inside a landmark mesh pruned';
writeData(data);
console.log(`\nbuildings now ${data.buildings.length}`);
