import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { snapBridgeToBanks } from './geo.js';

/**
 * Pittsburgh's river crossings, each modelled as the structural type it really
 * is. Span breakdowns, deck widths and navigational clearances are the published
 * figures for each bridge (HAER / pghbridges / Wikipedia infoboxes); clearances
 * are measured to the underside of the deck above Emsworth Dam normal pool,
 * which is y = 0 in this scene. Paint colours are PennDOT's actual schemes, so
 * only some of these are "Aztec Gold".
 */

const PAINT = {
  gold: 0xf0d050,
  steel: 0x8d939c,
  bronze: 0x53603f,
  blue: 0x41688e,
  apricot: 0xcfb79a,
  historic: 0x87949e,
  rust: 0x6f5546,
};

const CONCRETE = 0x9a9689;
const DECK = 0x2a2c30;
const WALK = 0xb8b0a0;

/**
 * `spans` is the real span sequence of the main structure; it only sets the pier
 * proportions, so it is scaled onto whatever span the dataset gives. `clear` is
 * the clearance to the underside of the deck, `arch` the index of the span that
 * carries the arch (the rest are approach trusses).
 */
const STRUCTURES = [
  // Three Sisters: self-anchored eyebar-chain suspension, 840 ft of truss in
  // 215/410/215 ft spans, 62 ft deck, 40.3 ft clearance, towers 78 ft over pool.
  { match: /clemente/, form: 'suspension', eyebar: true, spans: [66, 133, 66], width: 19, clear: 12.4, tower: 11.6, paint: 'gold' },
  { match: /warhol bridge/, form: 'suspension', eyebar: true, spans: [66, 132, 66], width: 19, clear: 12.4, tower: 13, paint: 'gold' },
  { match: /carson/, form: 'suspension', eyebar: true, spans: [66, 125, 66], width: 19, clear: 12.3, tower: 11.6, paint: 'gold' },

  // Fort Pitt and Fort Duquesne: double-decked bowstring (tied) arches, 750 ft
  // and 430 ft main spans, four lanes on each deck.
  { match: /fort pitt/, form: 'decked-arch', spans: [69, 230, 69], arch: 1, width: 21, clear: 14.4, rise: 31, upper: 8.4, paint: 'gold' },
  { match: /fort duquesne/, form: 'decked-arch', spans: [62, 130, 62], arch: 1, width: 21, clear: 14, rise: 22, upper: 8.4, paint: 'gold' },

  // Lindenthal's lenticular (Pauli) trusses: two 360 ft lens spans, 42.5 ft
  // clearance, repainted to the 1883 scheme rather than gold.
  { match: /smithfield/, form: 'lenticular', spans: [110, 110], width: 18, clear: 13, rise: 12, drop: 5.5, paint: 'historic' },

  // Liberty: steel cantilever through truss, two 448 ft river spans.
  { match: /liberty/, form: 'cantilever', spans: [137, 137], width: 17, clear: 13.5, depth: 17, paint: 'apricot' },

  // Veterans: welded steel plate girder, 410 ft main span, seven lanes.
  { match: /veterans/, form: 'girder', spans: [95, 120, 95], width: 28, clear: 15.5, depth: 4.6, paint: 'steel' },

  // West End: 780 ft tied arch, the longest in the world when built, one pier in
  // the water, Warren pony trusses on the approaches.
  { match: /west end/, form: 'tied-arch', spans: [47, 240, 54], arch: 1, width: 18, clear: 20, rise: 43, paint: 'gold' },

  // 16th Street: trussed through arches, 437 ft main span, 41 ft deck, gold
  // since the 2002 rehabilitation.
  { match: /mccullough|16th/, form: 'through-arch', spans: [133, 133, 133], width: 12.6, clear: 12.6, rise: 19, paint: 'gold' },

  // Fort Wayne Railroad Bridge: four-track through truss.
  { match: /fort wayne|warhol rail/, form: 'through-truss', spans: [80, 110, 80], width: 18, clear: 12, depth: 12, paint: 'steel' },

  // Birmingham: 607 ft bowstring arch, six lanes, PennDOT "Antique Bronze".
  { match: /birmingham/, form: 'tied-arch', spans: [70, 185, 70], arch: 1, width: 24, clear: 19.8, rise: 33, paint: 'bronze' },

  // South Tenth Street (Philip Murray): the county's only wire-cable suspension
  // bridge, 725 ft main span, 116 ft towers, Aztec Gold.
  { match: /tenth|10th/, form: 'suspension', spans: [77, 221, 77], width: 18, clear: 15.3, tower: 33, paint: 'gold' },

  // Panhandle: Pennsylvania Pratt through truss channel span, two rail tracks.
  { match: /panhandle/, form: 'through-truss', spans: [90, 107, 90], width: 10, clear: 13.4, depth: 11, paint: 'steel' },

  // Hot Metal: the paired Monongahela Connecting Railroad trusses, one now a
  // roadway and one a trail, and explicitly not painted gold.
  { match: /hot metal/, form: 'through-truss', spans: [90, 90, 90], width: 11, clear: 12, depth: 10, twin: 23, paint: 'rust' },

  // 31st Street: open-spandrel steel deck arches, 380 ft three-hinged centre
  // span, 28 ft roadway, 72.6 ft deck, painted "31st Blue".
  { match: /31st/, form: 'deck-arch', spans: [55, 116, 55], arch: 1, width: 11, clear: 22.1, rise: 17, paint: 'blue' },
];

