import * as THREE from 'three';
import { footprintCentroid } from './geo.js';
import { createWaterMaterial } from './water.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvasTexture(canvas, { color = true, repeat = 1, renderer = null } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
  tex.anisotropy = Math.min(16, maxAniso);
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

/**
 * Every family's palette below was picked for the night scene, which leaves the
 * brickwork near 0.04 albedo where real brick sits around 0.25. In daylight that
 * flattens the buildings: with almost no tonal range, the cornices, setbacks and
 * pier bays stop reading and the stock looks like plain dark boxes. Set once by
 * `createCityMaterials` so all fourteen families lift together.
 */
let facadeDayMode = true;

/**
 * Gamma lift toward daylight reflectance. Applied in sRGB so the families keep
 * their relative order — pale stone stays pale, dark glass stays dark.
 */
function liftForDay(hex, exponent = 0.45) {
  if (!facadeDayMode) return hex;
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const out = [16, 8, 0].map((shift) => {
    const s = ((v >> shift) & 255) / 255;
    return Math.round(Math.min(1, s ** exponent) * 255);
  });
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}

function paintFacade(opts) {
  const {
    seed = 1,
    width = 512,
    height = 512,
    cols = 6,
    rows = 8,
    litChance = 0.32,
    brick = false,
    glass = false,
    panels = false,
    tallWindows = false,
  } = opts;
  const base = liftForDay(opts.base ?? '#3d322c');
  const mortar = liftForDay(opts.mortar ?? '#2a2420');
  const frame = liftForDay(opts.frame ?? '#161410');
  // Daylight glazing mirrors the sky rather than reading as a black hole, but
  // stays darker than the surrounding wall.
  const windowDark = facadeDayMode
    ? liftForDay(opts.windowDark ?? '#07090d', 0.62)
    : (opts.windowDark ?? '#07090d');
  const windowLit = opts.windowLit ?? '#e0b25a';

  const rand = rng(seed);
  const { color, emissive, rough, c, e, r } = makeCanvases(width, height);

  c.fillStyle = base;
  c.fillRect(0, 0, width, height);
  e.fillStyle = '#000';
  e.fillRect(0, 0, width, height);
  r.fillStyle = glass ? '#6a6a6a' : '#c8c4be';
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
      r.fillStyle = lit ? '#2a2a2a' : '#3a3a3a';
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

  return {
    map: canvasTexture(color),
    emissiveMap: canvasTexture(emissive),
    roughnessMap: canvasTexture(rough, { color: false }),
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

function makeGrassMaps(dayMode = true) {
  const color = noiseCanvas(256, 256, (ctx, w, h) => {
    // Sunlit turf sits near 0.13 albedo; the darker base is the night palette.
    ctx.fillStyle = dayMode ? '#416b39' : '#1c3a22';
    ctx.fillRect(0, 0, w, h);
    const lift = dayMode ? 78 : 0;
    for (let i = 0; i < 2200; i++) {
      const g = 70 + lift + Math.random() * 50;
      ctx.fillStyle = `rgba(${30 + lift + Math.random() * 20},${g},${40 + lift * 0.5 + Math.random() * 20},${0.18 + Math.random() * 0.25})`;
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
    map: canvasTexture(color, { repeat: 2 }),
    roughnessMap: canvasTexture(rough, { color: false, repeat: 2 }),
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
    map: canvasTexture(color, { repeat: 10 }),
    roughnessMap: canvasTexture(rough, { color: false, repeat: 10 }),
  };
}

function makeRoadMaps(dayMode = true) {
  const color = noiseCanvas(128, 128, (ctx, w, h) => {
    // Sunlit asphalt is around 0.09 albedo once the road tint is applied; the
    // near-black base below is the night palette.
    ctx.fillStyle = dayMode ? '#6e7076' : '#2a2c32';
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

function makeNightEnv() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#05070c');
  g.addColorStop(0.46, '#0a121c');
  g.addColorStop(0.52, '#2a2218');
  g.addColorStop(0.58, '#10141a');
  g.addColorStop(1, '#07090e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = `rgba(255,220,160,${0.04 + Math.random() * 0.08})`;
    ctx.fillRect(Math.random() * 256, 62 + Math.random() * 10, 3 + Math.random() * 8, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function stdMat(maps, extras = {}) {
  return new THREE.MeshStandardMaterial({
    map: maps.map,
    roughnessMap: maps.roughnessMap,
    emissiveMap: maps.emissiveMap,
    color: extras.color ?? 0xffffff,
    roughness: extras.roughness ?? 0.7,
    metalness: extras.metalness ?? 0.08,
    emissive: extras.emissive ?? 0xffcc88,
    emissiveIntensity: extras.emissiveIntensity ?? 0,
    vertexColors: extras.vertexColors ?? true,
    envMapIntensity: extras.envMapIntensity ?? 0.35,
  });
}

export function createCityMaterials({ dayMode = true } = {}) {
  facadeDayMode = dayMode;
  const families = {
    lowrise: {
      mat: stdMat(
        paintFacade({
          seed: 11,
          base: '#3a322c',
          mortar: '#2a241e',
          cols: 5,
          rows: 6,
          litChance: dayMode ? 0.04 : 0.18,
          brick: true,
        }),
        { roughness: 0.88, metalness: 0.04, emissiveIntensity: dayMode ? 0.08 : 0.55 },
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
        { roughness: 0.84, metalness: 0.05, emissiveIntensity: 0.7 },
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
        { roughness: 0.78, metalness: 0.08, emissiveIntensity: 0.72 },
      ),
      floorH: 3.8,
      windowW: 3.3,
    },
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
        { roughness: 0.42, metalness: 0.38, emissiveIntensity: 0.8, envMapIntensity: 0.7 },
      ),
      floorH: 3.5,
      windowW: 3.0,
    },
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
          roughness: 0.18,
          metalness: 0.62,
          emissive: 0xa8c4d8,
          emissiveIntensity: 0.85,
          envMapIntensity: 1.1,
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
          roughness: 0.14,
          metalness: 0.7,
          emissive: 0x6aa898,
          emissiveIntensity: 0.75,
          envMapIntensity: 1.2,
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
        { roughness: 0.8, metalness: 0.06, emissiveIntensity: 0.6 },
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
        { roughness: 0.7, metalness: 0.16, emissiveIntensity: 0.45 },
      ),
      floorH: 8.5,
      windowW: 10,
    },
    artdeco: {
      mat: stdMat(
        paintFacade({
          seed: 91,
          base: '#6a6458',
          mortar: '#4a4438',
          windowDark: '#0c0e10',
          windowLit: '#e8d090',
          cols: 5,
          rows: 9,
          litChance: 0.26,
          tallWindows: true,
        }),
        { roughness: 0.74, metalness: 0.1, emissiveIntensity: 0.65 },
      ),
      floorH: 4.2,
      windowW: 2.8,
    },
    chapel: {
      mat: stdMat(
        paintFacade({
          seed: 92,
          base: '#6e6860',
          mortar: '#3e3a34',
          windowDark: '#080a0c',
          windowLit: '#d8c878',
          cols: 4,
          rows: 5,
          litChance: 0.18,
          tallWindows: true,
        }),
        { roughness: 0.86, metalness: 0.03, emissiveIntensity: 0.5 },
      ),
      floorH: 5.8,
      windowW: 2.2,
    },
    sandstone: {
      mat: stdMat(
        paintFacade({
          seed: 93,
          base: '#7a7060',
          mortar: '#4a4438',
          windowDark: '#0a0c0e',
          windowLit: '#e0c070',
          cols: 6,
          rows: 7,
          litChance: 0.2,
        }),
        { roughness: 0.9, metalness: 0.02, emissiveIntensity: 0.45 },
      ),
      floorH: 4.5,
      windowW: 3.6,
    },
    copper: {
      mat: stdMat(
        paintFacade({
          seed: 94,
          base: '#4a6a58',
          mortar: '#2a4038',
          windowDark: '#0a1010',
          windowLit: '#c8d8a0',
          cols: 5,
          rows: 8,
          litChance: 0.22,
        }),
        { roughness: 0.68, metalness: 0.22, emissiveIntensity: 0.55 },
      ),
      floorH: 3.9,
      windowW: 3.2,
    },
    convention: {
      mat: stdMat(
        paintFacade({
          seed: 95,
          base: '#c8ccc8',
          mortar: '#a0a4a0',
          windowDark: '#101418',
          windowLit: '#e8ece8',
          cols: 10,
          rows: 4,
          litChance: 0.35,
          glass: true,
        }),
        { roughness: 0.35, metalness: 0.28, emissiveIntensity: 0.6, envMapIntensity: 0.9 },
      ),
      floorH: 6.0,
      windowW: 5.0,
    },
    steelTower: {
      mat: stdMat(
        paintFacade({
          seed: 96,
          base: '#5a4030',
          mortar: '#3a2818',
          windowDark: '#080808',
          windowLit: '#d0a870',
          cols: 7,
          rows: 11,
          litChance: 0.3,
          glass: true,
        }),
        { roughness: 0.55, metalness: 0.42, emissiveIntensity: 0.65, envMapIntensity: 0.8 },
      ),
      floorH: 3.6,
      windowW: 3.0,
    },
  };

  const grass = makeGrassMaps(dayMode);
  const ground = makeGroundMaps();
  const road = makeRoadMaps(dayMode);

  const parkMat = new THREE.MeshStandardMaterial({
    // The grass map already carries the green, so tinting it again in daylight
    // multiplied two dark values together and parks came out near black.
    color: dayMode ? 0xffffff : 0x2a5a34,
    map: grass.map,
    roughnessMap: grass.roughnessMap,
    roughness: 1,
    metalness: 0,
    emissive: 0x041208,
    emissiveIntensity: dayMode ? 0 : 0.2,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const { mat: waterMat, uniforms: waterUniforms } = createWaterMaterial({ dayMode });

  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: ground.map,
    roughnessMap: ground.roughnessMap,
    roughness: 0.94,
    metalness: 0.04,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const roadMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: road.map,
    roughness: 0.88,
    metalness: 0.08,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const foamMat = new THREE.MeshStandardMaterial({
    color: dayMode ? 0x8d8f86 : 0x3a4a46,
    roughness: 0.72,
    metalness: 0.12,
    emissive: 0x102018,
    emissiveIntensity: dayMode ? 0 : 0.15,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });

  const bankMat = new THREE.MeshStandardMaterial({
    color: dayMode ? 0x6d6250 : 0x2a2418,
    roughness: 0.95,
    metalness: 0.02,
  });

  const treeMat = new THREE.MeshStandardMaterial({
    // White in day mode because the planting supplies a per-instance tint, which
    // three.js multiplies against this; tinting twice crushed the canopy to black.
    color: dayMode ? 0xffffff : 0x0e1c12,
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
    envMap: makeNightEnv(),
    dayMode,
  };
}

const STYLE_FAMILY = {
  ppg: 'ppg',
  gothic: 'gothic',
  chapel: 'chapel',
  artdeco: 'artdeco',
  copper: 'copper',
  sandstone: 'sandstone',
  convention: 'convention',
  steelTower: 'steelTower',
  glass: 'glass',
  stadium: 'stadium',
  brick: 'brick',
};

export function buildingFamily(b) {
  if (b.style && STYLE_FAMILY[b.style]) return STYLE_FAMILY[b.style];
  const n = (b.n || '').toLowerCase();
  const h = b.h || 10;
  if (/ppg/.test(n)) return 'ppg';
  if (/cathedral of learning/.test(n)) return 'gothic';
  if (/chapel|church|cathedral/.test(n)) return 'chapel';
  if (/gulf tower|grant building/.test(n)) return 'artdeco';
  if (/koppers/.test(n)) return 'copper';
  if (/carnegie|soldiers and sailors/.test(n)) return 'sandstone';
  if (/pnc park|acrisure|stadium|heinz field/.test(n)) return 'stadium';
  if (b.f && b.f.length >= 3 && h < 60) {
    const [cx, cz] = footprintCentroid(b.f);
    if (Math.hypot(cx + 415, cz + 657) < 140) return 'stadium';
    if (Math.hypot(cx + 1169, cz + 635) < 180) return 'stadium';
  }
  if (/u\.?s\.? steel|us steel/.test(n)) return 'steelTower';
  if (/convention/.test(n)) return 'convention';
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
