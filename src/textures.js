import * as THREE from 'three';
import { footprintCentroid } from './geo.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvasTexture(canvas, { color = true, repeat = 1 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeCanvases(w, h) {
  const color = document.createElement('canvas');
  color.width = w;
  color.height = h;
  const emissive = document.createElement('canvas');
  emissive.width = w;
  emissive.height = h;
  const rough = document.createElement('canvas');
  rough.width = w;
  rough.height = h;
  return {
    color,
    emissive,
    rough,
    c: color.getContext('2d'),
    e: emissive.getContext('2d'),
    r: rough.getContext('2d'),
  };
}

/** Derive a subtle tangent-space normal map from a height/luminance canvas. */
function bakeNormalFromHeight(srcCanvas, strength = 1.6) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const src = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const lum = (i) => {
    const o = i * 4;
    return (src[o] * 0.299 + src[o + 1] * 0.587 + src[o + 2] * 0.114) / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = lum(i);
      const lR = lum(y * w + ((x + 1) % w));
      const lU = lum(((y + 1) % h) * w + x);
      let dx = (l - lR) * strength;
      let dy = (l - lU) * strength;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = i * 4;
      img.data[o] = (dx * invLen * 0.5 + 0.5) * 255;
      img.data[o + 1] = (dy * invLen * 0.5 + 0.5) * 255;
      img.data[o + 2] = (invLen * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(out, { color: false });
}

function paintFacade(opts) {
  const {
    seed = 1,
    width = 256,
    height = 256,
    base = '#3d322c',
    mortar = '#2a2420',
    windowDark = '#07090d',
    windowLit = '#e0b25a',
    frame = '#161410',
    cols = 6,
    rows = 8,
    litChance = 0.32,
    brick = false,
    glass = false,
    panels = false,
    tallWindows = false,
  } = opts;

  const rand = rng(seed);
  const { color, emissive, rough, c, e, r } = makeCanvases(width, height);

  c.fillStyle = base;
  c.fillRect(0, 0, width, height);
  e.fillStyle = '#000';
  e.fillRect(0, 0, width, height);
  // Roughness base: glass/steel stay smoother; masonry stays diffuse.
  r.fillStyle = glass ? '#3a3a3a' : panels ? '#a8a49e' : '#c8c4be';
  r.fillRect(0, 0, width, height);

  if (brick) {
    const bh = 7;
    const bw = 16;
    c.fillStyle = mortar;
    for (let y = 0; y < height; y += bh) {
      const shift = (y / bh) % 2 === 0 ? 0 : bw * 0.5;
      for (let x = -bw; x < width + bw; x += bw) {
        const shade = 0.88 + rand() * 0.18;
        c.fillStyle = `rgba(0,0,0,${0.08 + rand() * 0.1})`;
        c.fillRect(x + shift, y, bw - 1, bh - 1);
        c.fillStyle = base;
        c.globalAlpha = shade;
        c.fillRect(x + shift + 1, y + 1, bw - 3, bh - 3);
        c.globalAlpha = 1;
      }
    }
  } else if (panels) {
    c.strokeStyle = mortar;
    c.lineWidth = 2;
    const pw = width / 3;
    const ph = height / 4;
    for (let y = 0; y < height; y += ph) {
      for (let x = 0; x < width; x += pw) {
        c.strokeRect(x + 2, y + 2, pw - 4, ph - 4);
      }
    }
  } else if (glass) {
    for (let y = 0; y < height; y++) {
      const band = 0.92 + Math.sin(y * 0.2) * 0.06;
      c.fillStyle = `rgba(255,255,255,${0.015 + (1 - band) * 0.04})`;
      c.fillRect(0, y, width, 1);
    }
  } else {
    for (let i = 0; i < 400; i++) {
      c.fillStyle = `rgba(0,0,0,${rand() * 0.07})`;
      c.fillRect(rand() * width, rand() * height, 2, 2);
    }
  }

  const cellW = width / cols;
  const cellH = height / rows;
  const insetX = tallWindows ? 0.28 : 0.22;
  const insetY = tallWindows ? 0.1 : 0.22;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const lit = rand() < litChance;
      const x = col * cellW + cellW * insetX;
      const y = row * cellH + cellH * insetY;
      const w = cellW * (1 - insetX * 2);
      const h = cellH * (1 - insetY * 2);
      c.fillStyle = frame;
      c.fillRect(x - 1, y - 1, w + 2, h + 2);
      if (lit) {
        const glow = c.createLinearGradient(x, y, x, y + h);
        glow.addColorStop(0, windowLit);
        glow.addColorStop(1, '#8a6230');
        c.fillStyle = glow;
        e.fillStyle = windowLit;
      } else {
        c.fillStyle = windowDark;
        e.fillStyle = '#000';
      }
      c.fillRect(x, y, w, h);
      e.fillRect(x, y, w, h);
      // Windows are smoother (esp. glass curtain walls); frames stay rougher.
      if (glass) {
        r.fillStyle = lit ? '#1a1a1a' : '#222222';
      } else {
        r.fillStyle = lit ? '#2a2a2a' : '#3a3a3a';
      }
      r.fillRect(x, y, w, h);
      if (lit && rand() < 0.45) {
        c.fillStyle = 'rgba(255,230,180,0.25)';
        c.fillRect(x + 1, y + 1, w * 0.4, h * 0.35);
      }
    }
  }

  // Roof sample texel in the corner (UVs for caps point here)
  c.fillStyle = '#1a1816';
  c.fillRect(0, 0, 2, 2);
  e.fillStyle = '#000';
  e.fillRect(0, 0, 2, 2);
  r.fillStyle = '#d0d0d0';
  r.fillRect(0, 0, 2, 2);

  // Height cue for normals: darker mortar/frames = recessed, lit glass = flatter.
  const normalStrength = glass ? 0.9 : brick ? 2.2 : panels ? 1.4 : 1.6;

  return {
    map: canvasTexture(color),
    emissiveMap: canvasTexture(emissive),
    roughnessMap: canvasTexture(rough, { color: false }),
    normalMap: bakeNormalFromHeight(color, normalStrength),
  };
}

