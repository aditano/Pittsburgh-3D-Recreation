import * as THREE from 'three';
const { buildPncPark, buildAcrisureStadium, buildPpgArena } = await import('/workspace/src/stadiums.js');
for (const [name, fn, spec] of [
  ['PNC', buildPncPark, { h: 36, orientYaw: 0.2503 }],
  ['Acrisure', buildAcrisureStadium, { h: 58, orientYaw: 1.2972 }],
  ['PPG', buildPpgArena, { h: 40, orientYaw: 3.046 }],
]) {
  const g = fn(spec);
  let tris = 0;
  let meshes = 0;
  let verts = 0;
  g.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const gg = o.geometry;
    const i = gg.getIndex();
    tris += (i ? i.count : gg.attributes.position.count) / 3;
    verts += gg.attributes.position.count;
  });
  const bb = new THREE.Box3().setFromObject(g);
  console.log(
    name,
    'meshes', meshes,
    'tris', Math.round(tris),
    'verts', verts,
    'bbox x', bb.min.x.toFixed(0), bb.max.x.toFixed(0),
    'y', bb.min.y.toFixed(1), bb.max.y.toFixed(1),
    'z', bb.min.z.toFixed(0), bb.max.z.toFixed(0),
  );
}
