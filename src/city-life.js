import {createSignals} from './signals.js';
import * as THREE from 'three';
import {makePath,samplePath,nearestSegment} from './motion.js';
import {pointInPoly} from './geo.js';

const box=new THREE.BoxGeometry(1,1,1);
export function person(color=0xe4b63f){
  const root=new THREE.Group();
  const material=new THREE.MeshStandardMaterial({color,roughness:.85});
  const skin=new THREE.MeshStandardMaterial({color:0xc78e69});
  const dark=new THREE.MeshStandardMaterial({color:0x243044});
  function part(mat,x,y,z,w,h,d){const m=new THREE.Mesh(box,mat);m.position.set(x,y,z);m.scale.set(w,h,d);root.add(m);return m;}
  part(material,0,1.12,0,.48,.65,.28);part(skin,0,1.66,0,.3,.32,.3);
  const legs=[part(dark,-.14,.39,0,.19,.76,.22),part(dark,.14,.39,0,.19,.76,.22)];
  const arms=[part(material,-.34,1.07,0,.16,.62,.19),part(material,.34,1.07,0,.16,.62,.19)];
  root.userData.gait=(t,moving)=>{legs.forEach((m,i)=>m.rotation.x=moving?Math.sin(t+i*Math.PI)*.55:0);arms.forEach((m,i)=>m.rotation.x=moving?-Math.sin(t+i*Math.PI)*.5:0);};
  return root;
}
export function vehicle(color=0xe4b63f,rail=false){
  const root=new THREE.Group();
  function part(c,x,y,z,w,h,d){const m=new THREE.Mesh(box,new THREE.MeshStandardMaterial({color:c,roughness:.45,metalness:.2}));m.position.set(x,y,z);m.scale.set(w,h,d);root.add(m);return m;}
  const length=rail?24:11.5;
  part(color,0,1.6,0,2.6,2.8,length);part(0x163247,0,2.15,0,2.66,1.15,length-.8);
  part(color,0,2.9,0,2.65,.3,length);part(0x22252b,0,.5,0,2.7,.8,length-2);
  part(0xffefbd,0,1.5,length/2+.03,2,.25,.1);return root;
}
export function createCityLife(data,yFn,waterIndex,scene,constrained,streetData=null){
  const collision=buildingIndex(data.buildings);
  const segments=[];
  for(const s of streetData?.roads?.length ? streetData.roads.filter(r=>!r.bridge&&!r.tunnel).map(r=>({...r,r:({primary:5,secondary:4,tertiary:3}[r.highway]||3)})) : data.streets||[]){if(s.r<3)continue;for(let i=1;i<s.c.length;i++){
    const a=s.c[i-1],b=s.c[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    if(length<8||waterIndex.inside(...a)||waterIndex.inside(...b)||waterIndex.inside((a[0]+b[0])/2,(a[1]+b[1])/2))continue;
    if(s.oneway!=='-1')segments.push({a,b,rank:s.r,length,path:makePath([a,b]),name:s.name||''});
    if(s.oneway!=='yes'&&s.oneway!=='1')segments.push({a:b,b:a,rank:s.r,length,path:makePath([b,a]),name:s.name||''});
  }}
  const junctions=new Map();
  const nodeKey=p=>`${Math.round(p[0])},${Math.round(p[1])}`;
  for(const s of segments){const key=nodeKey(s.a);if(!junctions.has(key))junctions.set(key,[]);junctions.get(key).push(s);}
  for(const s of segments){const outgoing=junctions.get(nodeKey(s.b))||[];s.next=outgoing.filter(n=>nodeKey(n.b)!==nodeKey(s.a));s.reverse=outgoing.find(n=>nodeKey(n.b)===nodeKey(s.a));}
  const signals=createSignals(streetData?.signals,segments,yFn,scene);
  const root=new THREE.Group();scene.add(root);
  const count=Math.min(constrained?160:540,segments.length),dummy=new THREE.Object3D();
  const cars=new THREE.InstancedMesh(box,new THREE.MeshStandardMaterial({roughness:.4,metalness:.3}),count);
  const roofs=new THREE.InstancedMesh(box,new THREE.MeshStandardMaterial({color:0x183348,roughness:.25}),count);
  const lamps=new THREE.InstancedMesh(box,new THREE.MeshBasicMaterial({color:0xffe2a3}),count*2);
  [cars,roofs,lamps].forEach(m=>{m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);m.frustumCulled=false;root.add(m);});
  const palette=[0xe6e9ec,0x2f4d6b,0x991f2c,0xc9ac6a,0x252a30,0x597771];
  const agents=Array.from({length:count},(_,i)=>{cars.setColorAt(i,new THREE.Color(palette[i%palette.length]));return {s:segments[(i*47)%segments.length],d:(i*.618%1),speed:6+i%7,velocity:0};});
  const people=[];for(let i=0;i<(constrained?35:100);i++){
    const s=segments[(i*31)%segments.length];if(!s)break;
    const mesh=person(palette[i%palette.length]);root.add(mesh);people.push({mesh,s,d:(i*.713%1),speed:.9+i%4*.15});
  }
  const matrix=(mesh,i,x,y,z,heading,w,h,d)=>{dummy.position.set(x,y,z);dummy.rotation.set(0,heading,0);dummy.scale.set(w,h,d);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);};
  function advance(a,dt,time=null,gap=Infinity){
    let distance=a.speed*dt;
    if(time!==null){const toLine=(1-a.d)*a.s.length-8;
      const stop=toLine>=0&&!signals.canPass(a.s,time,toLine);
      const available=Math.max(0,Math.min(gap-6,stop?toLine:Infinity));
      const desired=Math.min(a.speed,Math.sqrt(2*3.5*available));
      a.velocity=THREE.MathUtils.damp(a.velocity,desired,3,dt);distance=Math.min(available,a.velocity*dt);
    }
    a.d+=distance/a.s.length;if(a.d>1){
    const choices=a.s.next;
    const next=choices.length?choices[Math.floor(a.d*7919)%choices.length]:a.s.reverse;
    if(next){a.s=next;a.d=0;}else{a.d=1;a.velocity=0;}
  }return samplePath(a.s.path,a.d*a.s.length);}
  return {segments,root,signals,nearest:(x,z)=>nearestSegment(x,z,segments),update(dt,time,night){
    signals.update(time);
    const queues=new Map();for(const a of agents){if(!queues.has(a.s))queues.set(a.s,[]);queues.get(a.s).push(a);}
    for(const q of queues.values()){q.sort((a,b)=>b.d-a.d);q.forEach((a,i)=>a.gap=i?(q[i-1].d-a.d)*a.s.length:Infinity);}
    agents.forEach((a,i)=>{const p=advance(a,dt,time,a.gap),x=p.x+Math.cos(p.heading)*1.7,z=p.z-Math.sin(p.heading)*1.7,y=yFn(x,z)+1.15;
      matrix(cars,i,x,y+.65,z,p.heading,1.85,1.05,4.3);matrix(roofs,i,x-Math.sin(p.heading)*.25,y+1.3,z-Math.cos(p.heading)*.25,p.heading,1.65,.65,2.25);
      for(let k=0;k<2;k++)matrix(lamps,i*2+k,x+Math.sin(p.heading)*2.16+Math.cos(p.heading)*(k?-.6:.6),y+.8,z+Math.cos(p.heading)*2.16-Math.sin(p.heading)*(k?-.6:.6),p.heading,.35,.2,.12);
    });
    for(const m of [cars,roofs,lamps])m.instanceMatrix.needsUpdate=true;lamps.visible=night>.2;
    for(const a of people){const wait=(1-a.d)*a.s.length<9&&a.s.signal&&signals.canPass(a.s,time,20);const p=advance(a,wait?0:dt),side=({3:4.7,4:6.2,5:8}[a.s.rank]||5.2),x=p.x+Math.cos(p.heading)*side,z=p.z-Math.sin(p.heading)*side;
      a.mesh.visible=!waterIndex.inside(x,z)&&!collision(x,z);a.mesh.position.set(x,yFn(x,z)+1.25,z);a.mesh.rotation.y=p.heading;a.mesh.userData.gait(time*5,true);
    }
  }};
}
export function createWalker({camera,controls,canvas,scene,life,yFn,waterIndex,buildings,onExit}){
  const avatar=person();scene.add(avatar);avatar.visible=false;
  const keys=new Set(),position=new THREE.Vector3(),saved={};let active=false,yaw=0,pitch=.28,gait=0;
  const collision=buildingIndex(buildings);
  const blocked=(x,z)=>waterIndex.inside(x,z)||collision(x,z);
  function key(e,down){if(!active||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight','Escape'].includes(e.code)){e.preventDefault();down?keys.add(e.code):keys.delete(e.code);if(down&&e.code==='Escape')onExit();}}
  window.addEventListener('keydown',e=>key(e,true));window.addEventListener('keyup',e=>key(e,false));window.addEventListener('blur',()=>keys.clear());
  canvas.addEventListener('pointerdown',e=>{if(active)canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(active&&e.buttons){yaw-=e.movementX*.005;pitch=THREE.MathUtils.clamp(pitch+e.movementY*.003,.08,.75);}});
  document.querySelectorAll('[data-walk-key]').forEach(b=>{b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);keys.add(b.dataset.walkKey);});for(const event of ['pointerup','pointercancel','lostpointercapture'])b.addEventListener(event,()=>keys.delete(b.dataset.walkKey));});
  const api={get active(){return active;},enter(x,z){const s=life.nearest(x,z);if(!s)return;
    if(!active){saved.position=camera.position.clone();saved.target=controls.target.clone();}
    let sx=s.x,sz=s.z;
    const length=s.length||1,nx=(s.b[1]-s.a[1])/length,nz=-(s.b[0]-s.a[0])/length;
    for(const offset of [5,-5,2,-2,0]){const px=s.x+nx*offset,pz=s.z+nz*offset;if(!blocked(px,pz)){sx=px;sz=pz;break;}}
    position.set(sx,yFn(sx,sz)+1.25,sz);yaw=Math.atan2(s.b[0]-s.a[0],s.b[1]-s.a[1]);
    camera.position.set(sx-Math.sin(yaw)*7,position.y+4,sz-Math.cos(yaw)*7);active=true;avatar.visible=true;controls.enabled=false;camera.near=.15;camera.updateProjectionMatrix();keys.clear();
    document.body.classList.add('walking');
  },exit(){if(!active)return;active=false;avatar.visible=false;keys.clear();controls.enabled=true;camera.near=2;camera.updateProjectionMatrix();camera.position.copy(saved.position);controls.target.copy(saved.target);document.body.classList.remove('walking');},update(dt){if(!active)return;
    let f=Number(keys.has('KeyW')||keys.has('ArrowUp'))-Number(keys.has('KeyS')||keys.has('ArrowDown'));
    let r=Number(keys.has('KeyD')||keys.has('ArrowRight'))-Number(keys.has('KeyA')||keys.has('ArrowLeft'));
    const norm=Math.hypot(f,r)||1,speed=(keys.has('ShiftLeft')||keys.has('ShiftRight')?5.5:2.4)*dt;
    const dx=(Math.sin(yaw)*f+Math.cos(yaw)*r)/norm*speed,dz=(Math.cos(yaw)*f-Math.sin(yaw)*r)/norm*speed;
    const valid=(x,z)=>!blocked(x,z)&&Math.abs(yFn(x,z)+1.25-position.y)<1.5&&x>-4500&&x<8500&&z>-3900&&z<4500;
    if(valid(position.x+dx,position.z))position.x+=dx;if(valid(position.x,position.z+dz))position.z+=dz;
    position.y=yFn(position.x,position.z)+1.25;avatar.position.copy(position);if(f||r)avatar.rotation.y=Math.atan2(dx,dz);gait+=dt*(speed/dt||0)*2.7;avatar.userData.gait(gait,!!(f||r));
    const target=position.clone().add(new THREE.Vector3(0,1.35,0));let distance=7;
    for(let d=1;d<7;d+=.35){if(blocked(position.x-Math.sin(yaw)*d,position.z-Math.cos(yaw)*d)){distance=Math.max(.7,d-.4);break;}}
    const desired=new THREE.Vector3(position.x-Math.sin(yaw)*distance,position.y+2+pitch*distance,position.z-Math.cos(yaw)*distance);
    desired.y=Math.max(desired.y,yFn(desired.x,desired.z)+1);camera.position.lerp(desired,1-Math.exp(-dt*12));camera.lookAt(target);controls.target.copy(target);
  }};return api;
}

/** Uniform grid keeps street-level collision queries local, even with 80k buildings. */
export function buildingIndex(buildings){
 const grid=new Map(),size=80,key=(x,z)=>`${x},${z}`;
 for(const b of buildings){if(!b.f?.length)continue;const xs=b.f.map(p=>p[0]),zs=b.f.map(p=>p[1]);
  const bounds={f:b.f,minX:Math.min(...xs),maxX:Math.max(...xs),minZ:Math.min(...zs),maxZ:Math.max(...zs)};
  for(let x=Math.floor(bounds.minX/size);x<=Math.floor(bounds.maxX/size);x++)for(let z=Math.floor(bounds.minZ/size);z<=Math.floor(bounds.maxZ/size);z++){const k=key(x,z);if(!grid.has(k))grid.set(k,[]);grid.get(k).push(bounds);}
 }
 return (x,z)=>(grid.get(key(Math.floor(x/size),Math.floor(z/size)))||[]).some(b=>x>=b.minX&&x<=b.maxX&&z>=b.minZ&&z<=b.maxZ&&pointInPoly(x,z,b.f));
}
