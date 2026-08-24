import * as THREE from 'three';
import { buildPncPark, buildAcrisureStadium, buildPpgArena } from './src/stadiums.js';

const realistic = {
  'pnc-park': [
    [-100, -95], [100, -95], [100, 95], [-100, 95], [-100, -95],
  ],
  'acrisure-stadium': [
    [-115, -100], [115, -100], [115, 100], [-115, 100], [-115, -100],
  ],
  'ppg-arena': [
    [-95, -87], [95, -87], [95, 87], [-95, 87], [-95, -87],
  ],
};
const degenerate = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

const cases = [
  ['buildPncPark', buildPncPark, { h: 38, f: realistic['pnc-park'], orientYaw: 0.39 }],
  ['buildAcrisureStadium', buildAcrisureStadium, { h: 54, f: realistic['acrisure-stadium'], orientYaw: Math.PI / 2 }],
  ['buildPpgArena', buildPpgArena, { h: 40, f: realistic['ppg-arena'], orientYaw: Math.PI }],
];

function stats(group) {
  let tris = 0;
  let draws = 0;
  group.traverse((o) => {
    if (!o.isMesh) return;
    draws++;
    const idx = o.geometry.getIndex();
    tris += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
    const pos = o.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i++) {
      if (!Number.isFinite(pos[i])) throw new Error(`NaN position in ${o.material.name || 'mesh'}`);
    }
  });
  const bb = new THREE.Box3().setFromObject(group);
  const size = bb.getSize(new THREE.Vector3());
  const finite = [bb.min, bb.max].every((v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
  return { tris, draws, finite, size: size.toArray().map((v) => +v.toFixed(1)), min: bb.min.toArray().map((v) => +v.toFixed(1)), max: bb.max.toArray().map((v) => +v.toFixed(1)) };
}

for (const [name, fn, spec] of cases) {
  const good = stats(fn(spec));
  const bad = stats(fn({ h: spec.h, f: degenerate }));
  const empty = stats(fn({}));
  console.log(name, 'realistic', JSON.stringify(good));
  console.log(name, 'degenerate', JSON.stringify(bad));
  console.log(name, 'no-spec   ', JSON.stringify(empty));
  if (!good.finite || !bad.finite || !empty.finite) throw new Error(`${name} produced a non-finite bbox`);
  if (good.tris < 1000) throw new Error(`${name} produced too few triangles`);
}

// Winding sanity: the seating risers must face the field, treads must face up.
{
  const g = buildAcrisureStadium({ h: 54, f: realistic['acrisure-stadium'], orientYaw: 0 });
  let up = 0;
  let inward = 0;
  let total = 0;
  g.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.normal) return;
    if (o.material.color.getHex() !== 0xa08a2c) return;
    const n = o.geometry.attributes.normal;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < n.count; i += 7) {
      total++;
      if (n.getY(i) > 0.8) up++;
      const dot = n.getX(i) * p.getX(i) + n.getZ(i) * p.getZ(i);
      if (dot < 0 && Math.abs(n.getY(i)) < 0.4) inward++;
    }
  });
  console.log('lower-bowl normals: up', up, 'inward-facing risers', inward, 'of', total);
  if (up < total * 0.2 || inward < total * 0.2) throw new Error('seating winding looks wrong');
}

console.log('OK');
