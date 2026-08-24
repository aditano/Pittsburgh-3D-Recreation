import { readFileSync } from 'node:fs';
import {
  massingProfile,
  buildArticulatedBuilding,
  buildRoofscape,
  detailTier,
  footprintArea,
  insetRing,
  ringFromFootprint,
  insideWithMargin,
  footprintSeed,
} from './src/architecture.js';
import { buildingFamily } from './src/textures.js';
import { footprintCentroid, hash01 } from './src/geo.js';

const FAMILY_SPEC = {
  lowrise: [3.6, 3.8],
  brick: [3.7, 3.4],
  limestone: [3.8, 3.3],
  steel: [3.5, 3.0],
  glass: [3.45, 2.7],
  ppg: [3.4, 2.5],
  gothic: [5.4, 2.5],
  stadium: [8.5, 10],
  artdeco: [4.2, 2.8],
  chapel: [5.8, 2.2],
  sandstone: [4.5, 3.6],
  copper: [3.9, 3.2],
  convention: [6.0, 5.0],
  steelTower: [3.6, 3.0],
};

let failures = 0;
const seen = new Map();
function fail(msg) {
  failures++;
  const key = msg.replace(/[-\d.]+/g, '#').slice(0, 90);
  const c = (seen.get(key) || 0) + 1;
  seen.set(key, c);
  if (c <= 2) console.error('FAIL:', msg);
}

function checkGeom(g, label) {
  if (!g) return 0;
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const uv = g.attributes.uv;
  const col = g.attributes.color;
  const arrays = [pos, nrm, uv, col].filter(Boolean);
  for (const a of arrays) {
    for (let i = 0; i < a.array.length; i++) {
      if (!Number.isFinite(a.array[i])) {
        fail(`${label}: non-finite value in attribute (idx ${i})`);
        return g.index.count / 3;
      }
    }
  }
  const idx = g.index;
  if (!idx) fail(`${label}: geometry is not indexed`);
  else {
    for (let i = 0; i < idx.count; i++) {
      const v = idx.array[i];
      if (!Number.isInteger(v) || v < 0 || v >= pos.count) fail(`${label}: bad index ${v}`);
    }
  }
  // bounds sanity
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getX(i)) > 60000 || Math.abs(pos.getZ(i)) > 60000 || Math.abs(pos.getY(i)) > 5000) {
      fail(`${label}: vertex out of plausible range`);
      break;
    }
  }
  return idx ? idx.count / 3 : 0;
}