const FALLBACK = {
  sisters: { form: 'suspension', eyebar: true, spans: [66, 130, 66], width: 19, clear: 12.4, tower: 12, paint: 'gold' },
  'double-arch': { form: 'decked-arch', spans: [65, 180, 65], arch: 1, width: 21, clear: 14, rise: 26, upper: 8.4, paint: 'gold' },
  lenticular: { form: 'lenticular', spans: [110, 110], width: 18, clear: 13, rise: 12, drop: 5.5, paint: 'historic' },
  cantilever: { form: 'cantilever', spans: [137, 137], width: 17, clear: 13.5, depth: 17, paint: 'steel' },
  truss: { form: 'through-truss', spans: [90, 110, 90], width: 14, clear: 13, depth: 11, paint: 'steel' },
};

function inferType(name) {
  const n = (name || '').toLowerCase();
  if (/clemente|warhol bridge|carson/.test(n)) return 'sisters';
  if (/fort pitt|fort duquesne/.test(n)) return 'double-arch';
  if (/smithfield/.test(n)) return 'lenticular';
  if (/liberty/.test(n)) return 'cantilever';
  return 'truss';
}

function structureFor(b) {
  const n = (b.n || '').toLowerCase();
  const hit = STRUCTURES.find((s) => s.match.test(n));
  return hit || FALLBACK[b.type || inferType(b.n)] || FALLBACK.truss;
}

/** Pier positions as fractions of the modelled span, from the real span list. */
function pierFractions(spans) {
  const total = spans.reduce((a, s) => a + s, 0) || 1;
  const out = [];
  let run = 0;
  for (let i = 0; i < spans.length - 1; i++) {
    run += spans[i];
    out.push(run / total);
  }
  return out;
}

function spanRanges(fracs) {
  const edges = [0, ...fracs, 1];
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) out.push([edges[i], edges[i + 1]]);
  return out;
}

function addBox(geoms, mid, size, quat) {
  const g = new THREE.BoxGeometry(size.x, size.y, size.z);
  const m = new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  geoms.push(g);
}

function addCyl(geoms, mid, radius, height, quat) {
  const g = new THREE.CylinderGeometry(radius, radius * 1.15, height, 8);
  const m = new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  geoms.push(g);
}

function boxBetween(geoms, a, b, thickY, thickZ) {
  const len = a.distanceTo(b);
  if (len < 0.2) return;
  const mid = new THREE.Vector3().lerpVectors(a, b, 0.5);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  addBox(geoms, mid, new THREE.Vector3(len, thickY, thickZ), quat);
}

