/**
 * Quantitative geography audit of the shipped dataset against live OSM.
 *
 * Sections:
 *   1. projection — offset distribution for every name-matched building, plus an
 *      affine fit of the residual field. A pure translation, a scale error or a
 *      rotation all leave distinct signatures in that fit; a mean of zero proves
 *      nothing on its own, because opposing errors cancel.
 *   2. footprints — centroid offset, area ratio and symmetric Hausdorff distance
 *      per named building, so a footprint that is centred correctly but the wrong
 *      shape still gets caught.
 *   3. water     — our river polygons against the OSM bank multipolygons, and
 *      every building that overlaps open water.
 *
 * Matching is by name *and* proximity (see scripts/osm-features.mjs): a
 * name-only match pairs the downtown Giant Eagle with the one in Brighton
 * Heights and reports an 11 km "error" that is really a matching bug.
 *
 * Read-only. Run: node scripts/audit-geography.mjs
 */
import polygonClipping from 'polygon-clipping';
import { overpass, project, readData, ringArea, ringFromGeometry } from './osm.mjs';
import {
  areaCentroid,
  AUDIT_BBOX,
  fetchNamedBuildings,
  groupRelationWays,
  hausdorff,
  indexByName,
  nearestByName,
  percentile,
} from './osm-features.mjs';

const fmt = (n, d = 1) => Number(n).toFixed(d);

/** The extent rebuild-water.mjs clips the river surfaces to. */
const SCENE = { minX: -4600, maxX: 8600, minZ: -4000, maxZ: 4600 };

function absArea(ring) {
  return Math.abs(ringArea(ring));
}

function multiArea(mp) {
  let a = 0;
  for (const poly of mp) {
    a += absArea(poly[0]);
    for (let i = 1; i < poly.length; i++) a -= absArea(poly[i]);
  }
  return a;
}

/**
 * Solve `v = a0 + a1*x + a2*z` by normal equations. Used on the residual field:
 * a1/a2 that are indistinguishable from zero mean the projection has no scale or
 * rotation error and the remaining scatter is genuine per-building disagreement.
 */
function fitPlane(samples) {
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];
  for (const { x, z, v } of samples) {
    const basis = [1, x, z];
    for (let i = 0; i < 3; i++) {
      b[i] += basis[i] * v;
      for (let j = 0; j < 3; j++) M[i][j] += basis[i] * basis[j];
    }
  }
  // Gauss-Jordan with partial pivoting; the system is 3x3 so this is exact enough.
  const A = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return [0, 0, 0];
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    for (let c = col; c < 4; c++) A[col][c] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let c = col; c < 4; c++) A[r][c] -= f * A[col][c];
    }
  }
  return [A[0][3], A[1][3], A[2][3]];
}

function report(label, values) {
  console.log(
    `  ${label}: n=${values.length}  median ${fmt(percentile(values, 50))}m  p75 ${fmt(percentile(values, 75))}m` +
      `  p90 ${fmt(percentile(values, 90))}m  p99 ${fmt(percentile(values, 99))}m  max ${fmt(percentile(values, 100))}m`,
  );
}

// ------------------------------------------------------------------- matches

function matchBuildings(data, idx) {
  const matches = [];
  for (const b of data.buildings) {
    if (!b.n || !b.f || b.f.length < 4) continue;
    const c = areaCentroid(b.f);
    // 400 m is generous for a footprint that is meant to be the same building,
    // and tight enough that a same-named store in another neighbourhood cannot
    // be picked up as the match.
    const hit = nearestByName(idx, b.n, c[0], c[1], 400);
    if (!hit) continue;
    matches.push({ b, c, osm: hit.f, d: hit.d });
  }
  return matches;
}

// -------------------------------------------------------------- 1 projection