/* ---------------- degenerate cases ---------------- */
const degenerate = [
  ['null', null],
  ['undefined', undefined],
  ['empty', []],
  ['one point', [[0, 0]]],
  ['two points', [[0, 0], [1, 1]]],
  ['triangle open', [[0, 0], [10, 0], [5, 8]]],
  ['triangle closed', [[0, 0], [10, 0], [5, 8], [0, 0]]],
  ['zero area', [[0, 0], [10, 0], [20, 0], [10, 0], [0, 0]]],
  ['all identical', [[3, 3], [3, 3], [3, 3], [3, 3]]],
  ['sliver', [[0, 0], [200, 0.02], [200, 0.04], [0, 0.03], [0, 0]]],
  ['self touching bowtie', [[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]],
  ['huge 500m square', [[0, 0], [500, 0], [500, 500], [0, 500], [0, 0]]],
  ['huge concave L', [[0, 0], [500, 0], [500, 120], [140, 120], [140, 500], [0, 500], [0, 0]]],
  ['NaN coords', [[0, 0], [NaN, 5], [10, 10], [0, 0]]],
  ['Infinity coords', [[0, 0], [Infinity, 5], [10, 10], [0, 0]]],
  ['nulls inside', [[0, 0], null, [10, 0], [10, 10], [0, 0]]],
  ['strings', [['0', '0'], ['10', '0'], ['10', '10'], ['0', '10']]],
  ['star spikes', [[0, 0], [30, 1], [60, 0], [59, 30], [60, 60], [30, 59], [0, 60], [1, 30], [0, 0]]],
  ['deep notch', [[0, 0], [60, 0], [60, 40], [31, 40], [31, 2], [29, 2], [29, 40], [0, 40], [0, 0]]],
  ['clockwise square', [[0, 0], [0, 40], [40, 40], [40, 0], [0, 0]]],
  ['tiny 1m2', [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  ['duplicate run', [[0, 0], [0, 0], [0, 0], [30, 0], [30, 30], [30, 30], [0, 30], [0, 0]]],
];
const degenHeights = [-5, 0, 0.001, NaN, undefined, 3, 40, 120, 400, 1e9];

for (const [name, fp] of degenerate) {
  for (const hh of degenHeights) {
    for (const t of [null, 0, 1, 2]) {
      try {
        const prof = massingProfile(fp, hh, undefined, { style: 'brick' });
        if (!Array.isArray(prof)) fail(`${name}: massingProfile did not return an array`);
        for (const tier of prof) {
          if (!Number.isFinite(tier.y0) || !Number.isFinite(tier.y1)) fail(`${name}: NaN tier y`);
          if (tier.y1 < tier.y0) fail(`${name}: inverted tier`);
          for (const [x, z] of tier.ring) {
            if (!Number.isFinite(x) || !Number.isFinite(z)) fail(`${name}: NaN in tier ring`);
          }
        }
        const r = buildArticulatedBuilding({
          footprint: fp,
          height: hh,
          baseY: 12.5,
          style: 'brick',
          tier: t,
          floorH: 3.7,
          windowW: 3.4,
        });
        checkGeom(r.wall, `${name}/wall`);
        checkGeom(r.trim, `${name}/trim`);
        const rs = buildRoofscape({
          footprint: fp,
          height: hh,
          baseY: 12.5,
          tier: t,
          roofRing: r.roofRing,
          roofY: r.roofY,
        });
        checkGeom(rs, `${name}/roof`);
        // also exercise the self-computing path
        checkGeom(buildRoofscape({ footprint: fp, height: hh, baseY: 12.5, tier: t }), `${name}/roof2`);
      } catch (e) {
        fail(`${name} h=${hh} tier=${t} threw: ${e && e.message}`);
      }
    }
  }
}
console.log('degenerate cases done, failures so far:', failures);

/* ---------------- inset correctness ---------------- */
for (const [name, fp] of degenerate) {
  const ring = ringFromFootprint(fp);
  if (!ring) continue;
  const a0 = footprintArea(fp);
  for (const d of [0.3, 1, 3, 12, 60, 400]) {
    const inner = insetRing(ring, d);
    if (!inner) continue;
    if (inner.length !== ring.length) fail(`${name}: inset changed vertex count`);
    const a1 = Math.abs(
      inner.reduce((acc, p, i) => {
        const q = inner[(i + 1) % inner.length];
        return acc + p[0] * q[1] - q[0] * p[1];
      }, 0) / 2,
    );
    if (a1 > a0 + 1e-3) fail(`${name}: inset grew area (${a1} > ${a0})`);
    if (a1 < a0 * 0.15) fail(`${name}: inset collapsed below threshold`);
    for (const [x, z] of inner) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) fail(`${name}: NaN in inset`);
    }
  }
  const outer = insetRing(ring, -0.7);
  if (outer) {
    const a1 = Math.abs(
      outer.reduce((acc, p, i) => {
        const q = outer[(i + 1) % outer.length];
        return acc + p[0] * q[1] - q[0] * p[1];
      }, 0) / 2,
    );
    if (a1 < a0 * 0.95) fail(`${name}: outward offset shrank`);
  }
}
console.log('inset checks done, failures so far:', failures);

/* ---------------- normals face outward, UVs match the facade convention ---------------- */
{
  const fp = [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]];
  const baseY = 7;
  const floorH = 3.7;
  const windowW = 3.4;
  for (const [style, h] of [['brick', 24], ['limestone', 60], ['glass', 180], ['lowrise', 10]]) {
    const r = buildArticulatedBuilding({ footprint: fp, height: h, baseY, style, floorH, windowW });
    for (const [label, g] of [['wall', r.wall], ['trim', r.trim]]) {
      if (!g) continue;
      const pos = g.attributes.position;
      const nrm = g.attributes.normal;
      const uv = g.attributes.uv;
      let inwardVertical = 0;
      let maxV = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const ny = nrm.getY(i);
        const nx = nrm.getX(i);
        const nz = nrm.getZ(i);
        if (Math.abs(Math.hypot(nx, ny, nz) - 1) > 1e-3) fail(`${style}/${label}: normal not unit`);
        // outward test against the plan centre (20, 15)
        if (Math.abs(ny) < 0.5) {
          const dx = pos.getX(i) - 20;
          const dz = pos.getZ(i) - 15;
          if (dx * nx + dz * nz < -0.05) inwardVertical++;
        }
        // UV convention: v must equal (y - baseY) / floorH on facade verts
        const u = uv.getX(i);
        const v = uv.getY(i);
        const isAnchor =
          (Math.abs(u - 0.003) < 1e-6 && Math.abs(v - 0.003) < 1e-6) ||
          (Math.abs(u - 0.012) < 1e-6 && Math.abs(v - 0.0055) < 1e-6);
        if (!isAnchor) {
          const expectV = (pos.getY(i) - baseY) / floorH;
          if (Math.abs(v - expectV) > 1e-4) fail(`${style}/${label}: v does not match (y-baseY)/floorH`);
          const along = Math.abs(nx) > Math.abs(nz) ? pos.getZ(i) : pos.getX(i);
          if (Math.abs(u - along / windowW) > 1e-4) fail(`${style}/${label}: u does not match along/windowW`);
          maxV = Math.max(maxV, v);
        }
      }
      // the parapet's inner face legitimately points inward; anything more is a winding bug
      const limit = label === 'trim' ? pos.count * 0.35 : pos.count * 0.02;
      if (inwardVertical > limit) {
        fail(`${style}/${label}: ${inwardVertical}/${pos.count} vertical normals point inward`);
      }
      // only the wall builder spans the full height; trim UVs stop at the plinth
      if (label === 'wall' && maxV > -Infinity && Math.abs(maxV - h / floorH) > 1.2) {
        fail(`${style}/${label}: top of facade at v=${maxV.toFixed(2)}, expected ~${(h / floorH).toFixed(2)}`);
      }
    }
    r.wall?.dispose();
    r.trim?.dispose();
  }
  console.log('normal / UV convention checks done, failures so far:', failures);
}

