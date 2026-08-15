import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const canvas = document.getElementById('c');
const layersEl = document.getElementById('layers');
const loaderEl = document.getElementById('loader');
const navEl = document.getElementById('nav');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070c);
scene.fog = new THREE.FogExp2(0x05070c, 0.00028);

const camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
camera.position.set(900, 650, 1100);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.inset = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.getElementById('app').appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 80;
controls.maxDistance = 6000;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(0, 40, 0);

const hemi = new THREE.HemisphereLight(0xb8c4d8, 0x1a1e28, 0.55);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 1.35);
sun.position.set(600, 900, 200);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 100;
sun.shadow.camera.far = 4000;
sun.shadow.camera.left = -1500;
sun.shadow.camera.right = 1500;
sun.shadow.camera.top = 1500;
sun.shadow.camera.bottom = -1500;
sun.shadow.bias = -0.0002;
scene.add(sun);

const fill = new THREE.DirectionalLight(0x6a7a9a, 0.35);
fill.position.set(-400, 300, -600);
scene.add(fill);

const groundMat = new THREE.MeshStandardMaterial({
  color: 0x0b1220,
  roughness: 0.92,
  metalness: 0.05,
});

const buildingMat = new THREE.MeshStandardMaterial({
  color: 0xe8ecf2,
  roughness: 0.72,
  metalness: 0.08,
});

const landmarkMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.55,
  metalness: 0.12,
  emissive: 0x22262e,
  emissiveIntensity: 0.15,
});

const parkMat = new THREE.MeshStandardMaterial({
  color: 0x132018,
  roughness: 1,
  metalness: 0,
});

const waterMat = new THREE.MeshStandardMaterial({
  color: 0x071018,
  roughness: 0.28,
  metalness: 0.35,
  transparent: true,
  opacity: 0.95,
});

const roadMats = {
  0: new THREE.LineBasicMaterial({ color: 0x3a4254 }),
  1: new THREE.LineBasicMaterial({ color: 0x6a7388 }),
  2: new THREE.LineBasicMaterial({ color: 0x9aa3b5 }),
  3: new THREE.LineBasicMaterial({ color: 0xc8cfdb }),
  4: new THREE.LineBasicMaterial({ color: 0xe8ecf2 }),
  5: new THREE.LineBasicMaterial({ color: 0xffffff }),
};

/** Soft spotlight disc on the ground that follows the focus */
const focusLight = new THREE.SpotLight(0xffffff, 28, 2200, Math.PI / 5, 0.72, 1.15);
focusLight.position.set(0, 700, 0);
focusLight.target.position.set(0, 0, 0);
focusLight.castShadow = false;
scene.add(focusLight);
scene.add(focusLight.target);

const focusGlow = new THREE.Mesh(
  new THREE.CircleGeometry(420, 64),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.045,
    depthWrite: false,
  }),
);
focusGlow.rotation.x = -Math.PI / 2;
focusGlow.position.y = 0.6;
scene.add(focusGlow);

function terrainHeight(x, z, peaks) {
  let h = 0;
  for (const peak of peaks) {
    const dx = x - peak.p[0];
    const dz = z - peak.p[1];
    const d = Math.hypot(dx, dz);
    if (d < peak.r) {
      const t = 1 - d / peak.r;
      h += peak.h * t * t;
    }
  }
  // flatten downtown / river confluence
  const flat = Math.hypot(x, z);
  if (flat < 900) {
    const k = Math.min(1, (900 - flat) / 900);
    h *= 1 - k * 0.92;
  }
  return h;
}

function shapeFromFootprint(footprint, yFn) {
  const shape = new THREE.Shape();
  const first = footprint[0];
  const y0 = yFn ? yFn(first[0], first[1]) : 0;
  // project footprint onto local XZ; Shape uses x,y -> we map to x,z
  shape.moveTo(first[0], first[1]);
  for (let i = 1; i < footprint.length - 1; i++) {
    shape.lineTo(footprint[i][0], footprint[i][1]);
  }
  shape.closePath();
  return { shape, baseY: y0 };
}

function extrudeBuilding(footprint, height, yFn) {
  const { shape, baseY } = shapeFromFootprint(footprint, yFn);
  // sample base height from centroid so building sits on terrain
  let cx = 0;
  let cz = 0;
  const n = footprint.length - 1;
  for (let i = 0; i < n; i++) {
    cx += footprint[i][0];
    cz += footprint[i][1];
  }
  cx /= n;
  cz /= n;
  const base = yFn ? yFn(cx, cz) : baseY;

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
  });
  // ExtrudeGeometry extrudes in +Z of shape space; rotate to Y-up
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, base, 0);
  return geom;
}

