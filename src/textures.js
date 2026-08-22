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

/** Per-window light palette — warm tungsten, cool office, rare accent hues. */
function pickWindowLight(rand, { glass = false, cool = false, accent = false } = {}) {
  const roll = rand();
  if (accent) {
    // PPG-style teal curtain wall with occasional jewel-tone accents.
    if (roll < 0.55) return { lit: '#88c8b8', em: '#98e8d0', core: '#d8fff4', dim: '#3a6860' };
    if (roll < 0.78) return { lit: '#a8d8c8', em: '#c0f0e0', core: '#e8fff8', dim: '#4a7870' };
    if (roll < 0.90) return { lit: '#e8d8a8', em: '#f8e8b8', core: '#fff8e0', dim: '#8a7850' };
    if (roll < 0.97) return { lit: '#c8a8e8', em: '#e0c0ff', core: '#f8e8ff', dim: '#685080' };
    return { lit: '#a8c8f0', em: '#c8e0ff', core: '#f0f8ff', dim: '#486888' };
  }
  if (glass || cool) {
    if (roll < 0.42) return { lit: '#d8e4f0', em: '#e8f4ff', core: '#ffffff', dim: '#6a7890' };
    if (roll < 0.68) return { lit: '#c8d8e8', em: '#d8ecff', core: '#f4faff', dim: '#5a6878' };
    if (roll < 0.84) return { lit: '#e8c890', em: '#f0d8a0', core: '#fff0c8', dim: '#8a6840' };
    if (roll < 0.95) return { lit: '#a8c8e8', em: '#b8d8f8', core: '#e0f0ff', dim: '#486878' };
    return { lit: '#b8e0c8', em: '#c8f0d8', core: '#e8fff0', dim: '#487860' };
  }
  // Masonry / brick — mostly warm residential/office tungsten.
  if (roll < 0.48) return { lit: '#e8b868', em: '#ffc878', core: '#fff4d8', dim: '#8a6230' };
  if (roll < 0.72) return { lit: '#f0d080', em: '#ffe090', core: '#fff8e0', dim: '#9a7038' };
  if (roll < 0.86) return { lit: '#e8ece8', em: '#f8fcff', core: '#ffffff', dim: '#7a8078' };
  if (roll < 0.94) return { lit: '#d0d8e8', em: '#e0ecff', core: '#f0f8ff', dim: '#606878' };
  if (roll < 0.98) return { lit: '#ffb860', em: '#ffc870', core: '#ffe8b0', dim: '#a06028' };
  return { lit: '#c8e0a8', em: '#d8f0b8', core: '#f0ffe0', dim: '#608048' };
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
    cool = false,
    accent = false,
    floodlit = false,
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
        const light = pickWindowLight(rand, { glass, cool, accent });
        const glow = c.createLinearGradient(x, y, x, y + h);
        glow.addColorStop(0, light.lit);
        glow.addColorStop(1, light.dim);
        c.fillStyle = glow;
        c.fillRect(x, y, w, h);
        // Emissive map: saturated base + hot core so bloom threshold catches windows only.
        e.fillStyle = light.em;
        e.fillRect(x, y, w, h);
        e.fillStyle = light.core;
        const cw = Math.max(2, w * (0.32 + rand() * 0.28));
        const ch = Math.max(2, h * (0.24 + rand() * 0.24));
        e.fillRect(x + (w - cw) * 0.5, y + h * 0.06, cw, ch);
        if (rand() < 0.24) {
          e.fillStyle = 'rgba(255,255,255,0.9)';
          e.fillRect(x + w * 0.1, y + h * 0.52, w * 0.3, h * 0.22);
        }
        if (rand() < 0.38) {
          c.fillStyle = 'rgba(255,255,255,0.18)';
          c.fillRect(x + 1, y + 1, w * 0.42, h * 0.32);
        }
      } else {
        c.fillStyle = windowDark;
        c.fillRect(x, y, w, h);
        e.fillStyle = '#000';
        e.fillRect(x, y, w, h);
      }
      // Windows are smoother (esp. glass curtain walls); frames stay rougher.
      if (glass) {
        r.fillStyle = lit ? '#1a1a1a' : '#222222';
      } else {
        r.fillStyle = lit ? '#2a2a2a' : '#3a3a3a';
      }
      r.fillRect(x, y, w, h);
      // Stadium / arena floodlight panels — extra-bright emissive bands.
      if (floodlit && panels && rand() < 0.14) {
        e.fillStyle = '#fff8e0';
        e.fillRect(x - 1, y - 1, w + 2, h + 2);
        c.fillStyle = '#f0e8c0';
        c.fillRect(x, y, w, h);
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
 * Atmospheric dusk/twilight sky dome shader.
 *
 * Produces a physical gradient:
 * - Zenith: deep night indigo (cool twilight blue)
 * - Mid-sky: dusky violet/slate transition
 * - Horizon base: atmospheric haze
 * - Sunward horizon: warm amber/rose sunset glow centered at the sun's azimuth
 * - Sun forward Mie scattering halo around the sun vector
 * - Nadir: dark ground tone below horizon for seamless reflections & aerial view
 * - High-frequency dither to eliminate 8-bit banding in dark gradients
 */
export function createSkyDome({
  sunPosition = new THREE.Vector3(600, 900, 200),
  radius = 16000,
} = {}) {
  const vertexShader = /* glsl */ `
    varying vec3 vWorldDirection;

    void main() {
      vWorldDirection = position;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      gl_Position.z = gl_Position.w; // Always project onto the far clipping plane
    }
  `;

  const fragmentShader = /* glsl */ `
    varying vec3 vWorldDirection;

    uniform vec3 uSunPosition;
    uniform vec3 uZenithColor;
    uniform vec3 uMidColor;
    uniform vec3 uHorizonColor;
    uniform vec3 uSunsetGlowColor;
    uniform vec3 uNadirColor;

    void main() {
      vec3 dir = normalize(vWorldDirection);
      float y = dir.y;

      vec3 sunDir = normalize(uSunPosition);
      vec2 dirXZ = normalize(dir.xz + vec2(1e-6));
      vec2 sunDirXZ = normalize(sunDir.xz + vec2(1e-6));

      float sunDot = max(0.0, dot(dir, sunDir));
      float azimuthDot = max(0.0, dot(dirXZ, sunDirXZ));

      vec3 skyColor;
      if (y >= 0.0) {
        // Atmospheric elevation gradient: deep zenith to soft horizon
        float tZenith = pow(y, 0.62);
        float tMid = smoothstep(0.0, 0.35, y) * (1.0 - smoothstep(0.12, 0.65, y));
        skyColor = mix(uHorizonColor, uZenithColor, tZenith);
        skyColor = mix(skyColor, uMidColor, tMid * 0.42);
      } else {
        // Seamless ground/nadir transition below horizon
        float tNadir = clamp(-y * 3.5, 0.0, 1.0);
        skyColor = mix(uHorizonColor, uNadirColor, tNadir);
      }

      // Warm sunset horizon glow on the sunward side of the city
      float horizonBand = smoothstep(0.38, 0.0, abs(y - 0.02));
      float duskSpread = pow(azimuthDot, 2.4);
      vec3 duskGlow = uSunsetGlowColor * duskSpread * horizonBand;
      skyColor += duskGlow;

      // Soft forward Mie scattering halo around the sun position
      float mie1 = pow(sunDot, 14.0) * 0.38;
      float mie2 = pow(sunDot, 48.0) * 0.65;
      vec3 sunHalo = (uSunsetGlowColor * 1.1 + vec3(0.08, 0.06, 0.04)) * (mie1 + mie2);
      skyColor += sunHalo * smoothstep(-0.06, 0.08, y);

      // Subtle atmospheric haze variation along the horizon
      float hazeWisp = sin(dir.x * 16.0 + dir.z * 12.0) * sin(dir.z * 20.0) * 0.012;
      skyColor += vec3(hazeWisp * 0.4) * horizonBand;

      // High-frequency dither to eliminate 8-bit banding on subtle dark gradients
      float dither = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * (1.0 / 255.0);
      skyColor += vec3(dither);

      gl_FragColor = vec4(skyColor, 1.0);

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `;

  const uniforms = {
    uSunPosition: { value: sunPosition.clone() },
    uZenithColor: { value: new THREE.Color(0x061022) },
    uMidColor: { value: new THREE.Color(0x0e1828) },
    uHorizonColor: { value: new THREE.Color(0x16202e) },
    uSunsetGlowColor: { value: new THREE.Color(0x5c2c16) },
    uNadirColor: { value: new THREE.Color(0x030508) },
  };

  const mat = new THREE.ShaderMaterial({
    name: 'SkyDomeShader',
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });

  const geo = new THREE.SphereGeometry(radius, 64, 32);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -100;
  return mesh;
}

/**
 * Prefiltered night/dusk environment for MeshStandardMaterial reflections.
 * Regenerated directly from the sky dome probe so glass/steel reflections and
 * IBL diffuse lighting are physically coherent with the atmosphere.
 * Call once at startup with the WebGLRenderer; do not rebuild per frame.
 */
export function createNightEnvironment(
  renderer,
  { sunPosition = new THREE.Vector3(600, 900, 200) } = {},
) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();

  const envScene = new THREE.Scene();

  // Sky dome probe mesh (radius 100 fits comfortably in PMREM CubeCamera)
  const skyMesh = createSkyDome({ sunPosition, radius: 100 });
  envScene.add(skyMesh);

  // Key specular catch-light aligned with the sun direction for crisp glass/metal reflections
  const sunDir = sunPosition.clone().normalize();
  const key = new THREE.DirectionalLight(0xffc090, 2.8);
  key.position.copy(sunDir.clone().multiplyScalar(10));
  envScene.add(key);

  // Cool sky fill from upper hemisphere
  const fill = new THREE.DirectionalLight(0x5a7ca8, 0.9);
  fill.position.set(-sunDir.x * 8, 12, -sunDir.z * 8);
  envScene.add(fill);

  // Soft warm ambient/city glow accents in the downtown direction
  const cityGlow = new THREE.PointLight(0xffb070, 20, 50, 2);
  cityGlow.position.set(sunDir.x * 6, 1.5, sunDir.z * 6);
  envScene.add(cityGlow);

  // Mild blur (sigma) softens the probe so reflections read cinematic, not mirror-sharp.
  const envMap = pmrem.fromScene(envScene, 0.04, 0.1, 500).texture;

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
          emissive: 0xffc888,
          emissiveIntensity: 0.68,
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
          emissive: 0xffcc88,
          emissiveIntensity: 0.88,
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
          emissive: 0xffd090,
          emissiveIntensity: 0.92,
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
          litChance: 0.42,
          glass: true,
          cool: true,
        }),
        {
          roughness: 0.28,
          metalness: 0.55,
          emissive: 0xffc890,
          emissiveIntensity: 1.02,
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
          litChance: 0.46,
          glass: true,
          cool: true,
        }),
        {
          roughness: 0.08,
          metalness: 0.82,
          emissive: 0xb8d4e8,
          emissiveIntensity: 1.08,
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
          litChance: 0.38,
          glass: true,
          accent: true,
        }),
        {
          roughness: 0.06,
          metalness: 0.88,
          emissive: 0x88e0c8,
          emissiveIntensity: 1.0,
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
          emissive: 0xffd888,
          emissiveIntensity: 0.78,
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
          litChance: 0.36,
          panels: true,
          floodlit: true,
        }),
        {
          roughness: 0.62,
          metalness: 0.22,
          emissive: 0xffe090,
          emissiveIntensity: 0.78,
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

  /**
   * Cinematic weather-reactive water uniforms (Pass 8).
   *
   * `uTime` is advanced every frame by main.js; the rest are eased each frame
   * by the WeatherController so the surface transitions with the atmosphere:
   * - uSunDir       world-space sun direction for the specular glint lobe
   * - uChoppiness   ripple frequency/amplitude multiplier (rain>1, snow<<1)
   * - uRainDrops    0..1 raindrop impact-ring + broken-surface disturbance
   * - uSunGlint     strength of the sun-reflection sparkle
   * - uReflectivity Fresnel/mirror boost (rain dulls it, snow goes glassy)
   * - uWetTint/uTintMix  weather tint target + blend amount (grey rain chop,
   *   pale steely near-freezing sheen; 0 mix on sunny keeps the base color)
   */
  const waterUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(600, 900, 200).normalize() },
    uChoppiness: { value: 1 },
    uRainDrops: { value: 0 },
    uSunGlint: { value: 1 },
    uReflectivity: { value: 1 },
    uTintMix: { value: 0 },
    uWetTint: { value: new THREE.Color(0x0a2834) },
  };
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
    shader.uniforms.uSunDir = waterUniforms.uSunDir;
    shader.uniforms.uChoppiness = waterUniforms.uChoppiness;
    shader.uniforms.uRainDrops = waterUniforms.uRainDrops;
    shader.uniforms.uSunGlint = waterUniforms.uSunGlint;
    shader.uniforms.uReflectivity = waterUniforms.uReflectivity;
    shader.uniforms.uTintMix = waterUniforms.uTintMix;
    shader.uniforms.uWetTint = waterUniforms.uWetTint;
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
         uniform vec3 uSunDir;
         uniform float uChoppiness;
         uniform float uRainDrops;
         uniform float uSunGlint;
         uniform float uReflectivity;
         uniform float uTintMix;
         uniform vec3 uWetTint;
         varying vec3 vWorldPos;

         // Analytic gradient of a 4-octave directional sine wave field over
         // world XZ (meters). Returning the gradient (not the height) means a
         // single evaluation yields the perturbed surface normal directly.
         vec2 waterGrad(vec2 p, float t, float chop) {
           vec2 g = vec2(0.0);
           // broad swell
           g += (0.50 * chop) * 0.045 * vec2(0.80, 0.60)
                * cos(dot(p, vec2(0.80, 0.60)) * 0.045 + t * 0.90);
           // cross swell
           g += (0.35 * chop) * 0.085 * vec2(-0.62, 0.79)
                * cos(dot(p, vec2(-0.62, 0.79)) * 0.085 - t * 1.30);
           // detail chop (grows super-linearly with choppiness for storms)
           g += (0.20 * chop * min(chop, 2.0)) * 0.190 * vec2(0.35, -0.94)
                * cos(dot(p, vec2(0.35, -0.94)) * 0.190 + t * 2.60);
           // counter-detail
           g += (0.16 * chop) * 0.240 * vec2(-0.92, -0.39)
                * cos(dot(p, vec2(-0.92, -0.39)) * 0.240 - t * 3.10);
           return g;
         }

         // Expanding raindrop impact rings on a hashed grid (no textures).
         vec2 rainRippleGrad(vec2 p, float t) {
           vec2 rp = p * 0.30;
           vec2 cell = floor(rp);
           vec2 fc = fract(rp) - 0.5;
           float rnd = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
           float ph = fract(t * 0.75 + rnd);
           float d = length(fc) + 1e-4;
           float ring = cos(d * 30.0 - ph * 9.0) * exp(-d * 4.0) * (1.0 - ph);
           return (fc / d) * ring;
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         vec2 wGrad = waterGrad(vWorldPos.xz, uTime, uChoppiness);
         wGrad += rainRippleGrad(vWorldPos.xz, uTime) * (0.12 * uRainDrops);
         // High-frequency broken-surface jitter while rain is falling.
         wGrad += (0.05 * uRainDrops) * vec2(
           sin(vWorldPos.x * 1.7 + vWorldPos.z * 2.3 + uTime * 9.0),
           sin(vWorldPos.z * 1.9 - vWorldPos.x * 2.1 + uTime * 11.0));
         vec3 wNormal = normalize(vec3(-wGrad.x * 5.5, 1.0, -wGrad.y * 5.5));
         vec3 wView = normalize(cameraPosition - vWorldPos);
         float wFacing = clamp(dot(wNormal, wView), 0.0, 1.0);
         float wFresnel = pow(1.0 - wFacing, 5.0);
         // Deep-water absorption looking straight down; the surface stays
         // brighter/mirror-like at grazing angles via the Fresnel terms below.
         diffuseColor.rgb *= mix(1.0, 0.42, wFacing * 0.85);
         // Weather tint: grey rain chop or pale steely near-freezing sheen.
         diffuseColor.rgb = mix(diffuseColor.rgb, uWetTint, uTintMix);
         // Subtle moving shimmer so the sheet never reads as flat.
         float wShimmer = sin(vWorldPos.x * 0.018 + uTime * 0.35)
                        * sin(vWorldPos.z * 0.014 + uTime * 0.28);
         diffuseColor.rgb += wShimmer * 0.03 * (0.5 + 0.5 * uChoppiness) * vec3(0.45, 0.7, 0.8);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         // Choppy/rain-broken water scatters; grazing angles tighten toward a
         // mirror so the skyline/sky reflection sharpens near the horizon.
         roughnessFactor = clamp(
           roughnessFactor + (uChoppiness - 1.0) * 0.06 + uRainDrops * 0.14, 0.03, 1.0);
         roughnessFactor = mix(
           roughnessFactor, 0.03, wFresnel * clamp(uReflectivity, 0.0, 1.0) * 0.85);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
         // Fresnel reflectivity boost: mirror-like at grazing angles.
         metalnessFactor = clamp(metalnessFactor + wFresnel * 0.38 * uReflectivity, 0.0, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         // Procedural rippled normal (world -> view space) feeds the standard
         // PBR pipeline, so IBL/sky reflections wobble with the waves.
         normal = normalize((viewMatrix * vec4(wNormal, 0.0)).xyz);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         // Sun glint: sharp lobe along the sun reflection, emissive so bloom
         // picks it up as sparkle. A faint wide lobe adds a warm sheen path.
         vec3 wReflect = reflect(-wView, wNormal);
         float wSunDot = max(dot(wReflect, uSunDir), 0.0);
         float wGlint = pow(wSunDot, 260.0) * 1.5 + pow(wSunDot, 36.0) * 0.045;
         totalEmissiveRadiance += vec3(1.0, 0.82, 0.58) * wGlint * uSunGlint;`,
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