/* ---------------- trim is proud, setbacks actually step ---------------- */
{
  const fp = [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]];
  const r = buildArticulatedBuilding({ footprint: fp, height: 70, baseY: 0, style: 'limestone', tier: 2 });
  r.wall.computeBoundingBox();
  r.trim.computeBoundingBox();
  const wb = r.wall.boundingBox;
  const tb = r.trim.boundingBox;
  if (!(tb.min.x < wb.min.x - 0.2 && tb.max.x > wb.max.x + 0.2)) {
    fail(`trim is not proud of the wall (${tb.min.x} vs ${wb.min.x})`);
  }
  if (tb.max.x - wb.max.x > 1.2) fail('trim overhang is implausibly large');

  let stepped = 0;
  for (let i = 0; i < 400; i++) {
    const cx = i * 37.5 - 2000;
    const cz = i * -21.25 + 900;
    const box = [[cx, cz], [cx + 44, cz], [cx + 44, cz + 38], [cx, cz + 38], [cx, cz]];
    const prof = massingProfile(box, 150, undefined, { style: i % 2 ? 'glass' : 'artdeco' });
    if (prof.length < 2) continue;
    const a0 = footprintArea([...prof[0].ring, prof[0].ring[0]]);
    const a1 = footprintArea([...prof[prof.length - 1].ring, prof[prof.length - 1].ring[0]]);
    if (a1 < a0 * 0.98) stepped++;
    for (let k = 1; k < prof.length; k++) {
      if (prof[k].y0 !== prof[k - 1].y1) fail('tier gap or overlap in massing profile');
    }
    if (Math.abs(prof[prof.length - 1].y1 - 150) > 1e-6) fail('massing does not reach full height');
  }
  console.log(`tall-building setbacks: ${stepped}/400 stepped inward`);
  if (stepped < 320) fail('too few tall buildings actually step back');
  r.wall.dispose();
  r.trim.dispose();
}

