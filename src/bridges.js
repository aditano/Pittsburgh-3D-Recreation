import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
/**
 * Roadway. The dark value is the night palette; in daylight it made every deck
 * and approach ramp read as a black slab laid across the ground rather than as
 * asphalt, which was most obvious where the Fort Duquesne ramp crosses the lawn
 * at Point State Park.
 */
const DECK_DAY = 0x5c5e63;
const DECK_NIGHT = 0x2a2c30;
const WALK = 0xb8b0a0;

/**
 * `spans` is the real span sequence of the main structure, in metres. Several of
 * these bridges are mostly land viaduct — Liberty is 273 m of cantilever truss
 * inside 812 m of deck — so the structure is laid over the river and the rest of
 * the deck becomes girder approach spans. `clear` is the clearance to the
 * underside of the deck, `arch` the index of the span carrying the arch.
 */
const STRUCTURES = [
  // Three Sisters: self-anchored eyebar-chain suspension. Carson's truss is
  // 840 ft in 215/410/215 ft spans inside 995 ft of deck; the other two match it
  // to within a few feet. 62 ft deck, 40.3 ft clearance, towers 78 ft over pool.
  { match: /clemente/, form: 'suspension', eyebar: true, spans: [65.5, 131, 65.5], width: 18.9, clear: 12.3, tower: 11.6, paint: 'gold' },
  { match: /warhol bridge/, form: 'suspension', eyebar: true, spans: [66, 135, 66], width: 18.9, clear: 12.3, tower: 13, paint: 'gold' },
  { match: /carson/, form: 'suspension', eyebar: true, spans: [65.5, 125, 65.5], width: 18.9, clear: 12.3, tower: 11.6, paint: 'gold' },

  // Fort Pitt and Fort Duquesne: double-decked bowstring (tied) arches with
  // 750 ft and 430 ft main spans, four lanes on each deck.
  { match: /fort pitt/, form: 'decked-arch', spans: [69.5, 229, 69.5], arch: 1, width: 21, clear: 14.4, rise: 31, upper: 8.4, paint: 'gold' },
  { match: /fort duquesne/, form: 'decked-arch', spans: [62, 130, 62], arch: 1, width: 21, clear: 14, rise: 22, upper: 8.4, paint: 'gold' },

  // Lindenthal's lenticular (Pauli) trusses: two 360 ft lens spans in 1,184 ft
  // of deck, repainted to the 1883 scheme rather than gold.
  { match: /smithfield/, form: 'lenticular', spans: [110, 110], width: 18, clear: 13, rise: 12, drop: 5.5, paint: 'historic' },

  // Liberty: steel cantilever through truss, two 448 ft river spans, deck
  // 44.4 ft over the pool.
  { match: /liberty/, form: 'cantilever', spans: [136.5, 136.5], width: 17, clear: 13.5, depth: 17, paint: 'apricot' },

  // Veterans: welded steel plate girder, 410 ft main span in 1,050 ft, seven
  // lanes, deck 51 ft over the pool.
  { match: /veterans/, form: 'girder', spans: [97, 125, 98], width: 28, clear: 15.5, depth: 4.6, paint: 'steel' },

  // West End: 780 ft tied arch, the longest in the world when built, one pier in
  // the water, Warren pony trusses on the approaches.
  { match: /west end/, form: 'tied-arch', spans: [47, 238, 54], arch: 1, width: 18, clear: 20, rise: 43, paint: 'gold' },

  // 16th Street: trussed through arches, 437 ft main span in 1,996 ft of deck,
  // 41.3 ft roadway and 41.3 ft clearance, gold since the 2002 rehabilitation.
  { match: /mccullough|16th/, form: 'through-arch', spans: [64, 133, 64], width: 12.6, clear: 12.6, rise: 19, paint: 'gold' },

  // Fort Wayne Railroad Bridge: two-track through truss, 985 ft over five spans
  // with a 319 ft channel span, deck 40.9 ft over the pool.
  { match: /fort wayne|warhol rail/, form: 'through-truss', spans: [51, 51, 97, 51, 51], width: 17.3, clear: 12.5, depth: 12, paint: 'steel' },

  // Birmingham: 607 ft bowstring arch in 1,662 ft, six lanes, PennDOT
  // "Antique Bronze".
  { match: /birmingham/, form: 'tied-arch', spans: [70, 185, 70], arch: 1, width: 24, clear: 19.8, rise: 33, paint: 'bronze' },

  // South Tenth Street (Philip Murray): the county's only wire-cable suspension
  // bridge, 725 ft main span in 1,275 ft, 58 ft deck, 50.3 ft clearance.
  { match: /tenth|10th/, form: 'suspension', spans: [84, 221, 84], width: 17.7, clear: 15.3, tower: 33, paint: 'gold' },

  // Panhandle: Pennsylvania Pratt through truss channel spans, three light rail
  // tracks on a deck only 8.4 m wide.
  { match: /panhandle/, form: 'through-truss', spans: [90, 107, 90], width: 9, clear: 13.4, depth: 11, paint: 'steel' },

  // Hot Metal: the paired 1887 Monongahela Connecting and 1900 Hot Metal
  // trusses on one set of piers, one now a roadway and one a trail, and
  // explicitly not painted gold.
  { match: /hot metal/, form: 'through-truss', spans: [90, 90, 90], width: 11, clear: 12, depth: 10, twin: 23, paint: 'rust' },

  // 31st Street: open-spandrel steel deck arches, 360 ft three-hinged centre
  // span in 2,681 ft of deck, 72.6 ft clearance, painted "31st Blue".
  { match: /31st/, form: 'deck-arch', spans: [55, 110, 55], arch: 1, width: 11, clear: 22.1, rise: 17, paint: 'blue' },

  // Washington Crossing (40th Street): steel deck arch, 360 ft main span in
  // 2,366 ft of deck, 72.5 ft clearance.
  { match: /40th|washington crossing/, form: 'deck-arch', spans: [55, 110, 55], arch: 1, width: 12, clear: 22.1, rise: 17, paint: 'steel' },
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

/** The longest run of the deck that is actually over the river, as a t range. */
function riverRun(frame, waterIndex) {
  const step = Math.max(0.004, 2 / frame.len);
  let run = null;
  let best = null;
  for (let t = 0; t <= 1.0001; t += step) {
    const p = at(frame, t, 0);
    if (waterIndex.inside(p.x, p.z)) {
      if (run === null) run = t;
      if (!best || t - run > best[1] - best[0]) best = [run, Math.min(1, t)];
    } else {
      run = null;
    }
  }
  return best;
}

/**
 * Places the real span sequence on the deck. The named structure is centred on
 * the river — widened if the crossing is broader than the published spans — and
 * whatever deck is left over at the ends becomes girder approach bays, so a
 * bridge that is mostly land viaduct still gets an arch of the right size over
 * the water instead of one stretched the full length of the deck.
 */
function layout(frame, spans, waterIndex) {
  const total = spans.reduce((a, s) => a + s, 0) || 1;
  const river = riverRun(frame, waterIndex);
  const needed = Math.max(Math.min(total, frame.len) / frame.len, river ? river[1] - river[0] : 0);
  const half = Math.min(0.5, needed / 2);
  const centre = river ? (river[0] + river[1]) / 2 : 0.5;
  const c = Math.min(1 - half, Math.max(half, centre));
  const main = [c - half, c + half];

  const ranges = [];
  let edge = main[0];
  for (const s of spans) {
    const next = edge + ((main[1] - main[0]) * s) / total;
    ranges.push([edge, next]);
    edge = next;
  }
  ranges[ranges.length - 1][1] = main[1];

  const bays = [];
  for (const [a, b] of [[0, main[0]], [main[1], 1]]) {
    const len = (b - a) * frame.len;
    if (len < 8) continue;
    const n = Math.max(1, Math.round(len / 34));
    for (let i = 0; i < n; i++) bays.push([a + ((b - a) * i) / n, a + ((b - a) * (i + 1)) / n]);
  }
  return { main, ranges, bays };
}

/**
 * The surveyed endpoints are the truth, so a deck is only ever pushed outwards:
 * an end that still sits over the river walks along the span until it reaches
 * dry ground and its abutment. Never pulling an end inwards keeps a coarse
 * shoreline from leaving a span hanging in the water, and the cap keeps a wrong
 * one from stretching the deck across the bank.
 */
function deckEnds(pts, waterIndex) {
  const dx = pts[1][0] - pts[0][0];
  const dz = pts[1][1] - pts[0][1];
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const cap = Math.max(24, len * 0.2);
  return pts.map((p, i) => {
    if (!waterIndex.inside(p[0], p[1])) return p.slice();
    const dir = i === 0 ? -1 : 1;
    let s = 0;
    while (s < cap && waterIndex.inside(p[0] + ux * dir * s, p[1] + uz * dir * s)) s += 3;
    s = Math.min(cap, s + 12);
    return [+(p[0] + ux * dir * s).toFixed(2), +(p[1] + uz * dir * s).toFixed(2)];
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

/** Approach-span bents: paired columns from grade up to the deck soffit. */
function addBents(geoms, frame, ts, deckY, width, yFn) {
  for (const t of ts) {
    const p = at(frame, t, 0);
    const ground = Math.min(deckY - 3, yFn(p.x, p.z));
    const h = deckY - 1.6 - ground;
    if (h < 2) continue;
    for (const side of [-1, 1]) {
      const leg = at(frame, t, ground + h * 0.5, side, width * 0.3);
      addBox(geoms, leg, new THREE.Vector3(1.9, h, 1.7), frame.quat);
    }
    addBox(geoms, at(frame, t, ground + h + 0.75), new THREE.Vector3(2.6, 1.5, width * 0.9), frame.quat);
  }
}

/**
 * Approach viaducts. Every one of these bridges reaches its street grid on a
 * ramp rather than dropping off its abutment, so the deck keeps going past each
 * end and is carried on bents until it meets grade.
 *
 * The ramp is kept short and tapering. At a 5.5% grade a 14 m deck needs over
 * 250 m of run, and since the ramp is modelled as a straight continuation of the
 * span rather than following the real curving alignment, that put a full-width
 * roadway clean across Point State Park. An 8.5% grade capped at 150 m is still
 * a plausible urban approach and stays close to the abutment.
 */
function addApproach(geoms, deckGeoms, frame, deckY, width, yFn, thick) {
  for (const end of [0, 1]) {
    const dirSign = end === 0 ? -1 : 1;
    const foot = at(frame, end, 0);
    const ground0 = Math.max(0, yFn(foot.x, foot.z));
    const drop = deckY - ground0;
    if (drop < 3) continue;
    const rampLen = Math.min(150, Math.max(30, drop / 0.085));
    const segs = Math.max(2, Math.round(rampLen / 25));
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
      // Narrow as it descends so it merges into the grid instead of ending as a
      // full-width plate dumped on the ground.
      const taper = width * (0.94 - 0.34 * (i / segs));
      boxBetween(deckGeoms, a, b, thick, taper);
      if (y1 - ground > 2.5) {
        for (const side of [-1, 1]) {
          const leg = at(frame, s1 / frame.len, (y1 + ground) * 0.5, side, taper * 0.36);
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
function addGirders(geoms, frame, a, b, deckY, width, depth) {
  const len = (b - a) * frame.len;
  if (len < 2) return;
  const y = deckY - depth * 0.5 - 0.6;
  for (let i = 0; i < 4; i++) {
    const p = at(frame, (a + b) * 0.5, y, i / 3 - 0.5, width * 0.72);
    addBox(geoms, p, new THREE.Vector3(len, depth, 1.2), frame.quat);
  }
  const braceN = Math.max(2, Math.round(len / 22));
  for (let i = 0; i <= braceN; i++) {
    const t = a + (b - a) * (i / braceN);
    addBox(geoms, at(frame, t, y), new THREE.Vector3(0.7, depth * 0.8, width * 0.78), frame.quat);
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
      const { main, ranges, bays } = layout(frame, rec.spans, waterIndex);
      const fracs = ranges.slice(0, -1).map((r) => r[1]);
      const upperY = rec.upper ? deckY + rec.upper : null;

      addDeck(deckGeoms, walkGeoms, frame, deckY, width, thick);
      if (upperY !== null) addDeck(deckGeoms, walkGeoms, frame, upperY, width, thick);
      addRailings(steel, frame, upperY ?? deckY, width, thick);
      addAbutments(concreteGeoms, frame, yFn, deckY, width);
      addPiers(concreteGeoms, frame, fracs, deckY, width);
      // Shore piers where the structure hands over to its approach spans.
      addPiers(
        concreteGeoms,
        frame,
        main.filter((t) => t > 0.01 && t < 0.99),
        deckY,
        width,
      );
      for (const [a, c] of bays) addGirders(steel, frame, a, c, deckY, width, Math.min(4.2, deckY * 0.3));
      addBents(
        concreteGeoms,
        frame,
        bays.map(([, c]) => c).filter((t) => t > 0.01 && t < 0.99),
        deckY,
        width,
        yFn,
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
          // The tie chord is the lower deck, so the rib springs there and the
          // upper deck rides inside the arch rather than under it.
          ranges.forEach(([a, c], i) => {
            if (i === archIndex)
              addArchRib(steel, lines, frame, a, c, deckY + 1, deckY + rec.rise, deckY + 1.2, width * 0.54, 18);
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
          addGirders(steel, frame, main[0], main[1], deckY, width, rec.depth);
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
        addLabel(b.n, at(frame, (main[0] + main[1]) * 0.5, (upperY ?? deckY) + crest + 22));
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
    color: dayMode ? DECK_DAY : DECK_NIGHT,
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
