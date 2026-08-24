/**
 * Rebuild every geographic layer from live OpenStreetMap geometry so the scene
 * is 1:1 with the real city:
 *
 *   - rivers: real `natural=water` multipolygons, islands kept as holes
 *   - bridges: real spans solved from the OSM bridge ways that cross the water
 *   - landmarks: real building footprints replacing hand-placed stand-ins
 *   - Point State Park: the real park outline
 *
 * Everything is projected with the single calibrated transform in osm.mjs, so
 * the new layers land exactly on top of the buildings and streets that were
 * already sourced from OSM.
 *
 * Run: node scripts/rebuild-geography.mjs
 */
import polygonClipping from 'polygon-clipping';
import {
  overpass,
  project,
  readData,
  writeData,
  ringFromGeometry,
  ringCentroid,
  ringArea,
  simplify,
} from './osm.mjs';
import { makeWaterIndex, footprintWaterOverlap, snapBridgeToBanks } from '../src/geo.js';

const BBOX = '40.360,-80.120,40.500,-79.860';
const NEAR_BBOX = '40.415,-80.050,40.470,-79.900';

/** Scene extent; water is clipped to this so it never runs off the terrain. */
const CLIP = { minX: -4600, maxX: 8600, minZ: -4000, maxZ: 4600 };

const RIVERS = [
  { key: 'Ohio River', match: /ohio river/i },
  { key: 'Allegheny River', match: /allegheny river/i },
  { key: 'Monongahela River', match: /monongahela river/i },
];

/**
 * Bridges to model, in the order they should be drawn. `match` is tested
 * against OSM `name`, `bridge:name` and `alt_name` so we pick up crossings that
 * only carry the popular name on the bridge tag (Fort Pitt, Fort Duquesne).
 */
const BRIDGES = [
  { n: 'ROBERTO CLEMENTE BRIDGE', match: /^roberto clemente bridge$/i, type: 'sisters', color: '#f0d050' },
  { n: 'ANDY WARHOL BRIDGE', match: /^andy warhol bridge$/i, type: 'sisters', color: '#f0d050' },
  { n: 'RACHEL CARSON BRIDGE', match: /^rachel carson bridge$/i, type: 'sisters', color: '#f0d050' },
  { n: 'FORT PITT BRIDGE', match: /^fort pitt bridge$/i, type: 'double-arch', color: '#8d939c' },
  { n: 'FORT DUQUESNE BRIDGE', match: /^fort duquesne bridge$/i, type: 'double-arch', color: '#8d939c' },
  { n: 'SMITHFIELD STREET BRIDGE', match: /^smithfield street( bridge)?$/i, type: 'lenticular', color: '#8d939c' },
  { n: 'LIBERTY BRIDGE', match: /^liberty bridge$/i, type: 'cantilever', color: '#8d939c' },
  { n: 'VETERANS BRIDGE', match: /^veterans bridge$/i, type: 'truss', color: '#8d939c' },
  { n: 'WEST END BRIDGE', match: /^west end bridge$/i, type: 'double-arch', color: '#8d939c' },
  { n: 'DAVID MCCULLOUGH BRIDGE', match: /^david mccullough bridge$/i, type: 'truss', color: '#f0d050' },
  { n: 'ANDY WARHOL RAIL BRIDGE', match: /^ns fort wayne line$/i, type: 'truss', color: '#8d939c', skipLabel: true },
  { n: 'BIRMINGHAM BRIDGE', match: /^birmingham bridge$/i, type: 'truss', color: '#8d939c' },
  { n: 'SOUTH TENTH STREET BRIDGE', match: /^south 10th street bridge$/i, type: 'truss', color: '#8d939c' },
  { n: 'PANHANDLE BRIDGE', match: /^panhandle bridge$/i, type: 'truss', color: '#8d939c' },
  { n: 'HOT METAL BRIDGE', match: /^hot metal street$/i, type: 'truss', color: '#8d939c' },
  { n: '31ST STREET BRIDGE', match: /^31st street bridge$/i, type: 'truss', color: '#8d939c' },
];

/**
 * Landmarks whose footprint must come from OSM rather than a hand-placed box.
 * `mesh` wires the footprint to a builder in src/landmarks.js.
 */
