/**
 * Rigorous geography audit against live OSM data.
 *
 * Checks, in order:
 *   1. named buildings   — centroid offset vs the same-named OSM footprint
 *   2. buildings in water — footprint area overlapping the water polygons
 *   3. water coverage     — our polygons vs OSM river centrelines and banks
 *   4. bridges            — endpoints and bearing vs the OSM bridge ways
 *
 * Read-only: prints a report, never writes the dataset.
 */
import polygonClipping from 'polygon-clipping';
import { overpass, project, readData, ringCentroid, ringFromGeometry } from './osm.mjs';

const BBOX = '40.417,-80.070,40.475,-79.905';

function fmt(n, d = 1) {
  return Number(n).toFixed(d);
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a / 2);
}

function multiArea(mp) {
  let a = 0;
  for (const poly of mp) {
    a += ringArea(poly[0]);
    for (let i = 1; i < poly.length; i++) a -= ringArea(poly[i]);
  }
  return a;
}

function norm(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(building|tower|center|centre|the|of|at|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

// ---------------------------------------------------------------- water shape

function waterMulti(data) {
  const polys = [];
  for (const w of data.water) {
    const poly = [w.f];
    for (const h of w.holes || []) poly.push(h);
    polys.push(poly);
  }
  return polys.length ? polygonClipping.union(...polys.map((p) => [p])) : [];
}

// ------------------------------------------------------------- named vs OSM

async function auditNamedBuildings(data, water) {
  console.log('\n=== 1. named building placement vs OSM ===');
  const res = await overpass(
    'audit-named-buildings',
    `[out:json][timeout:180];(way["building"]["name"](${BBOX});relation["building"]["name"](${BBOX}););out geom tags;`,
  );

  const osm = new Map();
  for (const el of res.elements) {
    const name = el.tags?.name;
    if (!name) continue;
    let ring = null;
    if (el.type === 'way') ring = ringFromGeometry(el.geometry);
    else {
      const outer = (el.members || []).filter((m) => m.role === 'outer' && m.geometry);
      let best = null;
      for (const m of outer) {
        const r = ringFromGeometry(m.geometry);
        if (r && (!best || ringArea(r) > ringArea(best))) best = r;
      }
      ring = best;
    }
    if (!ring) continue;
    const key = norm(name);
    const area = ringArea(ring);
    const prev = osm.get(key);
    if (!prev || area > prev.area) osm.set(key, { name, ring, area, c: ringCentroid(ring) });
  }
  console.log(`  OSM named footprints: ${osm.size}`);

  const offs = [];
  const bad = [];
  for (const b of data.buildings) {
    if (!b.n) continue;
    const hit = osm.get(norm(b.n));
    if (!hit) continue;
    const c = ringCentroid(b.f);
    const d = Math.hypot(c[0] - hit.c[0], c[1] - hit.c[1]);
    offs.push(d);
    // Scale tolerance with building size: big footprints have distant centroids.
    const span = Math.sqrt(ringArea(b.f));
    if (d > Math.max(25, span * 0.6)) bad.push({ n: b.n, d, span, c, o: hit.c });
  }
  offs.sort((a, b) => a - b);
  console.log(
    `  matched ${offs.length}  median ${fmt(percentile(offs, 50))}m  p90 ${fmt(percentile(offs, 90))}m  max ${fmt(offs[offs.length - 1] || 0)}m`,
  );
  bad.sort((a, b) => b.d - a.d);
  console.log(`  beyond tolerance: ${bad.length}`);
  for (const b of bad.slice(0, 25)) {
    console.log(
      `    ${fmt(b.d)}m  ${b.n}  ours(${fmt(b.c[0], 0)},${fmt(b.c[1], 0)}) osm(${fmt(b.o[0], 0)},${fmt(b.o[1], 0)})`,
    );
  }
  return { offs, bad };
}

// ------------------------------------------------------- buildings in water

function auditBuildingsInWater(data, water) {
  console.log('\n=== 2. buildings overlapping water ===');
  const hits = [];
  for (const b of data.buildings) {
    if (!b.f || b.f.length < 4) continue;
    const a = ringArea(b.f);
    if (a < 1) continue;
    let inter;
    try {
      inter = polygonClipping.intersection([[b.f]], water);
    } catch {
      continue;
    }
    if (!inter || !inter.length) continue;
    const frac = multiArea(inter) / a;
    if (frac > 0.08) hits.push({ n: b.n || '(unnamed)', frac, a, h: b.h, c: ringCentroid(b.f) });
  }
  hits.sort((x, y) => y.frac - x.frac || y.a - x.a);
  const severe = hits.filter((h) => h.frac > 0.5);
  console.log(`  >8% in water: ${hits.length}   >50% in water: ${severe.length}`);
  for (const h of hits.slice(0, 30)) {
    console.log(
      `    ${fmt(h.frac * 100, 0)}%  ${fmt(h.a, 0)}m2  h=${h.h}  ${h.n}  (${fmt(h.c[0], 0)},${fmt(h.c[1], 0)})`,
    );
  }
  return hits;
}

// ------------------------------------------------------------ water accuracy

async function auditWater(data, water) {
  console.log('\n=== 3. water coverage vs OSM ===');
  const res = await overpass(
    'audit-water-all',
    `[out:json][timeout:240];(
       relation["natural"="water"](${BBOX});
       way["natural"="water"](${BBOX});
       way["waterway"="riverbank"](${BBOX});
       relation["waterway"="riverbank"](${BBOX});
     );out geom tags;`,
  );

  const polys = [];
  const names = new Map();
  for (const el of res.elements) {
    const nm = el.tags?.name || '(unnamed)';
    if (el.type === 'way') {
      const r = ringFromGeometry(el.geometry);
      if (r) {
        polys.push([r]);
        names.set(nm, (names.get(nm) || 0) + ringArea(r));
      }
    } else {
      const outer = [];
      const inner = [];
      for (const m of el.members || []) {
        if (!m.geometry) continue;
        const r = ringFromGeometry(m.geometry);
        if (!r) continue;
        (m.role === 'inner' ? inner : outer).push(r);
      }
      for (const o of outer) {
        polys.push([o, ...inner]);
        names.set(nm, (names.get(nm) || 0) + ringArea(o));
      }
    }
  }
  console.log('  OSM water features by name:');
  for (const [n, a] of [...names].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${fmt(a / 1e4, 1)} ha  ${n}`);
  }

  let osmWater;
  try {
    osmWater = polygonClipping.union(...polys.map((p) => [p]));
  } catch (e) {
    console.log('  union failed:', e.message);
    return;
  }

  // Clip both to the scene box so the comparison is apples to apples.
  const [x0, z0] = project(40.475, -80.07);
  const [x1, z1] = project(40.417, -79.905);
  const clip = [[[[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]]]];
  const osmC = polygonClipping.intersection(osmWater, clip);
  const ourC = polygonClipping.intersection(water, clip);

  const aOsm = multiArea(osmC);
  const aOur = multiArea(ourC);
  const missing = multiArea(polygonClipping.difference(osmC, ourC));
  const extra = multiArea(polygonClipping.difference(ourC, osmC));
  console.log(`\n  OSM water in scene:  ${fmt(aOsm / 1e4)} ha`);
  console.log(`  our water in scene:  ${fmt(aOur / 1e4)} ha`);
  console.log(`  OSM water we MISS:   ${fmt(missing / 1e4)} ha  (${fmt((missing / aOsm) * 100)}%)`);
  console.log(`  water we INVENT:     ${fmt(extra / 1e4)} ha  (${fmt((extra / aOsm) * 100)}%)`);

  // Vertex density tells us whether the banks are smooth or blocky.
  for (const w of data.water) {
    let per = 0;
    for (let i = 0; i < w.f.length - 1; i++) {
      per += Math.hypot(w.f[i + 1][0] - w.f[i][0], w.f[i + 1][1] - w.f[i][1]);
    }
    console.log(
      `  ${w.n}: ${w.f.length} verts, ${fmt(per / 1000, 2)} km perimeter, ${fmt(per / (w.f.length - 1))} m/vert, ${w.holes?.length || 0} holes`,
    );
  }
  return { missing, extra, aOsm, osmC };
}

// ----------------------------------------------------------------- bridges

async function auditBridges(data) {
  console.log('\n=== 4. bridges vs OSM ===');
  const res = await overpass(
    'audit-bridges-named',
    `[out:json][timeout:180];way["bridge"]["name"](${BBOX});out geom tags;`,
  );

  const groups = new Map();
  for (const el of res.elements) {
    const nm = el.tags?.name;
    if (!nm || !el.geometry) continue;
    const pts = el.geometry.map((g) => project(g.lat, g.lon));
    const key = norm(nm);
    if (!groups.has(key)) groups.set(key, { name: nm, pts: [] });
    groups.get(key).pts.push(...pts);
  }

  for (const b of data.bridges) {
    const key = norm(b.n);
    let hit = groups.get(key);
    if (!hit) {
      for (const [k, v] of groups) {
        if (k.includes(key) || key.includes(k)) {
          hit = v;
          break;
        }
      }
    }
    const [a, c] = b.pts;
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const bearing = (Math.atan2(c[0] - a[0], -(c[1] - a[1])) * 180) / Math.PI;
    if (!hit) {
      console.log(`  ${b.n}: no OSM match  (len ${fmt(len)}m bearing ${fmt(bearing, 0)}deg)`);
      continue;
    }
    // Longest chord of the OSM way cluster approximates the span axis.
    let best = [0, 0, 0, 0];
    let bd = 0;
    const P = hit.pts;
    const step = Math.max(1, Math.floor(P.length / 60));
    for (let i = 0; i < P.length; i += step) {
      for (let j = i + step; j < P.length; j += step) {
        const d = Math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]);
        if (d > bd) {
          bd = d;
          best = [P[i][0], P[i][1], P[j][0], P[j][1]];
        }
      }
    }
    const ob = (Math.atan2(best[2] - best[0], -(best[3] - best[1])) * 180) / Math.PI;
    let dAng = Math.abs(((bearing - ob + 540) % 360) - 180);
    if (dAng > 90) dAng = 180 - dAng;
    // Distance from our endpoints to the nearest OSM vertex on the way.
    const near = (p) => {
      let m = Infinity;
      for (const q of P) m = Math.min(m, Math.hypot(q[0] - p[0], q[1] - p[1]));
      return m;
    };
    const flag = dAng > 8 || near(a) > 45 || near(c) > 45 ? '  <-- CHECK' : '';
    console.log(
      `  ${b.n}: ours ${fmt(len)}m osm ${fmt(bd)}m  dAngle ${fmt(dAng, 1)}deg  endpoints ${fmt(near(a), 0)}/${fmt(near(c), 0)}m${flag}`,
    );
  }
}

// --------------------------------------------------------------------- main

const data = readData();
const water = waterMulti(data);
console.log(`dataset: ${data.buildings.length} buildings, ${data.bridges.length} bridges`);

await auditNamedBuildings(data, water);
auditBuildingsInWater(data, water);
await auditWater(data, water);
await auditBridges(data);
console.log('\ndone');