/* ---------------- merges with the existing pipeline ---------------- */
{
  const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
  const THREE = await import('three');
  const { tintGeometry, applyFacadeUVs } = await import('./src/textures.js');

  const fp = [[0, 0], [30, 0], [30, 20], [0, 20], [0, 0]];
  const shape = new THREE.Shape();
  shape.moveTo(fp[0][0], -fp[0][1]);
  for (let i = 1; i < fp.length - 1; i++) shape.lineTo(fp[i][0], -fp[i][1]);
  shape.closePath();
  const legacy = new THREE.ExtrudeGeometry(shape, { depth: 20, bevelEnabled: false });
  legacy.rotateX(-Math.PI / 2);
  applyFacadeUVs(legacy, 3.7, 3.4, 0);
  tintGeometry(legacy, new THREE.Color(0.9, 0.9, 0.9));

  const mine = buildArticulatedBuilding({ footprint: fp, height: 20, baseY: 0, style: 'brick', floorH: 3.7, windowW: 3.4 });
  tintGeometry(mine.wall, new THREE.Color(0.9, 0.9, 0.9));
  if (mine.trim) tintGeometry(mine.trim, new THREE.Color(0.95, 0.95, 0.95));

  const parts = [legacy, mine.wall, mine.trim].filter(Boolean);
  const merged = mergeGeometries(parts, false);
  if (!merged) fail('mergeGeometries refused a mix of ExtrudeGeometry and architecture.js output');
  else {
    for (const key of ['position', 'normal', 'uv', 'color']) {
      if (!merged.attributes[key]) fail(`merged geometry lost the ${key} attribute`);
    }
    console.log('merge with ExtrudeGeometry ok:', merged.index.count / 3, 'tris');
    merged.dispose();
  }

  const roofs = [];
  for (let i = 0; i < 5; i++) {
    const off = i * 60;
    const f = [[off, 0], [off + 50, 0], [off + 50, 40], [off, 40], [off, 0]];
    const rr = buildRoofscape({ footprint: f, height: 80, baseY: 0, tier: 2 });
    if (rr) roofs.push(rr);
  }
  const mergedRoof = mergeGeometries(roofs, false);
  if (!mergedRoof) fail('roofscape geometries do not merge with each other');
  else console.log('roofscape merge ok:', mergedRoof.index.count / 3, 'tris,',
    'has color:', !!mergedRoof.attributes.color);
}

/* ---------------- determinism ---------------- */
{
  const fp = [[10, 10], [70, 12], [72, 60], [8, 58], [10, 10]];
  const a = buildArticulatedBuilding({ footprint: fp, height: 90, baseY: 3, style: 'limestone' });
  const b = buildArticulatedBuilding({ footprint: fp, height: 90, baseY: 3, style: 'limestone' });
  const pa = a.wall.attributes.position.array;
  const pb = b.wall.attributes.position.array;
  if (pa.length !== pb.length) fail('determinism: length mismatch');
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) { fail('determinism: value mismatch'); break; }
  const r1 = buildRoofscape({ footprint: fp, height: 90, baseY: 3, roofRing: a.roofRing, roofY: a.roofY });
  const r2 = buildRoofscape({ footprint: fp, height: 90, baseY: 3, roofRing: b.roofRing, roofY: b.roofY });
  const q1 = r1.attributes.position.array;
  const q2 = r2.attributes.position.array;
  for (let i = 0; i < q1.length; i++) if (q1[i] !== q2[i]) { fail('determinism: roofscape mismatch'); break; }
}
console.log('determinism ok');

/* ---------------- hash decorrelation ---------------- */
{
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 4000; i++) {
    const s = hash01(i * 3.7 - 900, i * -1.3 + 400);
    const v = hash01(s * 311.7 + 1 * 41.13, s * 727.3 - 1 * 19.71);
    buckets[Math.min(9, Math.floor(v * 10))]++;
  }
  const min = Math.min(...buckets);
  const max = Math.max(...buckets);
  console.log('h01 bucket spread', min, max);
  if (min < 250 || max > 600) fail('hash distribution is skewed');
}