function noiseCanvas(w, h, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  paint(ctx, w, h);
  return canvas;
}

function makeGrassMaps() {
  const color = noiseCanvas(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#1c3a22';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 2200; i++) {
      const g = 70 + Math.random() * 50;
      ctx.fillStyle = `rgba(${30 + Math.random() * 20},${g},${40 + Math.random() * 20},${0.18 + Math.random() * 0.25})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 2 + Math.random() * 4);
    }
  });
  const rough = noiseCanvas(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 800; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.2})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 3, 3);
    }
  });
  return {
    map: canvasTexture(color, { repeat: 8 }),
    roughnessMap: canvasTexture(rough, { color: false, repeat: 8 }),
  };
}

function makeGroundMaps() {
  const color = noiseCanvas(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#8a8680';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 3000; i++) {
      const v = 110 + Math.random() * 50;
      ctx.fillStyle = `rgba(${v},${v - 6},${v - 14},${0.12 + Math.random() * 0.2})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
  });
  const rough = noiseCanvas(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#c4c4c4';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 600; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.15})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 4, 4);
    }
  });
  return {
    map: canvasTexture(color, { repeat: 48 }),
    roughnessMap: canvasTexture(rough, { color: false, repeat: 48 }),
  };
}

function makeWaterMaps() {
  const color = noiseCanvas(256, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#0a2430');
    g.addColorStop(0.5, '#071820');
    g.addColorStop(1, '#0c2a36');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 180; i++) {
      ctx.strokeStyle = `rgba(140,190,210,${0.03 + Math.random() * 0.05})`;
      ctx.beginPath();
      const y = Math.random() * h;
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(w * 0.3, y + 8, w * 0.6, y - 8, w, y + 4);
      ctx.stroke();
    }
  });
  const rough = noiseCanvas(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#4a4a4a';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.35})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 6, 2);
    }
  });
  return {
    map: canvasTexture(color, { repeat: 6 }),
    roughnessMap: canvasTexture(rough, { color: false, repeat: 10 }),
  };
}

function makeRoadMaps() {
  const color = noiseCanvas(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#2a2c32';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(210,200,160,0.35)';
    ctx.fillRect(w * 0.48, 0, 2, h);
    for (let i = 0; i < 200; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.15})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 3, 2);
    }
  });
  return { map: canvasTexture(color, { repeat: 1 }) };
}

/**
 * Build a dusk/night gradient sky scene used as the PMREM source.
 * Soft directional lights act as specular catch-lights on glass/steel without
 * turning the probe into a bright daylight studio.
 *
 * Pass 4 may replace this with an env derived from a full sky dome — keep
 * createNightEnvironment() as the single swap point.
 */