function flatPolygon(footprint, y, yFn) {
  const shape = new THREE.Shape();
  shape.moveTo(footprint[0][0], footprint[0][1]);
  for (let i = 1; i < footprint.length - 1; i++) {
    shape.lineTo(footprint[i][0], footprint[i][1]);
  }
  shape.closePath();
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  // lift to average terrain / fixed y
  let lift = y;
  if (yFn) {
    let cx = 0;
    let cz = 0;
    const n = footprint.length - 1;
    for (let i = 0; i < n; i++) {
      cx += footprint[i][0];
      cz += footprint[i][1];
    }
    lift = yFn(cx / n, cz / n) + y;
  }
  geom.translate(0, lift, 0);
  return geom;
}

function makeGround(peaks) {
  const size = 7000;
  const segs = 140;
  const geom = new THREE.PlaneGeometry(size, size, segs, segs);
  geom.rotateX(-Math.PI / 2);
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z, peaks));
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, groundMat);
  mesh.receiveShadow = true;
  return mesh;
}

function makeGrid() {
  const helper = new THREE.GridHelper(5000, 100, 0x1c2436, 0x121826);
  helper.position.y = 0.4;
  helper.material.transparent = true;
  helper.material.opacity = 0.35;
  return helper;
}

function addLabel(text, position) {
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = text;
  el.style.cssText = `
    color: rgba(242,244,248,0.85);
    font-family: "DM Sans", system-ui, sans-serif;
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    white-space: nowrap;
    text-shadow: 0 0 12px rgba(0,0,0,0.85);
    user-select: none;
  `;
  const obj = new CSS2DObject(el);
  obj.position.copy(position);
  scene.add(obj);

  // stem line
  const stem = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(position.x, 0, position.z),
    position.clone(),
  ]);
  const line = new THREE.Line(
    stem,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }),
  );
  scene.add(line);
  return obj;
}

function buildBridges(bridges, yFn) {
  const group = new THREE.Group();
  for (const b of bridges) {
    const [a, c] = b.pts;
    const y1 = (yFn ? yFn(a[0], a[1]) : 0) + 18;
    const y2 = (yFn ? yFn(c[0], c[1]) : 0) + 18;
    const mid = new THREE.Vector3((a[0] + c[0]) / 2, Math.max(y1, y2) + 12, (a[1] + c[1]) / 2);
    const p0 = new THREE.Vector3(a[0], y1, a[1]);
    const p1 = new THREE.Vector3(c[0], y2, c[1]);

    const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
    const tube = new THREE.TubeGeometry(curve, 24, 3.2, 6, false);
    const color = new THREE.Color(b.color || '#e8c84a');
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.35,
      roughness: 0.4,
      metalness: 0.3,
    });
    const mesh = new THREE.Mesh(tube, mat);
    group.add(mesh);

    // towers
    for (const p of [p0, p1]) {
      const tower = new THREE.Mesh(
        new THREE.BoxGeometry(5, 42, 5),
        mat,
      );
      tower.position.set(p.x, p.y + 12, p.z);
      group.add(tower);
    }

    addLabel(b.n, mid.clone().add(new THREE.Vector3(0, 28, 0)));
  }
  scene.add(group);
}

