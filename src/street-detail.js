import * as THREE from 'three';
import {footprintCentroid,hash01,pointInPoly} from './geo.js';

/** Close-range geometry is partitioned so distant neighborhoods cost no draw calls. */
export function createStreetDetail(data,buildings,yFn,waterIndex,scene,constrained){
 const root=new THREE.Group();root.name='street-detail';scene.add(root);const tiles=new Map();
 const sharedBox=new THREE.BoxGeometry(1,1,1),dummy=new THREE.Object3D(),tint=new THREE.Color();
 const material=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.82});
 function bucket(x,z){const tx=Math.floor(x/250),tz=Math.floor(z/250),key=`${tx},${tz}`;if(!tiles.has(key))tiles.set(key,{x:(tx+.5)*250,z:(tz+.5)*250,matrices:[],colors:[]});return tiles.get(key);}
 function box(x,y,z,w,h,d,heading,color){
  dummy.position.set(x,y,z);dummy.rotation.set(0,heading,0);dummy.scale.set(w,h,d);dummy.updateMatrix();
  const tile=bucket(x,z);tile.matrices.push(...dummy.matrix.elements);tint.set(color);tile.colors.push(tint.r,tint.g,tint.b);
 }

 // Use the original render centerlines for pavement, so overlays cannot drift
 // when the newer OSM tag extract has slightly changed a carriageway.
 for(const s of data.streets){if(s.r<3||s.r>4)continue;for(let i=1;i<s.c.length;i++){
  const a=s.c[i-1],b=s.c[i],dx=b[0]-a[0],dz=b[1]-a[1],len=Math.hypot(dx,dz);if(len<5||len>600)continue;
  const mx=(a[0]+b[0])/2,mz=(a[1]+b[1])/2;if(mx< -1800||mx>3000||mz< -2300||mz>1300||waterIndex.inside(mx,mz)||waterIndex.inside(...a)||waterIndex.inside(...b))continue;
  const theta=Math.atan2(dx,dz),nx=dz/len,nz=-dx/len,half=s.r===3?3.75:5.25;
  // Short pavement sections conform to the ten-metre terrain instead of bridging slopes.
  const n=Math.ceil(len/8);for(let j=0;j<n;j++){const t=(j+.5)/n,x=a[0]+dx*t,z=a[1]+dz*t,y=yFn(x,z)+1.15;
   for(const sign of [-1,1]){box(x+nx*(half+1)*sign,y+.08,z+nz*(half+1)*sign,1.9,.18,len/n+.06,theta,0x919087);box(x+nx*half*sign,y+.12,z+nz*half*sign,.16,.24,len/n+.06,theta,0xb6b0a0);}
   if(j%2===0)box(x,y+.03,z,.12,.035,Math.min(3,len/n),theta,0xddc779);
  }
 }}
 // Ground-level lintels, projecting sills, door reveals and cornice shadows.
 // Preserve all mapped footprints. No guessed towers or moved streets.
 let detailed=0;
 for(const b of buildings){if(!b.f||b.h<4||b.landmarkMesh)continue;const [cx,cz]=footprintCentroid(b.f);
  if(cx< -1400||cx>2800||cz< -2300||cz>1000||waterIndex.inside(cx,cz))continue;
  const floorCount=Math.min(constrained?2:4,Math.floor((b.h-1)/3.4));
  const base=Math.max(...b.f.map(p=>yFn(...p)));
  for(let i=1;i<b.f.length;i++){const a=b.f[i-1],p=b.f[i],dx=p[0]-a[0],dz=p[1]-a[1],len=Math.hypot(dx,dz);if(len<5||len>150)continue;
   let nx=-dz/len,nz=dx/len;if(pointInPoly((a[0]+p[0])/2+nx,(a[1]+p[1])/2+nz,b.f)){nx=-nx;nz=-nz;}
   const heading=Math.atan2(nx,nz),bays=Math.min(22,Math.floor(len/3.2));
   for(let j=0;j<bays;j++){const t=(j+.5)/bays,x=a[0]+dx*t+nx*.15,z=a[1]+dz*t+nz*.15;
    for(let floor=0;floor<floorCount;floor++){const y=base+floor*3.4+1.15;box(x,y,z,1.45,.13,.36,heading,0xa2947f);box(x,y+1.95,z,1.55,.18,.25,heading,0x8b8273);}
    if(j===Math.floor(bays/2))box(x,base+1.25,z,.96,2.5,.09,heading,0x283333);
   }
  }detailed++;
 }
 for(const tile of tiles.values()){
  const count=tile.matrices.length/16;
  tile.mesh=new THREE.InstancedMesh(sharedBox,material,count);
  tile.mesh.instanceMatrix.array.set(tile.matrices);tile.mesh.instanceMatrix.needsUpdate=true;
  tile.mesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(tile.colors),3);
  tile.mesh.computeBoundingSphere();tile.mesh.receiveShadow=true;tile.mesh.castShadow=true;root.add(tile.mesh);
  delete tile.matrices;delete tile.colors;
 }

 return {root,detailed,update(camera){const radius=constrained?450:850;for(const tile of tiles.values())if(tile.mesh)tile.mesh.visible=Math.hypot(camera.position.x-tile.x,camera.position.z-tile.z)<radius&&camera.position.y-yFn(tile.x,tile.z)<650;}};
}
