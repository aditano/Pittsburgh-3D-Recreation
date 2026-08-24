/**
 * Bridge audit against OSM, one named river crossing at a time.
 *
 * For each crossing in scripts/landmark-checklist.mjs RIVER_BRIDGES:
 *   - is it in the dataset, and does the scene box even contain its channel
 *   - how wide is the channel the real alignment crosses, and does our deck
 *     cover it (a deck shorter than the channel ends in the river)
 *   - how far is our deck's bearing from the real alignment's
 *   - do both abutments land on dry ground and the midspan sit over water
 *   - do any two decks intersect or coincide
 *
 * The published `mainSpan` is reported for scale but is deliberately *not* a
 * pass/fail test: a main span is one span of a structure whose deck also runs
 * over the banks, so it is a different quantity from the crossing this scene
 * stores. The channel measurement is the test that means something.
 *
 * Read-only. Run: node scripts/audit-bridges.mjs
 */
import { readData } from './osm.mjs';
import { RIVER_BRIDGES } from './landmark-checklist.mjs';
import { nameKey, pointSegDist } from './osm-features.mjs';
import {
  alignmentsFor,
  angleGap,
  bearing180,
  fetchBridgeWays,
  inScene,
  makeWetTest,
  solveDeck,
} from './bridge-geom.mjs';

const fmt = (n, d = 1) => Number(n).toFixed(d);

const data = readData();
const wet = makeWetTest(data.water);
const raw = await fetchBridgeWays();

console.log(`dataset carries ${data.bridges.length} bridges\n`);

const byKey = new Map(data.bridges.map((b) => [nameKey(b.n), b]));
const lookup = (names) => {
  for (const nm of names) {
    const k = nameKey(nm);
    const hit = byKey.get(k) || byKey.get(k.replace(/ bridge$/, '')) || byKey.get(`${k} bridge`);
    if (hit) return hit;
  }
  return null;
};

let missing = 0;
let outside = 0;
let flagged = 0;

for (const spec of RIVER_BRIDGES) {
  const names = [spec.n, ...(spec.alt || [])];
  const match = new RegExp(`^(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`, 'i');
  const ours = lookup(names);
  const lines = alignmentsFor(raw.elements, match);
  const truth = lines.length ? solveDeck(lines, wet) : { error: 'no OSM carriageway by this name' };

  // A crossing whose channel is off the edge of the modelled box is not missing
  // data, it is out of frame, and the two need to read differently.
  const verts = lines.flat();
  const centre = verts.length
    ? [verts.reduce((s, p) => s + p[0], 0) / verts.length, verts.reduce((s, p) => s + p[1], 0) / verts.length]
    : null;
  // No channel to cross means the river itself is clipped away here, which is
  // the same situation as the alignment being off the edge.
  const framed = centre ? inScene(centre[0], centre[1]) && !truth.error : false;

  if (!ours) {
    const where = centre ? `alignment centre (${fmt(centre[0], 0)},${fmt(centre[1], 0)})` : 'no alignment found';
    if (!framed) {
      outside++;
      console.log(
        `  out of frame  ${spec.n.padEnd(28)} main span ${String(spec.mainSpan).padStart(4)}m over the ${spec.river}` +
          `  — ${where}, ${truth.error || 'outside the scene box'}`,
      );
    } else {
      missing++;
      console.log(
        `  MISSING       ${spec.n.padEnd(28)} main span ${String(spec.mainSpan).padStart(4)}m over the ${spec.river}` +
          `  — ${where}, channel ${fmt(truth.channel)}m available`,
      );
    }
    continue;
  }

  const [a, b] = ours.pts;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const notes = [];

  if (truth.error) {
    notes.push(truth.error);
  } else {
    if (len < truth.channel) notes.push(`deck ${fmt(len)}m does not cover a ${fmt(truth.channel)}m channel`);
    if (len > truth.channel * 1.9) notes.push(`deck ${fmt(len)}m over a ${fmt(truth.channel)}m channel`);
    const dAng = angleGap(bearing180(a, b), bearing180(truth.a, truth.b));
    if (dAng > 5) notes.push(`bearing off by ${fmt(dAng)}deg`);
    const nearLine = (p) => {
      let m = Infinity;
      for (const pts of lines) {
        for (let i = 0; i < pts.length - 1; i++) m = Math.min(m, pointSegDist(p, pts[i], pts[i + 1]));
      }
      return m;
    };
    const off = Math.max(nearLine(a), nearLine(b));
    if (off > 45) notes.push(`endpoint ${fmt(off, 0)}m off the real alignment`);
  }
  if (wet(a[0], a[1])) notes.push('start abutment in water');
  if (wet(b[0], b[1])) notes.push('end abutment in water');
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (!wet(mid[0], mid[1])) notes.push('midspan not over water');

  if (notes.length) flagged++;
  console.log(
    `  ${notes.length ? 'CHECK       ' : 'ok          '}  ${spec.n.padEnd(28)} deck ${fmt(len).padStart(6)}m  channel ${truth.channel ? fmt(truth.channel).padStart(6) : '     -'}m  main span ${String(spec.mainSpan).padStart(4)}m` +
      (notes.length ? `\n                ${notes.join('; ')}` : ''),
  );
}

const known = new Set();
for (const spec of RIVER_BRIDGES) {
  for (const nm of [spec.n, ...(spec.alt || [])]) {
    const k = nameKey(nm);
    known.add(k);
    known.add(k.replace(/ bridge$/, ''));
    known.add(`${k} bridge`);
  }
}
const extra = data.bridges.filter((b) => !known.has(nameKey(b.n)));
if (extra.length) console.log(`\n  dataset decks not on the checklist: ${extra.map((b) => b.n).join(', ')}`);

// -------------------------------------------------------- deck intersections

console.log('\n=== deck geometry ===');
let clashes = 0;
for (let i = 0; i < data.bridges.length; i++) {
  for (let j = i + 1; j < data.bridges.length; j++) {
    const [p0, p1] = data.bridges[i].pts;
    const [q0, q1] = data.bridges[j].pts;
    const side = (o, s, e) => Math.sign((e[0] - s[0]) * (o[1] - s[1]) - (e[1] - s[1]) * (o[0] - s[0]));
    const crosses = side(p0, q0, q1) !== side(p1, q0, q1) && side(q0, p0, p1) !== side(q1, p0, p1);
    const pm = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const qm = [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2];
    const dm = Math.hypot(pm[0] - qm[0], pm[1] - qm[1]);
    if (crosses) {
      console.log(`  CHECK  ${data.bridges[i].n} and ${data.bridges[j].n} decks intersect`);
      clashes++;
    } else if (dm < 60) {
      console.log(`  CHECK  ${data.bridges[i].n} and ${data.bridges[j].n} midpoints only ${fmt(dm)}m apart`);
      clashes++;
    }
  }
}
if (!clashes) console.log('  no intersecting or coincident decks');

console.log(
  `\n${RIVER_BRIDGES.length} checked: ${missing} missing, ${outside} out of frame, ${flagged} present but flagged, ${clashes} deck clashes`,
);
