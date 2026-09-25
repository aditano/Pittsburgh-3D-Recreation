/**
 * Sanity-check the solved bridge spans: both abutments must sit on dry land,
 * the middle must be over water, and no two decks may sit on top of each other.
 *
 * Failing (nonzero exit): an abutment in the water, a dry midspan, less than
 * 45% of the deck over water, or two decks whose midpoints are under 60 m apart.
 * Length and wet-percentage lines are informational when those checks pass.
 */
import { readData } from './osm.mjs';
import { failureExitCode, invokedDirectly } from './verifier-exit.mjs';

const WET_FRACTION_MIN = 0.45;
const DECK_OVERLAP_M = 60;

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function makeWet(data) {
  return (x, z) => {
    for (const w of data.water) {
      if (!pointInRing(x, z, w.f)) continue;
      for (const h of w.holes || []) if (pointInRing(x, z, h)) return false;
      return true;
    }
    return false;
  };
}

export function assessBridges(data) {
  const wet = makeWet(data);
  const bridges = [];
  const overlaps = [];
  for (const b of data.bridges) {
    const [a, c] = b.pts;
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    const notes = [];
    if (wet(a[0], a[1])) notes.push('start abutment in water');
    if (wet(c[0], c[1])) notes.push('end abutment in water');
    if (!wet(mid[0], mid[1])) notes.push('midspan not over water');

    let onWater = 0;
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (wet(a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t)) onWater++;
    }
    const frac = onWater / (steps + 1);
    if (frac < WET_FRACTION_MIN) notes.push(`only ${(frac * 100).toFixed(0)}% over water`);
    bridges.push({ name: b.n, len, frac, notes });
  }

  for (let i = 0; i < data.bridges.length; i++) {
    for (let j = i + 1; j < data.bridges.length; j++) {
      const p = data.bridges[i];
      const q = data.bridges[j];
      const pm = [(p.pts[0][0] + p.pts[1][0]) / 2, (p.pts[0][1] + p.pts[1][1]) / 2];
      const qm = [(q.pts[0][0] + q.pts[1][0]) / 2, (q.pts[0][1] + q.pts[1][1]) / 2];
      const d = Math.hypot(pm[0] - qm[0], pm[1] - qm[1]);
      if (d < DECK_OVERLAP_M) {
        overlaps.push({ a: p.n, b: q.n, distance: d });
      }
    }
  }

  const failures = bridges.filter((row) => row.notes.length).length + overlaps.length;
  return { bridges, overlaps, failures };
}

function printReport(report) {
  console.log(`${report.bridges.length} bridges\n`);
  for (const row of report.bridges) {
    const fail = row.notes.length > 0;
    console.log(
      `  ${fail ? 'FAIL' : 'ok   '} ${row.name.padEnd(30)} ${row.len.toFixed(0)}m  ${(row.frac * 100).toFixed(0)}% wet  ${row.notes.join('; ')}`,
    );
  }
  for (const hit of report.overlaps) {
    console.log(`  FAIL overlapping decks: ${hit.a} and ${hit.b} midpoints ${hit.distance.toFixed(0)}m apart`);
  }
  console.log(`\n${report.failures} bridges flagged`);
}

if (invokedDirectly(import.meta.url)) {
  const report = assessBridges(readData());
  printReport(report);
  process.exitCode = failureExitCode(report.failures);
}