/* ---------------- real city ---------------- */
const data = JSON.parse(readFileSync(new URL('./public/data/pittsburgh.json', import.meta.url)));
const buildings = data.buildings;

const stats = {
  0: { n: 0, tris: 0, max: 0, roofTris: 0 },
  1: { n: 0, tris: 0, max: 0, roofTris: 0 },
  2: { n: 0, tris: 0, max: 0, roofTris: 0 },
};
const archetypes = new Map();
let total = 0;
let plainTotal = 0;
let escaped = 0;
let worst = null;

const t0 = Date.now();
for (const b of buildings) {
  if (!b.f || b.f.length < 4) continue;
  const h = Math.max(3, b.h || 10);
  const fam = buildingFamily(b);
  const [floorH, windowW] = FAMILY_SPEC[fam] || [3.5, 3.2];
  const t = detailTier(b.f, h);
  let res;
  try {
    res = buildArticulatedBuilding({
      footprint: b.f,
      height: h,
      baseY: 4,
      style: fam,
      tier: t,
      floorH,
      windowW,
    });
  } catch (e) {
    fail(`real building ${b.n || '?'} threw: ${e.message}`);
    continue;
  }
  const wt = checkGeom(res.wall, `real/${b.n || '?'}/wall`);
  const tt = checkGeom(res.trim, `real/${b.n || '?'}/trim`);
  let rt = 0;
  if (t > 0) {
    const rs = buildRoofscape({
      footprint: b.f,
      height: h,
      baseY: 4,
      tier: t,
      style: fam,
      roofRing: res.roofRing,
      roofY: res.roofY,
    });
    rt = checkGeom(rs, `real/${b.n || '?'}/roof`);
    // every roofscape vertex must sit inside the roof ring
    if (rs && res.roofRing) {
      const pos = rs.attributes.position;
      for (let i = 0; i < pos.count; i += 7) {
        if (!insideWithMargin(pos.getX(i), pos.getZ(i), res.roofRing, -0.001)) {
          escaped++;
          break;
        }
      }
    }
    rs?.dispose();
  }
  const tris = wt + tt + rt;
  const s = stats[t];
  s.n++;
  s.tris += tris;
  s.roofTris += rt;
  if (tris > s.max) {
    s.max = tris;
    if (t === 2) worst = `${b.n || 'unnamed'} h=${h} area=${footprintArea(b.f).toFixed(0)} verts=${b.f.length - 1}`;
  }
  total += tris;

  const prof = massingProfile(b.f, h, undefined, { style: fam });
  if (prof.length) {
    const a = prof[0].archetype;
    archetypes.set(a, (archetypes.get(a) || 0) + 1);
  }

  const n = ringFromFootprint(b.f)?.length || 0;
  plainTotal += n * 2 + Math.max(0, n - 2);

  res.wall?.dispose();
  res.trim?.dispose();
}
const ms = Date.now() - t0;

console.log('\n--- real city ---');
console.log(`generated ${buildings.length} buildings in ${ms} ms`);
for (const t of [0, 1, 2]) {
  const s = stats[t];
  console.log(
    `tier ${t}: ${s.n} buildings, avg ${(s.tris / Math.max(1, s.n)).toFixed(1)} tris, ` +
      `max ${s.max}, total ${s.tris.toLocaleString()} (roofscape ${s.roofTris.toLocaleString()})`,
  );
}
console.log('CITY TOTAL TRIANGLES:', total.toLocaleString());
console.log('plain-prism baseline (today):', plainTotal.toLocaleString());
console.log('ratio:', (total / plainTotal).toFixed(2) + 'x');
console.log('archetypes:', [...archetypes.entries()].sort((a, b) => b[1] - a[1]));
console.log('roofscape vertices outside roof ring:', escaped);
console.log('worst tier-2 building:', worst);

const BUDGET = { 0: 140, 1: 460, 2: 1500 };
for (const t of [0, 1, 2]) {
  if (stats[t].max > BUDGET[t]) fail(`tier ${t} exceeded budget: ${stats[t].max} > ${BUDGET[t]}`);
}
if (total > 900000) fail(`city total over budget: ${total}`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
