/**
 * Rebuild the river surfaces from the real OSM water multipolygons.
 *
 * The rivers here are `natural=water` + `water=river` relations whose members
 * are *open* bank segments, so they only become usable polygons after the
 * segments are stitched end-to-end into closed rings. The previous pass force
 * closed each member on its own, which collapsed every bank into a sliver and
 * left banks averaging 145 m between vertices — coarse enough to swallow whole
 * North Shore blocks and to leave dry ground standing mid-channel.
 *
 * Islands (Washington's Landing, Brunot, Sycamore, ...) arrive as rings nested
 * inside a bank ring; they are subtracted so they stay dry land.
 */
import polygonClipping from 'polygon-clipping';
import { overpass, project, readData, writeData } from './osm.mjs';

const BBOX = '40.360,-80.120,40.500,-79.860';

/** Scene extent; water is clipped to this so it never runs off the terrain. */
const CLIP = { minX: -4600, maxX: 8600, minZ: -4000, maxZ: 4600 };

const RIVER_NAMES = /^(Ohio River|Allegheny River|Monongahela River)$/;

function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
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

/**
 * Stitch open polylines into closed rings by matching endpoints. Ways that are
 * already closed pass straight through. Anything that cannot be closed is
 * returned separately so the caller can decide whether to keep it.
 */
function stitchRings(ways) {
  const key = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const rings = [];
  const open = [];
  const pool = [];

  for (const w of ways) {
    if (w.length < 2) continue;
    const closed = key(w[0]) === key(w[w.length - 1]);
    if (closed && w.length >= 4) rings.push(w);
    else pool.push(w.slice());
  }

  // Index every fragment by both endpoints, then walk chains greedily.
  const used = new Uint8Array(pool.length);
  const ends = new Map();
  const addEnd = (k, i) => {
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k).push(i);
  };
  pool.forEach((w, i) => {
    addEnd(key(w[0]), i);
    addEnd(key(w[w.length - 1]), i);
  });

  for (let i = 0; i < pool.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = pool[i].slice();

    // Extend from the tail until the chain closes or runs out of neighbours.
    for (let guard = 0; guard < pool.length + 4; guard++) {
      const tail = key(chain[chain.length - 1]);
      if (tail === key(chain[0])) break;
      const cands = ends.get(tail) || [];
      let next = -1;
      for (const c of cands) {
        if (!used[c]) {
          next = c;
          break;
        }
      }
      if (next < 0) break;
      used[next] = 1;
      const w = pool[next];
      chain = key(w[0]) === tail ? chain.concat(w.slice(1)) : chain.concat(w.slice(0, -1).reverse());
    }

    if (key(chain[0]) === key(chain[chain.length - 1]) && chain.length >= 4) rings.push(chain);
    else open.push(chain);
  }

  return { rings, open };
}

function clipToScene(multi) {
  const box = [
    [
      [CLIP.minX, CLIP.minZ],
      [CLIP.maxX, CLIP.minZ],
      [CLIP.maxX, CLIP.maxZ],
      [CLIP.minX, CLIP.maxZ],
      [CLIP.minX, CLIP.minZ],
    ],
  ];
  return polygonClipping.intersection(multi, [box]);
}

function round(ring) {
  const out = ring.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]);
  const a = out[0];
  const b = out[out.length - 1];
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01) out.push([a[0], a[1]]);
  return out;
}

const query = `[out:json][timeout:300];
rel["natural"="water"]["water"~"river|reservoir"](${BBOX})->.r;
way["natural"="water"]["water"="river"](${BBOX})->.w;
(way(r.r); .w;);
out geom;`;

const raw = await overpass('water-river-ways', query);

/**
 * Mid-channel anchors taken from the OSM `waterway=river` centrelines, so the
 * labels follow the real channels instead of hand-guessed coordinates.
 */
const centrelines = await overpass(
  'water-centrelines',
  `[out:json][timeout:240];rel["waterway"="river"]["name"~"Ohio River|Allegheny River|Monongahela River"](${BBOX});out geom;`,
);
const RIVER_ANCHORS = [];
for (const el of centrelines.elements) {
  const n = el.tags?.name;
  if (!n || !RIVER_NAMES.test(n)) continue;
  const pts = [];
  for (const m of el.members || []) {
    if (!m.geometry) continue;
    for (const g of m.geometry) {
      const [x, z] = project(g.lat, g.lon);
      if (x > CLIP.minX && x < CLIP.maxX && z > CLIP.minZ && z < CLIP.maxZ) pts.push([x, z]);
    }
  }
  if (pts.length) RIVER_ANCHORS.push({ n, x: pts[pts.length >> 1][0], z: pts[pts.length >> 1][1] });
}
console.log(
  'channel anchors: ' +
    RIVER_ANCHORS.map((a) => `${a.n} (${a.x.toFixed(0)},${a.z.toFixed(0)})`).join(', '),
);