const LANDMARK_BUILDINGS = [
  { osm: 'PNC Park', match: /^pnc park$/i, n: 'PNC Park', mesh: 'pnc-park', h: 36, style: 'stadium' },
  { osm: 'Acrisure Stadium', match: /^acrisure stadium$/i, n: 'Acrisure Stadium', mesh: 'acrisure-stadium', h: 58, style: 'stadium' },
  { osm: 'PPG Paints Arena', match: /^ppg paints arena$/i, n: 'PPG Paints Arena', mesh: 'ppg-arena', h: 40, style: 'stadium' },
  { osm: 'U.S. Steel Tower', match: /^u\.?s\.? steel tower$/i, n: 'U.S. Steel Tower', mesh: 'us-steel', h: 256, style: 'steelTower' },
  { osm: 'BNY Mellon Center', match: /^bny mellon center$/i, n: 'BNY Mellon Center', mesh: 'bny-mellon', h: 222, style: 'glass' },
  { osm: 'Fifth Avenue Place', match: /^fifth avenue place$/i, n: 'Fifth Avenue Place', mesh: 'fifth-avenue', h: 188, style: 'glass' },
  { osm: 'One Oxford Cent(re|er)', match: /^one oxford cent(re|er)$/i, n: 'One Oxford Centre', mesh: 'oxford-centre', h: 187, style: 'glass' },
  { osm: 'Gulf Tower', match: /^gulf tower$/i, n: 'Gulf Tower', mesh: 'gulf-tower', h: 177, style: 'artdeco' },
  { osm: 'Koppers (Tower|Building)', match: /^koppers (tower|building)$/i, n: 'Koppers Building', mesh: 'koppers-tower', h: 145, style: 'artdeco' },
  { osm: 'Grant Building', match: /^grant building$/i, n: 'Grant Building', mesh: 'grant-building', h: 148, style: 'artdeco' },
  { osm: 'One PPG Place', match: /^one ppg place$/i, n: 'One PPG Place', mesh: 'ppg-tower', h: 194, style: 'ppg' },
  { osm: 'Tower at PNC Plaza', match: /^tower at pnc plaza$/i, n: 'Tower at PNC Plaza', mesh: 'pnc-tower', h: 165, style: 'glass' },
  { osm: 'Cathedral of Learning', match: /^cathedral of learning$/i, n: 'Cathedral of Learning', mesh: 'cathedral', h: 163, style: 'gothic' },
  { osm: 'Heinz (Memorial )?Chapel', match: /^heinz (memorial )?chapel$/i, n: 'Heinz Memorial Chapel', mesh: 'heinz-chapel', h: 46, style: 'chapel' },
  {
    osm: 'David L.? Lawrence Convention Cent(er|re)',
    match: /^david l\.? lawrence convention cent(er|re)$/i,
    n: 'David L. Lawrence Convention Center',
    mesh: 'convention-center',
    h: 48,
    style: 'convention',
  },
];

/** Hand-placed stand-ins that real OSM geometry now supersedes. */
const SYNTHETIC_NAMES = new Set([
  'CATHEDRAL OF LEARNING',
  'PPG PLACE',
  'FIFTH AVENUE PLACE',
  'BNY MELLON CENTER',
  'ONE OXFORD CENTRE',
  'U.S. STEEL TOWER',
  'POINT STATE PARK',
  'PNC PARK',
  'ACRISURE STADIUM',
  'MOUNT WASHINGTON',
  'ANDY WARHOL BRIDGE',
]);

function tagNames(tags = {}) {
  return [tags.name, tags['bridge:name'], tags.alt_name, tags.official_name].filter(Boolean);
}

function clipRings(outer, holes) {
  const box = [[
    [CLIP.minX, CLIP.minZ],
    [CLIP.maxX, CLIP.minZ],
    [CLIP.maxX, CLIP.maxZ],
    [CLIP.minX, CLIP.maxZ],
    [CLIP.minX, CLIP.minZ],
  ]];
  const subject = [outer, ...holes];
  let result;
  try {
    result = polygonClipping.intersection([subject], box);
  } catch {
    return [];
  }
  const out = [];
  for (const poly of result || []) {
    if (!poly.length) continue;
    const o = simplify(poly[0].map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]), 4);
    if (!o || Math.abs(ringArea(o)) < 4000) continue;
    const hs = [];
    for (let i = 1; i < poly.length; i++) {
      const h = simplify(poly[i].map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]), 4);
      if (h && Math.abs(ringArea(h)) > 2500) hs.push(h);
    }
    out.push({ f: o, holes: hs });
  }
  return out;
}

