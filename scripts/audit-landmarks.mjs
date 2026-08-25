/**
 * Landmark audit: presence, placement, footprint shape, height, and whether the
 * renderer's hard-coded anchors still bind.
 *
 * Three independent questions, because a landmark can fail any one of them
 * while passing the others:
 *
 *   1. Does the dataset contain it at all? A missing record is invisible, and
 *      the previous verifier reported four false "NOT IN DATASET" results purely
 *      because it looked for names the dataset does not use ("PPG Place" for the
 *      six separate PPG records, "Duquesne Incline" for the two station houses).
 *   2. Is the footprint in the right place and the right shape, measured against
 *      the projected OSM ring — area centroid offset, area ratio, and symmetric
 *      Hausdorff distance.
 *   3. Do `src/architecture.js` LANDMARKS and `src/landmarks.js` INCLINES still
 *      resolve? Those carry hard-coded `at: [x, z]` anchors and bind a bespoke
 *      crown only when the anchor falls *inside* a dataset footprint and within
 *      `r` of its area centroid. An anchor that misses binds nothing, and the
 *      landmark silently renders as generic stock — which looks exactly like the
 *      building being in the wrong place.
 *
 * Read-only. Run: node scripts/audit-landmarks.mjs
 */
import { readData, ringArea } from './osm.mjs';
import {
  areaCentroid,
  fetchNamedFeatures,
  hausdorff,
  indexByName,
  nameKey,
  nearestByName,
} from './osm-features.mjs';
import { CHECKLIST, INCLINE_STATIONS } from './landmark-checklist.mjs';
import { anchorBinds, pointInRing, readInclines, readRendererLandmarks } from './renderer-refs.mjs';

const fmt = (n, d = 1) => Number(n).toFixed(d);

// --------------------------------------------------------------------- main

const data = readData();
const osm = await fetchNamedFeatures();
console.log(`OSM named features in bbox: ${osm.length}`);
const idx = indexByName(osm);

const byKey = new Map();
for (const b of data.buildings) {
  if (!b.n) continue;
  const k = nameKey(b.n);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(b);
}

// -------------------------------------------- 1. checklist presence + geometry

console.log('\n=== 1. significant-structure checklist ===');
const missing = [];
const misplaced = [];
const heightIssues = [];

for (const spec of CHECKLIST) {
  const names = [spec.n, ...(spec.alt || [])];
  let ours = null;
  for (const nm of names) {
    const cands = byKey.get(nameKey(nm));
    if (cands?.length) {
      ours = cands.reduce((a, b) => (Math.abs(ringArea(b.f)) > Math.abs(ringArea(a.f)) ? b : a));
      break;
    }
  }
  if (!ours) {
    missing.push(spec);
    console.log(`  MISSING            ${spec.n}${spec.osm ? `  (osm: ${spec.osm})` : ''}`);
    continue;
  }

  const c = areaCentroid(ours.f);
  const ourA = Math.abs(ringArea(ours.f));
  const hit = nearestByName(idx, spec.osm || ours.n, c[0], c[1], 500);
  const notes = [];
  let info = '';
  let d = null;
  if (hit) {
    d = Math.hypot(hit.f.c[0] - c[0], hit.f.c[1] - c[1]);
    // Some landmarks are named in OSM only on the SITE, not the building: the
    // Allegheny General block is an unnamed `building=hospital` inside a named
    // `amenity=hospital` area. Comparing a building's shape against its campus
    // boundary reports 99 m of Hausdorff error for a footprint that is exactly
    // where it belongs, so a site match is tested for containment instead.
    if (!hit.f.tags?.building) {
      if (!pointInRing(c[0], c[1], hit.f.ring)) notes.push(`outside its OSM site by ${fmt(d)}m`);
      else info = `OSM names the ${fmt(hit.f.area, 0)}m2 site, not the building; ours stands inside it`;
    } else {
      const ratio = ourA / hit.f.area;
      const haus = hausdorff(ours.f, hit.f.ring);
      if (d > 8) notes.push(`offset ${fmt(d)}m`);
      if (haus > 12) notes.push(`hausdorff ${fmt(haus)}m`);
      if (ratio < 0.7 || ratio > 1.4) notes.push(`area x${fmt(ratio, 2)}`);
      if (notes.length) misplaced.push({ spec, ours, osm: hit.f, d, ratio, haus });
    }
  }
  if (spec.h != null) {
    const err = (ours.h - spec.h) / spec.h;
    if (Math.abs(err) > 0.1) {
      notes.push(`height ${ours.h}m vs cited ${spec.h}m (${err > 0 ? '+' : ''}${fmt(err * 100, 0)}%)`);
      heightIssues.push({ spec, ours, err });
    }
  }
  console.log(
    `  ${notes.length ? 'CHECK  ' : 'ok     '} ${(ours.n || spec.n).padEnd(46)} h=${String(ours.h).padStart(5)} ` +
      `${fmt(ourA, 0).padStart(7)}m2 at (${fmt(c[0], 0)},${fmt(c[1], 0)})${hit ? '' : ' [no OSM match]'}` +
      (notes.length ? `  <-- ${notes.join('; ')}` : '') +
      (info ? `  [${info}]` : ''),
  );
}
console.log(`\n  ${CHECKLIST.length} checked: ${missing.length} missing, ${misplaced.length} geometry issues, ${heightIssues.length} height issues`);

