/**
 * Re-solve the bridge spans against the corrected river banks.
 *
 * The previous spans were fitted while the water polygons were still the coarse
 * stitched-wrong version, so the "is this segment over water" test misfired and
 * several decks ended up far short of their real length (Fort Duquesne came out
 * at 269 m against a real 483 m) or skewed off the true crossing bearing.
 *
 * For each named bridge: keep the OSM way segments that cross open water, take
 * the largest connected cluster of them so approach ramps and interchange spurs
 * drop out, fit the crossing axis to that cluster, then push each end past the
 * waterline until it reaches solid bank so the deck lands on abutments.
 */
import { overpass, project, readData, writeData } from './osm.mjs';

const NEAR_BBOX = '40.410,-80.075,40.475,-79.895';

/** Metres of bank the deck should reach past the waterline at each end. */
const ABUTMENT = 26;

const BRIDGES = [
  { n: 'ROBERTO CLEMENTE BRIDGE', match: /^roberto clemente bridge$/i, type: 'sisters', color: '#f0d050', real: 303 },
  { n: 'ANDY WARHOL BRIDGE', match: /^andy warhol bridge$/i, type: 'sisters', color: '#f0d050', real: 323 },
  { n: 'RACHEL CARSON BRIDGE', match: /^rachel carson bridge$/i, type: 'sisters', color: '#f0d050', real: 303 },
  { n: 'FORT PITT BRIDGE', match: /^fort pitt bridge$/i, type: 'double-arch', color: '#f0d050', real: 368 },
  { n: 'FORT DUQUESNE BRIDGE', match: /^fort duquesne bridge$/i, type: 'double-arch', color: '#f0d050', real: 483 },
  { n: 'SMITHFIELD STREET BRIDGE', match: /^smithfield street bridge$/i, type: 'lenticular', color: '#87949e', real: 361 },
  // Liberty's 812 m total is mostly the approach up to the tunnels, so only the
  // two 448 ft river spans are compared here.
  { n: 'LIBERTY BRIDGE', match: /^liberty bridge$/i, type: 'cantilever', color: '#cfb79a', real: 273 },
  { n: 'VETERANS BRIDGE', match: /^veterans bridge$/i, type: 'girder', color: '#8d939c' },
  { n: 'WEST END BRIDGE', match: /^west end bridge$/i, type: 'tied-arch', color: '#f0d050', real: 463 },
  { n: 'DAVID MCCULLOUGH BRIDGE', match: /^(david mccullough bridge|16th street bridge)$/i, type: 'through-arch', color: '#f0d050' },
  { n: 'ANDY WARHOL RAIL BRIDGE', match: /^fort wayne bridge$/i, type: 'through-truss', color: '#8d939c' },
  { n: 'BIRMINGHAM BRIDGE', match: /^birmingham bridge$/i, type: 'tied-arch', color: '#53603f' },
  { n: 'SOUTH TENTH STREET BRIDGE', match: /^south 10th street bridge$/i, type: 'suspension', color: '#f0d050' },
  { n: 'PANHANDLE BRIDGE', match: /^panhandle bridge$/i, type: 'through-truss', color: '#8d939c' },
  { n: 'HOT METAL BRIDGE', match: /^(hot metal bridge|monongahela connecting railroad bridge)$/i, type: 'through-truss', color: '#6f5546' },
  { n: '31ST STREET BRIDGE', match: /^31st street bridge$/i, type: 'deck-arch', color: '#41688e' },
];

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function makeWetTest(water) {
  return (x, z) => {
    for (const w of water) {
      if (!pointInRing(x, z, w.f)) continue;
      let hole = false;
      for (const h of w.holes || []) {
        if (pointInRing(x, z, h)) {
          hole = true;
          break;
        }
      }
      if (!hole) return true;
    }
    return false;
  };
}

function tagNames(tags = {}) {
  return [tags.name, tags['bridge:name'], tags.alt_name, tags.old_name].filter(Boolean);
}

/**
 * Group segments that touch each other (within `tol`) so a bridge's main deck
 * separates from the ramps that merely share its name.
 */
function largestCluster(segments, tol = 45) {
  const n = segments.length;
  const parent = new Array(n).fill(0).map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const join = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const [a1, a2] = segments[i];
      const [b1, b2] = segments[j];
      let near = false;
      for (const p of [a1, a2]) {
        for (const q of [b1, b2]) {
          if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol) near = true;
        }
      }
      if (near) join(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(segments[i]);
  }
  let best = [];
  let bestLen = -1;
  for (const g of groups.values()) {
    let len = 0;
    for (const [a, b] of g) len += Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > bestLen) {
      bestLen = len;
      best = g;
    }
  }
  return best;
}

/** Longest chord of a point set, i.e. the true end-to-end axis. */
function longestChord(pts) {
  let best = null;
  let bd = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
      if (d > bd) {
        bd = d;
        best = [pts[i], pts[j]];
      }
    }
  }
  return { chord: best, len: bd };
}

