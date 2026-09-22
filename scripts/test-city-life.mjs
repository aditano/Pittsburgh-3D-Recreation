import {signalPhase,createSignals} from '../src/signals.js';
import {makeTerrain} from '../src/geo.js';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {makePath,samplePath,nearestSegment} from '../src/motion.js';
import {buildingIndex,chooseNext,createCityLife,createWalker,pedestrianShouldWait} from '../src/city-life.js';
import {createDayCycle} from '../src/day-cycle.js';
import {loadSettings,saveSettings} from '../src/quality.js';
import {roadwayLampHeading} from '../src/details.js';
import {createTransit} from '../src/transit.js';
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
handlers.keyup({code:'KeyW',target:{tagName:'BODY'},preventDefault(){}});
const beforeRight=controls.target.x;handlers.keydown({code:'KeyD',target:{tagName:'BODY'},preventDefault(){}});walker.update(.05);assert.ok(controls.target.x<beforeRight,'D moves camera-right when facing south');
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

assert.equal(pedestrianShouldWait({signal:{}}, 8, false), true);
assert.equal(pedestrianShouldWait({signal:{}}, 8, true), false);
assert.equal(pedestrianShouldWait({signal:{}}, 12, false), false);
assert.equal(pedestrianShouldWait({}, 2, false), false);
const grant={name:'Grant'}, side={name:'Side'};
const approach={name:'Grant', next:[grant, side], reverse:null};
const follower={s:approach, seed:1, hops:0};
for(let i=0;i<8;i++)assert.equal(chooseNext(follower), grant);
const unnamed={name:'', next:[grant, side], reverse:null};
const rover={s:unnamed, seed:0, hops:0};
const picks=new Set();
for(let i=0;i<6;i++)picks.add(chooseNext(rover));
assert.equal(picks.size, 2);
assert.equal(chooseNext({s:{name:'Alley', next:[], reverse:side}, seed:0, hops:0}), side);

const southArm=roadwayLampHeading(0, 1, 1);
assert.ok(Math.cos(southArm)>0.99&&Math.abs(Math.sin(southArm))<1e-6, 'a west-curb lamp points back east over the road');
const opposite=roadwayLampHeading(0, 1, -1);
assert.ok(Math.cos(opposite)<-0.99&&Math.abs(Math.sin(opposite))<1e-6, 'an east-curb lamp points back west over the road');

const blockedStreet={streets:[{r:5,c:[[20,20],[20,60]]}],buildings:[{f:[[10,15],[30,15],[30,70],[10,70],[10,15]]}]};
const blockedLife=createCityLife(blockedStreet,()=>0,water,new THREE.Scene(),true);
const blockedWalker=createWalker({camera,controls,canvas,scene:new THREE.Scene(),life:blockedLife,yFn:()=>0,waterIndex:water,buildings:blockedStreet.buildings,onExit(){}});
blockedWalker.enter(20,40);
assert.equal(blockedWalker.active,false,'walking does not start inside a building');
assert.equal(controls.enabled,true);

const hiddenLife=createCityLife(data,()=>0,water,new THREE.Scene(),true,null,(x,z)=>z>30&&z<50);
hiddenLife.update(.05,1,0);
assert.ok(hiddenLife.pedestrians.some(p=>!p.mesh.visible), 'shared collision hides people inside footprints');

const traffic=createCityLife({streets:[],buildings:[]},()=>0,water,new THREE.Scene(),true,{roads:[
  {highway:'primary',oneway:'yes',name:'Grant',c:[[0,0],[0,30],[0,60]]},
  {highway:'primary',oneway:'yes',name:'Side',c:[[0,30],[40,30]]},
],signals:[]});
const sideBefore=traffic.vehicles.filter(v=>v.s.name==='Side').length;
assert.ok(sideBefore>=1);
for(let i=0;i<400;i++)traffic.update(.05,i,0);
assert.equal(traffic.vehicles.filter(v=>v.s.name==='Side').length,sideBefore,'cars stay on the named street');

const crossing=createCityLife({streets:[],buildings:[]},()=>0,{inside:()=>false},new THREE.Scene(),true,{roads:[
  {highway:'primary',oneway:'yes',name:'North',c:[[0,-12],[0,0]]},
  {highway:'primary',oneway:'yes',name:'East',c:[[-20,0],[0,0]]},
  {highway:'primary',oneway:'yes',name:'South',c:[[0,0],[0,20]]},
],signals:[{id:0,p:[0,0]}]});
const north=crossing.segments.find(s=>s.name==='North');
assert.ok(north.signal);
assert.equal(crossing.signals.canPass(north,10,4),false);
assert.equal(crossing.signals.canPass(north,40,4),true);
const held=crossing.pedestrians.filter(p=>p.s===north&&(1-p.d)*p.s.length<9);
assert.ok(held.length>0);
const marks=held.map(p=>({p,d:p.d}));
crossing.update(.05,10,1);
for(const mark of marks)assert.equal(mark.p.d,mark.d,'pedestrians wait on red');
assert.ok(marks[0].p.mesh.children.every(child=>child.rotation.x===0),'a stopped pedestrian stands still');
for(let i=0;i<10;i++)crossing.update(.05,40,1);
assert.ok(marks.some(mark=>mark.p.d!==mark.d||mark.p.s!==north),'pedestrians cross on green');
assert.ok(crossing.pedestrians.some(p=>p.moving&&p.mesh.children.some(child=>Math.abs(child.rotation.x)>0.05)));

