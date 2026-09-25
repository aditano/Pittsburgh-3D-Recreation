/**
 * Verify the river surfaces two ways:
 *   - every point on the real OSM river centrelines must be wet
 *   - a list of known-dry landmarks must not be
 * Prints the gaps so a coverage regression is obvious rather than subtle.
 *
 * Failing (nonzero exit): any centreline sample inside the scene box is dry,
 * a known-dry landmark centroid sits in the water, or a probe name is missing
 * from the dataset. A footprint edge in the water while the centroid stays dry
 * is informational — it is printed and does not fail the run.
 */
import { overpass, project, readData } from './osm.mjs';
import { nameKey } from './osm-features.mjs';
import { failureExitCode, invokedDirectly } from './verifier-exit.mjs';

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

function centrelineLines(overpassJson) {
  const lines = new Map();
  for (const el of overpassJson.elements) {
    const nm = el.tags?.name;
    if (!nm) continue;
    for (const m of el.members || []) {
      if (!m.geometry) continue;
      const pts = m.geometry.map((g) => project(g.lat, g.lon));
      if (!lines.has(nm)) lines.set(nm, []);
      lines.get(nm).push(pts);
    }
  }
  return lines;
}

/** Any dry centreline sample inside the scene box fails. Zero samples (outside the box) does not. */
export function assessCentreline(wet, lines, clip = CLIP) {
  const rivers = [];
  let failures = 0;
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
          if (x < clip.minX || x > clip.maxX || z < clip.minZ || z > clip.maxZ) continue;
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
    if (dry > 0) failures++;
    runs.sort((a, b) => b.n - a.n);
    const pct = total ? (dry / total) * 100 : 0;
    rivers.push({ name: nm, total, dry, pct, runs });
  }
  return { failures, rivers };
}

/**
 * Centre-in-water and a missing probe name fail. An edge vertex in the water
 * with a dry centroid is informational.
 */
export function assessDryProbes(data, names = DRY_BUILDINGS) {
  const wet = makeTester(data.water || []);
  const byKey = new Map();
  for (const b of data.buildings || []) if (b.n) byKey.set(nameKey(b.n), b);
  const probes = [];
  let failures = 0;
  let infos = 0;
  for (const group of names) {
    const nm = group[0];
    let b = null;
    for (const cand of group) {
      b = byKey.get(nameKey(cand));
      if (b) break;
    }
    if (!b) {
      failures++;
      probes.push({ name: nm, status: 'missing', names: group });
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
    let status = 'dry';
    if (centreWet) {
      status = 'centre';
      failures++;
    } else if (inWater > 0) {
      status = 'edge';
      infos++;
    }
    probes.push({
      name: nm,
      status,
      cx,
      cz,
      inWater,
      verts: b.f.length - 1,
    });
  }
  return { failures, infos, probes };
}

function printWater(data) {
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
}

function printCentreline(report) {
  console.log('\ncentreline coverage (sampled every ~25 m, inside the scene box):');
  for (const river of report.rivers) {
    const mark = river.dry > 0 ? 'FAIL' : 'ok  ';
    console.log(`  ${mark} ${river.name}: ${river.total} samples, ${river.dry} dry (${river.pct.toFixed(1)}%)`);
    for (const r of river.runs.slice(0, 4)) {
      console.log(
        `      gap ~${(r.n * 25).toFixed(0)}m from (${r.x0.toFixed(0)},${r.z0.toFixed(0)}) to (${(r.x1 ?? r.x0).toFixed(0)},${(r.z1 ?? r.z0).toFixed(0)})`,
      );
    }
  }
}

function printProbes(report) {
  console.log('\nknown-dry probes (at each footprint centroid):');
  let centre = 0;
  let missing = 0;
  for (const probe of report.probes) {
    if (probe.status === 'missing') {
      missing++;
      console.log(`  FAIL missing          ${probe.names.join(' / ')}`);
      continue;
    }
    if (probe.status === 'centre') centre++;
    const label =
      probe.status === 'centre'
        ? 'FAIL centre in water '
        : probe.status === 'edge'
          ? 'INFO edge in water   '
          : 'ok   dry             ';
    console.log(
      `  ${label} ${probe.name} (${probe.cx.toFixed(0)},${probe.cz.toFixed(0)}) ${probe.inWater}/${probe.verts} verts wet`,
    );
  }
  console.log(
    `\n${centre} dry probes with centre in water, ${report.infos} with only an edge in water, ${missing} missing`,
  );
}

async function main() {
  const data = readData();
  const wet = makeTester(data.water);
  printWater(data);

  const res = await overpass(
    'verify-centrelines',
    `[out:json][timeout:240];rel["waterway"="river"]["name"~"Ohio River|Allegheny River|Monongahela River"](${BBOX});out geom;`,
  );
  const coverage = assessCentreline(wet, centrelineLines(res));
  printCentreline(coverage);

  const probes = assessDryProbes(data);
  printProbes(probes);

  const failures = coverage.failures + probes.failures;
  console.log(`${failures} failing, ${probes.infos} informational`);
  process.exitCode = failureExitCode(failures);
}

if (invokedDirectly(import.meta.url)) {
  await main();
}