// -------------------------------------------------- 2. renderer anchor binding

console.log('\n=== 2. renderer landmark anchors (src/architecture.js LANDMARKS) ===');
const lms = readRendererLandmarks();
let unbound = 0;
for (const lm of lms) {
  let bound = null;
  let nearest = null;
  let nd = Infinity;
  for (const b of data.buildings) {
    if (!b.f || b.f.length < 4) continue;
    const c = areaCentroid(b.f);
    const d = Math.hypot(c[0] - lm.at[0], c[1] - lm.at[1]);
    if (d < nd && b.n) {
      nd = d;
      nearest = b;
    }
    if (anchorBinds(lm, b.f, c) != null) {
      const score = Math.abs(ringArea(b.f));
      if (!bound || score < bound.score) bound = { b, d, score };
    }
  }
  if (!bound) {
    unbound++;
    console.log(
      `  UNBOUND  ${lm.n.padEnd(46)} anchor (${lm.at[0]},${lm.at[1]}) r=${lm.r}` +
        `  nearest named footprint: ${nearest?.n} at ${fmt(nd)}m`,
    );
    continue;
  }
  const nameOk = nameKey(bound.b.n || '') === nameKey(lm.n);
  console.log(
    `  ${nameOk ? 'ok     ' : 'MISNAME'}  ${lm.n.padEnd(46)} -> ${(bound.b.n || '(unnamed)').padEnd(40)} centroid ${fmt(bound.d)}m from anchor, h=${bound.b.h} vs lm ${lm.h}`,
  );
}
console.log(`  ${lms.length} anchors, ${unbound} unbound`);

// --------------------------------------------------------- 3. incline stations

console.log('\n=== 3. incline alignments (src/landmarks.js INCLINES) ===');
for (const inc of readInclines()) {
  const spec = INCLINE_STATIONS[inc.n];
  const run = Math.hypot(inc.upper[0] - inc.lower[0], inc.upper[1] - inc.lower[1]);
  const notes = [];
  const ends = {};
  if (spec) {
    for (const [which, nm] of [['lower', spec.lower], ['upper', spec.upper]]) {
      const cands = byKey.get(nameKey(nm));
      if (!cands?.length) {
        notes.push(`${which} station "${nm}" not in dataset`);
        continue;
      }
      ends[which] = areaCentroid(cands[0].f);
      const d = Math.hypot(ends[which][0] - inc[which][0], ends[which][1] - inc[which][1]);
      if (d > 40) notes.push(`${which} station ${fmt(d)}m from the anchor`);
    }
    const err = (run - spec.run) / spec.run;
    if (Math.abs(err) > 0.08) {
      notes.push(`run ${fmt(run)}m vs cited plan run ${spec.run}m (${fmt(err * 100, 0)}%)`);
      // Both anchors sit a few metres inside their station houses, which is
      // what shortens the track. Seating them on the station centroids is the
      // fix, so the audit prints the coordinates rather than just the error.
      if (ends.lower && ends.upper) {
        const seated = Math.hypot(ends.upper[0] - ends.lower[0], ends.upper[1] - ends.lower[1]);
        notes.push(
          `seating on the station centroids gives ${fmt(seated)}m ` +
            `(${fmt(((seated - spec.run) / spec.run) * 100, 0)}%): ` +
            `lower [${fmt(ends.lower[0])}, ${fmt(ends.lower[1])}] upper [${fmt(ends.upper[0])}, ${fmt(ends.upper[1])}]`,
        );
      }
    }
  }
  console.log(
    `  ${notes.length ? 'CHECK' : 'ok   '} ${inc.n.padEnd(24)} run ${fmt(run)}m` +
      (notes.length ? `\n          ${notes.join('\n          ')}` : ''),
  );
}

console.log('\ndone');
