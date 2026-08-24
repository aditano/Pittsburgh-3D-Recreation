import * as THREE from 'three';
import { POINT_PARK_RING } from './geo.js';

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.78,
    metalness: opts.metalness ?? 0.04,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    flatShading: opts.flatShading ?? false,
  });
}

function ringMesh(pts, y, width, material) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], -pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], -pts[i][1]);
  shape.closePath();
  const hole = new THREE.Path();
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const scale = 1 - width / 80;
  hole.moveTo(cx + (pts[0][0] - cx) * scale, -(cz + (pts[0][1] - cz) * scale));
  for (let i = 1; i < pts.length; i++) {
    hole.lineTo(cx + (pts[i][0] - cx) * scale, -(cz + (pts[i][1] - cz) * scale));
  }
  hole.closePath();
  shape.holes.push(hole);
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, y, 0);
  return new THREE.Mesh(geom, material);
}

function polyMesh(pts, y, material) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], -pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    if (i === pts.length - 1 && Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]) < 0.5) break;
    shape.lineTo(pts[i][0], -pts[i][1]);
  }
  shape.closePath();
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, y, 0);
  return new THREE.Mesh(geom, material);
}

/** Iconic Point State Park: triangular lawn, fountain at the western tip, fort traces. */
export function buildPointStatePark(yFn) {
  const g = new THREE.Group();
  g.name = 'point-state-park';
  const lawnY = yFn(-800, -80) + 0.9;

  const lawn = polyMesh(POINT_PARK_RING, lawnY, mat(0x3d6a3a, { roughness: 0.95 }));
  lawn.receiveShadow = true;
  g.add(lawn);

  const walk = mat(0xc8c2b4, { roughness: 0.7, metalness: 0.05 });
  const promenade = [
    [-940, -70],
    [-900, -40],
    [-820, -20],
    [-720, 10],
    [-640, 40],
    [-620, 20],
    [-700, -20],
    [-820, -50],
    [-900, -90],
    [-940, -100],
    [-960, -82],
    [-940, -70],
  ];
  g.add(polyMesh(promenade, lawnY + 0.12, walk));

  const northWalk = [
    [-930, -110],
    [-860, -130],
    [-760, -150],
    [-660, -140],
    [-650, -120],
    [-750, -128],
    [-850, -110],
    [-920, -92],
    [-930, -110],
  ];
  g.add(polyMesh(northWalk, lawnY + 0.12, walk));

  const fountainX = -864.17;
  const fountainZ = -77.92;
  const fountainY = lawnY + 0.2;
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(22, 24, 1.1, 48), mat(0x8a9aa0, { roughness: 0.35, metalness: 0.25 }));
  basin.position.set(fountainX, fountainY + 0.4, fountainZ);
  g.add(basin);
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(19.5, 19.5, 0.4, 48),
    new THREE.MeshStandardMaterial({
      color: 0x4aa0c8,
      roughness: 0.12,
      metalness: 0.35,
      transparent: true,
      opacity: 0.85,
      emissive: 0x1a4060,
      emissiveIntensity: 0.2,
    }),
  );
  water.position.set(fountainX, fountainY + 0.85, fountainZ);
  g.add(water);

  const jetMat = new THREE.MeshStandardMaterial({
    color: 0xd8eef8,
    transparent: true,
    opacity: 0.45,
    roughness: 0.2,
    metalness: 0.05,
    depthWrite: false,
  });
  const jet = new THREE.Mesh(new THREE.ConeGeometry(2.4, 28, 10, 1, true), jetMat);
  jet.position.set(fountainX, fountainY + 16, fountainZ);
  g.add(jet);
  const spray = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.6, 22, 8, 1, true), jetMat);
  spray.position.set(fountainX, fountainY + 12, fountainZ);
  g.add(spray);

  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(6 + i * 4.2, 0.22, 6, 32),
      mat(0xb8b0a4, { metalness: 0.3, roughness: 0.45 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(fountainX, fountainY + 1.3 + i * 0.35, fountainZ);
    g.add(ring);
  }

  const stone = mat(0x8a8478, { roughness: 0.88 });
  const bastion = [
    [-700, 20],
    [-660, 55],
    [-620, 40],
    [-610, 5],
    [-640, -20],
    [-680, -10],
    [-700, 20],
  ];
  const outline = ringMesh(bastion, lawnY + 0.18, 4.5, stone);
  g.add(outline);

  const museum = new THREE.Mesh(new THREE.BoxGeometry(38, 9, 22), mat(0x6a5848, { roughness: 0.82 }));
  museum.position.set(-647, lawnY + 4.5, 30);
  museum.rotation.y = 0.35;
  museum.castShadow = true;
  museum.receiveShadow = true;
  g.add(museum);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(40, 0.6, 24), mat(0x4a4038, { roughness: 0.7 }));
  roof.position.set(-647, lawnY + 9.2, 30);
  roof.rotation.y = 0.35;
  g.add(roof);

  const block = new THREE.Mesh(new THREE.BoxGeometry(9, 7, 9), mat(0x7a6a58, { roughness: 0.9 }));
  block.position.set(-662, lawnY + 3.5, -21);
  block.castShadow = true;
  g.add(block);
  const blockRoof = new THREE.Mesh(new THREE.ConeGeometry(7.2, 3.2, 4), mat(0x5a4030, { roughness: 0.75 }));
  blockRoof.position.set(-662, lawnY + 8.6, -21);
  blockRoof.rotation.y = Math.PI / 4;
  g.add(blockRoof);

  const portal = new THREE.Mesh(new THREE.BoxGeometry(90, 4.5, 18), mat(0x3a3a38, { roughness: 0.65, metalness: 0.2 }));
  portal.position.set(-700, lawnY + 2.4, -40);
  portal.rotation.y = 0.55;
  g.add(portal);

  const treeMat = mat(0x1a3a1c, { roughness: 1 });
  const treeGeo = new THREE.ConeGeometry(3.4, 9, 6);
  const dummy = new THREE.Object3D();
  const spots = [
    [-780, -40],
    [-750, -90],
    [-720, -20],
    [-690, -80],
    [-760, 10],
    [-820, -20],
    [-800, -110],
    [-730, 40],
    [-670, -50],
    [-710, -130],
  ];
  const trees = new THREE.InstancedMesh(treeGeo, treeMat, spots.length);
  spots.forEach((p, i) => {
    dummy.position.set(p[0], lawnY + 5.2, p[1]);
    dummy.rotation.y = i * 0.7;
    dummy.updateMatrix();
    trees.setMatrixAt(i, dummy.matrix);
  });
  trees.castShadow = true;
  g.add(trees);

  return g;
}