function spanFrame(a, c) {
  const p0 = new THREE.Vector3(a[0], 0, a[1]);
  const p1 = new THREE.Vector3(c[0], 0, c[1]);
  const dir = new THREE.Vector3().subVectors(p1, p0);
  const len = dir.length() || 1;
  dir.multiplyScalar(1 / len);
  const right = new THREE.Vector3(dir.z, 0, -dir.x);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  return { p0, p1, dir, right, len, quat };
}

function at(frame, t, y, side = 0, width = 0) {
  return new THREE.Vector3(
    frame.p0.x + frame.dir.x * frame.len * t + frame.right.x * side * width,
    y,
    frame.p0.z + frame.dir.z * frame.len * t + frame.right.z * side * width,
  );
}

function waterPierTs(frame, waterIndex, count) {
  const picks = [];
  const candidates =
    count >= 3 ? [0.26, 0.5, 0.74] : count === 1 ? [0.5] : [0.3, 0.7];
  for (const t of candidates) {
    const p = at(frame, t, 0);
    if (waterIndex.inside(p.x, p.z)) picks.push(t);
  }
  if (picks.length) return picks;
  let tA = 0.16;
  let tB = 0.84;
  while (tA < 0.45 && !waterIndex.inside(at(frame, tA, 0).x, at(frame, tA, 0).z)) tA += 0.02;
  while (tB > 0.55 && !waterIndex.inside(at(frame, tB, 0).x, at(frame, tB, 0).z)) tB -= 0.02;
  return [tA, tB];
}

/**
 * The surveyed endpoints are the truth; the water mask only nudges a deck the
 * last few metres onto its abutment. Bounding the nudge stops a coarse or wrong
 * shoreline from dragging a span out over the river or leaving it short of the
 * bank.
 */
function deckEnds(pts, waterIndex) {
  const snapped = snapBridgeToBanks(pts, waterIndex, 16);
  const len = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) || 1;
  const cap = Math.max(20, len * 0.1);
  return pts.map((p, i) => {
    const s = snapped[i] || p;
    const d = Math.hypot(s[0] - p[0], s[1] - p[1]);
    if (d <= cap) return s;
    return [p[0] + ((s[0] - p[0]) * cap) / d, p[1] + ((s[1] - p[1]) * cap) / d];
  });
}

function addDeck(geoms, walkGeoms, frame, deckY, width, thick = 1.8) {
  const mid = at(frame, 0.5, deckY);
  addBox(geoms, mid, new THREE.Vector3(frame.len + 8, thick, width), frame.quat);
  const walkW = Math.max(1.6, width * 0.14);
  const walkY = deckY + thick * 0.35;
  for (const side of [-1, 1]) {
    const p = at(frame, 0.5, walkY, side, (width - walkW) * 0.5);
    addBox(walkGeoms, p, new THREE.Vector3(frame.len + 6, 0.28, walkW), frame.quat);
  }
}

function addRailings(geoms, frame, deckY, width, thick) {
  const railY = deckY + thick * 0.5 + 1.15;
  for (const side of [-1, 1]) {
    const p = at(frame, 0.5, railY, side, width * 0.48);
    addBox(geoms, p, new THREE.Vector3(frame.len + 6, 0.16, 0.16), frame.quat);
    const postN = Math.max(8, Math.round(frame.len / 14));
    for (let i = 0; i <= postN; i++) {
      const t = i / postN;
      const q = at(frame, t, deckY + thick * 0.5 + 0.55, side, width * 0.48);
      addBox(geoms, q, new THREE.Vector3(0.14, 1.1, 0.14), frame.quat);
    }
  }
}

function addAbutments(geoms, frame, yFn, deckY, width) {
  for (const t of [0, 1]) {
    const p = at(frame, t, 0);
    const ground = Math.max(-1, yFn(p.x, p.z));
    const h = Math.max(4, deckY - ground + 1.2);
    const mid = at(frame, t, ground + h * 0.5);
    addBox(geoms, mid, new THREE.Vector3(9, h, width + 3), frame.quat);
  }
}

