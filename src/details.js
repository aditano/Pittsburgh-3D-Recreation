import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01 } from './geo.js';

function streetLightGeometry() {
  const pole = new THREE.CylinderGeometry(0.12, 0.16, 7.5, 6);
  pole.translate(0, 3.75, 0);
  const arm = new THREE.BoxGeometry(2.2, 0.12, 0.12);
  arm.translate(1.1, 7.5, 0);
  const head = new THREE.BoxGeometry(0.8, 0.25, 0.5);
  head.translate(2.2, 7.35, 0);
  return mergeGeometries([pole, arm, head], false);
}

const lightGeo = streetLightGeometry();
const lightMat = new THREE.MeshStandardMaterial({
  color: 0x3a3a3a,
  roughness: 0.65,
  metalness: 0.35,
});

export function buildStreetLights(streets, yFn, waterIndex) {
  const group = new THREE.Group();
  group.name = 'street-lights';
  const lights = [];
  const step = 85;

  for (const s of streets) {
    const r = s.r ?? 1;
    if (r < 4) continue;
    for (let i = 0; i < s.c.length - 1; i++) {
      const a = s.c[i];
      const b = s.c[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < step) continue;
      const n = Math.floor(len / step);
      const ux = dx / len;
      const uz = dz / len;
      const rx = -uz;
      const rz = ux;
      for (let j = 1; j < n; j++) {
        const t = (j * step) / len;
        const x = a[0] + dx * t;
        const z = a[1] + dz * t;
        if (waterIndex.inside(x, z)) continue;
        const side = j % 2 === 0 ? 1 : -1;
        const lx = x + rx * side * (r >= 5 ? 9 : 7);
        const lz = z + rz * side * (r >= 5 ? 9 : 7);
        const y = yFn(lx, lz) + 1.2;
        if (y < 0) continue;
        lights.push(lx, y, lz, hash01(lx, lz) * Math.PI * 2);
      }
    }
  }

  if (!lights.length) return group;
  const count = lights.length / 4;
  const mesh = new THREE.InstancedMesh(lightGeo, lightMat, count);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    dummy.position.set(lights[i * 4], lights[i * 4 + 1], lights[i * 4 + 2]);
    dummy.rotation.y = lights[i * 4 + 3];
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  group.add(mesh);

  const bulbGeo = new THREE.SphereGeometry(0.22, 6, 4);
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xffe8c0,
    emissive: 0xffc878,
    emissiveIntensity: 2.5,
    roughness: 0.3,
    metalness: 0,
  });
  const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, count);
  for (let i = 0; i < count; i++) {
    dummy.position.set(lights[i * 4] + 2.2, lights[i * 4 + 1] + 3.6, lights[i * 4 + 2]);
    dummy.rotation.set(0, lights[i * 4 + 3], 0);
    dummy.updateMatrix();
    bulbs.setMatrixAt(i, dummy.matrix);
  }
  bulbs.instanceMatrix.needsUpdate = true;
  group.add(bulbs);

  return group;
}

export function buildRooftopDetails(buildings, yFn) {
  const group = new THREE.Group();
  group.name = 'rooftop-details';
  const antennaGeoms = [];
  const domeGeoms = [];
  const spireGeoms = [];

  for (const b of buildings) {
    if (b.landmarkMesh || !b.f || b.f.length < 4) continue;
    const h = b.h || 10;
    if (h < 60) continue;
    const roof = b.roof || (h > 120 ? 'antenna' : null);
    if (!roof) continue;

    let cx = 0;
    let cz = 0;
    const n = b.f.length - 1;
    for (let i = 0; i < n; i++) {
      cx += b.f[i][0];
      cz += b.f[i][1];
    }
    cx /= n;
    cz /= n;
    const baseY = yFn(cx, cz) + h;

    if (roof === 'antenna') {
      const pole = new THREE.CylinderGeometry(0.3, 0.5, h * 0.06, 5);
      pole.translate(cx, baseY + h * 0.03, cz);
      antennaGeoms.push(pole);
      const dish = new THREE.CylinderGeometry(1.2, 1.2, 0.3, 8);
      dish.translate(cx, baseY + h * 0.06, cz);
      antennaGeoms.push(dish);
    } else if (roof === 'spire') {
      const spire = new THREE.ConeGeometry(1.8, h * 0.05, 4);
      spire.translate(cx, baseY + h * 0.025, cz);
      spireGeoms.push(spire);
    }
  }

  const detailMat = new THREE.MeshStandardMaterial({
    color: 0x6a6a6a,
    roughness: 0.5,
    metalness: 0.45,
  });
  const spireMat = new THREE.MeshStandardMaterial({
    color: 0x888880,
    roughness: 0.55,
    metalness: 0.3,
  });

  if (antennaGeoms.length) {
    const merged = mergeGeometries(antennaGeoms, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, detailMat);
      mesh.castShadow = true;
      group.add(mesh);
      for (const g of antennaGeoms) g.dispose();
    }
  }
  if (spireGeoms.length) {
    const merged = mergeGeometries(spireGeoms, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, spireMat);
      mesh.castShadow = true;
      group.add(mesh);
      for (const g of spireGeoms) g.dispose();
    }
  }
  return group;
}

export function buildStreetLightGlows(streets, yFn, waterIndex, scene) {
  const lights = [];
  const step = 170;
  let added = 0;
  const maxLights = 48;

  for (const s of streets) {
    if ((s.r ?? 1) < 5) continue;
    for (let i = 0; i < s.c.length - 1 && added < maxLights; i++) {
      const a = s.c[i];
      const b = s.c[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < step * 2) continue;
      const mx = (a[0] + b[0]) * 0.5;
      const mz = (a[1] + b[1]) * 0.5;
      if (waterIndex.inside(mx, mz)) continue;
      const y = yFn(mx, mz) + 5;
      if (y < 1) continue;
      const pl = new THREE.PointLight(0xffc878, 0.35, 45, 2);
      pl.position.set(mx, y, mz);
      scene.add(pl);
      added++;
    }
  }
  return added;
}
