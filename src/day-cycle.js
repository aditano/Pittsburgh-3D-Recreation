import * as THREE from 'three';
import {applyWeatherLook} from './weather.js';
export function createDayCycle(ctx,getWeather,setWeather){
 const lamps=[];ctx.scene.traverse(o=>{if(o.material?.userData?.cityLamp)lamps.push(o.material);});
 const facades=Object.values(ctx.materials.families).map(f=>({mat:f.mat,base:f.mat.emissiveIntensity}));
 let hour=17,elapsed=0,lastWeather=0;const clock=document.getElementById('city-clock'),slider=document.getElementById('time-slider'),play=document.getElementById('cycle-play'),weatherCycle=document.getElementById('weather-cycle');
 let running=true;
 play.addEventListener('click',()=>{running=!running;play.textContent=running?'Pause day':'Resume day';play.setAttribute('aria-pressed',String(running));});
 slider.addEventListener('input',()=>{hour=Number(slider.value);});
 const nightColor=new THREE.Color(0x070e23),nightHorizon=new THREE.Color(0x222a45),warm=new THREE.Color(0xf4a56e);
 return {update(dt){
  elapsed+=dt;if(running)hour=(hour+dt/30)%24;
  if(weatherCycle.checked&&elapsed-lastWeather>90){lastWeather=elapsed;const next={sunny:'rain',rain:'snow',snow:'sunny'};setWeather(next[getWeather()]);}
  const angle=(hour-6)/24*Math.PI*2,elevation=Math.sin(angle),day=THREE.MathUtils.smoothstep(elevation,-.12,.3),night=1-day;
  applyWeatherLook(getWeather(),ctx);
  const sunset=Math.max(0,1-Math.abs(elevation)/.32)*day;
  const u=ctx.sky.material.uniforms;u.uDay.value=day;u.uZenith.value.lerp(nightColor,night);u.uHorizon.value.lerp(warm,sunset*.7).lerp(nightHorizon,night);u.uGlow.value.lerp(warm,sunset);u.uCityGlow.value.setHex(0xf4b561);
  ctx.waterUniforms.uWaterDay.value=day;
  ctx.waterUniforms.uWaterZenith.value.copy(u.uZenith.value);
  ctx.waterUniforms.uWaterHorizon.value.copy(u.uHorizon.value);
  ctx.sunDir.set(Math.cos(angle),Math.max(.05,elevation),.35).normalize();u.uSunDir.value.copy(ctx.sunDir);
  ctx.sun.intensity*=day;ctx.sun.color.lerp(warm,sunset);ctx.hemi.intensity=.14+ctx.hemi.intensity*day;ctx.fill.intensity=.08+.12*day;
  ctx.scene.environmentIntensity=.045+.375*day;ctx.scene.fog.color.lerp(nightHorizon,night);ctx.scene.background.copy(ctx.scene.fog.color);ctx.renderer.setClearColor(ctx.scene.background,1);
  const h=Math.floor(hour),m=Math.floor((hour-h)*60);clock.textContent=`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;slider.value=hour;
  for(const mat of lamps){mat.emissive.setHex(0xffc878);mat.emissiveIntensity=night*3;}
  for(const {mat,base} of facades)mat.emissiveIntensity=base+night*.85;
  ctx.materials.roadMat.roughness=getWeather()==='rain'?.35:.9;
  return night;
 }};
}
