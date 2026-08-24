/** Local meters: +X east, +Y up, +Z south. Origin near the Point. */

export function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; i++) {
    const xi = poly[i][0];
    const zi = poly[i][1];
    const xj = poly[j][0];
    const zj = poly[j][1];
    const denom = zj - zi || 1e-12;
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / denom + xi;
    if (intersect) inside = !inside;
    j = i;
  }
  return inside;
}

function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function decodeBase64(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Sampler over the baked USGS 3DEP grid (decimetres above normal pool). Returns
 * a bilinearly interpolated ground height in metres, so hillside streets and
 * the Mount Washington bluff follow the real landform.
 */
export function makeTerrain(terrain) {
  if (!terrain?.data) return () => 0;
  const bytes = decodeBase64(terrain.data);
  const grid = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const { minX, minZ, step, cols, rows } = terrain;

  return function terrainHeight(x, z) {
    const fx = (x - minX) / step;
    const fz = (z - minZ) / step;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const cx0 = Math.max(0, Math.min(cols - 1, x0));
    const cz0 = Math.max(0, Math.min(rows - 1, z0));
    const cx1 = Math.max(0, Math.min(cols - 1, x0 + 1));
    const cz1 = Math.max(0, Math.min(rows - 1, z0 + 1));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const tz = Math.max(0, Math.min(1, fz - z0));
    const a = grid[cz0 * cols + cx0];
    const b = grid[cz0 * cols + cx1];
    const c = grid[cz1 * cols + cx0];
    const d = grid[cz1 * cols + cx1];
    return ((a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz) * 0.1;
  };
}

/** Riverbed depth below normal pool, in metres. */
export const BED_Y = -3.2;

/**
 * Ground height with the river channels carved out.
 *
 * The bank easing has to reach `BED_Y` at the waterline, not merely lean toward
 * it: the terrain grid is coarser than the ground mesh, so any shoreline cell
 * left above pool renders as a slab of land standing in the middle of a river.
 */
export function surfaceHeight(x, z, terrainFn, waterIndex) {
  const h = terrainFn(x, z);
  if (!waterIndex) return h;
  if (waterIndex.inside(x, z)) return BED_Y;
  const bank = waterIndex.bankStrength(x, z);
  if (bank <= 0) return h;
  const t = bank * bank;
  return Math.min(h * (1 - t) + BED_Y * t, h);
}

function rasterizePoly(grid, poly, minX, minZ, res, cols, rows) {
  const n = poly.length;
  if (n < 3) return;
  const closed =
    Math.hypot(poly[0][0] - poly[n - 1][0], poly[0][1] - poly[n - 1][1]) < 0.01;
  const count = closed ? n - 1 : n;

  for (let row = 0; row < rows; row++) {
    const y = row + 0.5;
    const xs = [];
    for (let i = 0; i < count; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const y1 = (a[1] - minZ) / res;
      const y2 = (b[1] - minZ) / res;
      if (y1 > y !== y2 > y) {
        const x1 = (a[0] - minX) / res;
        const x2 = (b[0] - minX) / res;
        xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1 || 1e-12));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.floor(xs[k]));
      const b = Math.min(cols - 1, Math.ceil(xs[k + 1]));
      const base = row * cols;
      for (let col = a; col <= b; col++) grid[base + col] = 1;
    }
  }
}

function erasePoly(grid, poly, minX, minZ, res, cols, rows) {
  const n = poly.length;
  if (n < 3) return;
  const closed =
    Math.hypot(poly[0][0] - poly[n - 1][0], poly[0][1] - poly[n - 1][1]) < 0.01;
  const count = closed ? n - 1 : n;

  for (let row = 0; row < rows; row++) {
    const y = row + 0.5;
    const xs = [];
    for (let i = 0; i < count; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const y1 = (a[1] - minZ) / res;
      const y2 = (b[1] - minZ) / res;
      if (y1 > y !== y2 > y) {
        const x1 = (a[0] - minX) / res;
        const x2 = (b[0] - minX) / res;
        xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1 || 1e-12));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.floor(xs[k]));
      const b = Math.min(cols - 1, Math.ceil(xs[k + 1]));
      const base = row * cols;
      for (let col = a; col <= b; col++) grid[base + col] = 0;
    }
  }
}

