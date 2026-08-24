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
 * Every family's palette is authored twice, because the night colours are
 * nowhere near a daylight reflectance: the night brickwork sits around 0.04
 * albedo where sunlit brick is nearer 0.25. Running the night set in daylight
 * flattens the city — no tonal range, so cornices, setbacks and pier bays stop
 * reading and the stock looks like plain dark boxes.
 *
 * Gamma-lifting the night colours instead was the previous approach and it does
 * not work either: a single exponent that brings brick up to 0.25 also drags
 * dark bronze and mirror glass up past 0.4, and it desaturates as it goes, so
 * the whole skyline converges on the same pale blue-grey. The daylight values
 * below are authored against the real materials instead. Set once by
 * `createCityMaterials` so all fourteen families switch together.
 */
let facadeDayMode = true;

/**
 * Gamma lift toward daylight reflectance, for the few colours that have no
 * authored daylight counterpart. Applied in sRGB so relative order survives.
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

/** sRGB hex or rgb() string -> [r, g, b] in 0..255. */
function parseRgb(css) {
  const hex = /^#([0-9a-f]{6})$/i.exec(css);
  if (hex) {
    const v = parseInt(hex[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const fn = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(css);
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : [128, 128, 128];
}

/** Scale a colour's luminance, clamped. `k` < 1 darkens, > 1 lightens. */
function shade(css, k) {
  const [r, g, b] = parseRgb(css);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/** Blend two colours in sRGB. `t` = 0 gives `a`, 1 gives `b`. */
function mixCss(a, b, t) {
  const A = parseRgb(a);
  const B = parseRgb(b);
  const f = (i) => Math.round(A[i] + (B[i] - A[i]) * t);
  return `rgb(${f(0)},${f(1)},${f(2)})`;
}

/**
 * Anchor swatches that `architecture.js` pins its trim triangles to, painted at
 * both the top and the bottom edge of the canvas.
 *
 * Which edge UV v = 0 lands on depends on the texture's `flipY`, which is true
 * by default for a CanvasTexture, so painting only the top-left corner - the
 * obvious reading of the paint code - actually put the anchors in the middle of
 * the bottom row of windows. Painting both edges makes the anchors correct
 * either way and keeps the two files from having to agree about it.
 *
 * Spans in UV, matching ROOF_UV and TRIM_UV in architecture.js:
 *   u 0     .. 0.0156   the dark anchor  (roof decks, soffits, storefront glazing)
 *   u 0.0156.. 0.0469   the stone anchor (base courses, cornices, parapets, piers)
 *   v within 0.0156 of either end
 * Trim triangles have all three vertices on one UV, so they sample mip 0 at any
 * range and hold their exact tone; the strips do not need to survive mipping.
 */
const PIN_DARK_U = 0.0156;
const PIN_STONE_U = 0.0469;
const PIN_V = 0.0156;

function paintPinStrip(ctx, width, height, dark, stone) {
  const band = Math.max(4, Math.round(height * PIN_V));
  for (const y of [0, height - band]) {
    ctx.fillStyle = dark;
    ctx.fillRect(0, y, Math.round(width * PIN_DARK_U), band);
    ctx.fillStyle = stone;
    ctx.fillRect(
      Math.round(width * PIN_DARK_U),
      y,
      Math.round(width * (PIN_STONE_U - PIN_DARK_U)),
      band,
    );
  }
}

/**
 * One texture repeat carries `cols` windows across and `rows` floors up; the
 * caller scales UVs so a repeat covers `cols * windowW` by `rows * floorH`
 * metres, putting one painted window on one real window.
 *
 * What has to read from 400-1500 m up is not the window itself - at that range
 * a window is one or two pixels and mips to a flat average - but the horizontal
 * and vertical BANDING between the windows: the spandrel under each sill, the
 * pier between each bay. So those bands carry most of the tonal range here, and
 * the window-to-wall contrast is deliberately kept low. The previous painting
 * did the opposite, outlining every window in near-black, and the result mipped
 * down to salt-and-pepper noise that read as a patterned box.
 */
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
  const day = facadeDayMode;
  const pal = (day && opts.day) || {};
  const base = pal.base ?? liftForDay(opts.base ?? '#3d322c');
  const mortar = pal.mortar ?? liftForDay(opts.mortar ?? '#2a2420');
  // Daylight glazing mirrors the sky rather than reading as a black hole, but
  // stays darker than the surrounding wall.
  const glazing =
    pal.windowDark ??
    (day ? liftForDay(opts.windowDark ?? '#07090d', 0.62) : (opts.windowDark ?? '#07090d'));
  const windowLit = opts.windowLit ?? '#e0b25a';
  // Painted or anodised frames are lighter than the glass they hold in daylight.
  // A dark frame is a night-time reading and it is what turned the window grid
  // into noise.
  const frame =
    pal.frame ??
    (opts.frame ? liftForDay(opts.frame) : day ? mixCss(base, '#e8e8e4', 0.35) : '#161410');
  const sky = day ? '#a8c6e0' : '#20303c';

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
    for (let y = 0; y < height; y += bh) {
      const shift = (y / bh) % 2 === 0 ? 0 : bw * 0.5;
      for (let x = -bw; x < width + bw; x += bw) {
        c.fillStyle = mortar;
        c.fillRect(x + shift, y, bw - 1, bh - 1);
        c.fillStyle = shade(base, 0.9 + rand() * 0.2);
        c.fillRect(x + shift + 1, y + 1, bw - 3, bh - 3);
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
  const reveal = Math.max(1, Math.round(cellH * 0.035));

  // Spandrel under each sill and pier beside each bay. These are the bands that
  // survive to flyover range, so they get real tonal separation: the spandrel
  // sits in the window head's shadow, the pier catches light on one flank.
  const spandrel = shade(base, day ? 0.82 : 0.7);
  const sill = shade(base, day ? 1.18 : 1.3);
  const pierLit = shade(base, day ? 1.1 : 1.16);
  const pierShade = shade(base, day ? 0.86 : 0.78);

  for (let row = 0; row < rows; row++) {
    const y = row * cellH + cellH * insetY;
    const h = cellH * (1 - insetY * 2);
    c.fillStyle = spandrel;
    c.fillRect(0, y + h, width, cellH * insetY * 2);
    c.fillStyle = sill;
    c.fillRect(0, y + h, width, Math.max(1, reveal * 0.7));
  }
  for (let col = 0; col < cols; col++) {
    const x = col * cellW;
    const pw = Math.max(1, Math.round(cellW * insetX));
    c.fillStyle = pierLit;
    c.fillRect(x, 0, pw, height);
    c.fillStyle = pierShade;
    c.fillRect(x + cellW - pw, 0, pw, height);
  }

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
        glow.addColorStop(1, shade(windowLit, 0.6));
        c.fillStyle = glow;
        e.fillStyle = windowLit;
      } else if (day) {
        // Sky at the head of the pane, the darker interior at the cill, and a
        // per-pane offset so the grid does not read as one repeated stamp.
        const jitter = 0.78 + rand() * 0.44;
        const g = c.createLinearGradient(x, y, x, y + h);
        g.addColorStop(0, shade(mixCss(glazing, sky, 0.5), jitter));
        g.addColorStop(0.55, shade(mixCss(glazing, sky, 0.22), jitter));
        g.addColorStop(1, shade(glazing, jitter * 0.92));
        c.fillStyle = g;
        e.fillStyle = '#000';
      } else {
        c.fillStyle = glazing;
        e.fillStyle = '#000';
      }
      c.fillRect(x, y, w, h);
      e.fillRect(x, y, w, h);
      r.fillStyle = lit ? '#2a2a2a' : '#3a3a3a';
      r.fillRect(x, y, w, h);

      // The head reveal: a real window is set back in its opening, and the
      // shadow the head casts on the glass is the cheapest depth cue there is.
      c.fillStyle = `rgba(0,0,0,${day ? 0.3 : 0.42})`;
      c.fillRect(x, y, w, reveal);
      c.fillRect(x, y, Math.max(1, reveal * 0.6), h);

      if (lit && rand() < 0.45) {
        c.fillStyle = 'rgba(255,230,180,0.25)';
        c.fillRect(x + 1, y + 1, w * 0.4, h * 0.35);
      } else if (!lit && rand() < 0.3) {
        // Blinds and curtains, which is most of what a daytime window shows.
        c.fillStyle = day ? 'rgba(228,226,216,0.5)' : 'rgba(120,124,132,0.16)';
        c.fillRect(x + reveal, y + reveal, w - reveal, h * (0.2 + rand() * 0.5));
      }
    }
  }

  paintPinStrip(c, width, height, day ? '#4c4a46' : '#1a1816', shade(base, day ? 1.06 : 1.15));
  paintPinStrip(e, width, height, '#000', '#000');
  paintPinStrip(r, width, height, '#b0b0b0', '#d0d0d0');

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

/**
 * Car park surface. One tile covers 22 m, which at 2.6 m per bay and a 6 m aisle
 * is one double-loaded bay run - the pattern that identifies surface parking
 * from the air more than the tone does.
 */
function makeParkingMaps(dayMode = true) {
  const color = noiseCanvas(256, 256, (ctx, w, h) => {
    ctx.fillStyle = dayMode ? '#74777c' : '#26282e';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.14})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 3, 3);
    }
    ctx.strokeStyle = dayMode ? 'rgba(226,222,206,0.5)' : 'rgba(150,146,132,0.3)';
    ctx.lineWidth = 2;
    // Two bay runs nose to nose, with the drive aisle between them.
    const bay = w / 8;
    for (const [y0, y1] of [
      [h * 0.06, h * 0.36],
      [h * 0.54, h * 0.84],
    ]) {
      for (let x = 0; x <= w; x += bay) {
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(w, y0);
      ctx.stroke();
    }
  });
  return { map: canvasTexture(color, { repeat: 1 }) };
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

/**
 * Daylight is a different scene, not the same scene turned up.
 *
 * Every palette below is authored for the night view: a third of the windows
 * lit, and emissive up around 0.7 so they glow. Run that same table in daylight
 * and every wall in the city carries a glowing orange grid, which is precisely
 * what makes the stock read as patterned boxes instead of buildings. In daylight
 * the windows are glass reflecting sky, and only the odd interior light shows.
 */
const DAY_LIT_SCALE = 0.06;

export function createCityMaterials({ dayMode = true } = {}) {
  facadeDayMode = dayMode;
  /** Facade material for one family, with the night palette adapted to daylight. */
  const facade = (paint, extras = {}) =>
    stdMat(
      paintFacade(
        dayMode ? { ...paint, litChance: (paint.litChance ?? 0.3) * DAY_LIT_SCALE } : paint,
      ),
      dayMode
        ? { ...extras, emissiveIntensity: (extras.emissiveIntensity ?? 0) * DAY_LIT_SCALE }
        : extras,
    );
  const families = {
    // Pittsburgh's low-rise stock is overwhelmingly red brick.
    lowrise: {
      mat: facade(
        {
          seed: 11,
          base: '#3a322c',
          mortar: '#2a241e',
          day: { base: '#8a6a58', mortar: '#6e5346', windowDark: '#586a76' },
          cols: 5,
          rows: 6,
          litChance: 0.18,
          brick: true,
        },
        { roughness: 0.88, metalness: 0.04, emissiveIntensity: 0.55 },
      ),
      floorH: 3.6,
      windowW: 3.8,
    },
    brick: {
      mat: facade(
        {
          seed: 22,
          base: '#4a3028',
          mortar: '#2c1e1a',
          day: { base: '#8f5a44', mortar: '#6b4033', windowDark: '#5a6c78' },
          cols: 6,
          rows: 8,
          litChance: 0.28,
          brick: true,
        },
        { roughness: 0.84, metalness: 0.05, emissiveIntensity: 0.7 },
      ),
      floorH: 3.7,
      windowW: 3.4,
    },
    // Buff limestone and terracotta, the commercial cladding of the 1900-1930
    // blocks that still make up most of the Golden Triangle below 30 storeys.
    limestone: {
      mat: facade(
        {
          seed: 33,
          base: '#5c584c',
          mortar: '#3a3830',
          day: { base: '#c4bda8', mortar: '#a49c88', windowDark: '#5d6d78' },
          windowLit: '#e8c878',
          cols: 6,
          rows: 8,
          litChance: 0.3,
        },
        { roughness: 0.78, metalness: 0.08, emissiveIntensity: 0.72 },
      ),
      floorH: 3.8,
      windowW: 3.3,
    },
    steel: {
      mat: facade(
        {
          seed: 44,
          base: '#3a4048',
          mortar: '#2a3038',
          windowDark: '#0a1014',
          day: { base: '#8e9aa4', mortar: '#75808a', windowDark: '#4e6472' },
          windowLit: '#d8c090',
          cols: 8,
          rows: 10,
          litChance: 0.38,
          glass: true,
        },
        {
          roughness: dayMode ? 0.5 : 0.42,
          metalness: dayMode ? 0.24 : 0.38,
          emissiveIntensity: 0.8,
          envMapIntensity: dayMode ? 0.8 : 0.7,
        },
      ),
      floorH: 3.5,
      windowW: 3.0,
    },
    glass: {
      mat: facade(
        {
          seed: 55,
          base: '#1a2830',
          mortar: '#0e181e',
          windowDark: '#0a1418',
          day: { base: '#93a8b8', mortar: '#7c909e', windowDark: '#546c7c', frame: '#b6c2cb' },
          windowLit: '#c8d8e8',
          frame: '#0a1014',
          cols: 8,
          rows: 10,
          litChance: 0.42,
          glass: true,
        },
        {
          roughness: dayMode ? 0.24 : 0.18,
          metalness: dayMode ? 0.45 : 0.62,
          emissive: 0xa8c4d8,
          emissiveIntensity: 0.85,
          envMapIntensity: dayMode ? 1.0 : 1.1,
        },
      ),
      floorH: 3.45,
      windowW: 2.7,
    },
    // PPG Place is 19,750 panes of mirror glass over six buildings. It reads as
    // a silver-grey mirror in daylight, not the near-black of the night palette.
    ppg: {
      mat: facade(
        {
          seed: 66,
          base: '#0c1c1c',
          mortar: '#061010',
          windowDark: '#061014',
          day: { base: '#9fb2bb', mortar: '#8496a0', windowDark: '#5d7684', frame: '#c2ccd2' },
          windowLit: '#8ec4b0',
          frame: '#081212',
          cols: 8,
          rows: 12,
          litChance: 0.34,
          glass: true,
        },
        {
          roughness: dayMode ? 0.16 : 0.14,
          metalness: dayMode ? 0.5 : 0.7,
          emissive: 0x6aa898,
          emissiveIntensity: 0.75,
          envMapIntensity: dayMode ? 1.15 : 1.2,
        },
      ),
      floorH: 3.4,
      windowW: 2.5,
    },
    gothic: {
      mat: facade(
        {
          seed: 77,
          base: '#6a6458',
          mortar: '#3e3a32',
          windowDark: '#0c0e12',
          day: { base: '#bdb298', mortar: '#9a8f76', windowDark: '#4f5a62' },
          windowLit: '#e8d090',
          cols: 5,
          rows: 6,
          litChance: 0.22,
          tallWindows: true,
        },
        { roughness: 0.8, metalness: 0.06, emissiveIntensity: 0.6 },
      ),
      floorH: 5.4,
      windowW: 2.5,
    },
    stadium: {
      mat: facade(
        {
          seed: 88,
          base: '#3a4034',
          mortar: '#2a2c26',
          windowDark: '#121410',
          day: { base: '#9ba1a6', mortar: '#7f858a', windowDark: '#4a5560' },
          windowLit: '#d0c080',
          cols: 4,
          rows: 4,
          litChance: 0.2,
          panels: true,
        },
        { roughness: 0.7, metalness: 0.16, emissiveIntensity: 0.45 },
      ),
      floorH: 8.5,
      windowW: 10,
    },
    artdeco: {
      mat: facade(
        {
          seed: 91,
          base: '#6a6458',
          mortar: '#4a4438',
          windowDark: '#0c0e10',
          day: { base: '#c7bba0', mortar: '#a3977c', windowDark: '#54626c' },
          windowLit: '#e8d090',
          cols: 5,
          rows: 9,
          litChance: 0.26,
          tallWindows: true,
        },
        { roughness: 0.74, metalness: 0.1, emissiveIntensity: 0.65 },
      ),
      floorH: 4.2,
      windowW: 2.8,
    },
    chapel: {
      mat: facade(
        {
          seed: 92,
          base: '#6e6860',
          mortar: '#3e3a34',
          windowDark: '#080a0c',
          day: { base: '#c0b6a4', mortar: '#9b9182', windowDark: '#4b555e' },
          windowLit: '#d8c878',
          cols: 4,
          rows: 5,
          litChance: 0.18,
          tallWindows: true,
        },
        { roughness: 0.86, metalness: 0.03, emissiveIntensity: 0.5 },
      ),
      floorH: 5.8,
      windowW: 2.2,
    },
    // The Carnegie group in Oakland is Ohio buff sandstone.
    sandstone: {
      mat: facade(
        {
          seed: 93,
          base: '#7a7060',
          mortar: '#4a4438',
          windowDark: '#0a0c0e',
          day: { base: '#bda98a', mortar: '#98866c', windowDark: '#525d66' },
          windowLit: '#e0c070',
          cols: 6,
          rows: 7,
          litChance: 0.2,
        },
        { roughness: 0.9, metalness: 0.02, emissiveIntensity: 0.45 },
      ),
      floorH: 4.5,
      windowW: 3.6,
    },
    // Oxidised copper: the Koppers chateau roof and its kin.
    copper: {
      mat: facade(
        {
          seed: 94,
          base: '#4a6a58',
          mortar: '#2a4038',
          windowDark: '#0a1010',
          day: { base: '#7f9c8c', mortar: '#5f7a6c', windowDark: '#4c5f5c' },
          windowLit: '#c8d8a0',
          cols: 5,
          rows: 8,
          litChance: 0.22,
        },
        { roughness: 0.68, metalness: 0.22, emissiveIntensity: 0.55 },
      ),
      floorH: 3.9,
      windowW: 3.2,
    },
    convention: {
      mat: facade(
        {
          seed: 95,
          base: '#c8ccc8',
          mortar: '#a0a4a0',
          windowDark: '#101418',
          day: { base: '#ccd0d2', mortar: '#adb2b5', windowDark: '#5b6d78' },
          windowLit: '#e8ece8',
          cols: 10,
          rows: 4,
          litChance: 0.35,
          glass: true,
        },
        { roughness: 0.35, metalness: 0.28, emissiveIntensity: 0.6, envMapIntensity: 0.9 },
      ),
      floorH: 6.0,
      windowW: 5.0,
    },
    // The US Steel Tower is clad in liquid-filled Cor-Ten box columns that were
    // left to weather. It is the darkest thing on the skyline in any light.
    steelTower: {
      mat: facade(
        {
          seed: 96,
          base: '#5a4030',
          mortar: '#3a2818',
          windowDark: '#080808',
          day: { base: '#6b5140', mortar: '#4f3b2c', windowDark: '#40484c' },
          windowLit: '#d0a870',
          cols: 7,
          rows: 11,
          litChance: 0.3,
          glass: true,
        },
        {
          roughness: dayMode ? 0.6 : 0.55,
          metalness: dayMode ? 0.3 : 0.42,
          emissiveIntensity: 0.65,
          envMapIntensity: dayMode ? 0.7 : 0.8,
        },
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

  // Car parks, yards and plazas. Sunlit asphalt sits near 0.12 albedo, a little
  // darker than the mixed ground it is cut out of, and the paint striping is
  // what makes a lot read as a lot rather than a grey hole. The tint multiplies
  // the map, so it has to be near white to land on 0.12 rather than on 0.04.
  const pavingMat = new THREE.MeshStandardMaterial({
    color: dayMode ? 0xdcdcde : 0x4a4c52,
    map: makeParkingMaps(dayMode).map,
    roughness: 0.9,
    metalness: 0.06,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const sandMat = new THREE.MeshStandardMaterial({
    color: dayMode ? 0xa89878 : 0x2e2820,
    roughness: 0.96,
    metalness: 0.01,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
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
    pavingMat,
    sandMat,
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
  stone: 'limestone',
};

/** Stable 0..1 from a footprint centroid, so a building keeps its cladding. */
function claddingRoll(footprint) {
  if (!footprint || footprint.length < 3) return 0.5;
  const [cx, cz] = footprintCentroid(footprint);
  const s = Math.imul(Math.round(cx * 7) ^ 0x9e3779b9, Math.round(cz * 13) | 1);
  return ((s >>> 8) & 0xffff) / 0x10000;
}

/**
 * Cladding family for an untagged footprint.
 *
 * Height alone is a poor proxy, and using it as a strict ladder gave every
 * building in a band the same cladding: the whole 28-55 m stock came out cream
 * limestone and everything above it pale blue curtain wall, which is what made
 * the skyline read as a set of identical pale slabs. Pittsburgh's tall stock is
 * actually mostly pre-war masonry — Gulf, Koppers, Grant, Frick and Union Trust
 * are all stone-clad and all over 70 m — so each band is split by a stable roll
 * on the footprint, weighted to what the district really holds.
 */
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
  const roll = claddingRoll(b.f);
  if (b.landmark || h > 100) return roll < 0.68 ? 'glass' : 'artdeco';
  if (h > 55) return roll < 0.42 ? 'steel' : roll < 0.78 ? 'limestone' : 'artdeco';
  if (h > 28) return roll < 0.58 ? 'limestone' : roll < 0.88 ? 'brick' : 'steel';
  if (h > 14) return roll < 0.78 ? 'brick' : 'limestone';
  return roll < 0.86 ? 'lowrise' : 'brick';
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
