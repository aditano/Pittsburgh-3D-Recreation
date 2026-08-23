import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { footprintCentroid } from './geo.js';

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
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of f) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ, w: maxX - minX, d: maxZ - minZ };
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
  const towerH = h * 0.92;

  const base = new THREE.Mesh(new THREE.BoxGeometry(w * 0.85, h * 0.35, d * 0.85), stone);
  base.position.y = h * 0.175;
  base.castShadow = true;
  g.add(base);

  const tower = new THREE.Mesh(new THREE.BoxGeometry(towerW, towerH, towerW), stone);
  tower.position.y = towerH * 0.5;
  tower.castShadow = true;
  g.add(tower);

  const cren = new THREE.Mesh(new THREE.BoxGeometry(towerW * 1.08, h * 0.04, towerW * 1.08), stone);
  cren.position.y = towerH + h * 0.02;
  g.add(cren);

  const spire = new THREE.Mesh(new THREE.ConeGeometry(towerW * 0.25, h * 0.12, 4), mat(0x6a6458, { roughness: 0.75 }));
  spire.position.y = towerH + h * 0.08;
  g.add(spire);

  for (let i = 0; i < 4; i++) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(w * 0.3, h * 0.25, d * 0.55), stone);
    const side = i < 2 ? -1 : 1;
    if (i % 2 === 0) wing.position.set(side * w * 0.42, h * 0.125, 0);
    else wing.position.set(0, h * 0.125, side * d * 0.42);
    wing.castShadow = true;
    g.add(wing);
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

function buildGlassTower(h, footprint) {
  const g = new THREE.Group();
  const b = footprintBounds(footprint);
  const w = Math.max(b.w, 35);
  const d = Math.max(b.d, 35);
  const glass = mat(0x88a0b0, { roughness: 0.15, metalness: 0.65, emissive: 0x406080, emissiveIntensity: 0.4, envMapIntensity: 1.2 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.94, d), glass);
  body.position.y = h * 0.47;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, h * 0.08, 6), mat(0x888888, { metalness: 0.7 }));
  antenna.position.y = h * 0.98;
  g.add(antenna);
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
  'pnc-tower': (b) => buildGlassTower(b.h, b.f),
  'fifth-avenue': (b) => buildGlassTower(b.h, b.f),
  'bny-mellon': (b) => buildGlassTower(b.h, b.f),
  'oxford-centre': (b) => buildGlassTower(b.h, b.f),
};

export function buildLandmarkMeshes(buildings, yFn) {
  const group = new THREE.Group();
  group.name = 'landmarks';

  for (const b of buildings) {
    if (!b.landmarkMesh || !b.f) continue;
    const builder = BUILDERS[b.landmarkMesh];
    if (!builder) continue;
    const [cx, cz] = footprintCentroid(b.f);
    const baseY = yFn(cx, cz);
    try {
      const mesh = builder(b);
      mesh.position.set(cx, baseY, cz);
      group.add(mesh);
    } catch (err) {
      console.warn('Landmark mesh failed:', b.n, err);
    }
  }

  const fountain = buildPointFountain();
  fountain.position.set(-864.17, yFn(-864.17, -77.92), -77.92);
  group.add(fountain);

  const incline = buildIncline();
  incline.position.set(-1364.04, yFn(-1364.04, 200.38), 200.38);
  group.add(incline);

  return group;
}

export function isLandmarkMeshBuilding(b) {
  return Boolean(b.landmarkMesh);
}
