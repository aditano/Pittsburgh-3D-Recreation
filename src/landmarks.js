import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { footprintCentroid, footprintWaterOverlap, footprintLandBaseY } from './geo.js';
import { buildPointStatePark } from './point.js';

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.45,
    metalness: opts.metalness ?? 0.2,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    envMapIntensity: opts.envMapIntensity ?? 0.6,
  });
}

function footprintBounds(f) {
  const [cx, cz] = footprintCentroid(f);
  let xx = 0;
  let zz = 0;
  let xz = 0;
  const n = f.length - 1;
  for (let i = 0; i < n; i++) {
    const dx = f[i][0] - cx;
    const dz = f[i][1] - cz;
    xx += dx * dx;
    zz += dz * dz;
    xz += dx * dz;
  }
  const yaw = 0.5 * Math.atan2(2 * xz, xx - zz);
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = f[i][0] - cx;
    const dz = f[i][1] - cz;
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    minX = Math.min(minX, lx);
    maxX = Math.max(maxX, lx);
    minZ = Math.min(minZ, lz);
    maxZ = Math.max(maxZ, lz);
  }
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    w: Math.max(8, maxX - minX),
    d: Math.max(8, maxZ - minZ),
    yaw,
    cx,
    cz,
  };
}

function buildPPGTower(h, footprint) {
  const g = new THREE.Group();
  const b = footprintBounds(footprint);
  const w = Math.max(b.w, 42);
  const d = Math.max(b.d, 42);
  const bodyH = h * 0.82;
  const glass = mat(0xb8d4d0, { roughness: 0.12, metalness: 0.72, emissive: 0x4a8a78, emissiveIntensity: 0.35, envMapIntensity: 1.4 });
  const spireMat = mat(0xd8ece8, { roughness: 0.1, metalness: 0.8, emissive: 0x6aa898, emissiveIntensity: 0.5, envMapIntensity: 1.5 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(w, bodyH, d), glass);
  body.position.y = bodyH * 0.5;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const mullionMat = mat(0x9ac8bc, { roughness: 0.18, metalness: 0.6, emissive: 0x3a7868, emissiveIntensity: 0.2 });
  for (let i = -2; i <= 2; i++) {
    const vert = new THREE.Mesh(new THREE.BoxGeometry(0.35, bodyH * 0.96, d + 0.2), mullionMat);
    vert.position.set(i * (w / 5), bodyH * 0.5, 0);
    g.add(vert);
    const horiz = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.3, 0.35), mullionMat);
    horiz.position.set(0, bodyH * (0.25 + ((i + 2) / 4) * 0.5), d * 0.5 + 0.1);
    g.add(horiz);
    const horiz2 = horiz.clone();
    horiz2.position.z = -d * 0.5 - 0.1;
    g.add(horiz2);
  }

  const spireH = h * 0.18;
  for (const [ox, oz] of [
    [-w * 0.42, -d * 0.42],
    [w * 0.42, -d * 0.42],
    [-w * 0.42, d * 0.42],
    [w * 0.42, d * 0.42],
  ]) {
    const spire = new THREE.Mesh(new THREE.ConeGeometry(2.8, spireH, 4), spireMat);
    spire.position.set(ox, bodyH + spireH * 0.5, oz);
    spire.rotation.y = Math.PI / 4;
    spire.castShadow = true;
    g.add(spire);
  }

  const crown = new THREE.Mesh(new THREE.ConeGeometry(w * 0.12, spireH * 0.6, 4), spireMat);
  crown.position.y = bodyH + spireH * 0.3;
  crown.rotation.y = Math.PI / 4;
  crown.castShadow = true;
  g.add(crown);
  return g;
}