async function buildWater() {
  const query = `[out:json][timeout:180];
(
  relation["natural"="water"](${BBOX});
  way["natural"="water"](${BBOX});
  way["waterway"="riverbank"](${BBOX});
);
out geom;`;
  const raw = await overpass('water', query);

  const surfaces = [];
  for (const river of RIVERS) {
    const parts = [];
    for (const el of raw.elements) {
      const name = el.tags?.['waterway:name'] || el.tags?.name || '';
      if (!river.match.test(name)) continue;
      if (el.type === 'way') {
        const ring = ringFromGeometry(el.geometry);
        if (ring) parts.push({ outer: ring, holes: [] });
      } else if (el.type === 'relation') {
        const outers = [];
        const inners = [];
        for (const m of el.members || []) {
          if (!m.geometry) continue;
          const ring = ringFromGeometry(m.geometry);
          if (!ring) continue;
          (m.role === 'inner' ? inners : outers).push(ring);
        }
        for (const o of outers) {
          // Attach each island to whichever outer ring contains it.
          const holes = inners.filter((h) => {
            const [hx, hz] = ringCentroid(h);
            return pointInRing(hx, hz, o);
          });
          parts.push({ outer: o, holes });
        }
      }
    }

    let kept = 0;
    for (const part of parts) {
      for (const piece of clipRings(part.outer, part.holes)) {
        surfaces.push({ n: river.key, f: piece.f, holes: piece.holes });
        kept++;
      }
    }
    const area = surfaces
      .filter((s) => s.n === river.key)
      .reduce((a, s) => a + Math.abs(ringArea(s.f)), 0);
    console.log(`  ${river.key}: ${kept} surface(s), ${(area / 1e6).toFixed(2)} km2 in frame`);
  }

  surfaces.sort((a, b) => Math.abs(ringArea(b.f)) - Math.abs(ringArea(a.f)));
  return surfaces;
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-12) + xi) inside = !inside;
    j = i;
  }
  return inside;
}

/**
 * Solve a straight span from the real bridge ways: keep only the segments that
 * actually cross open water, fit their principal axis, and take the extremes.
 * Approach ramps and interchange spurs therefore drop out on their own.
 */
function solveSpan(segments, waterIndex) {
  const overWater = segments.filter(([a, b]) =>
    waterIndex.inside((a[0] + b[0]) / 2, (a[1] + b[1]) / 2),
  );
  const use = overWater.length ? overWater : segments;
  if (!use.length) return null;

  const pts = [];
  for (const [a, b] of use) pts.push(a, b);
  let cx = 0;
  let cz = 0;
  for (const [x, z] of pts) {
    cx += x;
    cz += z;
  }
  cx /= pts.length;
  cz /= pts.length;

  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (const [x, z] of pts) {
    xx += (x - cx) ** 2;
    zz += (z - cz) ** 2;
    xz += (x - cx) * (z - cz);
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  const ux = Math.cos(angle);
  const uz = Math.sin(angle);

  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, z] of pts) {
    const t = (x - cx) * ux + (z - cz) * uz;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  if (hi - lo < 40) return null;

  return [
    [+(cx + ux * lo).toFixed(2), +(cz + uz * lo).toFixed(2)],
    [+(cx + ux * hi).toFixed(2), +(cz + uz * hi).toFixed(2)],
  ];
}

async function buildBridges(waterIndex) {
  const query = `[out:json][timeout:180];
(
  way["bridge"]["name"](${NEAR_BBOX});
  way["bridge"]["bridge:name"](${NEAR_BBOX});
  way["man_made"="bridge"](${NEAR_BBOX});
);
out geom;`;
  const raw = await overpass('bridges', query);

  const out = [];
  for (const spec of BRIDGES) {
    const segments = [];
    for (const el of raw.elements) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      if (!tagNames(el.tags).some((n) => spec.match.test(n))) continue;
      for (let i = 0; i < el.geometry.length - 1; i++) {
        const a = project(el.geometry[i].lat, el.geometry[i].lon);
        const b = project(el.geometry[i + 1].lat, el.geometry[i + 1].lon);
        segments.push([a, b]);
      }
    }
    if (!segments.length) {
      console.log(`  ! ${spec.n}: no OSM match`);
      continue;
    }
    const pts = solveSpan(segments, waterIndex);
    if (!pts) {
      console.log(`  ! ${spec.n}: span too short to model`);
      continue;
    }
    out.push({ n: spec.n, color: spec.color, type: spec.type, pts });
  }
  return out;
}

