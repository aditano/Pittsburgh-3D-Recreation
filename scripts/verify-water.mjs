/**
 * Verify the river surfaces two ways:
 *   - every point on the real OSM river centrelines must be wet
 *   - a list of known-dry landmarks must not be
 * Prints the gaps so a coverage regression is obvious rather than subtle.
 */
import { overpass, project, readData } from './osm.mjs';
import { nameKey } from './osm-features.mjs';

const BBOX = '40.360,-80.120,40.500,-79.860';
const CLIP = { minX: -4600, maxX: 8600, minZ: -4000, maxZ: 4600 };

/**
 * Buildings that are unambiguously on land, as a guard against water sprawl.
 * Probed at their own footprint centroid so the check follows the dataset
 * rather than a hand-typed coordinate.
 *
 * Names must be the names the dataset actually stores. Four of these used to be
 * spelled the way a person would say them — "PPG Place" for the six separate
 * PPG records, "Duquesne Incline" for the two station houses, "US Steel Tower"
 * without its stops, "Carnegie Science Center" for what OSM renamed Kamin in
 * 2023 — and every one reported a false "NOT IN DATASET" while the building
 * stood right where it belongs. Alternates are listed so a future rename shows
 * up as a rename rather than as a missing landmark.
 */
const DRY_BUILDINGS = [
  ['PNC Park'],
  ['Acrisure Stadium'],
  ['Alcoa Corporate Center'],
  ['Microsoft Engineering Office'],
  ['Riverside Center for Innovation North'],
  ['Morgan at North Shore'],
  ['The Andy Warhol Museum'],
  ['Kamin Science Center', 'Carnegie Science Center'],
  ['Sheraton Pittsburgh Hotel at Station Square'],
  ['Station Square Parking Garage'],
  ['U.S. Steel Tower', 'US Steel Tower'],
  ['One PPG Place', 'PPG Place'],
  ['David L. Lawrence Convention Center'],
  ['Cathedral of Learning'],
  ['PPG Paints Arena'],
  ['Duquesne Lower Station'],
  ['Duquesne Upper Station'],
  ['Monongahela Lower Station'],
  ['Monongahela Upper Station'],
  ['Fort Pitt Block House'],
  ['Senator John Heinz History Center'],
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

function makeTester(water) {
  return (x, z) => {
    for (const w of water) {
      if (!pointInRing(x, z, w.f)) continue;
      let inHole = false;
      for (const h of w.holes || []) {
        if (pointInRing(x, z, h)) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }
    return false;
  };
}

const data = readData();
const wet = makeTester(data.water);

console.log(`water surfaces: ${data.water.length}`);
for (const w of data.water) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of w.f) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  console.log(
    `  ${w.n}: ${w.f.length} verts  x[${minX.toFixed(0)}..${maxX.toFixed(0)}] z[${minZ.toFixed(0)}..${maxZ.toFixed(0)}]  ${(w.holes || []).length} islands`,
  );
}

// ------------------------------------------------- centreline coverage

const res = await overpass(
  'verify-centrelines',
  `[out:json][timeout:240];rel["waterway"="river"]["name"~"Ohio River|Allegheny River|Monongahela River"](${BBOX});out geom;`,
);

const lines = new Map();
for (const el of res.elements) {
  const nm = el.tags?.name;
  if (!nm) continue;
  for (const m of el.members || []) {
    if (!m.geometry) continue;
    const pts = m.geometry.map((g) => project(g.lat, g.lon));
    if (!lines.has(nm)) lines.set(nm, []);
    lines.get(nm).push(pts);
  }
}

console.log('\ncentreline coverage (sampled every ~25 m, inside the scene box):');
let worstRuns = [];
for (const [nm, segs] of lines) {
  let total = 0;
  let dry = 0;
  const runs = [];
  let run = null;
  for (const pts of segs) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / 25));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        if (x < CLIP.minX || x > CLIP.maxX || z < CLIP.minZ || z > CLIP.maxZ) continue;
        total++;
        if (wet(x, z)) {
          if (run) {
            runs.push(run);
            run = null;
          }
        } else {
          dry++;
          if (!run) run = { x0: x, z0: z, n: 0 };
          run.n++;
          run.x1 = x;
          run.z1 = z;
        }
      }
    }
  }
  if (run) runs.push(run);
  const pct = total ? (dry / total) * 100 : 0;
  console.log(`  ${nm}: ${total} samples, ${dry} dry (${pct.toFixed(1)}%)`);
  runs.sort((a, b) => b.n - a.n);
  for (const r of runs.slice(0, 4)) {
    console.log(
      `      gap ~${(r.n * 25).toFixed(0)}m from (${r.x0.toFixed(0)},${r.z0.toFixed(0)}) to (${(r.x1 ?? r.x0).toFixed(0)},${(r.z1 ?? r.z0).toFixed(0)})`,
    );
  }
  worstRuns = worstRuns.concat(runs);
}

// -------------------------------------------------------- dry-land guard

console.log('\nknown-dry probes (at each footprint centroid):');
const byKey = new Map();
for (const b of data.buildings) if (b.n) byKey.set(nameKey(b.n), b);

let wrong = 0;
let missing = 0;
for (const names of DRY_BUILDINGS) {
  const nm = names[0];
  let b = null;
  for (const cand of names) {
    b = byKey.get(nameKey(cand));
    if (b) break;
  }
  if (!b) {
    missing++;
    console.log(`  NOT IN DATASET    ${names.join(' / ')}`);
    continue;
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < b.f.length - 1; i++) {
    cx += b.f[i][0];
    cz += b.f[i][1];
  }
  cx /= b.f.length - 1;
  cz /= b.f.length - 1;
  // Sample the whole footprint, not just the centroid, so a partly submerged
  // building cannot pass by having a dry middle.
  let inWater = 0;
  for (let i = 0; i < b.f.length - 1; i++) if (wet(b.f[i][0], b.f[i][1])) inWater++;
  const centreWet = wet(cx, cz);
  if (centreWet || inWater > 0) wrong++;
  console.log(
    `  ${centreWet ? 'CENTRE IN WATER <-- BAD' : inWater ? 'edge in water <-- check' : 'dry  ok                '}  ${nm} (${cx.toFixed(0)},${cz.toFixed(0)}) ${inWater}/${b.f.length - 1} verts wet`,
  );
}
console.log(`\n${wrong} of ${DRY_BUILDINGS.length} dry probes touching water, ${missing} missing from dataset`);
