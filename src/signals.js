import * as THREE from 'three';
/** Two opposing phases, each followed by yellow and an all-red clearance. */
export function signalPhase(time,axis,offset=0){
 const t=((time+offset)%70+70)%70;
 const local=(t-axis*35+70)%70;
 return local<28?'green':local<32?'yellow':'red';
}
export function createSignals(mapped,segments,yFn,scene){
 const junctions=[];
 // Multiple OSM heads at an intersection share a controller.
 for(const node of mapped||[]){if(!junctions.some(j=>Math.hypot(j.x-node.p[0],j.z-node.p[1])<32))junctions.push({x:node.p[0],z:node.p[1],offset:(node.id%17)*3,approaches:[]});}
 for(const s of segments){let best=null,distance=28;for(const j of junctions){const d=Math.hypot(s.b[0]-j.x,s.b[1]-j.z);if(d<distance){best=j;distance=d;}}
  if(best){s.signal=best;s.signalAxis=Math.abs(s.b[0]-s.a[0])>Math.abs(s.b[1]-s.a[1])?0:1;best.approaches.push(s);}
 }
 for(const s of segments)if(s.signal?.approaches.length<2)delete s.signal;
 const active=junctions.filter(j=>j.approaches.length>1),root=new THREE.Group();root.name='traffic-signals';scene.add(root);
 const heads=[];for(const j of active){const directions=new Set();for(const s of j.approaches){const dx=(s.b[0]-s.a[0])/s.length,dz=(s.b[1]-s.a[1])/s.length,key=Math.round(Math.atan2(dx,dz)/(.5*Math.PI));if(directions.has(key))continue;directions.add(key);heads.push({j,axis:s.signalAxis,x:s.b[0]-dx*8+dz*4.5,z:s.b[1]-dz*8-dx*4.5,heading:Math.atan2(dx,dz)+Math.PI});}}
 const box=new THREE.BoxGeometry(1,1,1),dummy=new THREE.Object3D();
 const poles=new THREE.InstancedMesh(box,new THREE.MeshStandardMaterial({color:0x444b4b,metalness:.6,roughness:.6}),heads.length);
 const housings=new THREE.InstancedMesh(box,new THREE.MeshStandardMaterial({color:0xe4b93c,roughness:.55}),heads.length);
 const lamps=new THREE.InstancedMesh(new THREE.SphereGeometry(.17,8,6),new THREE.MeshBasicMaterial({color:0xffffff}),heads.length*3);
 lamps.instanceMatrix.setUsage(THREE.StaticDrawUsage);lamps.frustumCulled=false;
 function set(mesh,i,x,y,z,heading,w,h,d){dummy.position.set(x,y,z);dummy.rotation.set(0,heading,0);dummy.scale.set(w,h,d);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);}
 heads.forEach((h,i)=>{const y=yFn(h.x,h.z)+1.2;set(poles,i,h.x,y+2.8,h.z,0,.12,5.6,.12);set(housings,i,h.x,y+5.15,h.z,h.heading,.58,1.55,.38);
  for(let k=0;k<3;k++)set(lamps,i*3+k,h.x+Math.sin(h.heading)*.23,y+5.65-k*.5,h.z+Math.cos(h.heading)*.23,0,1,1,.6);
 });root.add(poles,housings,lamps);
 // Stop bars and zebra stripes sit ahead of each controlled approach.
 const markings=new THREE.InstancedMesh(box,new THREE.MeshStandardMaterial({color:0xddd9c7,roughness:.95}),heads.length*7);
 heads.forEach((h,i)=>{const dx=-Math.sin(h.heading),dz=-Math.cos(h.heading),nx=dz,nz=-dx;
  const x=h.x-nx*4.5,z=h.z-nz*4.5,y=yFn(x,z)+1.19;
  set(markings,i*7,x,y,z,h.heading,7,.04,.32);
  for(let k=0;k<6;k++)set(markings,i*7+k+1,x+nx*(k-2.5)*1.05+dx*3,y,z+nz*(k-2.5)*1.05+dz*3,h.heading,.5,.04,2.4);
 });root.add(markings);
 const bright={red:new THREE.Color(0xff3024),yellow:new THREE.Color(0xffbd25),green:new THREE.Color(0x53f49f)},dark=new THREE.Color(0x151b1d);
 return {root,count:active.length,canPass(s,time,distance){if(!s.signal)return true;const phase=signalPhase(time,s.signalAxis,s.signal.offset);return phase==='green'||(phase==='yellow'&&distance<6);},update(time){heads.forEach((h,i)=>{const phase=signalPhase(time,h.axis,h.j.offset);['red','yellow','green'].forEach((color,k)=>lamps.setColorAt(i*3+k,phase===color?bright[color]:dark));});if(lamps.instanceColor)lamps.instanceColor.needsUpdate=true;}};
}
