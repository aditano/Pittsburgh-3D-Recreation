/**
 * Cross-check one named place against OSM without going through the name
 * matcher, so a placement fix can be confirmed from an independent direction.
 *
 * The matcher pairs a dataset record with the nearest same-named OSM footprint,
 * which means it cannot tell "our footprint is 100 m off" apart from "we
 * matched the wrong building". Nominatim knows nothing about our dataset, so
 * agreeing with it is real evidence.
 *
 * Run: node scripts/probe-place.mjs "Phipps Conservatory"
 */
import { areaCentroid } from './osm-features.mjs';
import { project, readData, ringArea } from './osm.mjs';

const query = process.argv.slice(2).join(' ');
if (!query) {
  console.error('usage: node scripts/probe-place.mjs "<place name>"');
  process.exit(1);
}

const url = new URL('https://nominatim.openstreetmap.org/search');
url.search = new URLSearchParams({
  q: `${query}, Pittsburgh, Pennsylvania`,
  format: 'json',
  limit: '3',
});
const res = await fetch(url, {
  headers: { 'User-Agent': 'pittsburgh-3d-recreation/1.0 (map fidelity build script)' },
});
const hits = await res.json();
if (!hits.length) {
  console.log(`nominatim has no result for "${query}"`);
  process.exit(0);
}

console.log(`nominatim results for "${query}":`);
const refs = [];
for (const h of hits) {
  const p = project(parseFloat(h.lat), parseFloat(h.lon));
  refs.push(p);
  console.log(
    `  ${h.lat},${h.lon} -> local (${p[0].toFixed(1)},${p[1].toFixed(1)})  ${h.type}  ${h.display_name.slice(0, 80)}`,
  );
}

const data = readData();
const key = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ours = data.buildings.filter((b) => b.n && key(b.n).includes(key(query)));
if (!ours.length) {
  console.log('\nno dataset footprint whose name contains that string');
  process.exit(0);
}
console.log('\ndataset footprints:');
for (const b of ours) {
  const c = areaCentroid(b.f);
  const d = Math.min(...refs.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
  console.log(
    `  ${b.n}: centroid (${c[0].toFixed(1)},${c[1].toFixed(1)}) ` +
      `${Math.abs(ringArea(b.f)).toFixed(0)}m2 h=${b.h} — ${d.toFixed(1)}m from the nearest nominatim point`,
  );
}