function buildPPGLow(h, footprint, scale = 1) {
  const g = new THREE.Group();
  const b = footprintBounds(footprint);
  const w = Math.max(b.w, 28);
  const d = Math.max(b.d, 28);
  const totalH = h * scale;
  const glass = mat(0xc0d8d4, { roughness: 0.14, metalness: 0.68, emissive: 0x5a9888, emissiveIntensity: 0.3, envMapIntensity: 1.2 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, totalH * 0.88, d), glass);
  body.position.y = totalH * 0.44;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  for (let i = 0; i < 6; i++) {
    const t = (i / 6) * Math.PI * 2;
    const spire = new THREE.Mesh(new THREE.ConeGeometry(1.2, totalH * 0.22, 4), glass);
    spire.position.set(Math.cos(t) * w * 0.38, totalH * 0.88 + totalH * 0.11, Math.sin(t) * d * 0.38);
    spire.rotation.y = Math.PI / 4;
    spire.castShadow = true;
    g.add(spire);
  }
  return g;
}

function buildCathedral(h, footprint) {
  const g = new THREE.Group();
  const b = footprintBounds(footprint);
  const w = Math.max(b.w, 55);
  const d = Math.max(b.d, 55);
  const stone = mat(0x8a8478, { roughness: 0.82, metalness: 0.04 });
  const towerW = Math.min(w, d) * 0.35;
  const towerH = h * 0.88;

  const base = new THREE.Mesh(new THREE.BoxGeometry(w * 0.88, h * 0.32, d * 0.88), stone);
  base.position.y = h * 0.16;
  base.castShadow = true;
  g.add(base);

  const tower = new THREE.Mesh(new THREE.BoxGeometry(towerW, towerH, towerW), stone);
  tower.position.y = towerH * 0.5;
  tower.castShadow = true;
  g.add(tower);

  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    const cren = new THREE.Mesh(new THREE.BoxGeometry(towerW * 0.14, h * 0.035, towerW * 0.1), stone);
    cren.position.set(Math.cos(t) * towerW * 0.48, towerH + h * 0.018, Math.sin(t) * towerW * 0.48);
    cren.rotation.y = -t;
    g.add(cren);
  }

  const spire = new THREE.Mesh(new THREE.ConeGeometry(towerW * 0.22, h * 0.14, 4), mat(0x6a6458, { roughness: 0.75 }));
  spire.position.y = towerH + h * 0.07;
  spire.rotation.y = Math.PI / 4;
  g.add(spire);

  for (let i = 0; i < 4; i++) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(w * 0.28, h * 0.22, d * 0.52), stone);
    const side = i < 2 ? -1 : 1;
    if (i % 2 === 0) wing.position.set(side * w * 0.4, h * 0.11, 0);
    else wing.position.set(0, h * 0.11, side * d * 0.4);
    wing.castShadow = true;
    g.add(wing);
  }

  for (let i = 0; i < 4; i++) {
    const t = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const mini = new THREE.Mesh(new THREE.ConeGeometry(2.5, h * 0.06, 4), stone);
    mini.position.set(Math.cos(t) * w * 0.38, h * 0.25, Math.sin(t) * d * 0.38);
    mini.rotation.y = Math.PI / 4;
    g.add(mini);
  }
  return g;
}

function buildUSSteel(h, footprint) {
  const g = new THREE.Group();
  const b = footprintBounds(footprint);
  const w = Math.max(b.w, 50);
  const d = Math.max(b.d, 50);
  const corten = mat(0x6a4a38, { roughness: 0.78, metalness: 0.35, emissive: 0x1a0c08, emissiveIntensity: 0.08 });
  const bodyH = h * 0.96;

  const shape = new THREE.Shape();
  shape.moveTo(-w * 0.5, -d * 0.35);
  shape.lineTo(w * 0.5, -d * 0.35);
  shape.lineTo(0, d * 0.5);
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, { depth: bodyH, bevelEnabled: false });
  geom.rotateX(-Math.PI / 2);
  const body = new THREE.Mesh(geom, corten);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const crown = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, h * 0.025, d * 0.45), mat(0x4a3828, { roughness: 0.7, metalness: 0.4 }));
  crown.position.set(0, bodyH + h * 0.012, -d * 0.05);
  crown.castShadow = true;
  g.add(crown);
  return g;
}

