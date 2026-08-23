import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { snapBridgeToBanks } from './geo.js';

const YELLOW = 0xe8c84a;
const SISTERS_YELLOW = 0xf0d050;
const STEEL = 0x8d939c;
const DECK = 0x2a2c30;
const WALK = 0xb8b0a0;

function inferType(name) {
  const n = (name || '').toLowerCase();
  if (/clemente|warhol|carson/.test(n)) return 'sisters';
  if (/fort pitt|fort duquesne/.test(n)) return 'double-arch';
  if (/smithfield/.test(n)) return 'lenticular';
  if (/liberty/.test(n)) return 'cantilever';
  if (/hot metal/.test(n)) return 'truss';
  return 'truss';
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

function addDeck(geoms, walkGeoms, frame, deckY, width, thick = 1.8) {
  const mid = at(frame, 0.5, deckY);
  addBox(geoms, mid, new THREE.Vector3(frame.len + 10, thick, width), frame.quat);
  const walkW = Math.max(1.6, width * 0.14);
  const walkY = deckY + thick * 0.35;
  for (const side of [-1, 1]) {
    const p = at(frame, 0.5, walkY, side, (width - walkW) * 0.5);
    addBox(walkGeoms, p, new THREE.Vector3(frame.len + 8, 0.28, walkW), frame.quat);
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

function addPiers(geoms, frame, ts, deckY, width) {
  for (const t of ts) {
    const bottom = -3.8;
    const h = deckY - bottom + 1.2;
    const mid = at(frame, t, bottom + h * 0.5);
    addCyl(geoms, mid, Math.max(1.6, width * 0.12), h, new THREE.Quaternion());
    const cap = at(frame, t, deckY - 0.2);
    addBox(geoms, cap, new THREE.Vector3(6, 1.2, width * 0.7), frame.quat);
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

function addSisters(geoms, lines, frame, deckY, width, waterIndex) {
  const ts = waterPierTs(frame, waterIndex, 2);
  const towerH = 36;
  const baseY = -3.5;
  const topY = deckY + towerH;
  for (const t of ts) {
    for (const side of [-1, 1]) {
      const leg = at(frame, t, (baseY + topY) * 0.5, side, width * 0.38);
      addBox(geoms, leg, new THREE.Vector3(2.4, topY - baseY, 2.2), frame.quat);
    }
    const top = at(frame, t, deckY + towerH);
    addBox(geoms, top, new THREE.Vector3(3.2, 2.4, width * 0.9), frame.quat);
    const portal = at(frame, t, deckY + 8);
    addBox(geoms, portal, new THREE.Vector3(2.2, 1.6, width * 0.85), frame.quat);
  }

  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  for (const side of [-1, 1]) {
    const abut0 = at(frame, 0.02, deckY + 2, side, width * 0.36);
    const top0 = at(frame, t0, deckY + towerH - 1, side, width * 0.36);
    const mid = at(frame, (t0 + t1) * 0.5, deckY + 11, side, width * 0.36);
    const top1 = at(frame, t1, deckY + towerH - 1, side, width * 0.36);
    const abut1 = at(frame, 0.98, deckY + 2, side, width * 0.36);
    addCatenary(lines, abut0, top0, 1.2, 12);
    addCatenary(lines, top0, mid, 0.4, 14);
    addCatenary(lines, mid, top1, 0.4, 14);
    addCatenary(lines, top1, abut1, 1.2, 12);

    const hangN = 16;
    for (let i = 1; i < hangN; i++) {
      const t = t0 + ((t1 - t0) * i) / hangN;
      const u = i / hangN;
      const sag = 4 * u * (1 - u);
      const cy = deckY + towerH - 1 - sag * (deckY + towerH - 1 - (deckY + 11));
      const cable = at(frame, t, cy, side, width * 0.36);
      const deck = at(frame, t, deckY + 1.2, side, width * 0.36);
      lines.push(cable.x, cable.y, cable.z, deck.x, deck.y, deck.z);
    }
  }
}

function addArch(geoms, lines, frame, deckY, width, rise, doubleDeck) {
  const segs = 18;
  for (const side of [-1, 1]) {
    let prev = null;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const y = deckY + (doubleDeck ? 8 : 2) + Math.sin(Math.PI * t) * rise;
      const p = at(frame, t, y, side, width * 0.42);
      if (prev) boxBetween(geoms, prev, p, 1.1, 1.1);
      prev = p;
      if (i % 2 === 0) {
        const deck = at(frame, t, deckY + (doubleDeck ? 8 : 1.2), side, width * 0.42);
        lines.push(p.x, p.y, p.z, deck.x, deck.y, deck.z);
      }
    }
  }
  if (doubleDeck) {
    const upper = at(frame, 0.5, deckY + 8);
    addBox(geoms, upper, new THREE.Vector3(frame.len + 6, 1.2, width * 0.92), frame.quat);
  }
}

function addTruss(geoms, frame, deckY, width, height, style) {
  const segs = style === 'lenticular' ? 12 : 10;
  for (const side of [-1, 1]) {
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const wave = Math.sin(Math.PI * t);
      const topH =
        style === 'lenticular' ? height * wave : style === 'cantilever' ? height * (0.55 + 0.45 * wave) : height;
      const botH = style === 'lenticular' ? -height * 0.28 * wave : 0;
      const top = at(frame, t, deckY + 1.2 + topH, side, width * 0.44);
      const bot = at(frame, t, deckY + 1.2 + botH, side, width * 0.44);
      boxBetween(geoms, bot, top, 0.55, 0.55);
      if (i < segs) {
        const t2 = (i + 1) / segs;
        const wave2 = Math.sin(Math.PI * t2);
        const topH2 =
          style === 'lenticular' ? height * wave2 : style === 'cantilever' ? height * (0.55 + 0.45 * wave2) : height;
        const botH2 = style === 'lenticular' ? -height * 0.28 * wave2 : 0;
        const top2 = at(frame, t2, deckY + 1.2 + topH2, side, width * 0.44);
        const bot2 = at(frame, t2, deckY + 1.2 + botH2, side, width * 0.44);
        boxBetween(geoms, top, top2, 0.7, 0.7);
        boxBetween(geoms, bot, bot2, 0.55, 0.55);
        if (style !== 'lenticular' && i % 2 === 0) boxBetween(geoms, bot, top2, 0.4, 0.4);
        else if (style === 'lenticular') boxBetween(geoms, bot, top2, 0.4, 0.4);
      }
    }
  }
}

export function buildBridges(bridges, { yFn, waterIndex, addLabel }) {
  const group = new THREE.Group();
  const yellowGeoms = [];
  const steelGeoms = [];
  const deckGeoms = [];
  const walkGeoms = [];
  const yellowLines = [];
  const steelLines = [];

  for (const b of bridges) {
    const pts = snapBridgeToBanks(b.pts, waterIndex, 24);
    const type = b.type || inferType(b.n);
    const frame = spanFrame(pts[0], pts[1]);
    const h0 = Math.max(0, yFn(pts[0][0], pts[0][1]));
    const h1 = Math.max(0, yFn(pts[1][0], pts[1][1]));
    const bank = Math.max(h0, h1);
    const clearance = type === 'cantilever' ? 18 : type === 'double-arch' ? 14 : 11;
    const deckY = bank + clearance;
    const width = type === 'double-arch' ? 22 : type === 'sisters' ? 16 : 15;
    const steel = type === 'sisters' ? yellowGeoms : steelGeoms;
    const lines = type === 'sisters' ? yellowLines : steelLines;

    addDeck(deckGeoms, walkGeoms, frame, deckY, width, type === 'double-arch' ? 2.2 : 1.7);
    addRailings(steel, frame, deckY, width, type === 'double-arch' ? 2.2 : 1.7);
    addAbutments(steel, frame, yFn, deckY, width);

    const pierCount = type === 'lenticular' || type === 'truss' ? 2 : type === 'cantilever' ? 3 : 2;
    addPiers(steel, frame, waterPierTs(frame, waterIndex, pierCount), deckY, width);

    if (type === 'sisters') addSisters(steel, lines, frame, deckY, width, waterIndex);
    else if (type === 'double-arch') addArch(steel, lines, frame, deckY, width, 30, true);
    else if (type === 'lenticular') addTruss(steel, frame, deckY, width, 16, 'lenticular');
    else if (type === 'cantilever') addTruss(steel, frame, deckY, width, 22, 'cantilever');
    else addTruss(steel, frame, deckY, width, 14, 'warren');

    if (type === 'sisters') {
      const lightN = Math.max(6, Math.round(frame.len / 35));
      for (let i = 0; i <= lightN; i++) {
        const t = i / lightN;
        const lp = at(frame, t, deckY + 2.8);
        addBox(yellowGeoms, lp, new THREE.Vector3(0.5, 0.5, 0.5), frame.quat);
      }
    }

    const mid = at(frame, 0.5, deckY + (type === 'sisters' ? 48 : 36));
    addLabel(b.n, mid);
  }

  const yellowMat = new THREE.MeshStandardMaterial({
    color: SISTERS_YELLOW,
    emissive: SISTERS_YELLOW,
    emissiveIntensity: 0.48,
    roughness: 0.32,
    metalness: 0.48,
    envMapIntensity: 0.8,
  });
  const steelMat = new THREE.MeshStandardMaterial({
    color: STEEL,
    emissive: 0x202228,
    emissiveIntensity: 0.12,
    roughness: 0.4,
    metalness: 0.5,
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

  addMerged(yellowGeoms, yellowMat);
  addMerged(steelGeoms, steelMat);
  addMerged(deckGeoms, deckMat);
  addMerged(walkGeoms, walkMat, false);

  function addLines(arr, color) {
    if (arr.length < 6) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    group.add(
      new THREE.LineSegments(
        geom,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
      ),
    );
  }
  addLines(yellowLines, SISTERS_YELLOW);
  addLines(steelLines, 0xb0b6be);

  return group;
}
