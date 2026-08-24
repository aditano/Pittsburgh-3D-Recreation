/**
 * Sanity-check the solved bridge spans: both abutments must sit on dry land,
 * the middle must be over water, and no two decks may sit on top of each other.
 */
import { readData } from './osm.mjs';

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const data = readData();
const wet = (x, z) => {
  for (const w of data.water) {
    if (!pointInRing(x, z, w.f)) continue;
    for (const h of w.holes || []) if (pointInRing(x, z, h)) return false;
    return true;
  }
  return false;
};

let problems = 0;
console.log(`${data.bridges.length} bridges\n`);
for (const b of data.bridges) {
  const [a, c] = b.pts;
  const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
  const notes = [];
  if (wet(a[0], a[1])) notes.push('start abutment in water');
  if (wet(c[0], c[1])) notes.push('end abutment in water');
  if (!wet(mid[0], mid[1])) notes.push('midspan not over water');

  // Fraction of the deck actually over the channel.
  let onWater = 0;
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (wet(a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t)) onWater++;
  }
  const frac = onWater / (steps + 1);
  if (frac < 0.45) notes.push(`only ${(frac * 100).toFixed(0)}% over water`);
  if (notes.length) problems++;
  console.log(
    `  ${notes.length ? 'CHECK' : 'ok   '} ${b.n.padEnd(30)} ${len.toFixed(0)}m  ${(frac * 100).toFixed(0)}% wet  ${notes.join('; ')}`,
  );
}

// Decks that nearly coincide usually mean two names solved onto one crossing.
for (let i = 0; i < data.bridges.length; i++) {
  for (let j = i + 1; j < data.bridges.length; j++) {
    const p = data.bridges[i];
    const q = data.bridges[j];
    const pm = [(p.pts[0][0] + p.pts[1][0]) / 2, (p.pts[0][1] + p.pts[1][1]) / 2];
    const qm = [(q.pts[0][0] + q.pts[1][0]) / 2, (q.pts[0][1] + q.pts[1][1]) / 2];
    const d = Math.hypot(pm[0] - qm[0], pm[1] - qm[1]);
    if (d < 60) {
      console.log(`  CHECK overlapping decks: ${p.n} and ${q.n} midpoints ${d.toFixed(0)}m apart`);
      problems++;
    }
  }
}

console.log(`\n${problems} bridges flagged`);
