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
 * Roughness in the green channel, metalness in the blue one, which is exactly
 * where three.js reads them from, so one canvas drives both.
 *
 * A single scalar metalness for a whole facade is what made every curtain-wall
 * building read as one shiny pale slab: at metalness 0.45 the spandrels and
 * mullions mirror the sky as hard as the glass does, so the wall averages to
 * sky blue and the glazing pattern disappears into it. Per-texel metalness
 * keeps the glass a mirror and leaves the frame and the wall dielectric.
 */
function rm(rough, metal) {
  const q = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(0,${q(rough)},${q(metal)})`;
}

/**
 * Soft stain, repeated across the canvas edges it overlaps so the tiling does
 * not cut it in half. Pittsburgh masonry is soot-streaked, and the streaking is
 * most of what stops a brick wall reading as printed graph paper.
 */
function stain(ctx, w, h, x, y, radius, rgb, alpha) {
  const xs = x < radius ? [x, x + w] : x > w - radius ? [x, x - w] : [x];
  const ys = y < radius ? [y, y + h] : y > h - radius ? [y, y - h] : [y];
  for (const px of xs) {
    for (const py of ys) {
      const g = ctx.createRadialGradient(px, py, 0, px, py, radius);
      g.addColorStop(0, `rgba(${rgb},${alpha})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
    }
  }
}

/**
 * Common bond brickwork. Three separate scales of variation, because any one of
 * them alone reads as noise: a per-course drift for the kiln run, a per-brick
 * scatter, and the odd burnt-dark header.
 */
function paintBrick(c, w, h, base, mortar, rand) {
  const bh = 7;
  const bw = 15;
  c.fillStyle = mortar;
  c.fillRect(0, 0, w, h);
  for (let y = 0, course = 0; y < h; y += bh, course++) {
    const drift = 0.88 + rand() * 0.26;
    const shift = course % 2 ? bw * 0.5 : 0;
    for (let x = -bw; x < w + bw; x += bw) {
      const t = rand();
      c.fillStyle = shade(base, drift * (t < 0.07 ? 0.48 + t : 0.82 + t * 0.44));
      c.fillRect(x + shift, y, bw - 1.5, bh - 1.5);
    }
  }
}

/** Coursed ashlar stone: bigger units than brick, tighter joints, less scatter. */
function paintAshlar(c, w, h, base, mortar, rand, blockW = 32, blockH = 22) {
  c.fillStyle = mortar;
  c.fillRect(0, 0, w, h);
  for (let y = 0, course = 0; y < h; y += blockH, course++) {
    const drift = 0.96 + rand() * 0.08;
    const shift = course % 2 ? blockW * 0.5 : 0;
    for (let x = -blockW; x < w + blockW; x += blockW) {
      c.fillStyle = shade(base, drift * (0.95 + rand() * 0.1));
      c.fillRect(x + shift, y, blockW - 1.2, blockH - 1.2);
    }
  }
}

/** Precast concrete panels with a recessed joint: post-war institutional bulk. */
function paintPanels(c, w, h, base, mortar, rand, nx = 3, ny = 4) {
  c.fillStyle = base;
  c.fillRect(0, 0, w, h);
  const pw = w / nx;
  const ph = h / ny;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      c.fillStyle = shade(base, 0.96 + rand() * 0.09);
      c.fillRect(ix * pw, iy * ph, pw - 2, ph - 2);
      c.fillStyle = mortar;
      c.fillRect(ix * pw + pw - 2, iy * ph, 2, ph);
      c.fillRect(ix * pw, iy * ph + ph - 2, pw, 2);
    }
  }
}

/**
 * Weathering-steel box columns. The oxide coat is blotchy and the columns
 * themselves are the wall, so the vertical rhythm has to come from the metal
 * rather than from windows punched into it.
 */
function paintOxide(c, w, h, base, mortar, rand, cols) {
  c.fillStyle = base;
  c.fillRect(0, 0, w, h);
  const cw = w / cols;
  for (let i = 0; i < cols; i++) {
    c.fillStyle = shade(base, 0.9 + rand() * 0.2);
    c.fillRect(i * cw, 0, cw, h);
    c.fillStyle = shade(mortar, 0.9);
    c.fillRect(i * cw, 0, 1.5, h);
  }
  for (let i = 0; i < 140; i++) {
    stain(c, w, h, rand() * w, rand() * h, 8 + rand() * 26, '92,52,26', 0.05 + rand() * 0.1);
  }
}

/**
 * One pane of glazing.
 *
 * Real curtain wall is nothing like a flat tone: each unit sits at a slightly
 * different angle in its frame, so a handful of panes catch the sky and go
 * near-white while others look straight into a dark interior, and the scatter
 * between them is what identifies the surface as glass. A uniform tint with a
 * uniform gradient - which is what this used to be - reads as painted board.
 */
const PANE_MEAN = 0.31;

function paintPane(c, x, y, w, h, p) {
  const {
    glazing, sky, rand, day, lit, windowLit,
    band = 1, facet = 1, skyGain = 1, dim = 1, jitter = 1,
  } = p;
  if (lit) {
    // Daylight swamps an interior, so a lit window in sun is only a slight
    // warm lift on the glass rather than the lantern it is after dark.
    const top = day ? mixCss(windowLit, glazing, 0.5) : windowLit;
    const g = c.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, top);
    g.addColorStop(1, shade(top, 0.6));
    c.fillStyle = g;
    c.fillRect(x, y, w, h);
    return;
  }
  if (!day) {
    c.fillStyle = shade(glazing, 0.85 + rand() * 0.3);
    c.fillRect(x, y, w, h);
    return;
  }
  const t = rand();
  const spread = t < 0.08 ? 0.46 + t * 1.0 : t < 0.3 ? 0.06 + t * 0.2 : 0.14 + t * 0.34;
  // A punched window is genuinely a lottery - blinds up, blinds down, dark
  // room - so it wants the full spread. A coated curtain wall does not: its
  // panes are one continuous plane, so pane-to-pane scatter at that amplitude
  // reads as a checkerboard of noise. Damping the spread toward its mean and
  // moving the contrast onto the bay (below) is what makes it read as glazing.
  const skyMix = skyGain * (PANE_MEAN + (spread - PANE_MEAN) * jitter);
  const k = band * facet * dim * (1 - 0.14 * jitter + rand() * 0.28 * jitter);
  const g = c.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, shade(mixCss(glazing, sky, Math.min(0.96, skyMix + 0.2 * skyGain)), k));
  g.addColorStop(0.62, shade(mixCss(glazing, sky, skyMix), k));
  g.addColorStop(1, shade(mixCss(glazing, sky, skyMix * 0.35), k * 0.9));
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
}

