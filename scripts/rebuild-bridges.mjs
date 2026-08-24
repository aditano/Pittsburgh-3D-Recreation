/**
 * Solve each river bridge's deck from the OSM carriageway alignment.
 *
 * The deck stored in the dataset is the water crossing plus an abutment at each
 * end, solved by scripts/bridge-geom.mjs `solveDeck`. It is deliberately not the
 * published span: OSM carries a bridge's approach viaducts under the bridge's own
 * name (the Liberty Bridge's ways run 815 m for a 273 m river crossing), so
 * neither the way length nor the published main span is the length of deck this
 * scene needs.
 *
 * Run: node scripts/rebuild-bridges.mjs
 */
import { readData, writeData } from './osm.mjs';
import {
  alignmentsFor,
  angleGap,
  bearing180,
  bearing360,
  fetchBridgeWays,
  makeWetTest,
  solveDeck,
} from './bridge-geom.mjs';

/**
 * `real` is the published main-span length where one exists, logged for scale
 * only. `type` and `color` are what src/bridges.js reads to pick a structure.
 *
 * Only crossings whose channel lies inside the scene box are listed. The
 * Highland Park (z -5558), 62nd Street (z -5534) and Glenwood (z 5083) bridges
 * are outside it, and McKees Rocks spans x -4986..-3513 against a scene edge at
 * x -4600, so there is no channel here for any of them to cross.
 */
const BRIDGES = [
  { n: 'ROBERTO CLEMENTE BRIDGE', match: /^roberto clemente bridge$/i, type: 'sisters', color: '#f0d050', real: 303 },
  { n: 'ANDY WARHOL BRIDGE', match: /^andy warhol bridge$/i, type: 'sisters', color: '#f0d050', real: 323 },
  { n: 'RACHEL CARSON BRIDGE', match: /^rachel carson bridge$/i, type: 'sisters', color: '#f0d050', real: 303 },
  { n: 'FORT PITT BRIDGE', match: /^fort pitt bridge$/i, type: 'double-arch', color: '#f0d050', real: 368 },
  { n: 'FORT DUQUESNE BRIDGE', match: /^fort duquesne bridge$/i, type: 'double-arch', color: '#f0d050', real: 445 },
  { n: 'SMITHFIELD STREET BRIDGE', match: /^smithfield street( bridge)?$/i, type: 'lenticular', color: '#87949e', real: 361 },
  { n: 'LIBERTY BRIDGE', match: /^liberty bridge$/i, type: 'cantilever', color: '#cfb79a', real: 273 },
  { n: 'VETERANS BRIDGE', match: /^veterans bridge$/i, type: 'girder', color: '#8d939c', real: 320 },
  { n: 'WEST END BRIDGE', match: /^west end bridge$/i, type: 'tied-arch', color: '#f0d050', real: 236 },
  { n: 'DAVID MCCULLOUGH BRIDGE', match: /^(david mccullough bridge|16th street bridge)$/i, type: 'through-arch', color: '#f0d050', real: 275 },
  { n: 'ANDY WARHOL RAIL BRIDGE', match: /^fort wayne bridge$/i, type: 'through-truss', color: '#8d939c', real: 300 },
  { n: 'BIRMINGHAM BRIDGE', match: /^birmingham bridge$/i, type: 'tied-arch', color: '#53603f', real: 300 },
  { n: 'SOUTH TENTH STREET BRIDGE', match: /^south 10th street bridge$/i, type: 'suspension', color: '#f0d050', real: 221 },
  { n: 'PANHANDLE BRIDGE', match: /^panhandle bridge$/i, type: 'through-truss', color: '#8d939c', real: 350 },
  { n: 'HOT METAL BRIDGE', match: /^(hot metal bridge|hot metal street|monongahela connecting railroad bridge)$/i, type: 'through-truss', color: '#6f5546', real: 330 },
  { n: '31ST STREET BRIDGE', match: /^31st street bridge$/i, type: 'deck-arch', color: '#41688e', real: 265 },
  // Washington Crossing, 1924: steel open-spandrel deck arches, 360 ft centre
  // span. src/bridges.js already carries a structure for /40th|washington
  // crossing/, so this renders as a deck arch rather than the truss default.
  { n: '40TH STREET BRIDGE', match: /^(40th street bridge|washington crossing bridge)$/i, type: 'deck-arch', color: '#8d939c', real: 335 },
  // 1936 continuous Wichert through truss, three 465 ft spans over the
  // Monongahela at the Waterfront.
  { n: 'HOMESTEAD GRAYS BRIDGE', match: /^homestead grays bridge$/i, type: 'truss', color: '#8d939c', real: 470 },
];

const data = readData();
const wet = makeWetTest(data.water);
const raw = await fetchBridgeWays();

const before = new Map(data.bridges.map((b) => [b.n, b]));
const out = [];

for (const spec of BRIDGES) {
  const prev = before.get(spec.n);
  const lines = alignmentsFor(raw.elements, spec.match);
  const deck = solveDeck(lines, wet);

  if (deck.error) {
    console.log(`  ! ${spec.n}: ${deck.error}, keeping previous span`);
    if (prev) out.push(prev);
    continue;
  }

  const { a, b } = deck;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const prevLen = prev ? Math.hypot(prev.pts[1][0] - prev.pts[0][0], prev.pts[1][1] - prev.pts[0][1]) : 0;
  const turned = prev ? angleGap(bearing180(prev.pts[0], prev.pts[1]), bearing180(a, b)) : 0;

  console.log(
    `  ${prev ? ' ' : '+'} ${spec.n.padEnd(28)} channel ${deck.channel.toFixed(0).padStart(4)}m -> deck ${len.toFixed(0).padStart(4)}m ` +
      `(was ${prevLen.toFixed(0).padStart(4)}m, turned ${turned.toFixed(1).padStart(5)}deg)  main span ${String(spec.real).padStart(4)}m  ` +
      `bearing ${bearing360(a, b).toFixed(0).padStart(4)}deg  over water ${deck.overWater}/${deck.segments}, cluster ${deck.cluster}`,
  );

  out.push({
    n: spec.n,
    color: spec.color,
    type: spec.type,
    pts: [
      [+a[0].toFixed(2), +a[1].toFixed(2)],
      [+b[0].toFixed(2), +b[1].toFixed(2)],
    ],
  });
}

data.bridges = out;
data.meta.bridges =
  'decks solved from the dominant-bearing OSM carriageway cluster, clipped to the stitched river banks';
writeData(data);
console.log(`\nwrote ${out.length} bridges (was ${before.size})`);