function buildArtDecoTower(h, footprint, roofType) {
  const g = new THREE.Group();
  const b = footprintBounds(footprint);
  const w = Math.max(b.w, 30);
  const d = Math.max(b.d, 30);
  const bodyMat = mat(0x9a9488, { roughness: 0.72, metalness: 0.12 });
  const bodyH = h * 0.78;
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, bodyH, d), bodyMat);
  body.position.y = bodyH * 0.5;
  body.castShadow = true;
  g.add(body);

  if (roofType === 'stepped') {
    for (let i = 0; i < 4; i++) {
      const shrink = 1 - i * 0.14;
      const stepH = h * 0.06;
      const step = new THREE.Mesh(new THREE.BoxGeometry(w * shrink, stepH, d * shrink), bodyMat);
      step.position.y = bodyH + stepH * (i + 0.5);
      step.castShadow = true;
      g.add(step);
    }
    const finial = new THREE.Mesh(new THREE.ConeGeometry(2, h * 0.05, 6), mat(0xc8b878, { metalness: 0.5 }));
    finial.position.y = h * 0.97;
    g.add(finial);
  } else if (roofType === 'globe') {
    const top = new THREE.Mesh(new THREE.BoxGeometry(w * 0.75, h * 0.12, d * 0.75), bodyMat);
    top.position.y = bodyH + h * 0.06;
    g.add(top);
    const globe = new THREE.Mesh(new THREE.SphereGeometry(Math.min(w, d) * 0.18, 16, 12), mat(0xc0a050, { metalness: 0.55, emissive: 0x302008, emissiveIntensity: 0.2 }));
    globe.position.y = h * 0.92;
    g.add(globe);
  } else if (roofType === 'dome') {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(Math.min(w, d) * 0.35, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5),
      mat(0x2a6a48, { roughness: 0.55, metalness: 0.35, emissive: 0x0a2018, emissiveIntensity: 0.1 }),
    );
    dome.position.y = bodyH;
    g.add(dome);
  }
  return g;
}

function buildConventionCenter(h, footprint) {
  const g = new THREE.Group();
  const b = footprintBounds(footprint);
  const w = Math.max(b.w, 120);
  const d = Math.max(b.d, 80);
  const white = mat(0xe8ece8, { roughness: 0.55, metalness: 0.08, emissive: 0x182018, emissiveIntensity: 0.05 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.35, d), white);
  base.position.y = h * 0.175;
  base.castShadow = true;
  g.add(base);

  const curveSegs = 24;
  const roofGeoms = [];
  for (let i = 0; i < curveSegs; i++) {
    const t0 = i / curveSegs;
    const t1 = (i + 1) / curveSegs;
    const arch0 = Math.sin(t0 * Math.PI) * h * 0.45;
    const arch1 = Math.sin(t1 * Math.PI) * h * 0.45;
    const sliceW = w / curveSegs + 1;
    const slice = new THREE.BoxGeometry(sliceW, 2, d * 0.92);
    const midX = -w * 0.5 + w * ((t0 + t1) * 0.5);
    const midY = h * 0.35 + (arch0 + arch1) * 0.5;
    slice.translate(midX, midY, 0);
    roofGeoms.push(slice);
  }
  const roof = new THREE.Mesh(mergeGeometries(roofGeoms, false), white);
  roof.castShadow = true;
  g.add(roof);
  for (const rg of roofGeoms) rg.dispose();
  return g;
}