function buildNightEnvProbeScene() {
  const envScene = new THREE.Scene();

  // Equirectangular dusk gradient (canvas) — reliable across WebGL1/2 vs a custom shader.
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 512;
  skyCanvas.height = 256;
  const ctx = skyCanvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#0a1424'); // zenith — deep night blue, not pure black
  g.addColorStop(0.4, '#152536');
  g.addColorStop(0.5, '#4a3220'); // warm dusk horizon (brighter for specular catch)
  g.addColorStop(0.58, '#1a222c');
  g.addColorStop(1, '#0c1016'); // nadir / ground
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 256);
  // Soft city-glow band for richer glass reflections.
  for (let i = 0; i < 160; i++) {
    const x = Math.random() * 512;
    const y = 112 + Math.random() * 32;
    ctx.fillStyle = `rgba(255,176,96,${0.06 + Math.random() * 0.14})`;
    ctx.fillRect(x, y, 4 + Math.random() * 16, 1 + Math.random() * 2);
  }
  for (let i = 0; i < 50; i++) {
    ctx.fillStyle = `rgba(140,180,220,${0.05 + Math.random() * 0.08})`;
    ctx.fillRect(Math.random() * 512, 95 + Math.random() * 22, 6 + Math.random() * 12, 1);
  }
  const skyTex = new THREE.CanvasTexture(skyCanvas);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyTex.needsUpdate = true;

  const skyGeo = new THREE.SphereGeometry(40, 48, 24);
  const skyMat = new THREE.MeshBasicMaterial({
    map: skyTex,
    side: THREE.BackSide,
    depthWrite: false,
  });
  envScene.add(new THREE.Mesh(skyGeo, skyMat));

  // Warm low sun / dusk key — gives elongated speculars on curtain walls.
  const key = new THREE.DirectionalLight(0xffc090, 3.2);
  key.position.set(6, 2.2, -4);
  envScene.add(key);

  // Cool sky fill opposite the key.
  const fill = new THREE.DirectionalLight(0x6a88b8, 1.15);
  fill.position.set(-5, 4, 3);
  envScene.add(fill);

  // Soft ambient so recessed stone still picks up a little environment.
  const hemi = new THREE.HemisphereLight(0x243848, 0x0c0a08, 0.7);
  envScene.add(hemi);

  // A few warm point accents (distant downtown glow) for localized highlights.
  const glowA = new THREE.PointLight(0xffb070, 28, 60, 2);
  glowA.position.set(8, 1.5, -6);
  envScene.add(glowA);
  const glowB = new THREE.PointLight(0x88aacc, 16, 50, 2);
  glowB.position.set(-6, 3, 8);
  envScene.add(glowB);

  return envScene;
}

/**
 * Prefiltered night environment for MeshStandardMaterial reflections.
 * Call once at startup with the WebGLRenderer; do not rebuild per frame.
 *
 * Pass 4 (sky dome) may override scene.environment with a sky-derived probe —
 * swap implementations here rather than scattering env setup through main.js.
 */
export function createNightEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const envScene = buildNightEnvProbeScene();
  // Mild blur (sigma) softens the probe so reflections read cinematic, not mirror-sharp.
  // Keep sigma ≤ ~0.04 so PMREM sample count stays within Three's max (avoids clip warning).
  const envMap = pmrem.fromScene(envScene, 0.04).texture;

  // Probe scene only needed for the one-shot bake.
  envScene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
  pmrem.dispose();
  return envMap;
}

function stdMat(maps, extras = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    roughnessMap: maps.roughnessMap,
    emissiveMap: maps.emissiveMap,
    normalMap: maps.normalMap ?? null,
    color: extras.color ?? 0xffffff,
    roughness: extras.roughness ?? 0.7,
    metalness: extras.metalness ?? 0.08,
    emissive: extras.emissive ?? 0xffcc88,
    emissiveIntensity: extras.emissiveIntensity ?? 0,
    vertexColors: extras.vertexColors ?? true,
    envMapIntensity: extras.envMapIntensity ?? 0.35,
  });
  if (maps.normalMap && extras.normalScale != null) {
    mat.normalScale.set(extras.normalScale, extras.normalScale);
  } else if (maps.normalMap) {
    mat.normalScale.set(0.55, 0.55);
  }
  return mat;
}