async function buildCity(data) {
  const peaks = data.terrainPeaks || [];
  const yFn = (x, z) => terrainHeight(x, z, peaks);

  scene.add(makeGround(peaks));
  scene.add(makeGrid());

  // Parks
  const parkGeoms = [];
  for (const p of data.parks) {
    if (p.f.length < 4) continue;
    try {
      parkGeoms.push(flatPolygon(p.f, 0.8, yFn));
    } catch {
      /* skip bad poly */
    }
  }
  if (parkGeoms.length) {
    const parkMesh = new THREE.Mesh(mergeGeometries(parkGeoms, false), parkMat);
    parkMesh.receiveShadow = true;
    scene.add(parkMesh);
  }

  // Water
  const waterGeoms = [];
  for (const w of data.water) {
    if (w.f.length < 4) continue;
    try {
      waterGeoms.push(flatPolygon(w.f, 0.2, null));
    } catch {
      /* skip */
    }
  }
  if (waterGeoms.length) {
    const waterMesh = new THREE.Mesh(mergeGeometries(waterGeoms, false), waterMat);
    scene.add(waterMesh);
  }

  // Buildings — batch merge in chunks
  const normalGeoms = [];
  const landmarkGeoms = [];
  let buildingCount = 0;

  for (const b of data.buildings) {
    if (!b.f || b.f.length < 4) continue;
    try {
      const geom = extrudeBuilding(b.f, Math.max(3, b.h || 10), yFn);
      if (b.landmark || (b.n && b.h > 100)) {
        landmarkGeoms.push(geom);
      } else {
        normalGeoms.push(geom);
      }
      buildingCount += 1;
    } catch {
      /* skip degenerate */
    }
  }

  const CHUNK = 800;
  function addChunks(geoms, mat) {
    for (let i = 0; i < geoms.length; i += CHUNK) {
      const slice = geoms.slice(i, i + CHUNK);
      const merged = mergeGeometries(slice, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      for (const g of slice) g.dispose();
    }
  }

  addChunks(normalGeoms, buildingMat);
  addChunks(landmarkGeoms, landmarkMat);

  // Streets as line segments grouped by rank
  const byRank = new Map();
  for (const s of data.streets) {
    const r = s.r ?? 1;
    if (!byRank.has(r)) byRank.set(r, []);
    const pts = byRank.get(r);
    for (let i = 0; i < s.c.length - 1; i++) {
      const a = s.c[i];
      const b = s.c[i + 1];
      const ya = yFn(a[0], a[1]) + 1.2;
      const yb = yFn(b[0], b[1]) + 1.2;
      pts.push(a[0], ya, a[1], b[0], yb, b[1]);
    }
  }
  for (const [r, arr] of byRank) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const lines = new THREE.LineSegments(geom, roadMats[r] || roadMats[1]);
    scene.add(lines);
  }

  buildBridges(data.bridges || [], yFn);

  // Landmark labels
  for (const lm of data.landmarks || []) {
    const [x, z] = lm.p;
    const y = yFn(x, z) + (lm.h || 40) + 30;
    addLabel(lm.n, new THREE.Vector3(x, y, z));
  }

  layersEl.textContent = `buildings ${buildingCount.toLocaleString()} · live`;
  return buildingCount;
}

/* ---------- Camera presets ---------- */
const views = {
  aerial: {
    position: new THREE.Vector3(0, 2800, 0.01),
    target: new THREE.Vector3(0, 0, 0),
  },
  downtown: {
    position: new THREE.Vector3(780, 420, 920),
    target: new THREE.Vector3(40, 60, -40),
  },
  point: {
    position: new THREE.Vector3(-420, 280, 520),
    target: new THREE.Vector3(-280, 20, 40),
  },
  bridges: {
    position: new THREE.Vector3(180, 220, 640),
    target: new THREE.Vector3(-40, 30, -180),
  },
  oakland: {
    position: new THREE.Vector3(2200, 520, 900),
    target: new THREE.Vector3(1800, 80, 100),
  },
};

let rotateMode = false;
let anim = null;

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function animateCamera(toView, duration = 2200) {
  const fromPos = camera.position.clone();
  const fromTarget = controls.target.clone();
  const toPos = toView.position.clone();
  const toTarget = toView.target.clone();
  const start = performance.now();
  anim = { start, duration, fromPos, fromTarget, toPos, toTarget };
}

function setView(name) {
  for (const btn of navEl.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.view === name || (name === 'rotate' && btn.dataset.view === 'rotate'));
  }
  if (name === 'rotate') {
    rotateMode = !rotateMode;
    if (rotateMode) {
      animateCamera(views.downtown, 1600);
    }
    return;
  }
  rotateMode = false;
  if (views[name]) animateCamera(views[name]);
}

navEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  setView(btn.dataset.view);
});

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
}
window.addEventListener('resize', onResize);
onResize();

function tick(now) {
  requestAnimationFrame(tick);

  if (anim) {
    const t = Math.min(1, (now - anim.start) / anim.duration);
    const e = easeInOut(t);
    camera.position.lerpVectors(anim.fromPos, anim.toPos, e);
    controls.target.lerpVectors(anim.fromTarget, anim.toTarget, e);
    if (t >= 1) anim = null;
  } else if (rotateMode) {
    const t = now * 0.00012;
    const r = 980;
    camera.position.x = Math.cos(t) * r;
    camera.position.z = Math.sin(t) * r;
    camera.position.y = 480;
    controls.target.set(20, 50, -20);
  }

  // focus spotlight follows orbit target
  focusLight.position.set(controls.target.x, 750, controls.target.z);
  focusLight.target.position.copy(controls.target);
  focusGlow.position.x = controls.target.x;
  focusGlow.position.z = controls.target.z;

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
requestAnimationFrame(tick);

/* ---------- Boot ---------- */
(async () => {
  try {
    const res = await fetch('./data/pittsburgh.json');
    if (!res.ok) throw new Error(`Failed to load city data (${res.status})`);
    const data = await res.json();
    await buildCity(data);
    setView('downtown');
    loaderEl.classList.add('hide');
  } catch (err) {
    console.error(err);
    loaderEl.querySelector('.loader-text').textContent = String(err.message || err);
  }
})();
