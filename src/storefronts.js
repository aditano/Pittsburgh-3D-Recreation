import * as THREE from 'three';
import {nearestSegment} from './motion.js';
import {pointInPoly} from './geo.js';
export function createStorefronts(data,buildings,yFn,scene,onVisit){
 const root=new THREE.Group();scene.add(root);const signs=[];const destinations=[];
 const box=new THREE.BoxGeometry(1,1,1),colors=[0xb53229,0x278777,0x266b3f,0x315d9c,0x167381,0xc64830,0x75422a,0xc43636,0xa77032];
 const list=document.getElementById('business-list');
 data.places.forEach((place,i)=>{
  const containing=buildings.find(b=>pointInPoly(...place.p,b.f));
  let edges=[];for(const b of containing?[containing]:buildings){for(let j=1;j<b.f.length;j++)edges.push({a:b.f[j-1],b:b.f[j]});}
  const edge=nearestSegment(...place.p,edges);if(!edge||edge.distance>100)return;
  const dx=edge.b[0]-edge.a[0],dz=edge.b[1]-edge.a[1],len=Math.hypot(dx,dz);
  let nx=-dz/len,nz=dx/len;
  if(containing&&pointInPoly(edge.x+nx,edge.z+nz,containing.f)){nx=-nx;nz=-nz;}
  const g=new THREE.Group();g.position.set(edge.x+nx*.5,yFn(edge.x,edge.z)+1.2,edge.z+nz*.5);g.rotation.y=Math.atan2(nx,nz);root.add(g);
  const width=Math.max(4,Math.min(13,len-1));
  function part(color,x,y,z,w,h,d,emissive=false){const mat=new THREE.MeshStandardMaterial({color,roughness:.65,emissive:emissive?color:0,emissiveIntensity:.1});const m=new THREE.Mesh(box,mat);m.position.set(x,y,z);m.scale.set(w,h,d);g.add(m);return m;}
  part(0x142f38,0,1.7,.05,width,3.2,.15);
  for(let x=-width/2;x<=width/2;x+=2)part(0xd9cda9,x,1.7,.2,.12,3.3,.2);
  part(colors[i%colors.length],0,3.4,.9,width+.5,.22,2.3);
  part(colors[i%colors.length],0,3.15,2,width+.5,.5,.12);
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=128;const ctx=canvas.getContext('2d');ctx.fillStyle='#14211e';ctx.fillRect(0,0,1024,128);ctx.fillStyle='#fff0c8';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`bold ${place.name.length>25?39:49}px Georgia`;ctx.fillText(place.name.toUpperCase(),512,65,980);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const sign=new THREE.Mesh(new THREE.PlaneGeometry(width,1.2),new THREE.MeshStandardMaterial({map:texture,emissiveMap:texture,emissive:0xffffff,emissiveIntensity:.2,side:THREE.DoubleSide}));sign.position.set(0,4.25,.35);g.add(sign);signs.push(sign);
  // Pavement furniture: produce crates, planters and café tables.
  for(let j=0;j<3;j++){const x=(j-1)*width*.28;part(0x855c32,x,.4,2.3,1,.7,.8);part(j%2?0xdd9f3c:0x528346,x,.82,2.3,.85,.15,.7);}
  const visit=[g.position.x+nx*5,g.position.z+nz*5];destinations.push({...place,visit});
  const b=document.createElement('button');b.textContent=place.name;b.addEventListener('click',()=>onVisit(visit));list.append(b);
 });
 return {root,destinations,update(night){for(const sign of signs)sign.material.emissiveIntensity=.15+night*1.3;}};
}