async function buildLandmarks() {
  const names = LANDMARK_BUILDINGS.map((l) => l.osm);
  const query = `[out:json][timeout:180];
(
${names.map((n) => `  way["building"]["name"~"^${n}$",i](${BBOX});`).join('\n')}
${names.map((n) => `  relation["building"]["name"~"^${n}$",i](${BBOX});`).join('\n')}
  way["leisure"="stadium"]["name"](${NEAR_BBOX});
  way["building"="stadium"]["name"](${NEAR_BBOX});
);
out geom;`;
  const raw = await overpass('landmarks', query);

  const found = new Map();
  for (const el of raw.elements) {
    const name = el.tags?.name;
    if (!name) continue;
    const spec = LANDMARK_BUILDINGS.find((l) => l.match.test(name));
    if (!spec) continue;

    let ring = null;
    if (el.type === 'way') ring = ringFromGeometry(el.geometry);
    else {
      let best = null;
      for (const m of el.members || []) {
        if (m.role === 'inner' || !m.geometry) continue;
        const r = ringFromGeometry(m.geometry);
        if (r && (!best || Math.abs(ringArea(r)) > Math.abs(ringArea(best)))) best = r;
      }
      ring = best;
    }
    if (!ring) continue;

    const simplified = simplify(ring, 1.5);
    const area = Math.abs(ringArea(simplified));
    const prev = found.get(spec.mesh);
    if (prev && prev.area >= area) continue;
    found.set(spec.mesh, { spec, f: simplified, area });
  }

  for (const spec of LANDMARK_BUILDINGS) {
    if (!found.has(spec.mesh)) console.log(`  ! ${spec.n}: no OSM footprint`);
  }
  return found;
}

function parseHeight(tags) {
  const raw = tags.height ?? tags['building:height'];
  if (raw != null) {
    const m = String(raw).match(/-?\d+(\.\d+)?/);
    if (m) {
      const v = parseFloat(m[0]);
      if (v > 1 && v < 400) return /'|ft|feet/i.test(String(raw)) ? v * 0.3048 : v;
    }
  }
  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels >= 1 && levels < 110) {
    return levels * 3.55 + (levels > 3 ? 1.6 : 0.8);
  }
  return null;
}

/**
 * Replace estimated building heights with OSM `height` / `building:levels`
 * values. Matching is by centroid proximity rather than name: most of the city
 * fabric is unnamed, and the calibrated projection puts both sets within a few
 * metres of each other.
 */
