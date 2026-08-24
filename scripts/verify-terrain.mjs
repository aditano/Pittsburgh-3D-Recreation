import { readFileSync } from 'node:fs';
import { makeTerrain } from '/workspace/src/geo.js';
import { unproject } from '/workspace/scripts/osm.mjs';
const d = JSON.parse(readFileSync('/workspace/public/data/pittsburgh.json','utf8'));
const t = makeTerrain(d.terrain);
const pool = d.terrain.poolElevation;
// Well-known Pittsburgh points, checked against USGS 3DEP point-query service.
const spots = [
  ['Point State Park fountain', -765, -80],
  ['Downtown / Market Square', 330, 190],
  ['Mount Washington (Grandview)', -600, 900],
  ['Cathedral of Learning, Oakland', 4133, -369],
  ['PNC Park', -341, -665],
  ['Acrisure Stadium', -1182, -635],
  ['Strip District probe', 2200, -900],
  ['Herrs Island', 1150, -1750],
  ['Squirrel Hill', 5600, 1500],
];
const q = async (lat, lon) => {
  const url = `https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&units=Meters&wkid=4326&includeDate=false`;
  for (let i=0;i<4;i++){
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'pittsburgh-3d/1.0' } });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const v = Number(j.value ?? j?.location?.value);
      if (Number.isFinite(v)) return v;
      throw new Error('no value');
    } catch(e){ await new Promise(s=>setTimeout(s, 1500*(i+1))); }
  }
  return null;
};
console.log(`pool elevation ${pool} m; comparing "terrain + pool" against USGS 3DEP\n`);
console.log('name'.padEnd(30), 'ours(absMSL)', ' usgs', '  diff');
let n=0, sum=0, worst=0, worstName='';
for (const [name,x,z] of spots){
  const [lat,lon] = unproject(x,z);
  const ours = t(x,z) + pool;
  const usgs = await q(lat,lon);
  if (usgs === null){ console.log(name.padEnd(30), ours.toFixed(1).padStart(11), '   (query failed)'); continue; }
  const diff = ours - usgs;
  n++; sum += Math.abs(diff);
  if (Math.abs(diff) > Math.abs(worst)) { worst = diff; worstName = name; }
  console.log(name.padEnd(30), ours.toFixed(1).padStart(11), usgs.toFixed(1).padStart(7), (diff>=0?'+':'')+diff.toFixed(1));
}
if(n) console.log(`\nmean |error| ${(sum/n).toFixed(1)} m over ${n} points; worst ${worst.toFixed(1)} m at ${worstName}`);