/** Masonry-style river piers: rectangular shafts with a cap, not round columns. */
function addPiers(geoms, frame, ts, deckY, width, top = null) {
  for (const t of ts) {
    const bottom = -4.2;
    const capY = (top ?? deckY) - 1.2;
    const h = capY - bottom;
    if (h < 1) continue;
    const mid = at(frame, t, bottom + h * 0.5);
    addBox(geoms, mid, new THREE.Vector3(7.5, h, width * 0.82), frame.quat);
    const nose = at(frame, t, bottom + h * 0.3);
    addCyl(geoms, nose, width * 0.16, h * 0.6, new THREE.Quaternion());
    addBox(geoms, at(frame, t, capY + 0.7), new THREE.Vector3(9.5, 1.4, width * 0.95), frame.quat);
  }
}

/**
 * Approach viaducts. Every one of these bridges reaches its street grid on a
 * ramp rather than dropping off its abutment, so the deck keeps going past each
 * end at roughly a 6% grade and is carried on bents until it meets grade.
 */
function addApproach(geoms, deckGeoms, frame, deckY, width, yFn, thick) {
  for (const end of [0, 1]) {
    const dirSign = end === 0 ? -1 : 1;
    const foot = at(frame, end, 0);
    const ground0 = Math.max(0, yFn(foot.x, foot.z));
    const drop = deckY - ground0;
    if (drop < 3) continue;
    const rampLen = Math.min(220, Math.max(50, drop / 0.06));
    const segs = Math.max(2, Math.round(rampLen / 30));
    let y = deckY;
    let s = end === 0 ? 0 : frame.len;
    for (let i = 1; i <= segs; i++) {
      const s1 = s + (dirSign * rampLen) / segs;
      const target = deckY - (drop * i) / segs;
      const a = at(frame, s / frame.len, y);
      const b = at(frame, s1 / frame.len, target);
      const ground = Math.max(0, yFn(b.x, b.z));
      const y1 = Math.max(target, i === segs ? ground : ground + 1.2);
      b.y = y1;
      boxBetween(deckGeoms, a, b, thick, width * 0.94);
      if (y1 - ground > 2.5) {
        for (const side of [-1, 1]) {
          const leg = at(frame, s1 / frame.len, (y1 + ground) * 0.5, side, width * 0.34);
          addBox(geoms, leg, new THREE.Vector3(1.6, y1 - ground, 1.4), frame.quat);
        }
      }
      y = y1;
      s = s1;
      if (y1 - ground < 0.6) break;
    }
  }
}

function addCatenary(lines, a, b, sag, segs = 20) {
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const drop0 = sag * 4 * t0 * (1 - t0);
    const drop1 = sag * 4 * t1 * (1 - t1);
    lines.push(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0 - drop0, a.z + (b.z - a.z) * t0);
    lines.push(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1 - drop1, a.z + (b.z - a.z) * t1);
  }
}

/**
 * Suspension spans. The Three Sisters carry a polygonal eyebar chain whose pull
 * is taken by the deck's stiffening girders, so they have no anchorages; the
 * Tenth Street bridge carries smooth wire cables into anchor blocks past the
 * deck ends.
 */
