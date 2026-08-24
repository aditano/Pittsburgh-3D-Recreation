/**
 * Bake OSM land cover into public/data/landcover.json.
 *
 * The ground was previously tinted from slope and footprint density alone, which
 * cannot tell a car park from a lawn: both are flat and neither has buildings on
 * it. That put grass across the North Shore, which is in reality about 25 acres
 * of continuous surface parking between the two stadiums, and it put paving over
 * the leafy residential grid on the South Side Slopes.
 *
 * So the classes here are the ones that decide ground TONE from the air, not
 * every OSM landuse value:
 *
 *   paved   parking, parking aisles, industrial and railway yards, plazas
 *   grass   parks, recreation ground, grass, cemeteries, golf, pitches
 *   wood    woodland, scrub, nature reserve
 *   sand    beaches and bare rock along the banks
 *
 * Output is a flat array of `{ c: classIndex, f: ring }` in the local frame,
 * coordinates rounded to 0.1 m, rings simplified to 2 m. Read by src/main.js.
 *
 *   node scripts/build-landcover.mjs [--refresh]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, overpass, largestRing, ringArea, simplify } from './osm.mjs';

const refresh = process.argv.includes('--refresh');

/**
 * Scene extent in local metres, matching GROUND in src/main.js. Queried as a
 * lat/lon bbox with a margin so polygons that straddle the edge come through
 * whole and get clipped by the renderer instead of vanishing.
 */
const BBOX = '40.36,-80.14,40.53,-79.86';

export const CLASSES = ['paved', 'grass', 'wood', 'sand'];

/**
 * Ordered most-specific first: a golf course tagged `landuse=grass` should land
 * on grass, and a parking aisle inside a park should land on paving. Ties go to
 * whichever rule matches first, and at draw time later polygons win, so the
 * order here is also the paint order.
 */
const RULES = [
  { cls: 'wood', q: 'way["natural"~"^(wood|scrub)$"]' },
  { cls: 'wood', q: 'way["landuse"="forest"]' },
  { cls: 'grass', q: 'way["leisure"~"^(park|garden|recreation_ground|golf_course)$"]' },
  { cls: 'grass', q: 'way["landuse"~"^(grass|meadow|cemetery|village_green|recreation_ground)$"]' },
  { cls: 'grass', q: 'way["leisure"="pitch"]' },
  { cls: 'sand', q: 'way["natural"~"^(beach|bare_rock|shingle)$"]' },
  { cls: 'paved', q: 'way["landuse"~"^(industrial|railway|quarry|brownfield|construction)$"]' },
  { cls: 'paved', q: 'way["amenity"="parking"]' },
  { cls: 'paved', q: 'way["place"="square"]' },
  { cls: 'paved', q: 'way["man_made"="pier"]' },
];

const RELATION_RULES = [
  { cls: 'wood', q: 'relation["natural"~"^(wood|scrub)$"]' },
  { cls: 'grass', q: 'relation["leisure"~"^(park|golf_course|recreation_ground)$"]' },
  { cls: 'grass', q: 'relation["landuse"~"^(grass|cemetery|recreation_ground)$"]' },
  { cls: 'paved', q: 'relation["landuse"~"^(industrial|railway)$"]' },
  { cls: 'paved', q: 'relation["amenity"="parking"]' },
];

// Below this a polygon is a single parking bay or a flower bed: invisible at
// flyover range and pure cost in the raster.
const MIN_AREA = 400;

async function collect() {
  const out = [];
  const all = [...RULES, ...RELATION_RULES];
  for (let i = 0; i < all.length; i++) {
    const { cls, q } = all[i];
    const json = await overpass(
      `landcover-${i}-${cls}`,
      `[out:json][timeout:180];(${q}(${BBOX}););out geom;`,
      { refresh },
    );
    let kept = 0;
    for (const el of json.elements || []) {
      const ring = largestRing(el);
      if (!ring || ring.length < 4) continue;
      if (Math.abs(ringArea(ring)) < MIN_AREA) continue;
      const s = simplify(ring, 2);
      out.push({
        c: CLASSES.indexOf(cls),
        f: s.map(([x, z]) => [+x.toFixed(1), +z.toFixed(1)]),
      });
      kept++;
    }
    console.log(`  ${cls.padEnd(6)} ${q.slice(0, 52).padEnd(54)} -> ${kept}`);
  }
  return out;
}

const polys = await collect();
// Largest first so the small, specific polygons paint over the big generic ones.
polys.sort((a, b) => Math.abs(ringArea(b.f)) - Math.abs(ringArea(a.f)));

const path = join(ROOT, 'public/data/landcover.json');
writeFileSync(path, JSON.stringify({ classes: CLASSES, polys }));

const byClass = {};
let verts = 0;
for (const p of polys) {
  byClass[CLASSES[p.c]] = (byClass[CLASSES[p.c]] || 0) + 1;
  verts += p.f.length;
}
console.log(`\n${polys.length} polygons, ${verts} vertices -> ${path}`);
for (const [k, v] of Object.entries(byClass)) console.log(`  ${k.padEnd(6)} ${v}`);