/**
 * Rasterize the river surfaces into a water mask.
 *
 * `surfaces` accepts either bare rings or `{ f, holes }` records; holes are the
 * real OSM islands (Washington's Landing, Brunot Island, Herrs Island) and are
 * punched back out to land after the outers are filled.
 */
export function makeWaterIndex(surfaces, { erosion = 0 } = {}) {
  const minX = -4800;
  const maxX = 8800;
  const minZ = -4200;
  const maxZ = 4800;
  const res = 10;
  const cols = Math.ceil((maxX - minX) / res);
  const rows = Math.ceil((maxZ - minZ) / res);
  const water = new Uint8Array(cols * rows);

  const normalized = surfaces
    .map((s) => (Array.isArray(s) ? { f: s, holes: [] } : s))
    .filter((s) => s?.f && s.f.length >= 3);

  for (const s of normalized) {
    rasterizePoly(water, s.f, minX, minZ, res, cols, rows);
  }
  for (const s of normalized) {
    for (const hole of s.holes || []) {
      if (hole.length >= 3) erasePoly(water, hole, minX, minZ, res, cols, rows);
    }
  }

  if (erosion > 0) {
    const eroded = new Uint8Array(water);
    const r = Math.ceil(erosion / res);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        if (!water[i]) continue;
        let keep = true;
        for (let dz = -r; dz <= r && keep; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const rr = row + dz;
            const cc = col + dx;
            if (rr < 0 || rr >= rows || cc < 0 || cc >= cols || !water[rr * cols + cc]) {
              keep = false;
              break;
            }
          }
        }
        if (!keep) eroded[i] = 0;
      }
    }
    water.set(eroded);
  }

  const bank = new Uint8Array(cols * rows);
  const radius = 4;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (!water[i]) continue;
      for (let dz = -radius; dz <= radius; dz++) {
        const rr = row + dz;
        if (rr < 0 || rr >= rows) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const cc = col + dx;
          if (cc < 0 || cc >= cols) continue;
          const j = rr * cols + cc;
          if (water[j]) continue;
          const d = Math.hypot(dx, dz);
          if (d > radius) continue;
          const str = Math.round(255 * (1 - d / radius));
          if (str > bank[j]) bank[j] = str;
        }
      }
    }
  }

  function idx(x, z) {
    const col = Math.floor((x - minX) / res);
    const row = Math.floor((z - minZ) / res);
    if (col < 0 || row < 0 || col >= cols || row >= rows) return -1;
    return row * cols + col;
  }

  return {
    inside(x, z) {
      const i = idx(x, z);
      return i >= 0 && water[i] === 1;
    },
    nearBank(x, z) {
      const i = idx(x, z);
      return i >= 0 && bank[i] > 0;
    },
    bankStrength(x, z) {
      const i = idx(x, z);
      return i >= 0 ? bank[i] / 255 : 0;
    },
  };
}

/** Align a bridge at a center point, perpendicular to local river flow. */
export function alignBridgeAtCenter(cx, cz, halfLen, waterIndex) {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let flowX = 0;
  let flowZ = 1;
  let bestLen = 0;
  for (const [dx, dz] of dirs) {
    let len = 0;
    for (let i = 1; i < 300; i++) {
      if (waterIndex.inside(cx + dx * i * 4, cz + dz * i * 4)) len = i * 4;
      else break;
    }
    if (len > bestLen) {
      bestLen = len;
      flowX = dx;
      flowZ = dz;
    }
  }
  const bx = -flowZ;
  const bz = flowX;
  return [
    [+(cx - bx * halfLen).toFixed(2), +(cz - bz * halfLen).toFixed(2)],
    [+(cx + bx * halfLen).toFixed(2), +(cz + bz * halfLen).toFixed(2)],
  ];
}