const ways = [];
for (const el of raw.elements) {
  if (!el.geometry || el.geometry.length < 2) continue;
  ways.push(el.geometry.map((g) => project(g.lat, g.lon)));
}
console.log(`fetched ${ways.length} bank ways, ${ways.reduce((s, w) => s + w.length, 0)} vertices`);

const { rings, open } = stitchRings(ways);
console.log(`stitched into ${rings.length} closed rings (${open.length} fragments left open)`);
for (const o of open) {
  const d = Math.hypot(o[0][0] - o[o.length - 1][0], o[0][1] - o[o.length - 1][1]);
  if (d < 2000) console.log(`  unclosed fragment: ${o.length} pts, ${d.toFixed(0)}m gap`);
}

// Largest-first so containment tests always compare against an enclosing ring.
const sorted = rings
  .map((r) => ({ r, a: Math.abs(ringArea(r)) }))
  .filter((x) => x.a > 200)
  .sort((x, y) => y.a - x.a);
console.log(`kept ${sorted.length} rings above 200 m2`);

const outers = [];
const islands = [];
for (const cand of sorted) {
  const [px, pz] = cand.r[0];
  const host = outers.find((o) => pointInRing(px, pz, o.r));
  if (host) islands.push(cand);
  else outers.push(cand);
}
console.log(`  ${outers.length} bank rings, ${islands.length} islands`);
for (const i of islands.slice(0, 10)) console.log(`    island ${(i.a / 1e4).toFixed(2)} ha`);

let surface = polygonClipping.union(...outers.map((o) => [[o.r]]));
if (islands.length) {
  surface = polygonClipping.difference(surface, ...islands.map((i) => [[i.r]]));
}
surface = clipToScene(surface);

// Drop slivers that survive clipping, then label by the nearest river anchor.
const out = [];
for (const poly of surface) {
  const outer = poly[0];
  const a = Math.abs(ringArea(outer));
  if (a < 5000) continue;
  const holes = poly.slice(1).filter((h) => Math.abs(ringArea(h)) > 400);

  let cx = 0;
  let cz = 0;
  for (let i = 0; i < outer.length - 1; i++) {
    cx += outer[i][0];
    cz += outer[i][1];
  }
  cx /= outer.length - 1;
  cz /= outer.length - 1;
  // The three rivers merge into one polygon at the Point, so label a surface by
  // every channel it actually contains rather than by its centroid alone.
  const inside = RIVER_ANCHORS.filter((anc) => pointInRing(anc.x, anc.z, outer));
  let name;
  if (inside.length > 1) name = inside.map((a) => a.n.replace(' River', '')).join(' / ') + ' Rivers';
  else if (inside.length === 1) name = inside[0].n;
  else {
    let best = Infinity;
    name = 'River';
    for (const anc of RIVER_ANCHORS) {
      const d = Math.hypot(anc.x - cx, anc.z - cz);
      if (d < best) {
        best = d;
        name = anc.n;
      }
    }
  }

  out.push({ n: name, f: round(outer), holes: holes.map(round) });
}

out.sort((a, b) => Math.abs(ringArea(b.f)) - Math.abs(ringArea(a.f)));
console.log(`\nwriting ${out.length} water surfaces:`);
let totalA = 0;
let totalV = 0;
for (const w of out) {
  const a = Math.abs(ringArea(w.f));
  let per = 0;
  for (let i = 0; i < w.f.length - 1; i++) {
    per += Math.hypot(w.f[i + 1][0] - w.f[i][0], w.f[i + 1][1] - w.f[i][1]);
  }
  totalA += a;
  totalV += w.f.length;
  console.log(
    `  ${w.n}: ${(a / 1e4).toFixed(1)} ha, ${w.f.length} verts, ${(per / (w.f.length - 1)).toFixed(1)} m/vert, ${w.holes.length} islands`,
  );
}
console.log(`total ${(totalA / 1e4).toFixed(1)} ha across ${totalV} vertices`);

const data = readData();
data.water = out;
data.meta.water = 'OSM natural=water multipolygons, banks stitched from member ways';
writeData(data);
console.log('wrote public/data/pittsburgh.json');
