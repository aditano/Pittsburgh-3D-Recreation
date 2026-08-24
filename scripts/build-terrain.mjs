/**
 * Bake real Pittsburgh topography into the city data.
 *
 * Reads Mapzen/AWS "terrarium" elevation tiles (RGB-encoded metres over the
 * USGS 3DEP bare-earth composite), resamples them onto a regular grid in the
 * scene's local frame, and stores the grid as base64 Int16 decimetres. The
 * runtime then interpolates real ground height instead of the hand-authored
 * bumps that had Mount Washington sitting at river level.
 *
 * Run: node scripts/build-terrain.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { PROJECTION, ROOT, readData, writeData, unproject } from './osm.mjs';

const ZOOM = 14;
const TILE_DIR = join(ROOT, 'scripts/osm-cache/terrain');

/**
 * Grid at 40 m spacing, sized to contain the whole ground plane in main.js with
 * margin. Anything the grid misses gets edge-clamped at runtime, which drags
 * valley-wall elevations sideways across the rivers, so the cover must be total.
 */
const GRID = { minX: -6600, minZ: -6300, step: 40, cols: 388, rows: 295 };

/**
 * Normal pool elevation of the three rivers (Emsworth Pool is tagged ele=219,
 * the Point gauge sits near 216 m). Local Y = 0 is the water surface.
 */
const POOL_M = 216.5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}

function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

async function fetchTile(x, y) {
  if (!existsSync(TILE_DIR)) mkdirSync(TILE_DIR, { recursive: true });
  const path = join(TILE_DIR, `${ZOOM}-${x}-${y}.png`);
  if (!existsSync(path)) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`;
    let buf = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
        break;
      } catch (err) {
        if (attempt === 4) throw new Error(`tile ${x}/${y}: ${err.message}`);
        await sleep(1500 * (attempt + 1));
      }
    }
    writeFileSync(path, buf);
  }
  const png = PNG.sync.read(readFileSync(path));
  const size = png.width;
  const elev = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const r = png.data[i * 4];
    const g = png.data[i * 4 + 1];
    const b = png.data[i * 4 + 2];
    elev[i] = r * 256 + g + b / 256 - 32768;
  }
  return { elev, size };
}

async function main() {
  // Tile range needed to cover the grid.
  const corners = [
    [GRID.minX, GRID.minZ],
    [GRID.minX + GRID.cols * GRID.step, GRID.minZ],
    [GRID.minX, GRID.minZ + GRID.rows * GRID.step],
    [GRID.minX + GRID.cols * GRID.step, GRID.minZ + GRID.rows * GRID.step],
  ].map(([x, z]) => unproject(x, z, PROJECTION));

  const lats = corners.map((c) => c[0]);
  const lons = corners.map((c) => c[1]);
  const tx0 = Math.floor(lonToTileX(Math.min(...lons), ZOOM));
  const tx1 = Math.floor(lonToTileX(Math.max(...lons), ZOOM));
  const ty0 = Math.floor(latToTileY(Math.max(...lats), ZOOM));
  const ty1 = Math.floor(latToTileY(Math.min(...lats), ZOOM));
  console.log(`tiles x ${tx0}..${tx1}, y ${ty0}..${ty1} at z${ZOOM}`);

  const tiles = new Map();
  let fetched = 0;
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      tiles.set(`${tx},${ty}`, await fetchTile(tx, ty));
      fetched++;
    }
  }
  console.log(`${fetched} tiles loaded`);

  const sample = (lat, lon) => {
    const fx = lonToTileX(lon, ZOOM);
    const fy = latToTileY(lat, ZOOM);
    const tile = tiles.get(`${Math.floor(fx)},${Math.floor(fy)}`);
    if (!tile) return null;
    const { elev, size } = tile;
    // Bilinear inside the tile.
    const px = (fx - Math.floor(fx)) * size - 0.5;
    const py = (fy - Math.floor(fy)) * size - 0.5;
    const x0 = Math.max(0, Math.min(size - 1, Math.floor(px)));
    const y0 = Math.max(0, Math.min(size - 1, Math.floor(py)));
    const x1 = Math.min(size - 1, x0 + 1);
    const y1 = Math.min(size - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, px - x0));
    const ty = Math.max(0, Math.min(1, py - y0));
    const a = elev[y0 * size + x0];
    const b = elev[y0 * size + x1];
    const c = elev[y1 * size + x0];
    const d = elev[y1 * size + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  const heights = new Int16Array(GRID.cols * GRID.rows);
  let min = Infinity;
  let max = -Infinity;
  let missing = 0;
  for (let row = 0; row < GRID.rows; row++) {
    for (let col = 0; col < GRID.cols; col++) {
      const x = GRID.minX + col * GRID.step;
      const z = GRID.minZ + row * GRID.step;
      const [lat, lon] = unproject(x, z, PROJECTION);
      const e = sample(lat, lon);
      if (e == null) {
        missing++;
        continue;
      }
      const local = e - POOL_M;
      min = Math.min(min, local);
      max = Math.max(max, local);
      heights[row * GRID.cols + col] = Math.round(local * 10);
    }
  }

  console.log(`grid ${GRID.cols}x${GRID.rows} @ ${GRID.step}m, ${missing} gaps`);
  console.log(`relief ${min.toFixed(1)}m to ${max.toFixed(1)}m above pool`);

  const data = readData();
  data.terrain = {
    minX: GRID.minX,
    minZ: GRID.minZ,
    step: GRID.step,
    cols: GRID.cols,
    rows: GRID.rows,
    poolElevation: POOL_M,
    units: 'decimetres above pool',
    data: Buffer.from(heights.buffer).toString('base64'),
  };
  delete data.terrainPeaks;
  data.meta.terrain = `AWS terrarium z${ZOOM} (USGS 3DEP), ${GRID.step}m grid`;
  writeData(data);

  // Spot checks against known landmarks.
  const probes = [
    ['Point fountain', -765, -80, 0],
    ['Mount Washington (Grandview Ave)', -576, 1024, 110],
    ['Cathedral of Learning', 4133, -369, 60],
    ['Downtown Golden Triangle', 200, 0, 5],
    ['Herrs Island', 1500, -2100, 5],
    ['Duquesne Incline upper', -1490, 250, 120],
  ];
  const at = (x, z) => {
    const col = Math.round((x - GRID.minX) / GRID.step);
    const row = Math.round((z - GRID.minZ) / GRID.step);
    if (col < 0 || row < 0 || col >= GRID.cols || row >= GRID.rows) return NaN;
    return heights[row * GRID.cols + col] / 10;
  };
  console.log('\nspot checks (m above pool):');
  for (const [name, x, z, expect] of probes) {
    console.log(`  ${name.padEnd(30)} ${at(x, z).toFixed(1).padStart(7)}  (expected ~${expect})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
