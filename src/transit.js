import * as THREE from 'three';
import {makePath,samplePath} from './motion.js';
import {vehicle} from './city-life.js';

/** Parse a GTFS YYYYMMDD date into a UTC day. */
export function gtfsDay(value){
 if(!value||!/^\d{8}$/.test(String(value)))return null;
 const raw=String(value);
 return Date.UTC(Number(raw.slice(0,4)),Number(raw.slice(4,6))-1,Number(raw.slice(6,8)));
}

/** Report whether the bundled feed is still within feed_info's published window. */
export function feedStatus(data,now=Date.now()){
 const end=gtfsDay(data?.feed?.[0]?.feed_end_date);
 const start=gtfsDay(data?.feed?.[0]?.feed_start_date);
 if(end==null)return {ok:true,note:null};
 const day=Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),new Date(now).getUTCDate());
 if(start!=null&&day<start)return {ok:false,note:`Transit shapes are from a feed that starts ${data.feed[0].feed_start_date}; geometry may not match service yet.`};
 if(day>end)return {ok:false,note:`Transit shapes are from a feed that ended ${data.feed[0].feed_end_date}; routes stay visible but may be stale.`};
 return {ok:true,note:null};
}

export function createTransit(data,scene,yFn,onFocus){
 const root=new THREE.Group();scene.add(root);const records=[];
 const select=document.getElementById('transit-route'),info=document.getElementById('transit-info');
 const status=feedStatus(data);
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
 const focus=document.getElementById('focus-route');
 const stopList=document.getElementById('route-stops');
 function filter(){const value=select.value;let count=0;
  for(const r of records){const chosen=value===r.route.id;r.group.visible=value==='all'||chosen||(value==='rail'&&r.route.type==='rail')||(value==='bus'&&r.route.type==='bus');r.markers.visible=chosen;r.mat.opacity=chosen?1:.55;if(r.group.visible)count++;}
  const r=records.find(r=>r.route.id===value);
  let message=r?`${r.route.name} · ${r.stops.length} stops in model`:value==='none'?'Routes stay off the map until you pick one.':`${count} routes in model · animated simulation`;
  if(status.note)message=`${message} · ${status.note}`;
  info.textContent=message;
  stopList.replaceChildren();
  stopList.closest('details').hidden=!r;
  focus.disabled=!r;
  if(r){for(const stop of r.stops){const b=document.createElement('button');b.textContent=stop.name;b.addEventListener('click',()=>onFocus(stop.p));stopList.append(b);}}
 }
 select.addEventListener('change',filter);
 // A restored form value can land on one bus. The city should come up clear.
 select.value='none';
 filter();
 document.getElementById('focus-route').addEventListener('click',()=>{const r=records.find(r=>r.route.id===select.value);if(r?.paths[0]){const p=samplePath(r.paths[0],r.paths[0].length*.5);onFocus([p.x,p.z]);}});
 return {root,feedStatus:status,update(dt){for(const r of records){if(!r.group.visible)continue;for(const a of r.models){a.d=(a.d+dt*(r.route.type==='rail'?13:7))%a.path.length;const p=samplePath(a.path,a.d);a.mesh.position.set(p.x,Math.max(2,yFn(p.x,p.z))+1.2,p.z);a.mesh.rotation.y=p.heading;}}}};
}
