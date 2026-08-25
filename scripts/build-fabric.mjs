/**
 * Build the city's background building fabric: every OSM building in the scene
 * box that public/data/pittsburgh.json does NOT already model.
 *
 * Why this file exists. The shipped dataset carries ~7.5k footprints against the
 * ~87k that OpenStreetMap maps inside the scene box, and the shortfall is not
 * spread evenly: downtown is 91% complete while Squirrel Hill is 6% and the West
 * End 4%. On screen that reads as a correct downtown surrounded by a thin
 * scatter of buildings on empty green, because the thing that makes a
 * neighbourhood look like a neighbourhood is the continuous street wall, not the
 * few named buildings on it. This script produces that street wall as a separate
 * layer so the authored dataset (landmark meshes, styles, roof crowns, hand
 * checked heights) stays exactly as it is and can keep being edited by hand.
 *
 * Run:
 *   node scripts/build-fabric.mjs                      # full coverage
 *   node scripts/build-fabric.mjs --max=30000          # cap, inner districts first
 *   node scripts/build-fabric.mjs --refresh            # refetch every Overpass tile
 *   node scripts/build-fabric.mjs --tiles=8x6 --tolerance=1.0 --verts=16 --min-area=20
 *   node scripts/audit-fabric.mjs                      # verify the result
 *
 * Writes public/data/fabric.json. Never touches public/data/pittsburgh.json.
 *
 * Records use the same compact keys as the dataset — `f` footprint, `h` height,
 * `n` name — so the renderer can extrude both files through one code path. The
 * only addition is `hs`, the height provenance, which the audit reads.
 *
 * The buildings array is ordered inner districts first, outer last, and within a
 * district largest footprint first, so `--max` (or a plain `.slice()` in the
 * renderer) degrades by dropping the outskirts and the smallest sheds rather
 * than by punching holes in the middle of the city. `meta.districts` records the
 * offset and length of each district's run for the same reason.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import polygonClipping from 'polygon-clipping';
import {
  inScene,
  largestRing,
  overpass,
  ringArea,
  ringFromGeometry,
  ROOT,
  SCENE,
  simplify,
  unproject,
} from './osm.mjs';
import { areaCentroid, bbox, groupRelationWays, percentile } from './osm-features.mjs';
import { heightFromTags, narrowestExtent, plausible } from './height-rules.mjs';
import { pointInRing } from './renderer-refs.mjs';

const CACHE = join(ROOT, 'scripts/osm-cache');
const DATA_PATH = join(ROOT, 'public/data/pittsburgh.json');
const OUT_PATH = join(ROOT, 'public/data/fabric.json');

const fmt = (n, d = 1) => Number(n).toFixed(d);
const absArea = (r) => Math.abs(ringArea(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};
const OPT = {
  refresh: flag('refresh', false) !== false,
  max: Number(flag('max', Infinity)),
  tolerance: Number(flag('tolerance', 1.0)),
  verts: Number(flag('verts', 16)),
  minArea: Number(flag('min-area', 20)),
  tiles: String(flag('tiles', '8x6')),
};
const [TILE_COLS, TILE_ROWS] = OPT.tiles.split('x').map(Number);

// ----------------------------------------------------------------- districts
//
// The first eleven boxes are copied verbatim from scripts/audit-coverage.mjs so
// the coverage table this script prints is directly comparable with the one that
// audit reports — a district drawn even slightly differently would produce a
// different denominator and the two scripts would appear to disagree. They do
// not tile the scene, so a final catch-all box carries everything else (Polish
// Hill, Bloomfield, Troy Hill, Greenfield, Homewood, the Waterfront).
//
// `k` is the district's built character, which is what decides an untagged
// building's height further down. `p` is the priority order for `--max`:
// downtown and the inner ring first, the outskirts last.

const DISTRICTS = [
  { n: 'Golden Triangle', minX: -800, maxX: 900, minZ: -600, maxZ: 700, k: 'core', p: 1 },
  { n: 'North Shore / Allegheny', minX: -1800, maxX: 900, minZ: -1900, maxZ: -600, k: 'mixed', p: 2 },
  { n: 'Strip District', minX: 900, maxX: 2600, minZ: -1500, maxZ: -300, k: 'industrial', p: 3 },
  { n: 'Hill District', minX: 900, maxX: 3000, minZ: -300, maxZ: 900, k: 'rowhouse', p: 4 },
  { n: 'Oakland', minX: 3000, maxX: 5200, minZ: -900, maxZ: 600, k: 'institutional', p: 5 },
  { n: 'South Side Flats', minX: 600, maxX: 3400, minZ: 900, maxZ: 2000, k: 'rowhouse', p: 6 },
  { n: 'Mount Washington', minX: -1600, maxX: 600, minZ: 600, maxZ: 1800, k: 'rowhouse', p: 7 },
  { n: 'Lawrenceville', minX: 1800, maxX: 3800, minZ: -3200, maxZ: -1200, k: 'rowhouse', p: 8 },
  { n: 'Shadyside / E Liberty', minX: 5000, maxX: 7200, minZ: -2800, maxZ: -600, k: 'residential', p: 9 },
  { n: 'Squirrel Hill', minX: 5200, maxX: 7600, minZ: 0, maxZ: 2000, k: 'residential', p: 10 },
  { n: 'West End / McKees Rocks', minX: -4600, maxX: -1800, minZ: -1000, maxZ: 1600, k: 'industrial', p: 11 },
  { n: 'Outer neighbourhoods', minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity, k: 'residential', p: 12 },
];

const districtAt = (x, z) =>
  DISTRICTS.find((d) => x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ);

// -------------------------------------------------------------------- heights
//
// Requirement: do not hand every untagged building the same number. Half the
// existing dataset sits at a flat 14 m and that is exactly why whole
// neighbourhoods read as one extruded slab — a uniform height removes the
// silhouette that tells a viewer a rowhouse street from a warehouse district.
//
// So an untagged footprint's height is inferred from what its plan area and its
// district imply about the building, in this order:
//
//   1. `building=` value, when OSM states one. A tag is information and it beats
//      any guess from geometry. The values below match the TYPE_HEIGHTS table in
//      scripts/repair-footprints.mjs where they overlap (house 7, retail and
//      warehouse 8, school and church 12) so the two importers cannot disagree
//      about the same building. `apartments` is the one deliberate divergence:
//      that table's 14 m is the very default this layer exists to avoid, so an
//      apartment block is floored at three storeys and otherwise follows its
//      district's curve — three storeys in Lawrenceville, more in Shadyside.
//
//   2. Plan area against the district's curve. The curve is a table of
//      "footprints smaller than A m2 are S storeys". The numbers come from what
//      these districts physically are: a Pittsburgh rowhouse is a ~20 x 35 ft
//      party-wall block, so 130 m2 is the top of the two-storey band and
//      anything under ~45 m2 is a back-lot garage rather than a dwelling. Leafy
//      streets (Squirrel Hill, Shadyside) hold detached four-squares, so their
//      two-storey band runs to 200 m2.
//
//   3. Above the curve's last band the footprint is too big to be storeys of
//      housing — it is a school, a church hall, a supermarket, a mill. Those are
//      wide-span single volumes, and stacking notional floors on them is how a
//      big-box store ends up eight storeys tall, so the district's `wide` height
//      is used as an absolute instead of a multiple.
//
// The result is then nudged by up to +-7% using a hash of the OSM id. A real
// rowhouse terrace is not flat across its roofline, and without the nudge every
// footprint in a band gets a height identical to the metre, which reproduces the
// slab effect at a different height. The nudge is a function of the id, so the
// output is byte-for-byte reproducible.

const PROFILES = {
  core: { floor: 3.9, roof: 1.2, curve: [[60, 1], [200, 3], [600, 5], [2000, 8]], wide: 22 },
  mixed: { floor: 3.6, roof: 1.0, curve: [[50, 1], [150, 2], [500, 3], [1500, 4]], wide: 10 },
  institutional: { floor: 3.9, roof: 1.2, curve: [[50, 1], [200, 2], [800, 3], [3000, 4]], wide: 14 },
  industrial: { floor: 3.6, roof: 0.8, curve: [[50, 1], [150, 2], [600, 2], [2000, 2]], wide: 9 },
  rowhouse: { floor: 3.4, roof: 1.0, curve: [[45, 1], [130, 2], [400, 2.5], [1200, 3]], wide: 9 },
  residential: { floor: 3.4, roof: 1.1, curve: [[45, 1], [200, 2], [600, 2.5], [1500, 3]], wide: 10 },
};

/** Absolute heights for `building=` values that describe the whole massing. */
const TYPE_ABSOLUTE = [
  [/^(garage|garages|shed|carport|hut|cabin|shelter|greenhouse|container)$/, 3.2],
  [/^(roof|canopy)$/, 4.0],
  [/^(warehouse|industrial|factory|manufacture|hangar|silo|storage_tank|works)$/, 9],
  [/^(retail|supermarket|kiosk|service|commercial)$/, 8],
  [/^(school|college|university|kindergarten|civic|public|government|hospital|fire_station|train_station)$/, 12],
  [/^(church|cathedral|chapel|mosque|synagogue|temple|religious|monastery)$/, 12],
  [/^(hotel)$/, 16],
  [/^(stadium|sports_hall|sports_centre|pavilion|grandstand)$/, 12],
];

