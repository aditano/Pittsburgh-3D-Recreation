/**
 * Scratch: list each merged mesh a stadium builder emits with its material
 * colour, triangle count and bounding box, so a surface seen in a render can be
 * traced back to the array that produced it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { ROOT } from './osm.mjs';
import { buildAcrisureStadium, buildPncPark, buildPpgArena } from '../src/stadiums.js';

const data = JSON.parse(readFileSync(join(ROOT, 'public/data/pittsburgh.json'), 'utf8'));
const find = (re) => data.buildings.find((b) => b.n && re.test(b.n));

const cases = [
  ['PNC Park', buildPncPark, find(/PNC Park/)],
  ['Acrisure', buildAcrisureStadium, find(/Acrisure/)],
  ['PPG', buildPpgArena, find(/PPG Paints/)],
];

for (const [label, build, b] of cases) {
  if (!b) continue;
  const g = build({ h: b.h, f: b.f, orientYaw: b.field?.open });
  let tris = 0;
  const rows = [];
  g.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
    tris += n;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    const col = o.material.color ? `#${o.material.color.getHexString()}` : '-';
    rows.push({
      col,
      n,
      y: [bb.min.y, bb.max.y],
      r: Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x), Math.abs(bb.min.z), Math.abs(bb.max.z)),
      m: o.material.metalness,
      rough: o.material.roughness,
    });
  });
  rows.sort((a, x) => x.n - a.n);
  console.log(`\n=== ${label}: ${tris.toLocaleString()} triangles, ${rows.length} meshes`);
  for (const r of rows) {
    console.log(
      `  ${r.col}  tris ${String(r.n).padStart(7)}  y ${r.y[0].toFixed(1).padStart(6)}..${r.y[1].toFixed(1).padStart(6)}` +
        `  maxR ${r.r.toFixed(0).padStart(4)}  metal ${r.m.toFixed(2)} rough ${r.rough.toFixed(2)}`,
    );
  }
}