function addSuspension(geoms, lines, concrete, frame, deckY, width, rec, fracs) {
  const eyebar = !!rec.eyebar;
  const towerTop = deckY + rec.tower;
  const endY = deckY + 1.8;
  const off = width * 0.42;
  const t0 = fracs[0];
  const t1 = fracs[fracs.length - 1];
  const midY = deckY + rec.tower * (eyebar ? 0.34 : 0.24);

  for (const t of fracs) {
    for (const side of [-1, 1]) {
      const legBase = deckY - 4;
      const leg = at(frame, t, (legBase + towerTop) * 0.5, side, off);
      addBox(geoms, leg, new THREE.Vector3(2.8, towerTop - legBase, 2.4), frame.quat);
    }
    addBox(geoms, at(frame, t, towerTop + 0.9), new THREE.Vector3(3.4, 1.8, width * 0.98), frame.quat);
    addBox(geoms, at(frame, t, deckY + rec.tower * 0.6), new THREE.Vector3(2.2, 1.3, width * 0.92), frame.quat);
  }

  const chainAt = (t) => {
    if (t <= t0) return endY + ((towerTop - endY) * (t - 0)) / (t0 || 1);
    if (t >= t1) return towerTop + ((endY - towerTop) * (t - t1)) / (1 - t1 || 1);
    const u = (t - t0) / (t1 - t0);
    return towerTop - (towerTop - midY) * 4 * u * (1 - u);
  };

  for (const side of [-1, 1]) {
    const p = (t, y) => at(frame, t, y, side, off);
    const links = eyebar ? 5 : 9;
    addCatenary(lines, p(0, endY), p(t0, towerTop), 0, links);
    addCatenary(lines, p(t0, towerTop), p(t1, towerTop), towerTop - midY, eyebar ? 12 : 22);
    addCatenary(lines, p(t1, towerTop), p(1, endY), 0, links);

    const panel = eyebar ? 12 : 8;
    const hangN = Math.max(8, Math.round(frame.len / panel));
    for (let i = 1; i < hangN; i++) {
      const t = i / hangN;
      if (Math.abs(t - t0) < 0.02 || Math.abs(t - t1) < 0.02) continue;
      const top = p(t, chainAt(t));
      const foot = p(t, deckY + 1.1);
      if (top.y - foot.y < 1.2) continue;
      lines.push(top.x, top.y, top.z, foot.x, foot.y, foot.z);
    }

    // Stiffening girders: the reason a self-anchored span needs no anchorage.
    const girder = at(frame, 0.5, deckY + 1.1, side, off);
    addBox(geoms, girder, new THREE.Vector3(frame.len, eyebar ? 2.6 : 1.8, 0.9), frame.quat);
  }

  if (!eyebar) {
    // Wire cables need anchorages; the eyebar sisters take the pull in the deck.
    for (const t of [0, 1]) {
      addBox(concrete, at(frame, t, deckY + 2.6), new THREE.Vector3(10, 7, width * 0.9), frame.quat);
    }
  }
}

/** Arch rib through one span, with hangers or spandrel columns to the deck. */
function addArchRib(geoms, lines, frame, a, b, springY, crownY, deckY, off, segs = 16) {
  for (const side of [-1, 1]) {
    let prev = null;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const t = a + (b - a) * u;
      const y = springY + (crownY - springY) * Math.sin(Math.PI * u);
      const p = at(frame, t, y, side, off);
      if (prev) boxBetween(geoms, prev, p, 1.2, 1.1);
      prev = p;
      if (i === 0 || i === segs) continue;
      const foot = at(frame, t, deckY, side, off);
      if (Math.abs(p.y - foot.y) < 1.5) continue;
      if (p.y > foot.y) lines.push(p.x, p.y, p.z, foot.x, foot.y, foot.z);
      else if (i % 2 === 0) boxBetween(geoms, p, foot, 0.8, 0.8);
    }
  }
  // Portal and crown bracing between the two ribs.
  for (const u of [0.3, 0.5, 0.7]) {
    const t = a + (b - a) * u;
    const y = springY + (crownY - springY) * Math.sin(Math.PI * u);
    if (y - deckY < 4) continue;
    addBox(geoms, at(frame, t, y - 0.6), new THREE.Vector3(1.1, 0.9, off * 2), frame.quat);
  }
}

function addPonyTruss(geoms, frame, a, b, deckY, width, depth = 3.2) {
  const off = width * 0.44;
  const segs = Math.max(3, Math.round(((b - a) * frame.len) / 22));
  for (const side of [-1, 1]) {
    const top = (u) => at(frame, a + (b - a) * u, deckY + depth, side, off);
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      boxBetween(geoms, at(frame, a + (b - a) * u, deckY, side, off), top(u), 0.5, 0.5);
      if (i < segs) {
        boxBetween(geoms, top(u), top((i + 1) / segs), 0.6, 0.6);
        boxBetween(geoms, at(frame, a + (b - a) * u, deckY, side, off), top((i + 1) / segs), 0.4, 0.4);
      }
    }
  }
}