function auditProjection(matches) {
  console.log('\n=== 1. projection residuals ===');
  const offs = matches.map((m) => m.d);
  report('centroid offset', offs);

  const dxs = matches.map((m) => ({ x: m.c[0], z: m.c[1], v: m.osm.c[0] - m.c[0] }));
  const dzs = matches.map((m) => ({ x: m.c[0], z: m.c[1], v: m.osm.c[1] - m.c[1] }));
  const [tx, dxdx, dxdz] = fitPlane(dxs);
  const [tz, dzdx, dzdz] = fitPlane(dzs);

  console.log(`  mean residual:      dx ${fmt(dxs.reduce((s, p) => s + p.v, 0) / dxs.length, 2)}m  dz ${fmt(dzs.reduce((s, p) => s + p.v, 0) / dzs.length, 2)}m`);
  console.log(`  affine translation: dx ${fmt(tx, 2)}m  dz ${fmt(tz, 2)}m`);
  console.log(`  scale error:        x ${fmt(dxdx * 1e6, 1)} ppm  z ${fmt(dzdz * 1e6, 1)} ppm`);
  console.log(`  rotation:           ${fmt(((dxdz - dzdx) / 2) * (180 / Math.PI) * 1000, 2)} millideg`);
  console.log(`  shear:              ${fmt(((dxdz + dzdx) / 2) * 1e6, 1)} ppm`);

  // Over a 13 km scene a 1 ppm scale error is 13 mm, so quote the worst-corner
  // displacement the fitted affine would produce — that is the number that matters.
  const corner = 8600;
  const worst = Math.hypot(tx + dxdx * corner + dxdz * corner, tz + dzdx * corner + dzdz * corner);
  console.log(`  affine displacement at the scene corner (8.6 km out): ${fmt(worst, 2)}m`);

  const resid = matches.map((m) =>
    Math.hypot(
      m.osm.c[0] - m.c[0] - (tx + dxdx * m.c[0] + dxdz * m.c[1]),
      m.osm.c[1] - m.c[1] - (tz + dzdx * m.c[0] + dzdz * m.c[1]),
    ),
  );
  report('offset after removing the affine', resid);

  // Structure by quadrant: a systematic error shows up as one sign per region.
  const quads = { NW: [], NE: [], SW: [], SE: [] };
  for (const m of matches) {
    const k = (m.c[1] < 0 ? 'N' : 'S') + (m.c[0] < 0 ? 'W' : 'E');
    quads[k].push(m);
  }
  for (const [k, list] of Object.entries(quads)) {
    if (!list.length) continue;
    const mx = list.reduce((s, m) => s + (m.osm.c[0] - m.c[0]), 0) / list.length;
    const mz = list.reduce((s, m) => s + (m.osm.c[1] - m.c[1]), 0) / list.length;
    console.log(`  ${k}: n=${String(list.length).padStart(4)}  mean dx ${fmt(mx, 2)}m  mean dz ${fmt(mz, 2)}m  median offset ${fmt(percentile(list.map((m) => m.d), 50))}m`);
  }
  return offs;
}

// -------------------------------------------------------------- 2 footprints

function auditFootprints(matches) {
  console.log('\n=== 2. footprint agreement ===');
  const rows = [];
  for (const m of matches) {
    const ourA = absArea(m.b.f);
    const osmA = m.osm.area;
    if (ourA < 20 || osmA < 20) continue;
    rows.push({
      n: m.b.n,
      d: m.d,
      ratio: ourA / osmA,
      haus: hausdorff(m.b.f, m.osm.ring),
      ourA,
      osmA,
      c: m.c,
      landmark: !!(m.b.landmarkMesh || m.b.landmark || m.b.style),
    });
  }
  report('symmetric Hausdorff', rows.map((r) => r.haus));
  const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
  console.log(
    `  area ratio (ours/OSM): median ${fmt(percentile(ratios, 50), 3)}  p10 ${fmt(percentile(ratios, 10), 3)}  p90 ${fmt(percentile(ratios, 90), 3)}`,
  );

  // A footprint is "wrong" if its centroid is off by more than a quarter of its
  // own span, or its outline strays more than 12 m, or its area is out by 40%.
  const bad = rows.filter((r) => {
    const span = Math.sqrt(r.osmA);
    return r.d > Math.max(10, span * 0.25) || r.haus > 12 || r.ratio < 0.6 || r.ratio > 1.6;
  });
  bad.sort((a, b) => b.haus + b.d - (a.haus + a.d));
  console.log(`  footprints outside tolerance: ${bad.length} of ${rows.length}`);
  for (const r of bad.slice(0, 40)) {
    console.log(
      `    offset ${fmt(r.d).padStart(6)}m  hausdorff ${fmt(r.haus).padStart(6)}m  area x${fmt(r.ratio, 2)}  ${r.landmark ? '[styled] ' : ''}${r.n}`,
    );
  }
  return { rows, bad };
}