/** `building=` values that fix a storey count instead of an absolute height. */
const TYPE_STOREYS = [
  [/^(bungalow|static_caravan)$/, 1],
  [/^(house|detached|semidetached_house|farm)$/, 2],
  [/^(terrace|terraced_house|row_house|rowhouse|houseboat)$/, 2.4],
  [/^(apartments|residential|dormitory|barracks)$/, 3],
];

/**
 * A `building=` value only describes the whole massing if the footprint is big
 * enough to be that thing. There are 51 footprints of 20-60 m2 in the box
 * carrying `commercial`, `retail`, `stadium` or `university`; they are kiosks,
 * ticket huts and campus sheds, and handing them their type's height stands a
 * 12 m needle on a 3 m wide plan. Below this area the district curve decides.
 */
const TYPE_MIN_AREA = 60;

/** Deterministic ±1 from an OSM id, so re-runs produce an identical file. */
function jitter(id) {
  let h = (id | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (((h ^ (h >>> 16)) >>> 0) % 2001) / 1000 - 1;
}

function storeysFromArea(profile, area) {
  for (const [limit, storeys] of profile.curve) if (area < limit) return storeys;
  return null;
}

/**
 * `{ h, hs }` where `hs` is `t` (measured height tag), `l` (levels estimate) or
 * `i` (inferred here). Tag parsing and the sanity check on a tag come from
 * scripts/height-rules.mjs, so a fabric building is measured by exactly the
 * rules the height audit enforces on the dataset.
 */
function decideHeight(ring, area, tags, district, id) {
  const tag = heightFromTags(tags);
  if (tag && tag.h <= 260) {
    // `plausible` wants a dataset record; `h: 0` makes it judge the tag on its
    // own merits, which here is only the slenderness guard — it is what stops a
    // stray `height=40` on a 4 m wide garage becoming a needle.
    const verdict = plausible({ f: ring, h: 0 }, tag, false);
    if (verdict.apply) return { h: Math.max(3, tag.h), hs: tag.exact ? 't' : 'l' };
  }

  const profile = PROFILES[district.k];
  const type = String(tags.building || '');
  let h = null;
  for (const [re, metres] of TYPE_ABSOLUTE) {
    if (re.test(type) && (metres <= 6 || area >= TYPE_MIN_AREA)) h = metres;
  }
  if (h == null) {
    let storeys = null;
    for (const [re, s] of TYPE_STOREYS) if (re.test(type)) storeys = s;
    if (storeys == null) storeys = storeysFromArea(profile, area);
    h = storeys == null ? profile.wide : storeys * profile.floor + profile.roof;
  }

  h *= 1 + 0.07 * jitter(id);
  // Never stand a tower on a sliver: the same slenderness ceiling the shared
  // rules apply to an OSM tag also applies to an inferred height.
  const narrow = narrowestExtent(ring);
  if (narrow > 0) h = Math.min(h, Math.max(4, narrow * 6));
  return { h: Math.max(3, h), hs: 'i' };
}

// ------------------------------------------------------------ Overpass tiling
//
// One query for 87k building ways is a 70 MB response that times out on every
// public endpoint, so the scene box is split into a grid and each cell fetched
// separately. Tiles are padded slightly and overlap, because a `way(bbox)` query
// only returns ways with a node inside the box and a building sitting on a tile
// seam has to appear in one of them; duplicates are dropped by OSM id.
//
// The raw responses are not what gets cached. scripts/osm-cache is under version
// control and 70 MB of Overpass JSON does not belong there (audit-coverage.mjs
// hit the same wall and solved it the same way), so each tile is reduced to a
// gzipped digest of projected rings plus the four tags that matter and the raw
// entry is deleted. Rings in the digest are unsimplified at the file's 0.1 m
// convention, so simplification tolerance stays a build-time choice.

const HEIGHT_TAGS = ['building', 'height', 'building:height', 'building:levels', 'name'];

function tileBoxes() {
  const [nLat, wLon] = unproject(SCENE.minX, SCENE.minZ);
  const [sLat, eLon] = unproject(SCENE.maxX, SCENE.maxZ);
  const pad = 0.0006;
  const boxes = [];
  for (let r = 0; r < TILE_ROWS; r++) {
    for (let c = 0; c < TILE_COLS; c++) {
      const lat0 = sLat + ((nLat - sLat) * r) / TILE_ROWS - pad;
      const lat1 = sLat + ((nLat - sLat) * (r + 1)) / TILE_ROWS + pad;
      const lon0 = wLon + ((eLon - wLon) * c) / TILE_COLS - pad;
      const lon1 = wLon + ((eLon - wLon) * (c + 1)) / TILE_COLS + pad;
      boxes.push({ r, c, bbox: `${lat0.toFixed(5)},${lon0.toFixed(5)},${lat1.toFixed(5)},${lon1.toFixed(5)}` });
    }
  }
  return boxes;
}

function digestEntry(kind, id, ring, tags) {
  const g = {};
  for (const k of HEIGHT_TAGS) if (tags?.[k] != null) g[k] = String(tags[k]);
  return { i: `${kind[0]}${id}`, r: ring, g };
}

/**
 * `overpass()` already fails over between three endpoints, but with 48 tiles the
 * public instances hand out 429s and 504s in bursts, so an outer loop waits
 * minutes rather than seconds before giving up on a tile.
 */
async function fetchTile(name, query) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await overpass(name, query, { refresh: OPT.refresh && attempt === 0 });
    } catch (err) {
      lastErr = err;
      const wait = 20000 * (attempt + 1);
      console.log(`  ${name}: all endpoints failed, waiting ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw new Error(`tile ${name} failed: ${lastErr?.message}`);
}

async function tileDigest(tile) {
  const digestPath = join(CACHE, `fabric-digest-r${tile.r}c${tile.c}.json.gz`);
  if (!OPT.refresh && existsSync(digestPath)) {
    return JSON.parse(gunzipSync(readFileSync(digestPath)).toString('utf8'));
  }
  const name = `fabric-tile-r${tile.r}c${tile.c}`;
  const res = await fetchTile(
    name,
    `[out:json][timeout:300];way["building"](${tile.bbox});out geom tags;`,
  );

  const entries = [];
  for (const el of res.elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    if (el.tags?.building === 'no') continue;
    const ring = ringFromGeometry(el.geometry);
    if (!ring) continue;
    const b = bbox(ring);
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    if (!inScene(cx, cz)) continue;
    entries.push(digestEntry('way', el.id, ring.map(([x, z]) => [+x.toFixed(1), +z.toFixed(1)]), el.tags));
  }
  writeFileSync(digestPath, gzipSync(JSON.stringify(entries)));
  const raw = join(CACHE, `${name}.json`);
  if (existsSync(raw)) rmSync(raw);
  console.log(
    `  tile r${tile.r}c${tile.c}: ${res.elements.length} ways -> ${entries.length} in scene ` +
      `(digest ${fmt(statSync(digestPath).size / 1024, 0)} KB)`,
  );
  await sleep(400);
  return entries;
}

/**
 * The 97 building relations in the box, fetched in one query. `out geom` on a
 * relation comes back from the public instances with an empty member list, so
 * the `foreach` form from scripts/osm-features.mjs is the only one that returns
 * usable geometry.
 */
async function relationDigest() {
  const digestPath = join(CACHE, 'fabric-digest-rels.json.gz');
  if (!OPT.refresh && existsSync(digestPath)) {
    return JSON.parse(gunzipSync(readFileSync(digestPath)).toString('utf8'));
  }
  const [nLat, wLon] = unproject(SCENE.minX, SCENE.minZ);
  const [sLat, eLon] = unproject(SCENE.maxX, SCENE.maxZ);
  const box = `${sLat.toFixed(5)},${wLon.toFixed(5)},${nLat.toFixed(5)},${eLon.toFixed(5)}`;
  const res = await fetchTile(
    'fabric-tile-rels',
    `[out:json][timeout:300];rel["building"](${box})->.r;foreach.r->.x(.x out tags;way(r.x);out geom;);`,
  );
  const entries = [];
  for (const g of groupRelationWays(res.elements)) {
    if (g.tags?.building === 'no') continue;
    const ring = largestRing({
      type: 'relation',
      members: g.ways.map((w) => ({ role: 'outer', geometry: w.geometry })),
    });
    if (!ring) continue;
    const b = bbox(ring);
    if (!inScene((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2)) continue;
    entries.push(digestEntry('relation', g.id, ring.map(([x, z]) => [+x.toFixed(1), +z.toFixed(1)]), g.tags));
  }
  writeFileSync(digestPath, gzipSync(JSON.stringify(entries)));
  const raw = join(CACHE, 'fabric-tile-rels.json');
  if (existsSync(raw)) rmSync(raw);
  console.log(`  relations: ${entries.length} in scene`);
  return entries;
}

// --------------------------------------------------------------- deduplication
//
// A footprint that already exists in pittsburgh.json must not be extruded twice:
// two coincident walls z-fight, and a 14 m default standing inside a 30 m
// authored tower puts a visible collar around it. Matching has to be geometric
// because only 1370 of the dataset's buildings carry a name.
//
// Footprints in this city sit 3 m apart, so proximity alone is not a match. Two
// independent tests run, and either one is enough to reject a candidate:
//
//   - area overlap above 40% of the smaller footprint. This is the direct
//     measure of whether the two would fight for the same ground, and it is
//     immune to the rowhouse case: neighbouring terraces share a party wall and
//     overlap by nothing at all.
//   - the centroid / area-ratio / Hausdorff triple that
//     scripts/repair-footprints.mjs uses to decide a dataset footprint agrees
//     with its OSM twin, at tolerances scaled to the footprint (see below),
//     which catches one the dataset stores heavily simplified or rotated.
//
// In the event the first test does all the work: 7528 of 7528 matches are found
// by overlap and none by the fallback, which is a restatement of the fact that
// the dataset already agrees with OSM to a median 0.1 m.

const MATCH_OVERLAP = 0.4;

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

function pointRingDist(p, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, az] = ring[i];
    const dx = ring[i + 1][0] - ax;
    const dz = ring[i + 1][1] - az;
    const l2 = dx * dx + dz * dz;
    let d;
    if (l2 < 1e-12) d = Math.hypot(p[0] - ax, p[1] - az);
    else {
      let t = ((p[0] - ax) * dx + (p[1] - az) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      d = Math.hypot(p[0] - (ax + dx * t), p[1] - (az + dz * t));
    }
    if (d < best) best = d;
  }
  return best;
}

function hausdorffCapped(a, b, cap) {
  let m = 0;
  for (const p of a) {
    m = Math.max(m, pointRingDist(p, b));
    if (m > cap) return m;
  }
  for (const p of b) {
    m = Math.max(m, pointRingDist(p, a));
    if (m > cap) return m;
  }
  return m;
}

/**
 * Area of the bounding-box intersection — an upper bound on the area two rings
 * can share, so it rejects most neighbours before polygon clipping runs. A bare
 * "do the boxes touch" test does not: every rowhouse in a terrace touches its
 * neighbours' boxes, which is exactly the case there are 70000 of.
 */
function bbOverlapArea(a, b) {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Why these two footprints are the same building, or null.
 *
 * Shared ground comes first, because it is the direct measure of whether the two
 * extrusions would fight — and it has to be asked even of a pair whose centroids
 * are far apart, since a 48 m2 shed mapped inside a 1300 m2 mill sits nowhere
 * near its centre and is still a duplicate of it.
 *
 * The centroid / size / Hausdorff fallback catches a dataset footprint stored
 * simplified or rotated a few degrees off its OSM twin, and its tolerances have
 * to scale with the footprint. repair-footprints.mjs can afford flat 10 m and
 * 12 m limits because it has already established identity by name; here there is
 * no name, and a flat 12 m Hausdorff limit calls two adjacent rowhouses of
 * similar size the same building — it deleted 14620 real footprints when this
 * was first run. Taken relative to the smaller footprint's span the same rule is
 * 2.5 m and 4 m on a 100 m2 rowhouse, widening to repair-footprints' figures on
 * a 10000 m2 warehouse where 10 m really is within the noise of how a big shed
 * gets traced.
 */
function sameBuilding(candidate, other) {
  const minArea = Math.min(candidate.area, other.area);
  if (
    bbOverlapArea(candidate.bb, other.bb) >= MATCH_OVERLAP * minArea &&
    overlapFraction(candidate.ring, other.ring) >= MATCH_OVERLAP
  ) {
    return 'overlap';
  }

  const d = Math.hypot(candidate.c[0] - other.c[0], candidate.c[1] - other.c[1]);
  const span = Math.sqrt(minArea);
  const dTol = Math.min(10, Math.max(1.5, span * 0.25));
  if (d > dTol) return null;
  const ratio = candidate.area / other.area;
  if (ratio < 0.65 || ratio > 1.55) return null;
  const hTol = Math.min(12, Math.max(2.5, span * 0.4));
  return hausdorffCapped(candidate.ring, other.ring, hTol) <= hTol ? 'centroid+size' : null;
}

/** Centroid bucket index; every geometric test only involves neighbours. */
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

// ------------------------------------------------------------------- water
//
// Nothing may be extruded out of the river. The dataset's own water rings are
// the authority (scripts/verify-water.mjs tests the same way), and a footprint
// is judged by its centroid: the stitched banks overshoot the real shoreline by
// a metre or two in places, so testing every vertex would delete legitimate
// riverfront warehouses.

function waterTester(water) {
  return (x, z) => {
    for (const w of water) {
      if (!pointInRing(x, z, w.f)) continue;
      if ((w.holes || []).some((h) => pointInRing(x, z, h))) continue;
      return true;
    }
    return false;
  };
}

// ------------------------------------------------------------------ pipeline

console.log(`fabric build: ${TILE_COLS}x${TILE_ROWS} tiles, tolerance ${OPT.tolerance}m, vertex cap ${OPT.verts}, min area ${OPT.minArea}m2`);

const tiles = tileBoxes();
const seen = new Set();
const stock = [];
for (const tile of tiles) {
  for (const e of await tileDigest(tile)) {
    if (seen.has(e.i)) continue;
    seen.add(e.i);
    stock.push(e);
  }
}
for (const e of await relationDigest()) {
  if (seen.has(e.i)) continue;
  seen.add(e.i);
  stock.push(e);
}
console.log(`\nOSM building stock in scene: ${stock.length} distinct footprints`);

const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
const wet = waterTester(data.water || []);

const datasetGrid = centroidGrid(60);
let datasetInScene = 0;
for (const b of data.buildings) {
  if (!b.f || b.f.length < 4) continue;
  const c = areaCentroid(b.f);
  const bb = bbox(b.f);
  if (!inScene((bb.minX + bb.maxX) / 2, (bb.minZ + bb.maxZ) / 2)) continue;
  datasetInScene++;
  datasetGrid.add({ ring: b.f, c, bb, area: absArea(b.f), name: b.n });
}
console.log(`dataset buildings in scene: ${datasetInScene}`);

// Largest first, so when two OSM footprints describe the same building the
// bigger one wins the ground and the smaller annex is the one dropped.
const candidates = [];
for (const e of stock) {
  const ring = e.r;
  if (!ring || ring.length < 4) continue;
  const area = absArea(ring);
  candidates.push({ id: e.i, ring, area, tags: e.g || {}, c: areaCentroid(ring), bb: bbox(ring) });
}
candidates.sort((a, b) => b.area - a.area);

const reject = { tiny: 0, water: 0, dupDataset: 0, dupSelf: 0, degenerate: 0 };
const dupWhy = { overlap: 0, 'centroid+size': 0 };
const acceptedGrid = centroidGrid(60);
const accepted = [];

for (const cand of candidates) {
  if (cand.area < OPT.minArea) {
    reject.tiny++;
    continue;
  }
  const bbc = [(cand.bb.minX + cand.bb.maxX) / 2, (cand.bb.minZ + cand.bb.maxZ) / 2];
  if (wet(bbc[0], bbc[1]) || wet(cand.c[0], cand.c[1])) {
    reject.water++;
    continue;
  }
  // Generous enough that a footprint mapped inside a much larger one is still
  // compared against it; the bounding-box prefilter keeps the cost down.
  const reach = Math.max(80, Math.sqrt(cand.area));

  let dup = null;
  for (const other of datasetGrid.near(cand.c[0], cand.c[1], reach)) {
    dup = sameBuilding(cand, other);
    if (dup) break;
  }
  if (dup) {
    reject.dupDataset++;
    dupWhy[dup]++;
    continue;
  }
  for (const other of acceptedGrid.near(cand.c[0], cand.c[1], reach)) {
    if (sameBuilding(cand, other)) {
      dup = true;
      break;
    }
  }
  if (dup) {
    reject.dupSelf++;
    continue;
  }

  const district = districtAt(bbc[0], bbc[1]);
  const { h, hs } = decideHeight(cand.ring, cand.area, cand.tags, district, Number(cand.id.slice(1)));

  // Simplify to the target tolerance, then keep loosening until the ring fits
  // the vertex budget. These are background masses seen from hundreds of metres
  // away; a 40-vertex apse costs the renderer real geometry and reads identically
  // to a 12-vertex one.
  let tol = OPT.tolerance;
  let ring = simplify(cand.ring, tol);
  while (ring.length - 1 > OPT.verts && tol < 12) {
    tol *= 1.6;
    ring = simplify(cand.ring, tol);
  }
  ring = ring.map(([x, z]) => [+x.toFixed(1), +z.toFixed(1)]);
  // Rounding can collapse a coincident pair; drop repeats but keep closure.
  const clean = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i];
    const q = clean[clean.length - 1];
    if (Math.abs(p[0] - q[0]) < 0.05 && Math.abs(p[1] - q[1]) < 0.05) continue;
    clean.push(p);
  }
  if (Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) > 0.05) {
    clean.push([clean[0][0], clean[0][1]]);
  }
  if (clean.length < 4 || absArea(clean) < OPT.minArea * 0.5) {
    reject.degenerate++;
    continue;
  }

  const rec = { f: clean, h: +h.toFixed(1), hs };
  if (cand.tags.name) rec.n = cand.tags.name;
  const item = {
    rec,
    ring: clean,
    c: areaCentroid(clean),
    bb: bbox(clean),
    area: absArea(clean),
    district,
    vertsBefore: cand.ring.length - 1,
    vertsAfter: clean.length - 1,
  };
  accepted.push(item);
  acceptedGrid.add(item);
}

console.log(
  `\nrejected: ${reject.tiny} under ${OPT.minArea}m2, ${reject.water} in the river, ` +
    `${reject.dupDataset} already in the dataset (${dupWhy.overlap} by overlap, ${dupWhy['centroid+size']} by centroid+size), ` +
    `${reject.dupSelf} mapped twice in OSM, ${reject.degenerate} degenerate after simplification`,
);

// ------------------------------------------------------- order, cap and write

accepted.sort((a, b) => a.district.p - b.district.p || b.area - a.area);
const capped = Number.isFinite(OPT.max) ? accepted.slice(0, OPT.max) : accepted;
if (capped.length < accepted.length) {
  console.log(`--max=${OPT.max}: keeping ${capped.length} of ${accepted.length}, inner districts first`);
}

const runs = [];
for (const d of DISTRICTS) {
  const from = capped.findIndex((it) => it.district === d);
  const count = capped.filter((it) => it.district === d).length;
  runs.push({ n: d.n, priority: d.p, from: count ? from : -1, count });
}

const heightSources = { t: 0, l: 0, i: 0 };
for (const it of capped) heightSources[it.rec.hs]++;

const out = {
  meta: {
    city: 'Pittsburgh',
    layer: 'background building fabric',
    note:
      'every OSM building in the scene box that public/data/pittsburgh.json does not already model; ' +
      'same local frame and same compact keys, so both files extrude through one code path',
    origin: { lon: -80.002, lat: 40.441 },
    axes: '+X east, +Y up, +Z south',
    units: 'meters',
    projection: 'equirectangular about 40.441N 80.002W, 111320 m/deg',
    source: 'OpenStreetMap way[building] + relation[building], Overpass, tiled',
    generated: new Date().toISOString().slice(0, 10),
    dedupedAgainst: 'public/data/pittsburgh.json',
    keys: 'f = closed footprint ring [x,z] at 0.1 m, h = height in m, n = name, hs = height source (t OSM height tag, l OSM levels, i inferred from area and district)',
    build: {
      simplifyTolerance: OPT.tolerance,
      vertexCap: OPT.verts,
      minArea: OPT.minArea,
      tiles: `${TILE_COLS}x${TILE_ROWS}`,
      max: Number.isFinite(OPT.max) ? OPT.max : null,
    },
    counts: {
      osmStockInScene: stock.length,
      datasetInScene,
      fabric: capped.length,
      available: accepted.length,
      heightsMeasured: heightSources.t,
      heightsFromLevels: heightSources.l,
      heightsInferred: heightSources.i,
    },
    districts: runs,
    regenerate: 'node scripts/build-fabric.mjs',
  },
  buildings: capped.map((it) => it.rec),
};

writeFileSync(OUT_PATH, JSON.stringify(out));

// ------------------------------------------------------------------- report

const raw = statSync(OUT_PATH).size;
const gz = gzipSync(readFileSync(OUT_PATH)).length;
const before = capped.map((it) => it.vertsBefore);
const after = capped.map((it) => it.vertsAfter);

console.log(`\nwrote public/data/fabric.json`);
console.log(`  buildings              ${capped.length}`);
console.log(`  raw                    ${fmt(raw / 1048576, 2)} MB`);
console.log(`  gzipped                ${fmt(gz / 1048576, 2)} MB`);
console.log(
  `  vertices per footprint median ${percentile(before, 50)} -> ${percentile(after, 50)}` +
    `  p90 ${percentile(before, 90)} -> ${percentile(after, 90)}` +
    `  max ${percentile(before, 100)} -> ${percentile(after, 100)}`,
);
console.log(
  `  heights                ${heightSources.t} measured (height tag), ${heightSources.l} from building:levels, ` +
    `${heightSources.i} inferred (${fmt((heightSources.i / capped.length) * 100)}%)`,
);

const hs = capped.map((it) => it.rec.h);
console.log(
  `  height spread          p10 ${fmt(percentile(hs, 10))}m  median ${fmt(percentile(hs, 50))}m  p90 ${fmt(percentile(hs, 90))}m  max ${fmt(percentile(hs, 100))}m`,
);

console.log('\n=== per district: dataset + fabric against OSM ===');
console.log('  pri district                      OSM  dataset  fabric   before    after');
const stockCentres = stock.map((e) => {
  const b = bbox(e.r);
  return [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
});
const datasetCentres = [];
for (const b of data.buildings) {
  if (!b.f || b.f.length < 4) continue;
  const bb = bbox(b.f);
  datasetCentres.push([(bb.minX + bb.maxX) / 2, (bb.minZ + bb.maxZ) / 2]);
}
for (const d of DISTRICTS) {
  const inBox = (p) => p[0] >= d.minX && p[0] <= d.maxX && p[1] >= d.minZ && p[1] <= d.maxZ;
  const o = stockCentres.filter((p) => districtAt(p[0], p[1]) === d && inBox(p)).length;
  const u = datasetCentres.filter((p) => inScene(p[0], p[1]) && districtAt(p[0], p[1]) === d).length;
  const f = runs.find((r) => r.n === d.n).count;
  console.log(
    `  ${String(d.p).padStart(3)} ${d.n.padEnd(26)} ${String(o).padStart(5)} ${String(u).padStart(8)} ${String(f).padStart(7)}   ` +
      `${o ? fmt((u / o) * 100).padStart(5) : '   - '}%   ${o ? fmt(((u + f) / o) * 100).padStart(5) : '   - '}%`,
  );
}
const totO = stockCentres.length;
const totU = datasetInScene;
console.log(
  `      ${'TOTAL'.padEnd(26)} ${String(totO).padStart(5)} ${String(totU).padStart(8)} ${String(capped.length).padStart(7)}   ` +
    `${fmt((totU / totO) * 100).padStart(5)}%   ${fmt(((totU + capped.length) / totO) * 100).padStart(5)}%`,
);

console.log('\ndone — verify with: node scripts/audit-fabric.mjs');