/**
 * Find where the crossing axis actually enters and leaves the water.
 *
 * OSM splits bridge ways inconsistently — some crossings are a single way from
 * abutment to abutment, others are dozens of pieces including ramps — so the
 * span cannot be read off the way lengths. Sampling the axis against the bank
 * polygons instead gives the same answer whatever the segmentation, and the
 * deck then reaches one abutment's worth of bank past each waterline.
 */
function waterCrossing(origin, dir, wet, reach = 700, step = 3) {
  let bestLo = null;
  let bestHi = null;
  let bestLen = 0;
  let lo = null;
  for (let t = -reach; t <= reach; t += step) {
    const isWet = wet(origin[0] + dir[0] * t, origin[1] + dir[1] * t);
    if (isWet) {
      if (lo === null) lo = t;
    } else if (lo !== null) {
      // Ignore pinholes so an island or a pier gap cannot split the channel.
      if (t - step - lo > bestLen) {
        bestLen = t - step - lo;
        bestLo = lo;
        bestHi = t - step;
      }
      lo = null;
    }
  }
  if (lo !== null && reach - lo > bestLen) {
    bestLen = reach - lo;
    bestLo = lo;
    bestHi = reach;
  }
  if (bestLo === null) return null;
  return { lo: bestLo - ABUTMENT, hi: bestHi + ABUTMENT, wetLen: bestLen };
}

const data = readData();
const wet = makeWetTest(data.water);

const query = `[out:json][timeout:240];
(
  way["bridge"]["name"](${NEAR_BBOX});
  way["bridge"]["bridge:name"](${NEAR_BBOX});
  way["railway"]["bridge"](${NEAR_BBOX});
);
out geom tags;`;
const raw = await overpass('bridges-resolve', query);

const before = new Map(data.bridges.map((b) => [b.n, b]));
const out = [];

for (const spec of BRIDGES) {
  const segments = [];
  for (const el of raw.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    if (!tagNames(el.tags).some((n) => spec.match.test(n))) continue;
    for (let i = 0; i < el.geometry.length - 1; i++) {
      segments.push([
        project(el.geometry[i].lat, el.geometry[i].lon),
        project(el.geometry[i + 1].lat, el.geometry[i + 1].lon),
      ]);
    }
  }

  const prev = before.get(spec.n);
  if (!segments.length) {
    console.log(`  ! ${spec.n}: no OSM match, keeping previous span`);
    if (prev) out.push(prev);
    continue;
  }

  // Only the part actually over water defines the crossing.
  const overWater = segments.filter(([a, b]) => wet((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
  if (!overWater.length) {
    console.log(`  ! ${spec.n}: no segment over water, keeping previous span`);
    if (prev) out.push(prev);
    continue;
  }

  const cluster = largestCluster(overWater);
  const pts = [];
  for (const [a, b] of cluster) pts.push(a, b);
  const { chord, len } = longestChord(pts);
  if (!chord || len < 40) {
    console.log(`  ! ${spec.n}: crossing too short (${len.toFixed(0)}m), keeping previous span`);
    if (prev) out.push(prev);
    continue;
  }

  const dx = (chord[1][0] - chord[0][0]) / len;
  const dz = (chord[1][1] - chord[0][1]) / len;
  const mid = [(chord[0][0] + chord[1][0]) / 2, (chord[0][1] + chord[1][1]) / 2];
  const cross = waterCrossing(mid, [dx, dz], wet);
  if (!cross) {
    console.log(`  ! ${spec.n}: axis never crosses water, keeping previous span`);
    if (prev) out.push(prev);
    continue;
  }

  const a = [mid[0] + dx * cross.lo, mid[1] + dz * cross.lo];
  const b = [mid[0] + dx * cross.hi, mid[1] + dz * cross.hi];
  const finalLen = Math.hypot(b[0] - a[0], b[1] - a[1]);

  const pts2 = [
    [+a[0].toFixed(2), +a[1].toFixed(2)],
    [+b[0].toFixed(2), +b[1].toFixed(2)],
  ];
  const prevLen = prev ? Math.hypot(prev.pts[1][0] - prev.pts[0][0], prev.pts[1][1] - prev.pts[0][1]) : 0;
  const bearing = (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI;
  const realNote = spec.real ? ` real ${spec.real}m` : '';
  console.log(
    `  ${spec.n}: channel ${cross.wetLen.toFixed(0)}m -> deck ${finalLen.toFixed(0)}m (was ${prevLen.toFixed(0)}m)${realNote} bearing ${bearing.toFixed(0)}deg  segs ${overWater.length}/${segments.length}`,
  );

  out.push({ n: spec.n, color: spec.color, type: spec.type, pts: pts2 });
}

data.bridges = out;
data.meta.bridges = 'spans solved from OSM bridge ways clipped to the stitched river banks';
writeData(data);
console.log(`\nwrote ${out.length} bridges`);