async function refreshHeights(data) {
  const query = `[out:json][timeout:180];
way["building"][~"^(height|building:levels)$"~"."](${BBOX});
out tags center;`;
  const raw = await overpass('heights', query);

  const CELL = 40;
  const grid = new Map();
  const key = (cx, cz) => `${Math.floor(cx / CELL)},${Math.floor(cz / CELL)}`;
  for (const el of raw.elements) {
    if (!el.center || !el.tags) continue;
    const h = parseHeight(el.tags);
    if (h == null) continue;
    const [x, z] = project(el.center.lat, el.center.lon);
    const k = key(x, z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ x, z, h });
  }

  let updated = 0;
  let bigChange = 0;
  for (const b of data.buildings) {
    if (!b.f || b.f.length < 4) continue;
    const [cx, cz] = ringCentroid(b.f);
    let best = null;
    let bestD = 18;
    for (let gx = -1; gx <= 1; gx++) {
      for (let gz = -1; gz <= 1; gz++) {
        const cell = grid.get(key(cx + gx * CELL, cz + gz * CELL));
        if (!cell) continue;
        for (const c of cell) {
          const d = Math.hypot(c.x - cx, c.z - cz);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
    }
    if (!best) continue;
    const next = +best.h.toFixed(1);
    if (Math.abs(next - (b.h || 0)) > 1) {
      if (Math.abs(next - (b.h || 0)) > 8) bigChange++;
      b.h = next;
      updated++;
    }
  }
  console.log(`  ${updated} heights refreshed from OSM (${bigChange} changed by >8 m)`);
}

async function buildPointPark() {
  const query = `[out:json][timeout:120];
(
  way["leisure"="park"]["name"~"^Point State Park$",i](${NEAR_BBOX});
  relation["leisure"="park"]["name"~"^Point State Park$",i](${NEAR_BBOX});
);
out geom;`;
  const raw = await overpass('point-park', query);
  let best = null;
  for (const el of raw.elements) {
    const rings = [];
    if (el.type === 'way') {
      const r = ringFromGeometry(el.geometry);
      if (r) rings.push(r);
    } else {
      for (const m of el.members || []) {
        if (m.role === 'inner' || !m.geometry) continue;
        const r = ringFromGeometry(m.geometry);
        if (r) rings.push(r);
      }
    }
    for (const r of rings) {
      if (!best || Math.abs(ringArea(r)) > Math.abs(ringArea(best))) best = r;
    }
  }
  return best ? simplify(best, 2) : null;
}

async function main() {
  const data = readData();

  console.log('water');
  const water = await buildWater();

  const waterIndex = makeWaterIndex(water, { erosion: 12 });

  console.log('bridges');
  const bridges = await buildBridges(waterIndex);
  for (const b of bridges) {
    const snapped = snapBridgeToBanks(b.pts, waterIndex, 18);
    const len = Math.hypot(snapped[1][0] - snapped[0][0], snapped[1][1] - snapped[0][1]);
    let wet = 0;
    for (let i = 0; i <= 20; i++) {
      const x = snapped[0][0] + ((snapped[1][0] - snapped[0][0]) * i) / 20;
      const z = snapped[0][1] + ((snapped[1][1] - snapped[0][1]) * i) / 20;
      if (waterIndex.inside(x, z)) wet++;
    }
    console.log(
      `  ${b.n.padEnd(30)} ${len.toFixed(0).padStart(4)}m  ${((wet / 21) * 100).toFixed(0).padStart(3)}% over water`,
    );
  }

  console.log('building heights');
  await refreshHeights(data);

  console.log('landmarks');
  const landmarks = await buildLandmarks();

  console.log('point state park');
  const pointRing = await buildPointPark();
  if (pointRing) console.log(`  ${pointRing.length} vertices, ${(Math.abs(ringArea(pointRing)) / 1e4).toFixed(1)} ha`);

  // Drop hand-placed stand-ins and any stale landmark wiring.
  const before = data.buildings.length;
  const meshNames = new Set([...landmarks.values()].map((v) => v.spec.mesh));
  data.buildings = data.buildings.filter((b) => !SYNTHETIC_NAMES.has(b.n));
  for (const b of data.buildings) {
    if (b.landmarkMesh && meshNames.has(b.landmarkMesh)) {
      delete b.landmarkMesh;
      delete b.landmark;
    }
  }
  console.log(`  purged ${before - data.buildings.length} hand-placed buildings`);

  // Re-seat each landmark on its real OSM footprint.
  for (const { spec, f } of landmarks.values()) {
    const existing = data.buildings.find(
      (b) => b.n && spec.match.test(b.n) && Math.abs(ringArea(b.f)) > 0,
    );
    const record = existing || { n: spec.n };
    record.f = f;
    record.h = spec.h;
    record.n = spec.n;
    record.style = spec.style;
    record.landmark = true;
    record.landmarkMesh = spec.mesh;
    if (!existing) data.buildings.push(record);
    const [cx, cz] = ringCentroid(f);
    console.log(`  ${spec.n.padEnd(38)} ${f.length - 1} verts @ ${cx.toFixed(0)},${cz.toFixed(0)}`);
  }

  data.water = water;
  data.bridges = bridges;
  if (pointRing) data.pointPark = { n: 'Point State Park', f: pointRing };

  // Labels follow the real footprints.
  const labelFor = new Map();
  for (const { spec, f } of landmarks.values()) labelFor.set(spec.mesh, ringCentroid(f));
  data.landmarks = (data.landmarks || []).map((lm) => {
    const hit = [...landmarks.values()].find((v) => v.spec.n.toUpperCase() === lm.n.toUpperCase());
    return hit ? { ...lm, p: ringCentroid(hit.f).map((v) => +v.toFixed(1)) } : lm;
  });

  data.meta.note = 'buildings/streets/parks/water/bridges all projected from OpenStreetMap';
  data.meta.projection = 'equirectangular about 40.441N 80.002W, 111320 m/deg';
  data.meta.geographyRebuild = new Date().toISOString().slice(0, 10);
  writeData(data);

  // Sanity report.
  let wet = 0;
  for (const b of data.buildings) {
    if (!b.f || b.f.length < 4) continue;
    if (footprintWaterOverlap(b.f, waterIndex) > 0.18) wet++;
  }
  console.log(`\n${data.buildings.length} buildings, ${wet} still >18% over water (filtered at runtime)`);
  console.log(`${water.length} water surfaces, ${water.reduce((a, w) => a + (w.holes?.length || 0), 0)} islands`);
  console.log(`${bridges.length} bridges`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
