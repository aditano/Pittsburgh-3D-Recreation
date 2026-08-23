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

export function terrainHeight(x, z, peaks) {
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

  // Mount Washington / Duquesne Heights escarpment south of the Mon
  if (z > 280) {
    const dRidge = distToSeg(x, z, -1900, 420, 720, 1760);
    if (dRidge < 340) {
      const t = 1 - dRidge / 340;
      h += 72 * t * t;
    }
  }

  // North Side slope above Allegheny
  if (z < -600 && x > -1200 && x < 1200) {
    const dNorth = Math.abs(z + 900);
    if (dNorth < 500) {
      const t = 1 - dNorth / 500;
      h += 28 * t;
    }
  }

  // Oakland plateau
  if (x > 2800 && x < 5200 && z > -1200 && z < 600) {
    h += 18;
  }

  const downtown = Math.hypot(x, z);
  if (downtown < 980 && z < 640) {
    const k = Math.min(1, (980 - downtown) / 980);
    h *= 1 - k * 0.94;
  } else if (downtown < 980 && z >= 640) {
    const k = Math.min(1, (980 - downtown) / 980);
    h *= 1 - k * 0.22;
  }
  return h;
}

export function surfaceHeight(x, z, peaks, waterIndex) {
  let h = terrainHeight(x, z, peaks);
  if (!waterIndex) return h;
  if (waterIndex.inside(x, z)) return -3.5;
  const bank = waterIndex.bankStrength(x, z);
  if (bank > 0) {
    return h * (1 - bank * 0.62) - bank * 1.35;
  }
  return h;
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

export function makeWaterIndex(polygons) {
  const minX = -4200;
  const maxX = 8200;
  const minZ = -3600;
  const maxZ = 4200;
  const res = 10;
  const cols = Math.ceil((maxX - minX) / res);
  const rows = Math.ceil((maxZ - minZ) / res);
  const water = new Uint8Array(cols * rows);

  for (const poly of polygons) {
    if (!poly || poly.length < 3) continue;
    rasterizePoly(water, poly, minX, minZ, res, cols, rows);
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