function buildHeinzChapel(h) {
  const g = new THREE.Group();
  const stone = mat(0x7a7468, { roughness: 0.85, metalness: 0.03 });
  const chapelH = Math.max(h, 28);
  const body = new THREE.Mesh(new THREE.BoxGeometry(22, chapelH * 0.55, 36), stone);
  body.position.y = chapelH * 0.275;
  body.castShadow = true;
  g.add(body);

  const tower = new THREE.Mesh(new THREE.BoxGeometry(10, chapelH * 0.65, 10), stone);
  tower.position.set(0, chapelH * 0.55 + chapelH * 0.325, -8);
  tower.castShadow = true;
  g.add(tower);

  const spire = new THREE.Mesh(new THREE.ConeGeometry(3.5, chapelH * 0.35, 4), mat(0x5a5448, { roughness: 0.8 }));
  spire.position.set(0, chapelH * 0.55 + chapelH * 0.65 + chapelH * 0.175, -8);
  g.add(spire);
  return g;
}

function buildGlassTower(h, footprint, variant = 'default') {
  const g = new THREE.Group();
  const b = footprintBounds(footprint);
  const w = Math.max(b.w, 35);
  const d = Math.max(b.d, 35);
  const glass = mat(0x88a0b0, { roughness: 0.15, metalness: 0.65, emissive: 0x406080, emissiveIntensity: 0.4, envMapIntensity: 1.2 });
  const bodyH = h * 0.9;
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, bodyH, d), glass);
  body.position.y = bodyH * 0.5;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  if (variant === 'pnc') {
    const crown = new THREE.Mesh(new THREE.BoxGeometry(w * 0.55, h * 0.06, d * 0.55), mat(0x6a8090, { roughness: 0.2, metalness: 0.55 }));
    crown.position.y = bodyH + h * 0.03;
    g.add(crown);
    const spire = new THREE.Mesh(new THREE.ConeGeometry(w * 0.08, h * 0.12, 4), mat(0x788898, { metalness: 0.6 }));
    spire.position.y = bodyH + h * 0.09;
    spire.rotation.y = Math.PI / 4;
    g.add(spire);
  } else if (variant === 'fifth') {
    const steps = 5;
    for (let i = 0; i < steps; i++) {
      const shrink = 1 - i * 0.12;
      const stepH = h * 0.028;
      const step = new THREE.Mesh(new THREE.BoxGeometry(w * shrink, stepH, d * shrink), glass);
      step.position.y = bodyH + stepH * (i + 0.5);
      g.add(step);
    }
  } else if (variant === 'bny') {
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.22, w * 0.28, h * 0.08, 8), mat(0x708898, { metalness: 0.5 }));
    crown.position.y = bodyH + h * 0.04;
    g.add(crown);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, h * 0.05, w * 0.35), mat(0x8090a0, { metalness: 0.45 }));
      fin.position.set(0, bodyH + h * 0.075, (i < 2 ? 1 : -1) * d * 0.3);
      fin.rotation.y = i % 2 === 0 ? 0 : Math.PI / 2;
      g.add(fin);
    }
  }

  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, h * 0.07, 6), mat(0x888888, { metalness: 0.7 }));
  antenna.position.y = h * 0.97;
  g.add(antenna);
  return g;
}

