import * as THREE from 'three';
import {Reflector} from 'three/addons/objects/Reflector.js';
/** One mirrored scene capture shared by all river polygons, refreshed at 12 Hz. */
export function createRiverReflections(renderer,scene,camera,uniforms,waterMaterial,excluded){
 const mirror=new Reflector(new THREE.PlaneGeometry(1,1),{textureWidth:768,textureHeight:768,clipBias:.003,multisample:0});
 mirror.rotation.x=-Math.PI/2;mirror.position.y=.3;mirror.updateMatrixWorld();
 const inverse=mirror.matrixWorld.clone().invert();
 uniforms.uReflection.value=mirror.getRenderTarget().texture;
 let elapsed=0;const hidden=[];
 scene.traverse(o=>{if(o.material===waterMaterial)hidden.push(o);});
 return {update(dt,enabled){uniforms.uReflectionMix.value=enabled?1:0;if(!enabled)return;
  elapsed+=dt;if(elapsed<1/12)return;elapsed=0;
  const objects=[...hidden,...excluded.filter(Boolean)],visibility=objects.map(o=>o.visible);
  objects.forEach(o=>o.visible=false);
  const tone=renderer.toneMapping;renderer.toneMapping=THREE.NoToneMapping;
  camera.updateMatrixWorld();
  try{mirror.onBeforeRender(renderer,scene,camera);uniforms.uReflectionMatrix.value.copy(mirror.material.uniforms.textureMatrix.value).multiply(inverse);}
  finally{renderer.toneMapping=tone;objects.forEach((o,i)=>o.visible=visibility[i]);}
 },dispose(){mirror.dispose();mirror.geometry.dispose();}};
}
