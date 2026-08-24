import * as THREE from 'three';
import { buildPncPark, buildAcrisureStadium, buildPpgArena } from '../src/stadiums.js';

const W = 640;
const H = 480;
const params = new URLSearchParams(location.search);
const which = params.get('v') || 'pnc';
const view = params.get('view') || 'aerial';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(W, H);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fa8bc);

const hemi = new THREE.HemisphereLight(0xbcd4e8, 0x40483c, 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
sun.position.set(180, 260, 140);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const c = sun.shadow.camera;
c.left = -200; c.right = 200; c.top = 200; c.bottom = -200; c.far = 900;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1400, 1400),
  new THREE.MeshStandardMaterial({ color: 0x4c5148, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const builders = {
  pnc: () => buildPncPark({ h: 38, f: null, orientYaw: 0.39 }),
  acr: () => buildAcrisureStadium({ h: 54, f: null, orientYaw: Math.PI / 2 }),
  ppg: () => buildPpgArena({ h: 40, f: null, orientYaw: Math.PI }),
};
const group = builders[which]();
scene.add(group);

const camera = new THREE.PerspectiveCamera(38, W / H, 1, 3000);
if (view === 'aerial') camera.position.set(230, 260, 300);
else if (view === 'top') camera.position.set(0.1, 460, 0);
else camera.position.set(0, 42, 330);
camera.lookAt(0, 18, 0);

renderer.render(scene, camera);
document.title = 'ready';