/** Parallel-chord through truss: chords either side of the roadway, portals over it. */
function addThroughTruss(geoms, frame, a, b, deckY, width, depth) {
  const off = width * 0.46;
  const segs = Math.max(4, Math.round(((b - a) * frame.len) / 16));
  const botY = deckY + 0.8;
  const topY = deckY + depth;
  for (const side of [-1, 1]) {
    for (let i = 0; i <= segs; i++) {
      const t = a + (b - a) * (i / segs);
      boxBetween(geoms, at(frame, t, botY, side, off), at(frame, t, topY, side, off), 0.6, 0.6);
      if (i === segs) continue;
      const t2 = a + (b - a) * ((i + 1) / segs);
      boxBetween(geoms, at(frame, t, topY, side, off), at(frame, t2, topY, side, off), 0.8, 0.8);
      boxBetween(geoms, at(frame, t, botY, side, off), at(frame, t2, botY, side, off), 0.7, 0.7);
      const rising = i % 2 === 0;
      boxBetween(
        geoms,
        at(frame, rising ? t : t2, botY, side, off),
        at(frame, rising ? t2 : t, topY, side, off),
        0.45,
        0.45,
      );
    }
  }
  for (const t of [a, b]) {
    addBox(geoms, at(frame, t, topY - 0.5), new THREE.Vector3(1.0, 1.4, off * 2), frame.quat);
  }
  const swayN = Math.max(2, Math.round(((b - a) * frame.len) / 32));
  for (let i = 1; i < swayN; i++) {
    const t = a + (b - a) * (i / swayN);
    addBox(geoms, at(frame, t, topY - 0.3), new THREE.Vector3(0.7, 0.7, off * 2), frame.quat);
  }
}

/** Lens-shaped Pauli truss: both chords curve, meeting at the pier points. */
function addLenticular(geoms, frame, a, b, deckY, width, rise, drop) {
  const off = width * 0.44;
  const segs = Math.max(6, Math.round(((b - a) * frame.len) / 14));
  for (const side of [-1, 1]) {
    const topAt = (u) => at(frame, a + (b - a) * u, deckY + 1 + rise * Math.sin(Math.PI * u), side, off);
    const botAt = (u) => at(frame, a + (b - a) * u, deckY + 0.4 - drop * Math.sin(Math.PI * u), side, off);
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      boxBetween(geoms, botAt(u), topAt(u), 0.5, 0.5);
      if (i === segs) continue;
      const u2 = (i + 1) / segs;
      boxBetween(geoms, topAt(u), topAt(u2), 0.75, 0.75);
      boxBetween(geoms, botAt(u), botAt(u2), 0.65, 0.65);
      boxBetween(geoms, botAt(u), topAt(u2), 0.4, 0.4);
    }
  }
  for (const u of [0, 1]) {
    const t = a + (b - a) * u;
    addBox(geoms, at(frame, t, deckY + 2.6), new THREE.Vector3(1.2, 3.4, off * 2.1), frame.quat);
  }
}

/** Cantilever truss: deepest over the piers, shallow at midspan and the ends. */
function addCantilever(geoms, frame, a, b, deckY, width, depth) {
  const off = width * 0.45;
  const segs = Math.max(6, Math.round(((b - a) * frame.len) / 16));
  const botY = deckY + 0.8;
  for (const side of [-1, 1]) {
    const topAt = (u) => {
      const shape = 1 - 0.62 * Math.sin(Math.PI * u);
      return at(frame, a + (b - a) * u, botY + depth * shape, side, off);
    };
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      boxBetween(geoms, at(frame, a + (b - a) * u, botY, side, off), topAt(u), 0.6, 0.6);
      if (i === segs) continue;
      const u2 = (i + 1) / segs;
      boxBetween(geoms, topAt(u), topAt(u2), 0.8, 0.8);
      boxBetween(geoms, at(frame, a + (b - a) * u, botY, side, off), at(frame, a + (b - a) * u2, botY, side, off), 0.7, 0.7);
      const rising = u < 0.5;
      boxBetween(
        geoms,
        at(frame, a + (b - a) * (rising ? u : u2), botY, side, off),
        topAt(rising ? u2 : u),
        0.45,
        0.45,
      );
    }
  }
  for (const u of [0, 1]) {
    const t = a + (b - a) * u;
    addBox(geoms, at(frame, t, botY + depth - 0.6), new THREE.Vector3(1.1, 1.5, off * 2), frame.quat);
  }
}

