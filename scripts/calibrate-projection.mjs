/**
 * Solve the WGS84 -> local-meters transform that the shipped dataset uses, by
 * matching named OSM buildings against the dataset's own footprints.
 *
 * Run: node scripts/calibrate-projection.mjs
 */
import { overpass, readData, ringCentroid } from './osm.mjs';

const BBOX = '40.398,-80.062,40.478,-79.896';

const QUERY = `[out:json][timeout:180];
way["building"]["name"](${BBOX});
out geom;`;

function centroidOfGeometry(geometry) {
  let la = 0;
  let lo = 0;
  const n = geometry.length - 1;
  for (let i = 0; i < n; i++) {
    la += geometry[i].lat;
    lo += geometry[i].lon;
  }
  return [la / n, lo / n];
}

/**
 * Least squares for x = (lon - lon0) * sx and z = -(lat - lat0) * sz, solving
 * scale and origin independently per axis (the dataset's projection is a plain
 * equirectangular scaling, so the axes do not mix).
 */
function fitAxis(samples) {
  const n = samples.length;
  let sd = 0;
  let sv = 0;
  let sdd = 0;
  let sdv = 0;
  for (const [deg, val] of samples) {
    sd += deg;
    sv += val;
    sdd += deg * deg;
    sdv += deg * val;
  }
  const denom = n * sdd - sd * sd;
  const scale = (n * sdv - sd * sv) / denom;
  const offset = (sv - scale * sd) / n;
  return { scale, offset };
}

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const data = readData();
  const osm = await overpass('named-buildings', QUERY);

  // Dataset names that are hand-authored stand-ins, not OSM records.
  const synthetic = new Set(
    data.buildings
      .filter((b) => b.n && b.n === b.n.toUpperCase() && /[A-Z]{3}/.test(b.n))
      .map((b) => b.n),
  );

  const byName = new Map();
  for (const b of data.buildings) {
    if (!b.n || synthetic.has(b.n)) continue;
    if (!byName.has(b.n)) byName.set(b.n, []);
    byName.get(b.n).push(b);
  }

  const pairs = [];
  for (const el of osm.elements) {
    const name = el.tags?.name;
    if (!name || !el.geometry || el.geometry.length < 4) continue;
    const cand = byName.get(name);
    if (!cand || cand.length !== 1) continue;
    const [lat, lon] = centroidOfGeometry(el.geometry);
    const [x, z] = ringCentroid(cand[0].f);
    pairs.push({ name, lat, lon, x, z });
  }

  console.log(`matched ${pairs.length} unique named buildings`);
  if (pairs.length < 20) throw new Error('not enough matches to calibrate');

  // Robust pass: fit, drop outliers beyond 3x median residual, refit.
  let fitX = fitAxis(pairs.map((p) => [p.lon, p.x]));
  let fitZ = fitAxis(pairs.map((p) => [p.lat, p.z]));
  for (let pass = 0; pass < 3; pass++) {
    const res = pairs.map((p) =>
      Math.hypot(fitX.scale * p.lon + fitX.offset - p.x, fitZ.scale * p.lat + fitZ.offset - p.z),
    );
    const cut = Math.max(6, median(res) * 3);
    const kept = pairs.filter((_, i) => res[i] <= cut);
    if (kept.length < 20) break;
    fitX = fitAxis(kept.map((p) => [p.lon, p.x]));
    fitZ = fitAxis(kept.map((p) => [p.lat, p.z]));
    console.log(`pass ${pass + 1}: kept ${kept.length}/${pairs.length} (cut ${cut.toFixed(1)}m)`);
  }

  const mPerDegLon = fitX.scale;
  const mPerDegLat = -fitZ.scale;
  const lon0 = -fitX.offset / mPerDegLon;
  const lat0 = fitZ.offset / mPerDegLat;

  const residuals = pairs.map((p) =>
    Math.hypot(
      (p.lon - lon0) * mPerDegLon - p.x,
      -(p.lat - lat0) * mPerDegLat - p.z,
    ),
  );
  residuals.sort((a, b) => a - b);

  console.log('\nsolved projection:');
  console.log(`  lat0: ${lat0.toFixed(6)}`);
  console.log(`  lon0: ${lon0.toFixed(6)}`);
  console.log(`  mPerDegLon: ${mPerDegLon.toFixed(1)}`);
  console.log(`  mPerDegLat: ${mPerDegLat.toFixed(1)}`);
  console.log('\nresidual (m):');
  console.log(`  median ${residuals[Math.floor(residuals.length / 2)].toFixed(2)}`);
  console.log(`  p90    ${residuals[Math.floor(residuals.length * 0.9)].toFixed(2)}`);
  console.log(`  max    ${residuals[residuals.length - 1].toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