function buildStadium(h, footprint, sport = 'baseball') {
  const g = new THREE.Group();
  const b = footprintBounds(footprint);
  const w = Math.max(b.w, sport === 'baseball' ? 200 : 180);
  const d = Math.max(b.d, sport === 'baseball' ? 160 : 140);
  const bowlMat = mat(0x4a5248, { roughness: 0.72, metalness: 0.12 });
  const seatMat = mat(0x1a4a2a, { roughness: 0.85, metalness: 0.05, emissive: 0x0a2010, emissiveIntensity: 0.08 });
  const fieldMat = mat(0x2a6a32, { roughness: 0.92, metalness: 0.02 });

  const field = new THREE.Mesh(new THREE.BoxGeometry(w * 0.72, 0.6, d * 0.72), fieldMat);
  field.position.y = 0.3;
  g.add(field);

  const tiers = sport === 'baseball' ? 3 : 4;
  for (let t = 0; t < tiers; t++) {
    const shrink = 1 - t * 0.08;
    const tierH = h * (sport === 'baseball' ? 0.22 : 0.18);
    const tierY = 1.2 + t * tierH * 0.85;
    const segs = sport === 'baseball' ? 20 : 16;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * (sport === 'baseball' ? 1.35 : 2);
      const a1 = ((i + 1) / segs) * Math.PI * (sport === 'baseball' ? 1.35 : 2);
      const r0 = w * 0.42 * shrink;
      const r1 = w * 0.5 * shrink;
      const x0 = Math.cos(a0 + (sport === 'baseball' ? 0.35 : 0)) * r0;
      const z0 = Math.sin(a0 + (sport === 'baseball' ? 0.35 : 0)) * d * 0.42 * shrink;
      const x1 = Math.cos(a1 + (sport === 'baseball' ? 0.35 : 0)) * r1;
      const z1 = Math.sin(a1 + (sport === 'baseball' ? 0.35 : 0)) * d * 0.5 * shrink;
      const mx = (x0 + x1) * 0.5;
      const mz = (z0 + z1) * 0.5;
      const len = Math.hypot(x1 - x0, z1 - z0);
      const angle = Math.atan2(z1 - z0, x1 - x0);
      const section = new THREE.Mesh(new THREE.BoxGeometry(len + 1, tierH, 8 + t * 2), t % 2 === 0 ? seatMat : bowlMat);
      section.position.set(mx, tierY + tierH * 0.5, mz);
      section.rotation.y = -angle;
      section.castShadow = true;
      g.add(section);
    }
  }

  if (sport === 'football') {
    const lightH = h * 0.35;
    for (const [ox, oz] of [[-w * 0.42, 0], [w * 0.42, 0], [0, -d * 0.42], [0, d * 0.42]]) {
      const tower = new THREE.Mesh(new THREE.BoxGeometry(2, lightH, 2), mat(0x5a5a5a, { metalness: 0.4 }));
      tower.position.set(ox, lightH * 0.5 + h * 0.5, oz);
      g.add(tower);
      const bank = new THREE.Mesh(new THREE.BoxGeometry(8, 1.5, 3), mat(0x888888, { emissive: 0xffffcc, emissiveIntensity: 0.3 }));
      bank.position.set(ox, lightH + h * 0.5, oz);
      g.add(bank);
    }
  } else {
    const light = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2, h * 0.55, 8), mat(0x6a6a6a, { metalness: 0.35 }));
    light.position.set(-w * 0.35, h * 0.55, -d * 0.2);
    g.add(light);
  }
  return g;
}

function buildPointFountain() {
  const g = new THREE.Group();
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(18, 18, 0.8, 32), mat(0x3a4a48, { roughness: 0.6, metalness: 0.2 }));
  pool.position.y = 0.4;
  g.add(pool);

  const center = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.5, 8, 8), mat(0xc8c0b0, { metalness: 0.4 }));
  center.position.y = 4.5;
  g.add(center);

  for (let i = 0; i < 5; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4 + i * 2.5, 0.25, 6, 24), mat(0xb0a898, { metalness: 0.35 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 1.2 + i * 0.6;
    g.add(ring);
  }
  return g;
}

function buildIncline() {
  const g = new THREE.Group();
  const track = mat(0x4a4a4a, { roughness: 0.7, metalness: 0.3 });
  const car = mat(0x8a2020, { roughness: 0.5, metalness: 0.2 });

  const rail = new THREE.Mesh(new THREE.BoxGeometry(3, 1.2, 180), track);
  rail.position.set(0, 40, 0);
  rail.rotation.x = -0.38;
  rail.castShadow = true;
  g.add(rail);

  const lower = new THREE.Mesh(new THREE.BoxGeometry(14, 10, 18), mat(0x6a5a48, { roughness: 0.8 }));
  lower.position.set(0, 5, 70);
  g.add(lower);

  const upper = new THREE.Mesh(new THREE.BoxGeometry(14, 10, 18), mat(0x6a5a48, { roughness: 0.8 }));
  upper.position.set(-30, 75, -50);
  g.add(upper);

  const inclineCar = new THREE.Mesh(new THREE.BoxGeometry(5, 4, 8), car);
  inclineCar.position.set(-10, 35, 10);
  inclineCar.rotation.x = -0.38;
  g.add(inclineCar);
  return g;
}