function control(){const listeners={};return {value:'17',checked:false,textContent:'',listeners,addEventListener(name,fn){listeners[name]=fn;},setAttribute(){}};}
const clock=control(),slider=control(),play=control(),weatherCycle=control();
globalThis.document={getElementById(id){return { 'city-clock':clock,'time-slider':slider,'cycle-play':play,'weather-cycle':weatherCycle}[id];},activeElement:null,querySelectorAll:()=>[],body:{classList:{add(){},remove(){}}}};
const dayScene=new THREE.Scene();
dayScene.background=new THREE.Color(0x8ec8f0);
dayScene.fog=new THREE.FogExp2(0x9dbcd8,0.00009);
const sun=new THREE.DirectionalLight(0xfff6e8,2.9);
const hemi=new THREE.HemisphereLight(0xcfe2f7,0x6a7052,0.4);
const fill=new THREE.DirectionalLight(0xbcd2ea,0.16);
const sunDir=new THREE.Vector3();
const sky={material:{uniforms:{uDay:{value:1},uZenith:{value:new THREE.Color()},uHorizon:{value:new THREE.Color()},uGlow:{value:new THREE.Color()},uCityGlow:{value:new THREE.Color()},uSunDir:{value:new THREE.Vector3()}}}};
const waterUniforms={uWaterDay:{value:1},uWaterZenith:{value:new THREE.Color()},uWaterHorizon:{value:new THREE.Color()},uFlow:{value:1},uPrecip:{value:0}};
const roadMat={roughness:.9};
const renderer={toneMappingExposure:1,setClearColor(){}};
let weather='sunny';
const cycle=createDayCycle({scene:dayScene,sky,sun,hemi,fill,renderer,waterUniforms,sunDir,materials:{families:{},roadMat}},()=>weather,(next)=>{weather=next;});
cycle.update(.016);
assert.ok(sunDir.x<0,'late-afternoon sun is in the west');
assert.ok(fill.position.x>0,'fill light stays opposite the sun');
const sunnyEnv=dayScene.environmentIntensity;
weather='rain';
cycle.update(.016);
assert.ok(dayScene.environmentIntensity<sunnyEnv*0.75,'rain keeps the darker environment');
assert.equal(roadMat.roughness,0.35);
assert.ok(sky.material.uniforms.uCityGlow.value.r<0.7,'rain does not force a sunny gold horizon');
weatherCycle.checked=true;
weather='snow';
cycle.update(.016);
cycle.update(2);
assert.equal(weather,'snow','choosing weather restarts the cycle timer');
cycle.update(91);
assert.equal(weather,'sunny');
document.activeElement=slider;
slider.value='8';
slider.listeners.input();
cycle.update(1);
assert.equal(slider.value,'8','dragging the clock is not overwritten');
document.activeElement=null;
cycle.update(.016);
assert.notEqual(String(slider.value),'8');
slider.listeners.pointerdown();
const frozen=slider.value;
cycle.update(1);
assert.equal(slider.value,frozen,'a touch drag is not overwritten');
slider.listeners.pointerup();
cycle.update(.016);
assert.notEqual(slider.value,frozen);

const brokenStorage={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}};
const previousStorage=globalThis.localStorage;
globalThis.localStorage=brokenStorage;
assert.equal(loadSettings(false).quality,'high');
assert.equal(loadSettings(true).resolution,50);
assert.doesNotThrow(()=>saveSettings({quality:'low',resolution:75,weather:'rain'}));
globalThis.localStorage=previousStorage;
console.log('Passed: signal crossings, named-street routing, lamp heading, weather lighting, and storage fallback.');

const stopsDetails={hidden:false};
const stopList={children:[],replaceChildren(){this.children=[];},append(node){this.children.push(node);},closest(){return stopsDetails;}};
let onRouteChange;
const routeSelect={value:'1',options:[],append(option){this.options.push(option);},addEventListener(name,fn){if(name==='change')onRouteChange=fn;}};
const transitInfo={textContent:''};
const focusRoute={disabled:false,addEventListener(){}};
globalThis.document={
  createElement(){return {textContent:'',addEventListener(){}};},
  getElementById(id){return { 'transit-route':routeSelect,'transit-info':transitInfo,'route-stops':stopList,'focus-route':focusRoute}[id];},
};
const transitScene=new THREE.Scene();
createTransit({
  routes:[{id:'1',name:'FREEPORT ROAD',type:'bus',color:'#3300cc',paths:[[[0,0],[120,0]]]}],
  stops:[{name:'Market',p:[0,0],routes:['1']}],
},transitScene,()=>0,()=>{});
assert.equal(routeSelect.value,'none');
assert.match(transitInfo.textContent,/off the map/);
assert.equal(focusRoute.disabled,true);
assert.equal(stopsDetails.hidden,true);
const routeGroups=transitScene.children[0].children;
assert.ok(routeGroups.length>0&&routeGroups.every(group=>group.visible===false));
routeSelect.value='1';
onRouteChange();
assert.equal(routeGroups[0].visible,true);
assert.equal(focusRoute.disabled,false);
assert.equal(stopsDetails.hidden,false);
assert.match(transitInfo.textContent,/FREEPORT ROAD/);
console.log('Passed: transit stays hidden until a route is chosen.');