// ------------------------------------------------------------------ 3 water

function waterMulti(data) {
  const polys = [];
  for (const w of data.water) polys.push([[w.f, ...(w.holes || [])]]);
  return polys.length ? polygonClipping.union(...polys) : [];
}

/**
 * OSM river surfaces. The rivers here are `natural=water` + `water=river`
 * multipolygon relations, and `out geom` on a relation returns no member
 * geometry, so the members have to be requested as ways in their own right.
 */
async function osmWaterMulti() {
  const res = await overpass(
    'geo-water-rels',
    `[out:json][timeout:300];rel["natural"="water"](${AUDIT_BBOX})->.r;foreach.r->.x(.x out tags;way(r.x);out geom;);`,
  );
  const loose = await overpass(
    'geo-water-ways',
    `[out:json][timeout:240];way["natural"="water"](${AUDIT_BBOX});out geom tags;`,
  );

  const polys = [];
  const byName = new Map();
  const note = (nm, a) => byName.set(nm, (byName.get(nm) || 0) + a);

  for (const g of groupRelationWays(res.elements)) {
    const nm = g.tags.name || g.tags['waterway:name'] || '(unnamed)';
    // Members arrive as open bank segments; only stitching yields real rings.
    const ways = g.ways.map((w) => w.geometry.map((p) => project(p.lat, p.lon)));
    const { rings } = (await import('./osm.mjs')).stitchRings(ways);
    const closed = rings
      .map((r) => {
        const c = r.slice();
        if (Math.hypot(c[0][0] - c[c.length - 1][0], c[0][1] - c[c.length - 1][1]) > 0.01) c.push([c[0][0], c[0][1]]);
        return c;
      })
      .filter((r) => r.length >= 4 && absArea(r) > 200)
      .sort((a, b) => absArea(b) - absArea(a));
    if (!closed.length) continue;
    // Rings nested inside a larger ring of the same relation are its islands.
    const outers = [];
    for (const r of closed) {
      const host = outers.find((o) => pointInRing(r[0][0], r[0][1], o.ring));
      if (host) host.holes.push(r);
      else outers.push({ ring: r, holes: [] });
    }
    for (const o of outers) {
      polys.push([[o.ring, ...o.holes]]);
      note(nm, absArea(o.ring));
    }
  }
  for (const el of loose.elements) {
    const r = ringFromGeometry(el.geometry);
    if (!r) continue;
    polys.push([[r]]);
    note(el.tags?.name || '(unnamed)', absArea(r));
  }

  console.log('  OSM water features by name:');
  for (const [n, a] of [...byName].sort((x, y) => y[1] - x[1]).slice(0, 10)) {
    console.log(`    ${fmt(a / 1e4, 1).padStart(8)} ha  ${n}`);
  }
  return polygonClipping.union(...polys);
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

async function auditWater(data, water) {
  console.log('\n=== 3. water coverage vs OSM ===');
  const osm = await osmWaterMulti();

  // Compare inside the scene box the water is authored to fill (the same box
  // scripts/rebuild-water.mjs clips to), so river running off past Emsworth is
  // not counted as coverage we "missed".
  const clip = [[[[SCENE.minX, SCENE.minZ], [SCENE.maxX, SCENE.minZ], [SCENE.maxX, SCENE.maxZ], [SCENE.minX, SCENE.maxZ], [SCENE.minX, SCENE.minZ]]]];
  const osmC = polygonClipping.intersection(osm, clip);
  const ourC = polygonClipping.intersection(water, clip);
  const aOsm = multiArea(osmC);
  const aOur = multiArea(ourC);
  const missing = multiArea(polygonClipping.difference(osmC, ourC));
  const extra = multiArea(polygonClipping.difference(ourC, osmC));
  console.log(`\n  OSM water in scene: ${fmt(aOsm / 1e4)} ha`);
  console.log(`  our water in scene: ${fmt(aOur / 1e4)} ha`);
  console.log(`  OSM water we MISS:  ${fmt(missing / 1e4)} ha (${fmt((missing / aOsm) * 100)}%)`);
  console.log(`  water we INVENT:    ${fmt(extra / 1e4)} ha (${fmt((extra / aOsm) * 100)}%)`);

  for (const w of data.water) {
    let per = 0;
    for (let i = 0; i < w.f.length - 1; i++) {
      per += Math.hypot(w.f[i + 1][0] - w.f[i][0], w.f[i + 1][1] - w.f[i][1]);
    }
    console.log(
      `  ${w.n}: ${w.f.length} verts, ${fmt(per / 1000, 2)} km perimeter, ${fmt(per / (w.f.length - 1))} m/vert, ${w.holes?.length || 0} islands`,
    );
  }
}

function auditBuildingsInWater(data, water, idx) {
  console.log('\n=== 4. buildings overlapping water ===');
  const hits = [];
  for (const b of data.buildings) {
    if (!b.f || b.f.length < 4) continue;
    const a = absArea(b.f);
    if (a < 1) continue;
    let inter;
    try {
      inter = polygonClipping.intersection([[b.f]], water);
    } catch {
      continue;
    }
    if (!inter?.length) continue;
    const frac = multiArea(inter) / a;
    if (frac <= 0.08) continue;
    const c = areaCentroid(b.f);
    const hit = b.n ? nearestByName(idx, b.n, c[0], c[1], 400) : null;
    hits.push({
      n: b.n || '(unnamed)',
      frac,
      a,
      h: b.h,
      c,
      tags: hit ? hit.f.tags : null,
    });
  }
  hits.sort((x, y) => y.frac - x.frac || y.a - x.a);
  console.log(`  >8% in water: ${hits.length}   >50% in water: ${hits.filter((h) => h.frac > 0.5).length}`);
  for (const h of hits) {
    const kind = h.tags
      ? Object.entries(h.tags)
          .filter(([k]) => /^(building|man_made|tourism|historic|amenity|floating|leisure)$/.test(k))
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
      : 'no OSM match';
    console.log(
      `    ${fmt(h.frac * 100, 0).padStart(3)}%  ${fmt(h.a, 0).padStart(6)}m2  h=${String(h.h).padStart(5)}  ${h.n.padEnd(42)} (${fmt(h.c[0], 0)},${fmt(h.c[1], 0)})  ${kind}`,
    );
  }
  return hits;
}

// --------------------------------------------------------------------- main

const data = readData();
console.log(
  `dataset: ${data.buildings.length} buildings (${data.buildings.filter((b) => b.n).length} named), ` +
    `${data.streets.length} streets, ${data.bridges.length} bridges, ${data.water.length} water surfaces`,
);

const osmBuildings = await fetchNamedBuildings();
console.log(`OSM named building footprints in bbox: ${osmBuildings.length}`);
const idx = indexByName(osmBuildings);
const matches = matchBuildings(data, idx);
console.log(`name+proximity matches: ${matches.length}`);

auditProjection(matches);
auditFootprints(matches);
const water = waterMulti(data);
await auditWater(data, water);
auditBuildingsInWater(data, water, idx);
console.log('\ndone');
