import * as THREE from 'three';
import {makePath,samplePath} from './motion.js';
import {vehicle} from './city-life.js';
export function createTransit(data,scene,yFn,onFocus){
 const root=new THREE.Group();scene.add(root);const records=[];
 const select=document.getElementById('transit-route'),info=document.getElementById('transit-info');
 for(const route of data.routes){
  const option=document.createElement('option');option.value=route.id;option.textContent=`${route.id} · ${route.name}`;select.append(option);
  const group=new THREE.Group();root.add(group);const points=[];
  for(const path of route.paths)for(let i=1;i<path.length;i++){
   const a=path[i-1],b=path[i];points.push(a[0],Math.max(2,yFn(...a))+3,a[1],b[0],Math.max(2,yFn(...b))+3,b[1]);
  }
  const geom=new THREE.BufferGeometry();geom.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
  const mat=new THREE.LineBasicMaterial({color:route.color,transparent:true,opacity:.8,depthTest:false});
  const line=new THREE.LineSegments(geom,mat);line.renderOrder=5;group.add(line);
  const paths=route.paths.map(makePath).filter(p=>p.length>50).sort((a,b)=>b.length-a.length);
  const models=[];
  if(paths.length){const path=paths[0];for(let i=0;i<(route.type==='rail'?2:1);i++){const mesh=vehicle(route.color,route.type==='rail');group.add(mesh);models.push({mesh,path,d:path.length*(.25+i*.45)});}}
  const stops=data.stops.filter(s=>s.routes.includes(route.id));
  const markers=new THREE.InstancedMesh(new THREE.CylinderGeometry(2,2,.8,8),new THREE.MeshBasicMaterial({color:route.color,depthTest:false}),stops.length);
  const dummy=new THREE.Object3D();stops.forEach((s,i)=>{dummy.position.set(s.p[0],Math.max(2,yFn(...s.p))+3,s.p[1]);dummy.updateMatrix();markers.setMatrixAt(i,dummy.matrix);});markers.renderOrder=6;group.add(markers);
  records.push({route,group,mat,models,markers,stops,paths});
 }
 function filter(){const value=select.value;let count=0;
  for(const r of records){const chosen=value===r.route.id;r.group.visible=value==='all'||chosen||(value==='rail'&&r.route.type==='rail')||(value==='bus'&&r.route.type==='bus');r.markers.visible=chosen;r.mat.opacity=chosen?1:.55;if(r.group.visible)count++;}
  const r=records.find(r=>r.route.id===value);
  info.textContent=r?`${r.route.name} · ${r.stops.length} stops in model`:`${count} routes in model · animated simulation`;
  document.getElementById('route-stops').replaceChildren();
  if(r){for(const stop of r.stops){const b=document.createElement('button');b.textContent=stop.name;b.addEventListener('click',()=>onFocus(stop.p));document.getElementById('route-stops').append(b);}}
 }
 select.addEventListener('change',filter);filter();
 document.getElementById('focus-route').addEventListener('click',()=>{const r=records.find(r=>r.route.id===select.value);if(r?.paths[0]){const p=samplePath(r.paths[0],r.paths[0].length*.5);onFocus([p.x,p.z]);}});
 return {root,update(dt){for(const r of records){if(!r.group.visible)continue;for(const a of r.models){a.d=(a.d+dt*(r.route.type==='rail'?13:7))%a.path.length;const p=samplePath(a.path,a.d);a.mesh.position.set(p.x,Math.max(2,yFn(p.x,p.z))+1.2,p.z);a.mesh.rotation.y=p.heading;}}}};
}
