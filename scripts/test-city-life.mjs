import {signalPhase,createSignals} from '../src/signals.js';
import {makeTerrain} from '../src/geo.js';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {makePath,samplePath,nearestSegment} from '../src/motion.js';
import {buildingIndex,createCityLife,createWalker} from '../src/city-life.js';
const p=makePath([[0,0],[0,0],[0,10],[30,10]]);
assert.equal(p.length,40);assert.deepEqual(samplePath(p,25),{x:15,z:10,heading:Math.PI/2});
assert.equal(samplePath(p,999).x,30);assert.equal(samplePath(p,-10).z,0);
assert.equal(nearestSegment(5,2,[{a:[0,0],b:[10,0]}]).distance,2);
const buildings=[{f:[[0,0],[10,0],[10,10],[0,10],[0,0]]}];const collision=buildingIndex(buildings);
assert.equal(collision(5,5),true);assert.equal(collision(-1,5),false);
// Exercise the actual scene controllers without a GPU or browser dependency.
const handlers={};globalThis.window={addEventListener:(n,f)=>{handlers[n]=f;}};
globalThis.document={querySelectorAll:()=>[],body:{classList:{add(){},remove(){}}}};
const scene=new THREE.Scene(),water={inside:()=>false};
const data={streets:[{r:3,c:[[20,20],[20,60],[60,60]]}],buildings};
const life=createCityLife(data,()=>0,water,scene,true);
for(let i=0;i<600;i++)life.update(.05,i*.05,1);
scene.traverse(o=>{assert.ok(o.position.toArray().every(Number.isFinite));if(o.isInstancedMesh)assert.ok([...o.instanceMatrix.array].every(Number.isFinite));});
const camera=new THREE.PerspectiveCamera(45,1,2,25000);camera.position.set(100,100,100);
const controls={enabled:true,target:new THREE.Vector3()},canvas={addEventListener(){}};
const walker=createWalker({camera,controls,canvas,scene,life,yFn:()=>0,waterIndex:water,buildings,onExit(){}});
walker.enter(20,40);assert.equal(walker.active,true);assert.equal(controls.enabled,false);assert.equal(camera.near,.15);
handlers.keydown({code:'KeyW',target:{tagName:'BODY'},preventDefault(){}});walker.update(.05);assert.ok(camera.position.toArray().every(Number.isFinite));
walker.exit();assert.equal(controls.enabled,true);assert.equal(camera.near,2);assert.deepEqual(camera.position.toArray(),[100,100,100]);
const transit=JSON.parse(readFileSync(new URL('../public/data/transit.json',import.meta.url)));
for(const id of ['RED','BLUE','SLVR'])assert.ok(transit.routes.some(r=>r.id===id&&r.type==='rail'));
for(const r of transit.routes)for(const p of r.paths){assert.ok(p.length>=2);for(const [x,z]of p){assert.ok(Number.isFinite(x)&&Number.isFinite(z));assert.ok(x>-4600&&x<8600&&z>-4000&&z<4600);}}
const ids=new Set(transit.routes.map(r=>r.id));for(const s of transit.stops)assert.ok(s.routes.every(r=>ids.has(r)));
console.log(`Passed: path interpolation, collision grid, 30 seconds of traffic, walking lifecycle, ${transit.routes.length} routes and ${transit.stops.length} stops.`);

for(let t=0;t<140;t+=.1){assert.ok(!(signalPhase(t,0)==='green'&&signalPhase(t,1)==='green'));}
assert.equal(signalPhase(29,0),'yellow');assert.equal(signalPhase(33,0),'red');assert.equal(signalPhase(36,1),'green');
const legs=[{a:[-50,0],b:[0,0],length:50},{a:[0,-50],b:[0,0],length:50}];
const controller=createSignals([{id:0,p:[0,0]}],legs,()=>0,new THREE.Scene());
assert.equal(controller.canPass(legs[0],5,20),true);assert.equal(controller.canPass(legs[1],5,20),false);
assert.equal(controller.canPass(legs[0],33,20),false);controller.update(40);
const core=JSON.parse(readFileSync(new URL('../public/data/pittsburgh.json',import.meta.url)));
assert.equal(core.terrain.step,10);const terrain=makeTerrain(core.terrain);
assert.ok(terrain(-576,1024)>100&&terrain(-576,1024)<140);
assert.ok(terrain(4133,-369)>45&&terrain(4133,-369)<85);
assert.ok(terrain(200,0)>0&&terrain(200,0)<25);
console.log('Passed: opposing signal phases, yellow/all-red clearance, approach control, ten-meter terrain and landmark relief.');