/** Continuous plate girders slung under the roadway. */
function addGirders(geoms, frame, deckY, width, depth) {
  const lines = 4;
  for (let i = 0; i < lines; i++) {
    const side = i / (lines - 1) - 0.5;
    const p = at(frame, 0.5, deckY - depth * 0.5 - 0.6, side * 2, width * 0.36);
    addBox(geoms, p, new THREE.Vector3(frame.len, depth, 1.2), frame.quat);
  }
  const braceN = Math.max(4, Math.round(frame.len / 22));
  for (let i = 0; i <= braceN; i++) {
    const t = i / braceN;
    addBox(geoms, at(frame, t, deckY - depth * 0.5 - 0.6), new THREE.Vector3(0.7, depth * 0.8, width * 0.78), frame.quat);
  }
}

export function buildBridges(bridges, { yFn, waterIndex, addLabel, dayMode = true }) {
  const group = new THREE.Group();
  const steelGeoms = new Map();
  const steelLines = new Map();
  const concreteGeoms = [];
  const deckGeoms = [];
  const walkGeoms = [];

  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, []);
    return map.get(key);
  };

  for (const b of bridges) {
    const rec = structureFor(b);
    const pts = deckEnds(b.pts, waterIndex);
    const offsets = rec.twin ? [0, rec.twin] : [0];

    for (const lateral of offsets) {
      const base = spanFrame(pts[0], pts[1]);
      const shifted = lateral
        ? spanFrame(
            [pts[0][0] + base.right.x * lateral, pts[0][1] + base.right.z * lateral],
            [pts[1][0] + base.right.x * lateral, pts[1][1] + base.right.z * lateral],
          )
        : base;
      const frame = shifted;

      const h0 = Math.max(0, yFn(pts[0][0], pts[0][1]));
      const h1 = Math.max(0, yFn(pts[1][0], pts[1][1]));
      const thick = rec.form === 'girder' ? 1.4 : 1.8;
      const deckY = Math.max(rec.clear + thick * 0.5 + 0.6, Math.max(h0, h1) + 2.4);
      const width = rec.width;
      const steel = bucket(steelGeoms, rec.paint);
      const lines = bucket(steelLines, rec.paint);
      const fracs = pierFractions(rec.spans);
      const ranges = spanRanges(fracs);
      const upperY = rec.upper ? deckY + rec.upper : null;

      addDeck(deckGeoms, walkGeoms, frame, deckY, width, thick);
      if (upperY !== null) addDeck(deckGeoms, walkGeoms, frame, upperY, width, thick);
      addRailings(steel, frame, upperY ?? deckY, width, thick);
      addAbutments(concreteGeoms, frame, yFn, deckY, width);
      addPiers(
        concreteGeoms,
        frame,
        fracs.length ? fracs : waterPierTs(frame, waterIndex, 2),
        deckY,
        width,
      );
      if (!lateral) addApproach(concreteGeoms, deckGeoms, frame, upperY ?? deckY, width, yFn, thick);

      const archIndex = rec.arch ?? -1;
      switch (rec.form) {
        case 'suspension':
          addSuspension(steel, lines, concreteGeoms, frame, deckY, width, rec, fracs);
          break;
        case 'tied-arch':
          ranges.forEach(([a, c], i) => {
            if (i === archIndex) addArchRib(steel, lines, frame, a, c, deckY + 1, deckY + rec.rise, deckY + 1.2, width * 0.42);
            else addPonyTruss(steel, frame, a, c, deckY + 1, width, 3.4);
          });
          break;
        case 'decked-arch':
          ranges.forEach(([a, c], i) => {
            if (i === archIndex)
              addArchRib(steel, lines, frame, a, c, upperY - 1, upperY + rec.rise, upperY + 1, width * 0.42);
            else addPonyTruss(steel, frame, a, c, deckY + 1, width, 3.4);
          });
          for (const [a, c] of ranges) {
            const segs = Math.max(3, Math.round(((c - a) * frame.len) / 26));
            for (let i = 0; i <= segs; i++) {
              const t = a + (c - a) * (i / segs);
              for (const side of [-1, 1]) {
                const p = at(frame, t, (deckY + upperY) * 0.5, side, width * 0.4);
                addBox(steel, p, new THREE.Vector3(0.9, upperY - deckY, 0.9), frame.quat);
              }
            }
          }
          break;
        case 'through-arch':
          for (const [a, c] of ranges) {
            addArchRib(steel, lines, frame, a, c, deckY - 3.5, deckY + rec.rise, deckY + 1.2, width * 0.46, 18);
          }
          break;
        case 'deck-arch':
          for (const [a, c] of ranges) {
            const off = width * 0.4;
            const segs = 16;
            for (const side of [-1, 1]) {
              let prev = null;
              for (let i = 0; i <= segs; i++) {
                const u = i / segs;
                const t = a + (c - a) * u;
                const y = 1.5 + (deckY - 3.5 - 1.5) * Math.sin(Math.PI * u);
                const p = at(frame, t, y, side, off);
                if (prev) boxBetween(steel, prev, p, 1.3, 1.2);
                prev = p;
                if (i % 2 || i === 0 || i === segs) continue;
                boxBetween(steel, p, at(frame, t, deckY - 0.6, side, off), 0.8, 0.8);
              }
            }
          }
          break;
        case 'lenticular':
          for (const [a, c] of ranges) addLenticular(steel, frame, a, c, deckY, width, rec.rise, rec.drop);
          break;
        case 'cantilever':
          for (const [a, c] of ranges) addCantilever(steel, frame, a, c, deckY, width, rec.depth);
          break;
        case 'girder':
          addGirders(steel, frame, deckY, width, rec.depth);
          break;
        default:
          for (const [a, c] of ranges) addThroughTruss(steel, frame, a, c, deckY, width, rec.depth ?? 11);
      }

      if (rec.paint === 'gold' && rec.form === 'suspension') {
        const lightN = Math.max(6, Math.round(frame.len / 35));
        for (let i = 0; i <= lightN; i++) {
          const t = i / lightN;
          addBox(steel, at(frame, t, deckY + 2.8), new THREE.Vector3(0.5, 0.5, 0.5), frame.quat);
        }
      }

      if (!lateral) {
        const crest = rec.tower ?? rec.rise ?? rec.depth ?? 12;
        addLabel(b.n, at(frame, 0.5, (upperY ?? deckY) + crest + 22));
      }
    }
  }

  const materials = {};
  for (const [name, hex] of Object.entries(PAINT)) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: hex,
      emissive: hex,
      emissiveIntensity: name === 'gold' ? (dayMode ? 0.08 : 0.42) : dayMode ? 0.02 : 0.14,
      roughness: name === 'rust' ? 0.72 : 0.36,
      metalness: name === 'rust' ? 0.24 : 0.48,
      envMapIntensity: 0.8,
    });
  }
  const concreteMat = new THREE.MeshStandardMaterial({
    color: CONCRETE,
    roughness: 0.92,
    metalness: 0.03,
  });
  const deckMat = new THREE.MeshStandardMaterial({
    color: DECK,
    roughness: 0.86,
    metalness: 0.08,
  });
  const walkMat = new THREE.MeshStandardMaterial({
    color: WALK,
    roughness: 0.9,
    metalness: 0.04,
  });

  function addMerged(geoms, mat, shadows = true) {
    if (!geoms.length) return;
    const merged = mergeGeometries(geoms, false);
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
    for (const g of geoms) g.dispose();
  }

  for (const [name, geoms] of steelGeoms) addMerged(geoms, materials[name] || materials.steel);
  addMerged(concreteGeoms, concreteMat);
  addMerged(deckGeoms, deckMat);
  addMerged(walkGeoms, walkMat, false);

  for (const [name, arr] of steelLines) {
    if (arr.length < 6) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    group.add(
      new THREE.LineSegments(
        geom,
        new THREE.LineBasicMaterial({
          color: PAINT[name] || PAINT.steel,
          transparent: true,
          opacity: 0.85,
        }),
      ),
    );
  }

  return group;
}