/**
 * One texture repeat carries `cols` windows across and `rows` floors up; the
 * caller scales UVs so a repeat covers `cols * windowW` by `rows * floorH`
 * metres, putting one painted window on one real window. `cols`/`rows` must
 * match FACADE_GRID in architecture.js.
 *
 * What has to read from 400-1500 m up is not the window itself - at that range
 * a window is one or two pixels and mips to a flat average - but the RHYTHM:
 * the spandrel course under each sill, the pier between each bay, the band of
 * glazing across a floor. That rhythm is also what dates a building, so it is
 * authored per era rather than as one grid of punched squares at one contrast:
 *
 *   punched  pre-war masonry. Small openings, deep head reveal, a continuous
 *            stone sill course, wall area dominant so the brick or stone tone
 *            is what survives mipping.
 *   ribbon   mid-century. Continuous horizontal glazing bands between opaque
 *            spandrel courses, slim mullions, no piers.
 *   curtain  late modern. Near-continuous glazing, slim mullions, and a
 *            spandrel panel of a DIFFERENT material between floors.
 *   panel    precast bulk: arena and convention-centre walls.
 */
function paintFacade(opts) {
  const {
    seed = 1,
    width = 512,
    height = 512,
    cols = 6,
    rows = 8,
    litChance = 0.32,
    wall = 'stone',
    era = 'punched',
    winW = 0.44,
    winH = 0.58,
    headDrop = 0.16,
    pierW = 0,
    bandH = 0.48,
    spandrelH = 0.3,
    mullionW = 0.06,
    facetBays = 0,
    // How much sky a pane can pick up. A punched masonry window is a hole into
    // a dark room with a single sheet of clear glass in it, so it stays dark and
    // only catches sky at a glancing angle; a coated curtain wall is a mirror.
    // Running one value for both is what made pre-war walls read as a grid of
    // pale blue dots.
    skyGain = era === 'punched' || era === 'panel' ? 0.38 : 1,
    // How far pane-to-pane tone is allowed to scatter. See paintPane.
    paneJitter = era === 'curtain' ? 0.42 : era === 'ribbon' ? 0.7 : 1,
    beltCourse = false,
    soot = 0,
    wallRough = 0.9,
    wallMetal = 0.03,
    glassRough = 0.16,
    glassMetal = 0.5,
    trimRough = 0.84,
    // Roughness of the dark pin swatch, which is every roof deck, soffit and
    // shingle in architecture.js. Matte is right for all of them except a
    // glazed roof, where the vault is the same glass as the walls.
    roofRough = 0.82,
    windowLit = '#e0b25a',
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
  // Stone trim. On a brick building this is a genuinely different material -
  // limestone sills, lintels and belt courses on dark brick - and it is also
  // the swatch every cornice, parapet and pier in architecture.js samples.
  const trim = pal.trim ?? (opts.trim ? liftForDay(opts.trim) : shade(base, day ? 1.14 : 1.2));
  // Spandrel: the opaque panel between floors of a curtain wall, and the
  // recessed course under a punched window.
  const spandrel =
    pal.spandrel ?? (opts.spandrel ? liftForDay(opts.spandrel) : shade(base, day ? 0.8 : 0.68));
  const mullion =
    pal.mullion ??
    (opts.mullion ? liftForDay(opts.mullion) : day ? mixCss(base, '#e8e8e4', 0.4) : '#1a1816');
  const roofPin =
    pal.roofPin ?? (opts.roofPin ? liftForDay(opts.roofPin) : day ? '#4c4a46' : '#1a1816');
  // What the glazing reflects. Bronze and Cor-Ten glass mirrors a warm sky, not
  // the same cold blue as a clear-glass curtain wall.
  const sky = pal.sky ?? (day ? '#c6dcf0' : '#20303c');

  const rand = rng(seed);
  const { color, emissive, rough, c, e, r } = makeCanvases(width, height);

  e.fillStyle = '#000';
  e.fillRect(0, 0, width, height);
  r.fillStyle = rm(wallRough, wallMetal);
  r.fillRect(0, 0, width, height);

  // Interior lighting is a night phenomenon. Running the night rate through
  // daylight painted a third of every wall as a saturated orange rectangle,
  // which at district range was most of what "evenly spaced dots" meant: the
  // dots were lit windows, not glazing. A few per cent survive, because a deep
  // floorplate really does keep its lights on at noon.
  const litRate = day ? litChance * 0.07 : litChance;

  if (wall === 'brick') paintBrick(c, width, height, base, mortar, rand);
  else if (wall === 'panel') paintPanels(c, width, height, base, mortar, rand, 3, rows);
  else if (wall === 'oxide') paintOxide(c, width, height, base, mortar, rand, cols);
  else if (wall === 'metal') {
    c.fillStyle = base;
    c.fillRect(0, 0, width, height);
  } else paintAshlar(c, width, height, base, mortar, rand);

  // Soot and rain-washing. Masonry gets a lot, glass and metal almost none.
  // Two scales: broad patches that survive mipping and read as weathering at
  // any distance, and finer streaks that only show up close. Without the broad
  // pass a stone wall mips to one flat tone and looks poured, not built.
  for (let i = 0; i < Math.round(soot * 26); i++) {
    stain(c, width, height, rand() * width, rand() * height, 70 + rand() * 130, '30,24,18', 0.05 + rand() * 0.1);
  }
  for (let i = 0; i < Math.round(soot * 110); i++) {
    stain(c, width, height, rand() * width, rand() * height, 10 + rand() * 40, '26,20,15', 0.04 + rand() * 0.12);
  }
  // Rain-washed stone is lighter where the water runs, and that is what makes a
  // masonry wall read as weathered rather than merely dirty.
  for (let i = 0; i < Math.round(soot * 18); i++) {
    stain(c, width, height, rand() * width, rand() * height, 40 + rand() * 90, '236,230,214', 0.03 + rand() * 0.07);
  }

  const cellW = width / cols;
  const cellH = height / rows;
  const px = (v) => Math.max(1, Math.round(v));
  // Seamless across the vertical wrap, so the tone drift up the wall does not
  // put a hard line every `rows` floors.
  const rowBand = (row) => 1 + 0.05 * Math.sin((row / rows) * Math.PI * 2);

  if (era === 'punched' || era === 'panel') {
    const gw = cellW * winW;
    const gh = cellH * winH;
    const off = (cellW - gw) / 2;
    const reveal = px(cellH * 0.045);

    for (let row = 0; row < rows; row++) {
      const y = row * cellH + cellH * headDrop;
      // Continuous stone sill course under the openings, and on the
      // heavier-trimmed stock a lintel course over them. These two horizontals
      // are the strongest thing on a pre-war wall from any distance.
      c.fillStyle = trim;
      c.fillRect(0, y + gh, width, px(cellH * 0.03));
      if (beltCourse) {
        c.fillStyle = shade(trim, 0.9);
        c.fillRect(0, y - px(cellH * 0.035), width, px(cellH * 0.035));
      }
      r.fillStyle = rm(trimRough, wallMetal);
      r.fillRect(0, y + gh, width, px(cellH * 0.03));
    }

    // Piers. Art Deco towers are read almost entirely off these: a continuous
    // stone shaft up the full height with the glazing set back between them.
    if (pierW > 0) {
      const pw = px(cellW * pierW);
      for (let col = 0; col < cols; col++) {
        const x = col * cellW;
        c.fillStyle = shade(trim, 1.02);
        c.fillRect(x - pw * 0.5, 0, pw, height);
        c.fillStyle = 'rgba(0,0,0,0.16)';
        c.fillRect(x + pw * 0.5 - px(pw * 0.22), 0, px(pw * 0.22), height);
      }
    }

    for (let row = 0; row < rows; row++) {
      const band = rowBand(row);
      for (let col = 0; col < cols; col++) {
        const lit = rand() < litRate;
        const x = col * cellW + off;
        const y = row * cellH + cellH * headDrop;

        // The opening is a hole in masonry: dark jamb line all round, then the
        // glass, then the shadow the head casts down onto it.
        c.fillStyle = `rgba(0,0,0,${day ? 0.24 : 0.5})`;
        c.fillRect(x - 1, y - 1, gw + 2, gh + 2);
        paintPane(c, x, y, gw, gh, {
          glazing, sky, rand, day, lit, windowLit, band, skyGain, dim: 0.82,
        });
        c.fillStyle = `rgba(0,0,0,${day ? 0.44 : 0.5})`;
        c.fillRect(x, y, gw, reveal);
        c.fillRect(x, y, px(reveal * 0.7), gh);
        // Sunlit reveal on the opposite jamb, which is what makes the opening
        // read as set back rather than painted on.
        c.fillStyle = 'rgba(255,250,240,0.13)';
        c.fillRect(x + gw - px(reveal * 0.5), y + reveal, px(reveal * 0.5), gh - reveal);

        e.fillStyle = lit ? windowLit : '#000';
        e.fillRect(x, y, gw, gh);
        r.fillStyle = rm(glassRough, glassMetal);
        r.fillRect(x, y, gw, gh);

        if (lit && rand() < 0.45) {
          c.fillStyle = 'rgba(255,230,180,0.25)';
          c.fillRect(x + 1, y + 1, gw * 0.4, gh * 0.35);
        } else if (!lit && rand() < 0.18) {
          // Blinds, which is most of what a daytime window actually shows. At a
          // quarter of openings and near-white they were the pale dots on the
          // brick, so they are rarer and closer to the glass they sit behind.
          c.fillStyle = day ? 'rgba(214,209,196,0.2)' : 'rgba(120,124,132,0.16)';
          c.fillRect(x + reveal, y + reveal, gw - reveal * 2, gh * (0.16 + rand() * 0.44));
        }
      }
    }
  } else if (era === 'ribbon') {
    const gh = cellH * bandH;
    const mw = px(cellW * mullionW);
    for (let row = 0; row < rows; row++) {
      const y = row * cellH + cellH * headDrop;
      const band = rowBand(row);

      // Opaque spandrel course between the glazing bands, in its own material.
      c.fillStyle = spandrel;
      c.fillRect(0, y + gh, width, cellH - gh);
      r.fillStyle = rm(wallRough * 0.8, wallMetal + 0.06);
      r.fillRect(0, y + gh, width, cellH - gh);

      // The glazing band, pane by pane so the sky scatter still varies across
      // a continuous strip.
      for (let col = 0; col < cols; col++) {
        const lit = rand() < litRate;
        const x = col * cellW;
        paintPane(c, x, y, cellW, gh, {
          glazing, sky, rand, day, lit, windowLit, band, skyGain, jitter: paneJitter,
        });
        e.fillStyle = lit ? windowLit : '#000';
        e.fillRect(x, y, cellW, gh);
      }
      r.fillStyle = rm(glassRough, glassMetal);
      r.fillRect(0, y, width, gh);

      // Head shadow along the top of the band, then the mullions, then the
      // light sill line the band sits on.
      c.fillStyle = `rgba(0,0,0,${day ? 0.38 : 0.45})`;
      c.fillRect(0, y, width, px(gh * 0.12));
      for (let col = 0; col < cols; col++) {
        c.fillStyle = mullion;
        c.fillRect(col * cellW, y, mw, gh);
        c.fillStyle = 'rgba(0,0,0,0.3)';
        c.fillRect(col * cellW + mw, y, px(mw * 0.5), gh);
      }
      c.fillStyle = shade(trim, 1.04);
      c.fillRect(0, y + gh, width, px(cellH * 0.035));
      r.fillStyle = rm(trimRough, wallMetal);
      r.fillRect(0, y + gh, width, px(cellH * 0.035));
    }
  } else {
    // curtain wall
    const gh = cellH * (1 - spandrelH);
    const mw = px(cellW * mullionW);
    // Per-bay tone, held constant up the full height. On a real tower the
    // differences between panes run in vertical stripes - a plane of glass a
    // fraction out of true, one line of blinds, one bay in shade - so the
    // variation belongs to the bay, not to the individual pane.
    const bayGain = [];
    for (let col = 0; col < cols; col++) {
      const s = Math.abs(Math.sin((col + 1) * 12.9898 + seed) * 43758.5453);
      bayGain.push(0.88 + (s - Math.floor(s)) * 0.24);
    }
    for (let row = 0; row < rows; row++) {
      const y = row * cellH;
      const band = rowBand(row);

      c.fillStyle = spandrel;
      c.fillRect(0, y + gh, width, cellH - gh);
      r.fillStyle = rm(wallRough * 0.7, wallMetal + 0.1);
      r.fillRect(0, y + gh, width, cellH - gh);
      c.fillStyle = 'rgba(0,0,0,0.22)';
      c.fillRect(0, y + gh, width, px(cellH * 0.03));

      for (let col = 0; col < cols; col++) {
        const lit = rand() < litRate;
        // Faceted glazing: PPG Place pleats its curtain wall vertically, so
        // alternate bays catch the sky and the ones between them go dark.
        const pleat = facetBays
          ? (col % facetBays === 0 ? 1.3 : col % facetBays === 1 ? 0.7 : 0.98)
          : 1;
        const x = col * cellW;
        paintPane(c, x, y, cellW, gh, {
          glazing, sky, rand, day, lit, windowLit, band, skyGain,
          facet: pleat * bayGain[col],
          jitter: paneJitter,
        });
        e.fillStyle = lit ? windowLit : '#000';
        e.fillRect(x, y, cellW, gh);
      }
      r.fillStyle = rm(glassRough, glassMetal);
      r.fillRect(0, y, width, gh);

      c.fillStyle = `rgba(0,0,0,${day ? 0.26 : 0.4})`;
      c.fillRect(0, y, width, px(cellH * 0.03));
      for (let col = 0; col < cols; col++) {
        c.fillStyle = mullion;
        c.fillRect(col * cellW, y, mw, cellH);
        c.fillStyle = 'rgba(0,0,0,0.34)';
        c.fillRect(col * cellW + mw, y, px(mw * 0.6), cellH);
        r.fillStyle = rm(wallRough * 0.6, wallMetal + 0.2);
        r.fillRect(col * cellW, y, mw, cellH);
      }
    }
    // Deep piers between bays, for a wall that is structure first and glass
    // second: the US Steel box columns rather than a taut glass skin.
    if (pierW > 0) {
      const pw = px(cellW * pierW);
      for (let col = 0; col < cols; col++) {
        const x = col * cellW - pw * 0.5;
        c.fillStyle = base;
        c.fillRect(x, 0, pw, height);
        c.fillStyle = 'rgba(0,0,0,0.3)';
        c.fillRect(x + pw * 0.66, 0, px(pw * 0.34), height);
        c.fillStyle = 'rgba(255,244,228,0.1)';
        c.fillRect(x, 0, px(pw * 0.3), height);
        r.fillStyle = rm(wallRough, wallMetal);
        r.fillRect(x, 0, pw, height);
      }
    }
  }

  paintPinStrip(c, width, height, roofPin, trim);
  paintPinStrip(e, width, height, '#000', '#000');
  paintPinStrip(r, width, height, rm(roofRough, wallMetal), rm(trimRough, wallMetal));

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
    // Same canvas for both: three.js reads roughness from .g and metalness from
    // .b, so the facade can carry rough dielectric spandrel and mirror glazing
    // side by side. The scalars stay at 1 and let the map decide.
    roughnessMap: maps.roughnessMap,
    metalnessMap: maps.roughnessMap,
    emissiveMap: maps.emissiveMap,
    color: extras.color ?? 0xffffff,
    roughness: extras.roughness ?? 1,
    metalness: extras.metalness ?? 1,
    emissive: extras.emissive ?? 0xffcc88,
    emissiveIntensity: extras.emissiveIntensity ?? 0,
    vertexColors: extras.vertexColors ?? true,
    envMapIntensity: extras.envMapIntensity ?? 0.35,
  });
}