export function createCityMaterials() {
  const families = {
    // Masonry / stone: high roughness, near-zero metal, soft normals for mortar depth.
    lowrise: {
      mat: stdMat(
        paintFacade({
          seed: 11,
          base: '#3a322c',
          mortar: '#2a241e',
          cols: 5,
          rows: 6,
          litChance: 0.18,
          brick: true,
        }),
        {
          roughness: 0.92,
          metalness: 0.02,
          emissiveIntensity: 0.55,
          envMapIntensity: 0.28,
          normalScale: 0.7,
        },
      ),
      floorH: 3.6,
      windowW: 3.8,
    },
    brick: {
      mat: stdMat(
        paintFacade({
          seed: 22,
          base: '#4a3028',
          mortar: '#2c1e1a',
          cols: 6,
          rows: 8,
          litChance: 0.28,
          brick: true,
        }),
        {
          roughness: 0.9,
          metalness: 0.02,
          emissiveIntensity: 0.7,
          envMapIntensity: 0.3,
          normalScale: 0.75,
        },
      ),
      floorH: 3.7,
      windowW: 3.4,
    },
    limestone: {
      mat: stdMat(
        paintFacade({
          seed: 33,
          base: '#5c584c',
          mortar: '#3a3830',
          windowLit: '#e8c878',
          cols: 6,
          rows: 8,
          litChance: 0.3,
        }),
        {
          roughness: 0.82,
          metalness: 0.04,
          emissiveIntensity: 0.72,
          envMapIntensity: 0.4,
          normalScale: 0.45,
        },
      ),
      floorH: 3.8,
      windowW: 3.3,
    },
    // Mid/high-rise cladding: mixed metal + smoother finish so PMREM reads.
    steel: {
      mat: stdMat(
        paintFacade({
          seed: 44,
          base: '#3a4048',
          mortar: '#2a3038',
          windowDark: '#0a1014',
          windowLit: '#d8c090',
          cols: 8,
          rows: 10,
          litChance: 0.38,
          glass: true,
        }),
        {
          roughness: 0.28,
          metalness: 0.55,
          emissiveIntensity: 0.8,
          envMapIntensity: 0.95,
          normalScale: 0.35,
        },
      ),
      floorH: 3.5,
      windowW: 3.0,
    },
    // Curtain-wall glass: low roughness, high metalness → soft night reflections.
    glass: {
      mat: stdMat(
        paintFacade({
          seed: 55,
          base: '#1a2830',
          mortar: '#0e181e',
          windowDark: '#0a1418',
          windowLit: '#c8d8e8',
          frame: '#0a1014',
          cols: 8,
          rows: 10,
          litChance: 0.42,
          glass: true,
        }),
        {
          roughness: 0.08,
          metalness: 0.82,
          emissive: 0xa8c4d8,
          emissiveIntensity: 0.85,
          envMapIntensity: 1.35,
          normalScale: 0.22,
        },
      ),
      floorH: 3.45,
      windowW: 2.7,
    },
    ppg: {
      mat: stdMat(
        paintFacade({
          seed: 66,
          base: '#0c1c1c',
          mortar: '#061010',
          windowDark: '#061014',
          windowLit: '#8ec4b0',
          frame: '#081212',
          cols: 8,
          rows: 12,
          litChance: 0.34,
          glass: true,
        }),
        {
          roughness: 0.06,
          metalness: 0.88,
          emissive: 0x6aa898,
          emissiveIntensity: 0.75,
          envMapIntensity: 1.45,
          normalScale: 0.18,
        },
      ),
      floorH: 3.4,
      windowW: 2.5,
    },
    gothic: {
      mat: stdMat(
        paintFacade({
          seed: 77,
          base: '#6a6458',
          mortar: '#3e3a32',
          windowDark: '#0c0e12',
          windowLit: '#e8d090',
          cols: 5,
          rows: 6,
          litChance: 0.22,
          tallWindows: true,
        }),
        {
          roughness: 0.86,
          metalness: 0.03,
          emissiveIntensity: 0.6,
          envMapIntensity: 0.32,
          normalScale: 0.55,
        },
      ),
      floorH: 5.4,
      windowW: 2.5,
    },
    stadium: {
      mat: stdMat(
        paintFacade({
          seed: 88,
          base: '#3a4034',
          mortar: '#2a2c26',
          windowDark: '#121410',
          windowLit: '#d0c080',
          cols: 4,
          rows: 4,
          litChance: 0.2,
          panels: true,
        }),
        {
          roughness: 0.62,
          metalness: 0.22,
          emissiveIntensity: 0.45,
          envMapIntensity: 0.55,
          normalScale: 0.4,
        },
      ),
      floorH: 8.5,
      windowW: 10,
    },
  };

  const grass = makeGrassMaps();
  const ground = makeGroundMaps();
  const water = makeWaterMaps();
  const road = makeRoadMaps();

  const parkMat = new THREE.MeshStandardMaterial({
    color: 0x2a5a34,
    map: grass.map,
    roughnessMap: grass.roughnessMap,
    roughness: 1,
    metalness: 0,
    emissive: 0x041208,
    emissiveIntensity: 0.2,
  });

  const waterUniforms = { uTime: { value: 0 } };
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x0a2834,
    map: water.map,
    roughnessMap: water.roughnessMap,
    roughness: 0.18,
    metalness: 0.48,
    transparent: true,
    opacity: 0.94,
    envMapIntensity: 1.25,
  });
  waterMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWorldPos;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         varying vec3 vWorldPos;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         float n = sin(vWorldPos.x * 0.018 + uTime * 0.35) * sin(vWorldPos.z * 0.014 + uTime * 0.28);
         float edge = smoothstep(0.0, 18.0, abs(vWorldPos.y));
         diffuseColor.rgb += n * 0.035 * vec3(0.45, 0.7, 0.8);
         diffuseColor.rgb *= 0.88 + edge * 0.08;`,
      );
  };

  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: ground.map,
    roughnessMap: ground.roughnessMap,
    roughness: 0.94,
    metalness: 0.04,
    vertexColors: true,
  });

  const roadMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: road.map,
    roughness: 0.88,
    metalness: 0.08,
    vertexColors: true,
  });

  const foamMat = new THREE.MeshStandardMaterial({
    color: 0x3a4a46,
    roughness: 0.72,
    metalness: 0.12,
    emissive: 0x102018,
    emissiveIntensity: 0.15,
  });

  const bankMat = new THREE.MeshStandardMaterial({
    color: 0x2a2418,
    roughness: 0.95,
    metalness: 0.02,
  });

  const treeMat = new THREE.MeshStandardMaterial({
    color: 0x0e1c12,
    roughness: 1,
    metalness: 0,
  });

  return {
    families,
    parkMat,
    waterMat,
    waterUniforms,
    groundMat,
    roadMat,
    foamMat,
    bankMat,
    treeMat,
  };
}

export function buildingFamily(b) {
  const n = (b.n || '').toLowerCase();
  const h = b.h || 10;
  if (/ppg/.test(n)) return 'ppg';
  if (/cathedral of learning/.test(n)) return 'gothic';
  if (/pnc park|acrisure|stadium|heinz field/.test(n)) return 'stadium';
  if (b.f && b.f.length >= 3 && h < 60) {
    const [cx, cz] = footprintCentroid(b.f);
    if (Math.hypot(cx + 415, cz + 657) < 140) return 'stadium';
    if (Math.hypot(cx + 1169, cz + 635) < 180) return 'stadium';
  }
  if (/u\.?s\.? steel|us steel/.test(n)) return 'steel';
  if (/convention/.test(n)) return 'steel';
  if (b.landmark || h > 100) return 'glass';
  if (h > 55) return 'steel';
  if (h > 28) return 'limestone';
  if (h > 14) return 'brick';
  return 'lowrise';
}

export function applyFacadeUVs(geom, floorH, windowW, baseY) {
  geom.computeVertexNormals();
  const pos = geom.attributes.position;
  const nrm = geom.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ny = nrm.getY(i);
    if (ny > 0.55 || ny < -0.55) {
      uv[i * 2] = 0.003;
      uv[i * 2 + 1] = 0.003;
      continue;
    }
    const nx = nrm.getX(i);
    const nz = nrm.getZ(i);
    const along = Math.abs(nx) > Math.abs(nz) ? pos.getZ(i) : pos.getX(i);
    uv[i * 2] = along / windowW;
    uv[i * 2 + 1] = (pos.getY(i) - baseY) / floorH;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export function tintGeometry(geom, color) {
  const n = geom.attributes.position.count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    cols[i * 3] = color.r;
    cols[i * 3 + 1] = color.g;
    cols[i * 3 + 2] = color.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(cols, 3));
}

export function applyXZUvs(geom, scale = 0.04) {
  const pos = geom.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) * scale;
    uv[i * 2 + 1] = pos.getZ(i) * scale;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