const BUILDERS = {
  'ppg-tower': (b) => buildPPGTower(b.h, b.f),
  'ppg-low': (b) => buildPPGLow(b.h, b.f),
  'ppg-mid': (b) => buildPPGLow(b.h, b.f, 1.6),
  cathedral: (b) => buildCathedral(b.h, b.f),
  'us-steel': (b) => buildUSSteel(b.h, b.f),
  'gulf-tower': (b) => buildArtDecoTower(b.h, b.f, 'stepped'),
  'grant-building': (b) => buildArtDecoTower(b.h, b.f, 'globe'),
  'koppers-tower': (b) => buildArtDecoTower(b.h, b.f, 'dome'),
  'convention-center': (b) => buildConventionCenter(b.h, b.f),
  'heinz-chapel': (b) => buildHeinzChapel(b.h),
  'pnc-tower': (b) => buildGlassTower(b.h, b.f, 'pnc'),
  'fifth-avenue': (b) => buildGlassTower(b.h, b.f, 'fifth'),
  'bny-mellon': (b) => buildGlassTower(b.h, b.f, 'bny'),
  'oxford-centre': (b) => buildGlassTower(b.h, b.f),
  'pnc-park': (b) => buildStadium(b.h, b.f, 'baseball'),
  'acrisure-stadium': (b) => buildStadium(b.h, b.f, 'football'),
};

const SINGLETON_MESHES = new Set([
  'us-steel',
  'fifth-avenue',
  'bny-mellon',
  'pnc-tower',
  'oxford-centre',
  'gulf-tower',
  'koppers-tower',
  'grant-building',
  'convention-center',
  'cathedral',
  'heinz-chapel',
  'pnc-park',
  'acrisure-stadium',
  'ppg-arena',
]);

function landmarkScore(b) {
  const bb = footprintBounds(b.f);
  return (b.h || 0) + bb.w * bb.d * 0.002;
}

function dedupeLandmarkBuildings(buildings) {
  const singletons = new Map();
  const multi = [];
  for (const b of buildings) {
    if (!b.landmarkMesh || !b.f) continue;
    if (SINGLETON_MESHES.has(b.landmarkMesh)) {
      const prev = singletons.get(b.landmarkMesh);
      if (!prev || landmarkScore(b) > landmarkScore(prev)) singletons.set(b.landmarkMesh, b);
    } else {
      multi.push(b);
    }
  }
  return [...singletons.values(), ...multi];
}

export function buildLandmarkMeshes(buildings, yFn, waterIndex = null, pointPark = null) {
  const group = new THREE.Group();
  group.name = 'landmarks';

  for (const b of dedupeLandmarkBuildings(buildings)) {
    if (waterIndex && footprintWaterOverlap(b.f, waterIndex) > 0.35) continue;
    const builder = BUILDERS[b.landmarkMesh];
    if (!builder) continue;
    const [cx, cz] = footprintCentroid(b.f);
    const baseY = waterIndex
      ? footprintLandBaseY(b.f, yFn, waterIndex)
      : yFn(cx, cz);
    try {
      const frame = footprintBounds(b.f);
      const mesh = builder(b, frame);
      mesh.position.set(frame.cx, baseY, frame.cz);
      mesh.rotation.y = -frame.yaw;
      group.add(mesh);
    } catch (err) {
      console.warn('Landmark mesh failed:', b.n, err);
    }
  }

  group.add(buildPointStatePark(yFn, pointPark));

  // Duquesne Incline lower station, from OSM: 40.44012 N, 80.01784 W.
  const incline = buildIncline();
  incline.position.set(-1341, yFn(-1341, 98), 98);
  group.add(incline);

  return group;
}

export function isLandmarkMeshBuilding(b) {
  return Boolean(b.landmarkMesh);
}