/** Align a bridge span perpendicular to local river flow, preserving half-length. */
export function alignBridgePerpendicular(pts, waterIndex, halfLen = null) {
  const [a, c] = pts;
  const cx = (a[0] + c[0]) * 0.5;
  const cz = (a[1] + c[1]) * 0.5;
  const span = halfLen ?? Math.hypot(c[0] - a[0], c[1] - a[1]) * 0.5;

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let flowX = 0;
  let flowZ = 1;
  let bestLen = 0;
  for (const [dx, dz] of dirs) {
    let len = 0;
    for (let i = 1; i < 300; i++) {
      if (waterIndex.inside(cx + dx * i * 4, cz + dz * i * 4)) len = i * 4;
      else break;
    }
    if (len > bestLen) {
      bestLen = len;
      flowX = dx;
      flowZ = dz;
    }
  }

  const bx = -flowZ;
  const bz = flowX;
  return [
    [+(cx - bx * span).toFixed(2), +(cz - bz * span).toFixed(2)],
    [+(cx + bx * span).toFixed(2), +(cz + bz * span).toFixed(2)],
  ];
}

export function snapBridgeToBanks(pts, waterIndex, inset = 22) {
  const [a, c] = pts;
  const dx = c[0] - a[0];
  const dz = c[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  const start = -520;
  const end = len + 520;
  const step = 3;

  let prev = waterIndex.inside(a[0] + ux * start, a[1] + uz * start);
  const runs = [];
  let run0 = prev ? start : null;

  for (let s = start + step; s <= end; s += step) {
    const w = waterIndex.inside(a[0] + ux * s, a[1] + uz * s);
    if (w && !prev) run0 = s;
    if (!w && prev && run0 !== null) {
      runs.push([run0, s]);
      run0 = null;
    }
    prev = w;
  }
  if (run0 !== null) runs.push([run0, end]);

  if (!runs.length) return [a.slice(), c.slice()];

  runs.sort((p, q) => q[1] - q[0] - (p[1] - p[0]));
  const [s0, s1] = runs[0];
  if (s1 - s0 < 40) return [a.slice(), c.slice()];

  let sa = s0 - inset;
  let sc = s1 + inset;
  const walk = (s, dir) => {
    let t = s;
    for (let i = 0; i < 40; i++) {
      if (!waterIndex.inside(a[0] + ux * t, a[1] + uz * t)) return t;
      t += dir * 3;
    }
    return t;
  };
  sa = walk(sa, -1);
  sc = walk(sc, 1);

  return [
    [+(a[0] + ux * sa).toFixed(2), +(a[1] + uz * sa).toFixed(2)],
    [+(a[0] + ux * sc).toFixed(2), +(a[1] + uz * sc).toFixed(2)],
  ];
}

export function footprintWaterOverlap(footprint, waterIndex) {
  const n = footprint.length - 1;
  if (n < 3) return 1;
  let inside = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [x, z] = footprint[i];
    total++;
    if (waterIndex.inside(x, z)) inside++;
  }
  const [cx, cz] = footprintCentroid(footprint);
  total++;
  if (waterIndex.inside(cx, cz)) inside++;
  return inside / total;
}

export function footprintLandBaseY(footprint, yFn, waterIndex) {
  let best = -Infinity;
  const n = footprint.length - 1;
  for (let i = 0; i < n; i++) {
    const [x, z] = footprint[i];
    if (waterIndex.inside(x, z)) continue;
    best = Math.max(best, yFn(x, z));
  }
  const [cx, cz] = footprintCentroid(footprint);
  if (!waterIndex.inside(cx, cz)) best = Math.max(best, yFn(cx, cz));
  return best > -Infinity ? best : yFn(cx, cz);
}

export function hash01(x, z) {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

export function footprintCentroid(footprint) {
  let cx = 0;
  let cz = 0;
  const n = footprint.length - 1;
  for (let i = 0; i < n; i++) {
    cx += footprint[i][0];
    cz += footprint[i][1];
  }
  return [cx / n, cz / n];
}