/**
 * The wet band along a shoreline: broken water, silt and weed over the first
 * few metres of bank.
 *
 * It is a 7 m ribbon, so from anywhere the city is actually viewed from it is a
 * line one pixel wide or less - and a pale line that narrow does not average
 * into the bank, it aliases into a hard continuous outline tracing every bank
 * in the frame. That outline is a large part of what made the rivers read as
 * pasted onto the terrain rather than cut into it.
 *
 * So it is authored close to the water it edges, and faded out with view
 * distance: broken water is only visible from close enough to resolve it, and
 * beyond that the shoreline is just where one surface meets another. The fade
 * lives in the shader rather than in a per-frame uniform because view depth is
 * already computed in the vertex stage, and nothing outside this file drives
 * this material - a uniform would need an update hook in the render loop.
 */
const FOAM_NEAR = 170;
const FOAM_FAR = 560;

function makeFoamMaterial(dayMode) {
  const mat = new THREE.MeshStandardMaterial({
    color: dayMode ? 0x6c7067 : 0x2c3a37,
    roughness: 0.82,
    metalness: 0.06,
    emissive: 0x102018,
    emissiveIntensity: dayMode ? 0 : 0.12,
    side: THREE.DoubleSide,
    transparent: true,
    // The ribbon lies flat on the water it belongs to, so it must not occlude
    // the river surface or the far bank behind it.
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFoamDepth;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n\tvFoamDepth = -mvPosition.z;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFoamDepth;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n\tdiffuseColor.a *= 1.0 - smoothstep( ' +
          `${FOAM_NEAR.toFixed(1)}, ${FOAM_FAR.toFixed(1)}, vFoamDepth );`,
      );
  };
  // Program cache keys are built from the defines, which this edit does not
  // change, so without a key of its own the foam would share a compiled program
  // with any other standard material that happens to match it.
  mat.customProgramCacheKey = () => 'foam-distance-fade';
  return mat;
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
    // Pittsburgh's low-rise stock is overwhelmingly red brick, and it is dark:
    // local clay fired to a deep red-brown, then a century of soot on top.
    lowrise: {
      mat: facade(
        {
          seed: 11,
          base: '#3a322c',
          mortar: '#2a241e',
          day: {
            base: '#8a4a37',
            mortar: '#655045',
            windowDark: '#2e3740',
            trim: '#7d7060',
            roofPin: '#4a4640',
          },
          cols: 5,
          rows: 6,
          litChance: 0.18,
          wall: 'brick',
          era: 'punched',
          winW: 0.4,
          winH: 0.54,
          soot: 0.9,
          wallRough: 0.95,
          glassRough: 0.55,
          glassMetal: 0.08,
        },
        { emissiveIntensity: 0.55, envMapIntensity: 0.3 },
      ),
      floorH: 3.6,
      windowW: 3.8,
    },
    // The loft and warehouse stock: darker, sootier brick than the rowhouses,
    // with limestone sills, lintels and belt courses - the light-on-dark
    // contrast that identifies the type from any distance.
    brick: {
      mat: facade(
        {
          seed: 22,
          base: '#4a3028',
          mortar: '#2c1e1a',
          day: {
            base: '#6f4031',
            mortar: '#524036',
            windowDark: '#2a323b',
            // A cornice in full sun lifts a long way past its albedo, and at
            // limestone value the parapet band came out brighter than any wall
            // in the district - a white stripe round every warehouse roof.
            trim: '#6e6152',
            roofPin: '#454239',
          },
          cols: 6,
          rows: 8,
          litChance: 0.28,
          wall: 'brick',
          era: 'punched',
          winW: 0.44,
          winH: 0.6,
          beltCourse: true,
          soot: 1.1,
          wallRough: 0.93,
          glassRough: 0.52,
          glassMetal: 0.09,
        },
        { emissiveIntensity: 0.7, envMapIntensity: 0.32 },
      ),
      floorH: 3.7,
      windowW: 3.4,
    },
    // Buff Indiana limestone, the commercial cladding of the 1900-1930 blocks
    // that still make up most of the Golden Triangle below 30 storeys. The pale
    // end of the range - it only reads as pale because the brick beside it is
    // genuinely dark.
    limestone: {
      mat: facade(
        {
          seed: 33,
          base: '#5c584c',
          mortar: '#3a3830',
          day: {
            // Grey Indiana limestone, not the warm buff of the Art Deco towers.
            // Both families were authored within a few per cent of the same
            // cream, so the whole 30-60 m band came out one colour however the
            // roll split it. Downtown's ordinary stone stock is the grey one.
            base: '#b6afa0',
            mortar: '#948d7e',
            windowDark: '#39434e',
            trim: '#c2bbab',
            roofPin: '#494741',
          },
          windowLit: '#e8c878',
          cols: 6,
          rows: 8,
          litChance: 0.3,
          wall: 'stone',
          era: 'punched',
          winW: 0.46,
          winH: 0.62,
          beltCourse: true,
          soot: 0.55,
          wallRough: 0.86,
          glassRough: 0.44,
          glassMetal: 0.14,
        },
        { emissiveIntensity: 0.72, envMapIntensity: 0.4 },
      ),
      floorH: 3.8,
      windowW: 3.3,
    },
    // Mid-century: continuous ribbon glazing between precast spandrel courses.
    // The horizontal banding is the whole identity of the type, and it is what
    // distinguishes a 1960s slab from the punched masonry either side of it.
    steel: {
      mat: facade(
        {
          seed: 44,
          base: '#3a4048',
          mortar: '#2a3038',
          windowDark: '#0a1014',
          day: {
            base: '#a89f94',
            mortar: '#857d72',
            windowDark: '#3f4c54',
            spandrel: '#948c82',
            mullion: '#c2b8a9',
            trim: '#a89d8c',
            roofPin: '#464442',
          },
          windowLit: '#d8c090',
          cols: 8,
          rows: 10,
          litChance: 0.38,
          wall: 'panel',
          era: 'ribbon',
          bandH: 0.42,
          headDrop: 0.2,
          mullionW: 0.055,
          soot: 0.3,
          wallRough: 0.72,
          glassRough: 0.34,
          glassMetal: 0.34,
        },
        { emissiveIntensity: 0.8, envMapIntensity: dayMode ? 0.4 : 0.8 },
      ),
      floorH: 3.5,
      windowW: 3.0,
    },
    // Late-modern curtain wall: dark blue-green vision glass, near continuous,
    // slim aluminium mullions and an opaque spandrel panel between floors. The
    // spandrel has to be a different material from the glass or the whole tower
    // averages to one flat sheet of sky.
    glass: {
      mat: facade(
        {
          seed: 55,
          base: '#1a2830',
          mortar: '#0e181e',
          windowDark: '#0a1418',
          day: {
            base: '#333c44',
            mortar: '#242c33',
            // Tinted reflective vision glass. At metalness 0.82 this colour is
            // the SPECULAR tint rather than a diffuse albedo, so it has to be
            // authored as a reflectance - around a fifth, which is what
            // architectural coated glass actually returns - and the darkness
            // then comes from the reflection being dim, not from a black wall.
            windowDark: '#242d35',
            spandrel: '#1b2127',
            mullion: '#6b747c',
            // The stone pin is what every crown, coping and belt course in
            // architecture.js samples, and on a chamfered top like BNY Mellon's
            // that is a large flat plane in full sun. At slate value it lifted
            // to a pale blue cap brighter than the glass underneath it.
            trim: '#3d454c',
            roofPin: '#33383c',
          },
          windowLit: '#c8d8e8',
          cols: 8,
          rows: 10,
          litChance: 0.42,
          wall: 'metal',
          era: 'curtain',
          spandrelH: 0.28,
          mullionW: 0.05,
          wallRough: 0.52,
          glassRough: 0.38,
          skyGain: 0.66,
          // Kept well below a mirror on purpose. A metal's reflection runs to
          // white at the grazing angles a facade is seen at from the air, so a
          // high metalness makes every glass tower the colour of the sky
          // whatever its albedo says - which is exactly how the whole skyline
          // ended up one shade of pale blue.
          glassMetal: 0.28,
        },
        {
          emissive: 0xa8c4d8,
          emissiveIntensity: 0.85,
          envMapIntensity: dayMode ? 0.3 : 1.1,
        },
      ),
      floorH: 3.45,
      windowW: 2.7,
    },
    // PPG Place: 19,750 panes of Solarban 550 reflective glass, pleated
    // vertically so alternating facets catch the sky and the ones between them
    // go almost black. It is a DARK mirror - much darker than the limestone
    // around it - and the pleating is what makes it read as glass at all.
    ppg: {
      mat: facade(
        {
          seed: 66,
          base: '#0c1c1c',
          mortar: '#061010',
          windowDark: '#061014',
          day: {
            base: '#3a4145',
            mortar: '#2a2f33',
            // Solarban 550 is a neutral SILVER coating, so the tint is grey
            // rather than blue or bronze, and the complex reads dark because a
            // mirror at a quarter reflectance returns a quarter of the sky.
            windowDark: '#282e32',
            spandrel: '#1d2124',
            mullion: '#79828a',
            trim: '#3a4045',
            roofPin: '#2a2f34',
          },
          windowLit: '#cdd4d6',
          cols: 8,
          rows: 12,
          litChance: 0.34,
          wall: 'metal',
          era: 'curtain',
          spandrelH: 0.16,
          mullionW: 0.05,
          facetBays: 3,
          wallRough: 0.4,
          glassRough: 0.34,
          glassMetal: 0.3,
          // Solarban 550 returns about a fifth of what hits it, so the pane
          // must take up a fraction of the sky rather than most of it. This is
          // the single number that decides whether the complex reads as the
          // dark mirror it is or as another pale blue box.
          skyGain: 0.58,
        },
        {
          emissive: 0x6aa898,
          emissiveIntensity: 0.75,
          envMapIntensity: dayMode ? 0.4 : 1.2,
          // The complex has one specific glass. Letting the per-building tint
          // multiply it too pushed it to pale mint, which is most of why the
          // whole west end of downtown read as one pale blue mass.
          vertexColors: false,
        },
      ),
      floorH: 3.4,
      windowW: 2.5,
    },
    // The Cathedral of Learning: Indiana limestone, forty storeys of it, with
    // a century of soot in the shadows of the mullions.
    gothic: {
      mat: facade(
        {
          seed: 77,
          base: '#6a6458',
          mortar: '#3e3a32',
          windowDark: '#0c0e12',
          day: {
            base: '#af9e7f',
            mortar: '#8d7f65',
            windowDark: '#2f3843',
            trim: '#c4af8a',
            roofPin: '#4a4740',
          },
          windowLit: '#e8d090',
          cols: 5,
          rows: 6,
          litChance: 0.22,
          wall: 'stone',
          era: 'punched',
          winW: 0.5,
          winH: 0.76,
          headDrop: 0.1,
          pierW: 0.2,
          soot: 1.2,
          wallRough: 0.88,
          glassRough: 0.2,
          glassMetal: 0.22,
        },
        { emissiveIntensity: 0.6, envMapIntensity: 0.35 },
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
          day: {
            base: '#a3998c',
            mortar: '#7e766a',
            windowDark: '#2b333c',
            trim: '#b0a695',
            roofPin: '#4a4b4c',
          },
          windowLit: '#d0c080',
          cols: 4,
          rows: 4,
          litChance: 0.2,
          wall: 'panel',
          era: 'panel',
          winW: 0.52,
          winH: 0.4,
          soot: 0.25,
          wallRough: 0.74,
          glassRough: 0.2,
          glassMetal: 0.4,
        },
        { emissiveIntensity: 0.45, envMapIntensity: 0.5 },
      ),
      floorH: 8.5,
      windowW: 10,
    },
    // Art Deco: Gulf Tower and the Grant Building. Buff Indiana limestone in
    // continuous vertical piers with the windows and their darker spandrels
    // recessed between them, so the wall reads as a set of shafts.
    artdeco: {
      mat: facade(
        {
          seed: 91,
          base: '#6a6458',
          mortar: '#4a4438',
          windowDark: '#0c0e10',
          day: {
            base: '#cbb183',
            mortar: '#a89168',
            windowDark: '#333c47',
            trim: '#dbbb86',
            roofPin: '#4c4840',
          },
          windowLit: '#e8d090',
          cols: 5,
          rows: 9,
          litChance: 0.26,
          wall: 'stone',
          era: 'punched',
          winW: 0.42,
          winH: 0.78,
          headDrop: 0.08,
          pierW: 0.34,
          soot: 0.7,
          wallRough: 0.84,
          glassRough: 0.42,
          glassMetal: 0.14,
        },
        { emissiveIntensity: 0.65, envMapIntensity: 0.38 },
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
          day: {
            base: '#958772',
            mortar: '#776b5a',
            windowDark: '#2c3540',
            trim: '#a4947d',
            roofPin: '#43413c',
          },
          windowLit: '#d8c878',
          cols: 4,
          rows: 5,
          litChance: 0.18,
          wall: 'stone',
          era: 'punched',
          winW: 0.36,
          winH: 0.8,
          headDrop: 0.08,
          soot: 1.2,
          wallRough: 0.92,
          glassRough: 0.26,
          glassMetal: 0.14,
        },
        { emissiveIntensity: 0.5, envMapIntensity: 0.3 },
      ),
      floorH: 5.8,
      windowW: 2.2,
    },
    // The Carnegie group in Oakland and the Courthouse: brown Ohio sandstone,
    // Richardsonian and heavily soot-darkened. Warm and dark, nothing like the
    // buff limestone downtown.
    sandstone: {
      mat: facade(
        {
          seed: 93,
          base: '#7a7060',
          mortar: '#4a4438',
          windowDark: '#0a0c0e',
          day: {
            base: '#987754',
            mortar: '#755a3d',
            windowDark: '#2e3740',
            trim: '#af8e67',
            roofPin: '#443b30',
          },
          windowLit: '#e0c070',
          cols: 6,
          rows: 7,
          litChance: 0.2,
          wall: 'stone',
          era: 'punched',
          winW: 0.42,
          winH: 0.62,
          soot: 1.3,
          wallRough: 0.94,
          glassRough: 0.5,
          glassMetal: 0.1,
        },
        { emissiveIntensity: 0.45, envMapIntensity: 0.28 },
      ),
      floorH: 4.5,
      windowW: 3.6,
    },
    // The Koppers Building: buff limestone shaft under the only chateau roof on
    // the skyline, a steep copper pyramid long since gone green.
    //
    // The roof takes its colour from the DARK pin swatch, because that is what
    // every shingle and roof deck in architecture.js samples - so the patina
    // lives there rather than in the wall.
    copper: {
      mat: facade(
        {
          seed: 94,
          base: '#4a6a58',
          mortar: '#2a4038',
          windowDark: '#0a1010',
          day: {
            base: '#ceb487',
            mortar: '#ab9469',
            windowDark: '#39434f',
            trim: '#ddbd89',
            roofPin: '#708468',
          },
          windowLit: '#c8d8a0',
          cols: 5,
          rows: 8,
          litChance: 0.22,
          wall: 'stone',
          era: 'punched',
          winW: 0.44,
          winH: 0.66,
          pierW: 0.18,
          beltCourse: true,
          soot: 0.7,
          wallRough: 0.86,
          glassRough: 0.24,
          glassMetal: 0.26,
        },
        {
          emissiveIntensity: 0.55,
          envMapIntensity: 0.4,
          // One building, one specific cladding. The per-building tint for
          // Koppers is copper green, which is right for the roof and turns the
          // limestone shaft green if it is allowed to multiply through.
          vertexColors: false,
        },
      ),
      floorH: 3.9,
      windowW: 3.2,
    },
    // The convention centre: white standing-seam metal over a glazed base, and
    // one of the genuinely pale buildings in the city.
    convention: {
      mat: facade(
        {
          seed: 95,
          base: '#c8ccc8',
          mortar: '#a0a4a0',
          windowDark: '#101418',
          day: {
            base: '#c6cacd',
            mortar: '#a6abaf',
            windowDark: '#3d4d59',
            spandrel: '#a9aeb2',
            mullion: '#e0e4e6',
            trim: '#ccd0d3',
            roofPin: '#586066',
          },
          windowLit: '#e8ece8',
          cols: 10,
          rows: 4,
          litChance: 0.35,
          wall: 'metal',
          era: 'ribbon',
          bandH: 0.58,
          headDrop: 0.14,
          mullionW: 0.05,
          wallRough: 0.42,
          glassRough: 0.3,
          glassMetal: 0.32,
        },
        { emissiveIntensity: 0.6, envMapIntensity: 0.5 },
      ),
      floorH: 6.0,
      windowW: 5.0,
    },
    /**
     * Phipps: a Lord & Burnham glasshouse of 1893, and the one building in the
     * city that is genuinely almost all glass. It carries the same `glass` tag
     * as the downtown curtain-wall towers, which handed it a dark tinted
     * spandrel wall - the exact opposite material. A conservatory has no
     * spandrel, no tinted coating and no dark interior behind it: it is white
     * painted glazing bar over clear glass with daylight coming through from the
     * far side, so it reads PALER than anything around it, near the top of the
     * scene's range rather than the bottom.
     *
     * Almost all of what is visible from the air is the vault and the Palm Court
     * dome, and their upward-facing facets take the dark pin swatch - so
     * `roofPin` here is the tone the building is actually read by, and it has to
     * be glass rather than the roof deck it is on every other family.
     */
    glasshouse: {
      mat: facade(
        {
          seed: 97,
          base: '#b8c0bc',
          mortar: '#98a09c',
          windowDark: '#9aa8ac',
          day: {
            // White-painted iron glazing bar, and the stone plinth under it.
            base: '#d8dcd6',
            mortar: '#b4b8b0',
            // Clear glass lit from behind: a pale grey-green, brighter than any
            // curtain wall and only a little darker than the bars framing it.
            windowDark: '#c4d2ce',
            spandrel: '#cfd4ce',
            mullion: '#eef0ea',
            trim: '#e8ece6',
            roofPin: '#d4dedc',
            sky: '#e2ecf2',
          },
          windowLit: '#f0f2e6',
          // No FACADE_GRID entry, so this must be the default 6 x 8 grid.
          cols: 6,
          rows: 8,
          litChance: 0.1,
          wall: 'metal',
          era: 'punched',
          // Openings this large leave the bar itself as the only solid, which is
          // what a glasshouse elevation is.
          winW: 0.84,
          winH: 0.84,
          headDrop: 0.08,
          // Glass at grazing incidence catches the sky like any other glass;
          // there is no coating here to hold it back.
          skyGain: 1,
          wallRough: 0.46,
          glassRough: 0.1,
          glassMetal: 0.12,
          trimRough: 0.4,
          roofRough: 0.14,
        },
        { emissiveIntensity: 0.35, envMapIntensity: 0.55, vertexColors: false },
      ),
      // Glazing bars at 1.6 m and purlins at 2 m: the fine grid is the whole
      // identity of the type, and a storey-scale one would read as a shed.
      floorH: 2.0,
      windowW: 1.6,
    },
    // The US Steel Tower: 18 liquid-filled Cor-Ten box columns weathered to a
    // warm rust oxide, with bronze glass set a metre back between them and a
    // Cor-Ten spandrel beam at every floor. The columns - not the windows - are
    // what the eye reads, and in sun they sit near 0.14 reflectance: a rust
    // brown that is clearly LIGHTER than the glazing it frames.
    //
    // Both halves of that were inverted, which is what made the largest object
    // in the `downtown` frame a near-black monolith. The oxide was authored at
    // roughly half the value weathering steel returns - darker than the bronze
    // glass beside it - while everything BETWEEN the columns was lighter than
    // the metal: a pale mullion line up every bay crossing a spandrel course,
    // which reads as a checkerboard rather than as a wall of dark glass.
    //
    // The Cor-Ten also has to hold more of the canvas than its plan share
    // suggests. The glass sits deep in the reveal, so from any oblique angle the
    // column returns and the spandrel soffits cover most of it - and this wall
    // is a flat extruded prism that cannot occlude anything, so the depth of
    // that reveal has to be paid for in the atlas instead.
    steelTower: {
      mat: facade(
        {
          seed: 96,
          base: '#5a4030',
          mortar: '#3a2818',
          windowDark: '#080808',
          day: {
            base: '#a1704e',
            mortar: '#6a4530',
            // Bronze vision glass, and the darkest thing on the tower.
            windowDark: '#2f2a24',
            // The spandrel between floors is weathering steel, not glass: it is
            // the same plate as the columns, one storey deep and in their shade.
            spandrel: '#8a5e42',
            // Dark bronze-anodised aluminium, sitting back in the reveal.
            mullion: '#453b32',
            trim: '#a7754e',
            roofPin: '#453930',
            // Bronze glass mirrors a warm, dim sky, not a bright blue one.
            sky: '#8c7458',
          },
          windowLit: '#d0a870',
          cols: 7,
          rows: 11,
          // A Cor-Ten wall in sun does not have a constellation of interior
          // lights. The 6% day scale still left a scatter of warm panes that
          // read as a dotted grid from the downtown preset.
          litChance: 0,
          wall: 'oxide',
          era: 'curtain',
          spandrelH: 0.36,
          mullionW: 0.07,
          pierW: 0.44,
          skyGain: 0.3,
          wallRough: 0.7,
          glassRough: 0.36,
          glassMetal: 0.34,
        },
        {
          emissiveIntensity: 0,
          envMapIntensity: dayMode ? 0.4 : 0.8,
          // One building. Its per-building tint is a dark brown that, multiplied
          // through an already dark oxide, took the tower to near black.
          vertexColors: false,
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

  const foamMat = makeFoamMaterial(dayMode);

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
  const n = (b.n || '').toLowerCase();
  const h = b.h || 10;
  // Named buildings win over the data's `style` tag, which is a broad bucket:
  // Koppers is tagged `artdeco` along with Gulf and Grant, and it is, but it is
  // also the only chateau roof on the skyline and the only building in the city
  // whose roof has to come out copper green.
  if (/koppers/.test(n)) return 'copper';
  if (/u\.?s\.? steel|us steel/.test(n)) return 'steelTower';
  if (/ppg/.test(n)) return 'ppg';
  // Six of the seven tallest towers downtown carry the same `glass` tag, so
  // they were all handed one dark-blue curtain wall and the skyline read as one
  // building repeated. They are not remotely alike: Fifth Avenue Place is rose
  // granite with piers and a spire, One Oxford Centre is silver aluminium
  // ribbon, EQT Plaza is red granite. Only the genuinely dark-glass ones -
  // BNY Mellon Center, K&L Gates and Tower at PNC - keep the curtain wall.
  // Phipps carries the same tag, and it is glass - but an 1893 glasshouse is
  // the opposite end of the material from a coated curtain wall, pale where
  // they are dark. See the `glasshouse` family.
  if (/phipps/.test(n)) return 'glasshouse';
  if (/fifth avenue place/.test(n)) return 'artdeco';
  if (/oxford cent/.test(n)) return 'steel';
  if (/eqt plaza|dominion tower/.test(n)) return 'sandstone';
  if (b.style && STYLE_FAMILY[b.style]) return STYLE_FAMILY[b.style];
  if (/cathedral of learning/.test(n)) return 'gothic';
  if (/chapel|church|cathedral/.test(n)) return 'chapel';
  if (/gulf tower|grant building/.test(n)) return 'artdeco';
  if (/carnegie|soldiers and sailors/.test(n)) return 'sandstone';
  if (/pnc park|acrisure|stadium|heinz field/.test(n)) return 'stadium';
  if (b.f && b.f.length >= 3 && h < 60) {
    const [cx, cz] = footprintCentroid(b.f);
    if (Math.hypot(cx + 415, cz + 657) < 140) return 'stadium';
    if (Math.hypot(cx + 1169, cz + 635) < 180) return 'stadium';
  }
  if (/convention/.test(n)) return 'convention';
  const roll = claddingRoll(b.f);
  // Weighted to what each band really holds. The tall stock is mostly pre-war
  // masonry, and below 30 m the city is brick almost to the exclusion of
  // anything else - so the mix leans dark, and the pale limestone reads as the
  // exception it is rather than as the default.
  if (b.landmark || h > 100) {
    return roll < 0.3 ? 'glass' : roll < 0.58 ? 'artdeco' : roll < 0.82 ? 'limestone' : 'steel';
  }
  if (h > 55) {
    return roll < 0.22 ? 'limestone' : roll < 0.44 ? 'artdeco' : roll < 0.62 ? 'steel'
      : roll < 0.88 ? 'brick' : 'glass';
  }
  if (h > 28) {
    return roll < 0.34 ? 'brick' : roll < 0.55 ? 'limestone' : roll < 0.72 ? 'sandstone'
      : roll < 0.9 ? 'steel' : 'artdeco';
  }
  if (h > 14) {
    return roll < 0.5 ? 'brick' : roll < 0.72 ? 'lowrise' : roll < 0.9 ? 'limestone' : 'sandstone';
  }
  return roll < 0.7 ? 'lowrise' : roll < 0.93 ? 'brick' : 'limestone';
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
