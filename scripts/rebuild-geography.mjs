/**
 * Rebuild water (buffered local river centerlines) and restore bridge spans.
 * Centerlines are hand-calibrated in local meters to match building footprints
 * and verified bridge endpoints — OSM lat/lon projection is too inconsistent
 * across the map extent for sub-50m accuracy.
 *
 * Run: node scripts/rebuild-geography.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { footprintCentroid, makeWaterIndex, footprintWaterOverlap } from '../src/geo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = join(root, 'public/data/pittsburgh.json');

/** River centerlines in local meters (+X east, +Z south). */
const RIVER_CENTERLINES = [
  {
    n: 'Allegheny River',
    halfWidth: 108,
    line: [
      [1350, -420],
      [1100, -460],
      [820, -505],
      [520, -550],
      [260, -585],
      [79, -642],
      [-90, -541],
      [-283, -468],
      [-520, -390],
      [-720, -350],
      [-847, -318],
      [-900, -200],
      [-930, -110],
      [-950, -82],
    ],
  },
  {
    n: 'Monongahela River',
    halfWidth: 116,
    line: [
      [4000, 1480],
      [3532, 1455],
      [2200, 1320],
      [1500, 1200],
      [1100, 1080],
      [780, 960],
      [488, 840],
      [180, 710],
      [-54, 623],
      [-380, 440],
      [-580, 240],
      [-742, 130],
      [-850, 70],
      [-910, -10],
      [-948, -70],
    ],
  },
  {
    n: 'Ohio River',
    halfWidth: 132,
    line: [
      [-948, -78],
      [-1100, -70],
      [-1400, -48],
      [-1800, -18],
      [-2400, 20],
    ],
  },
];

/** Verified bridge spans from the hand-calibrated map (main branch). */
const BRIDGES = [
  {
    n: 'ROBERTO CLEMENTE BRIDGE',
    color: '#f0d050',
    type: 'sisters',
    pts: [
      [51.26, -391.2],
      [107.32, -892.08],
    ],
  },
  {
    n: 'ANDY WARHOL BRIDGE',
    color: '#f0d050',
    type: 'sisters',
    pts: [
      [-124.98, -345.78],
      [-55.75, -735.68],
    ],
  },
  {
    n: 'RACHEL CARSON BRIDGE',
    color: '#f0d050',
    type: 'sisters',
    pts: [
      [-315.07, -285.25],
      [-250, -650],
    ],
  },
  {
    n: 'SMITHFIELD STREET BRIDGE',
    color: '#8d939c',
    type: 'lenticular',
    pts: [
      [-79.8, 395.62],
      [-27.85, 850.67],
    ],
  },
  {
    n: 'FORT PITT BRIDGE',
    color: '#8d939c',
    type: 'double-arch',
    pts: [
      [-741.86, -91.83],
      [-958, 286.83],
    ],
  },
  {
    n: 'FORT DUQUESNE BRIDGE',
    color: '#8d939c',
    type: 'double-arch',
    pts: [
      [-694.7, -133.6],
      [-999.7, -534.3],
    ],
  },
  {
    n: 'LIBERTY BRIDGE',
    color: '#8d939c',
    type: 'cantilever',
    pts: [
      [442.06, 597.84],
      [534.39, 1083.13],
    ],
  },
  {
    n: 'HOT METAL BRIDGE',
    color: '#8d939c',
    type: 'truss',
    pts: [
      [3457.97, 1162.75],
      [3606.49, 1748.2],
    ],
  },
];

function bufferCenterline(line, halfWidth) {
  if (line.length < 2) return null;
  const left = [];
  const right = [];
  for (let i = 0; i < line.length; i++) {
    const prev = line[Math.max(0, i - 1)];
    const curr = line[i];
    const next = line[Math.min(line.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * halfWidth;
    const nz = (dx / len) * halfWidth;
    left.push([+(curr[0] + nx).toFixed(2), +(curr[1] + nz).toFixed(2)]);
    right.push([+(curr[0] - nx).toFixed(2), +(curr[1] - nz).toFixed(2)]);
  }
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]);
  return ring;
}

function simplifyRing(ring, tolerance = 8) {
  if (ring.length <= 4) return ring;
  const kept = [ring[0]];
  for (let i = 1; i < ring.length - 1; i++) {
    const prev = kept[kept.length - 1];
    const next = ring[i + 1];
    const cur = ring[i];
    const dx = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    const dist = Math.abs(dx * (prev[1] - cur[1]) - dz * (prev[0] - cur[0])) / len;
    if (dist > tolerance) kept.push(cur);
  }
  kept.push(ring[ring.length - 1]);
  return kept;
}

function loadMainBridges() {
  try {
    const raw = execSync('git show main:public/data/pittsburgh.json', { cwd: root, encoding: 'utf8' });
    return JSON.parse(raw).bridges || BRIDGES;
  } catch {
    return BRIDGES;
  }
}

function main() {
  const water = [];
  for (const river of RIVER_CENTERLINES) {
    const ring = simplifyRing(bufferCenterline(river.line, river.halfWidth), 10);
    water.push({ n: river.n, f: ring });
  }

  const bridges = loadMainBridges().map((b) => ({
    n: b.n,
    color: b.color,
    type: b.type,
    pts: b.pts.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]),
  }));

  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  data.water = water;
  data.bridges = bridges;
  data.meta.note = 'OSM buildings/streets/parks + calibrated local river centerlines + verified bridges';
  data.meta.geographyRebuild = new Date().toISOString().slice(0, 10);

  writeFileSync(dataPath, JSON.stringify(data));

  const wi = makeWaterIndex(water.map((w) => w.f), { erosion: 12 });
  let centroidWater = 0;
  let filtered = 0;
  let partial = 0;
  for (const b of data.buildings) {
    if (!b.f) continue;
    const [cx, cz] = footprintCentroid(b.f);
    if (wi.inside(cx, cz)) centroidWater++;
    const ov = footprintWaterOverlap(b.f, wi);
    if (ov > 0.18) filtered++;
    else if (ov > 0.05) partial++;
  }

  console.log(`${water.length} water polygons, ${bridges.length} bridges`);
  for (const br of bridges) {
    const [a, c] = br.pts;
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const cx = (a[0] + c[0]) / 2;
    const cz = (a[1] + c[1]) / 2;
    let waterPts = 0;
    for (let t = 0; t <= 20; t++) {
      const x = a[0] + (dx * t) / 20;
      const z = a[1] + (dz * t) / 20;
      if (wi.inside(x, z)) waterPts++;
    }
    console.log(
      `${br.n}: ${Math.hypot(dx, dz).toFixed(0)}m @ ${((Math.atan2(dz, dx) * 180) / Math.PI).toFixed(1)}° · ${((waterPts / 21) * 100).toFixed(0)}% over water`,
    );
  }
  console.log(`\nBuildings centroid in water: ${centroidWater}`);
  console.log(`Would filter (>18% overlap): ${filtered}`);
  console.log(`Partial overlap 5-18%: ${partial}`);
  console.log(`Point (-864,-78) in water: ${wi.inside(-864, -78)}`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
