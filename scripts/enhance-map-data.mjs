/**
 * Enriches pittsburgh.json with landmark styles, roof types, and expanded labels.
 * Run: node scripts/enhance-map-data.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = join(root, 'public/data/pittsburgh.json');
const data = JSON.parse(readFileSync(dataPath, 'utf8'));

function footprintCentroid(f) {
  let cx = 0;
  let cz = 0;
  const n = f.length - 1;
  for (let i = 0; i < n; i++) {
    cx += f[i][0];
    cz += f[i][1];
  }
  return [cx / n, cz / n];
}

const STYLE_RULES = [
  [/ppg place|^(one|two|three|four|five|six) ppg place/i, 'ppg'],
  [/cathedral of learning/i, 'gothic'],
  [/heinz memorial chapel/i, 'chapel'],
  [/gulf tower/i, 'artdeco'],
  [/koppers tower/i, 'copper'],
  [/grant building/i, 'artdeco'],
  [/david l\. lawrence convention/i, 'convention'],
  [/u\.?s\.? steel tower/i, 'steelTower'],
  [/tower at pnc plaza/i, 'glass'],
  [/fifth avenue place|bny mellon|one oxford|eqt plaza|k&l gates/i, 'glass'],
  [/soldiers and sailors/i, 'sandstone'],
  [/carnegie (museum|library|hall|mellon)/i, 'sandstone'],
  [/heinz hall|warhol museum/i, 'brick'],
  [/presbyterian church|memorial chapel|united church|cathedral parish/i, 'chapel'],
  [/pnc park|acrisure|heinz field|stadium/i, 'stadium'],
  [/convention center|westin convention/i, 'convention'],
];

const LANDMARK_MESH = [
  [/^(ppg place|one ppg place)$/i, 'ppg-tower'],
  [/^(two|three|four|five) ppg place$/i, 'ppg-low'],
  [/^six ppg place$/i, 'ppg-mid'],
  [/cathedral of learning/i, 'cathedral'],
  [/u\.?s\.? steel tower/i, 'us-steel'],
  [/gulf tower/i, 'gulf-tower'],
  [/koppers tower/i, 'koppers-tower'],
  [/grant building/i, 'grant-building'],
  [/david l\. lawrence convention/i, 'convention-center'],
  [/heinz memorial chapel/i, 'heinz-chapel'],
  [/tower at pnc plaza/i, 'pnc-tower'],
  [/fifth avenue place/i, 'fifth-avenue'],
  [/bny mellon center/i, 'bny-mellon'],
  [/one oxford centre/i, 'oxford-centre'],
  [/^pnc park$/i, 'pnc-park'],
  [/^acrisure stadium$/i, 'acrisure-stadium'],
];

const ROOF_RULES = [
  [/u\.?s\.? steel/i, 'flat'],
  [/gulf tower/i, 'stepped'],
  [/koppers/i, 'dome'],
  [/grant building/i, 'globe'],
  [/cathedral of learning/i, 'gothicSpire'],
  [/ppg place|one ppg/i, 'spires'],
  [/tower at pnc/i, 'spire'],
  [/bny mellon/i, 'antenna'],
];

function matchRule(rules, name) {
  for (const [re, val] of rules) {
    if (re.test(name)) return val;
  }
  return null;
}

let styled = 0;
let meshLandmarks = 0;
let roofTagged = 0;

for (const b of data.buildings) {
  const n = b.n || '';
  const style = matchRule(STYLE_RULES, n);
  if (style) {
    b.style = style;
    styled++;
  }
  const meshId = matchRule(LANDMARK_MESH, n);
  if (meshId) {
    b.landmarkMesh = meshId;
    b.landmark = true;
    meshLandmarks++;
  }
  const roof = matchRule(ROOF_RULES, n);
  if (roof) {
    b.roof = roof;
    roofTagged++;
  }
  if (b.h > 120 && !b.roof && !b.landmarkMesh) {
    b.roof = 'antenna';
    roofTagged++;
  }
}

const extraLandmarks = [
  { n: 'GULF TOWER', p: [575, -178.3], h: 178 },
  { n: 'GRANT BUILDING', p: [377.6, 373], h: 149 },
  { n: 'KOPPERS TOWER', p: [547.1, -123.4], h: 145 },
  { n: 'CONVENTION CENTER', p: [562.7, -488.9], h: 157 },
  { n: 'HEINZ MEMORIAL CHAPEL', p: [4248.9, -480.8], h: 50 },
  { n: 'TOWER AT PNC PLAZA', p: [140.5, 86], h: 166 },
  { n: 'CARNEGIE MUSEUM', p: [3800, -800], h: 35 },
  { n: 'SOLDIERS & SAILORS MEMORIAL', p: [3200, -200], h: 45 },
  { n: 'ANDY WARHOL MUSEUM', p: [-200, -600], h: 25 },
  { n: 'ROBERTO CLEMENTE BRIDGE', p: [80, -640], h: 25 },
  { n: 'RACHEL CARSON BRIDGE', p: [-280, -470], h: 25 },
  { n: 'FORT PITT BRIDGE', p: [-850, 100], h: 35 },
  { n: 'LIBERTY BRIDGE', p: [490, 840], h: 30 },
  { n: 'SMITHFIELD STREET BRIDGE', p: [-55, 620], h: 25 },
  { n: 'MONONGAHELA INCLINE', p: [-1200, 350], h: 15 },
];

const existing = new Set((data.landmarks || []).map((l) => l.n.toUpperCase()));
for (const lm of extraLandmarks) {
  if (!existing.has(lm.n)) data.landmarks.push(lm);
}

data.terrainPeaks = [
  { p: [-720.14, 1391.5], h: 125, r: 750 },
  { p: [-1525.01, 667.92], h: 95, r: 520 },
  { p: [-1364.04, 200.38], h: 75, r: 280 },
  { p: [3134.74, -1558.48], h: 58, r: 620 },
  { p: [4405.59, -445.28], h: 48, r: 520 },
  { p: [4134.47, -365.9], h: 42, r: 400 },
  { p: [1863.9, -2115.08], h: 62, r: 420 },
  { p: [169.45, -2115.08], h: 38, r: 460 },
  { p: [-900, -700], h: 28, r: 350 },
  { p: [2800, 200], h: 32, r: 380 },
];

data.meta.note =
  'OSM buildings, streets, parks + crafted three-rivers water + landmark mesh metadata';
data.meta.enhanced = '2026-08-23';
data.meta.landmarkMeshes = meshLandmarks;
data.meta.styledBuildings = styled;

writeFileSync(dataPath, JSON.stringify(data));
console.log(`Enhanced ${dataPath}`);
console.log(`  styled: ${styled}, landmark meshes: ${meshLandmarks}, roofs: ${roofTagged}`);
console.log(`  landmarks: ${data.landmarks.length}, terrain peaks: ${data.terrainPeaks.length}`);
