import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import polygonClipping from 'polygon-clipping';
import { createCityLife } from '../src/city-life.js';
import { makeTerrain } from '../src/geo.js';
import { fetchOptionalJson, loadCityDatasets } from '../src/load-city-data.js';
import { samplePath } from '../src/motion.js';
import { disposeComposerResources } from '../src/postprocessing.js';
import { readData, ROOT, unproject } from './osm.mjs';
import { assessBridges } from './verify-bridges.mjs';
import { assessCentreline, assessDryProbes } from './verify-water.mjs';
import { failureExitCode } from './verifier-exit.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

const urls = {
  city: 'pittsburgh.json',
  landcover: 'landcover.json',
  fabric: 'fabric.json',
  transit: 'transit.json',
  businesses: 'strip-businesses.json',
  streets: 'street-detail.json',
};

const optionalFetch = async (url) => {
  if (url === 'landcover.json') throw new Error('offline');
  if (url === 'fabric.json') return response(new SyntaxError('bad fabric'));
  if (url === 'transit.json') return response(null, false, 404);
  if (url === 'strip-businesses.json') return response({ shops: 1 });
  if (url === 'street-detail.json') return response(new SyntaxError('bad streets'));
  if (url === 'pittsburgh.json') return response({ buildings: [1] });
  throw new Error(`unexpected ${url}`);
};

const loaded = await loadCityDatasets(urls, optionalFetch);
assert.equal(loaded.landcover, null, 'network failure on landcover falls back');
assert.equal(loaded.fabric, null, 'invalid fabric JSON falls back');
assert.equal(loaded.transit, null, 'missing transit falls back');
assert.deepEqual(loaded.businesses, { shops: 1 }, 'a healthy optional layer still loads');
assert.equal(loaded.streets, null, 'invalid street JSON falls back');
assert.deepEqual(loaded.city, { buildings: [1] });
assert.equal(await fetchOptionalJson('missing.json', async () => response(null, false, 404)), null);

await assert.rejects(
  () => loadCityDatasets(urls, async (url) => (url === 'pittsburgh.json' ? Promise.reject(new Error('offline')) : response({}))),
  /offline/,
);
await assert.rejects(
  () => loadCityDatasets(urls, async (url) => (url === 'pittsburgh.json' ? response(null, false, 503) : response({}))),
  /503/,
);
await assert.rejects(() =>
  loadCityDatasets(urls, async (url) => (url === 'pittsburgh.json' ? response(new SyntaxError('bad city')) : response({}))),
);

const channel = [{ f: [[-50, -30], [50, -30], [50, 30], [-50, 30], [-50, -30]] }];
const span = (name, z) => ({ n: name, pts: [[-100, z], [100, z]] });
assert.equal(assessBridges({ water: channel, bridges: [span('SPAN', 0)] }).failures, 0);
const overlapped = assessBridges({ water: channel, bridges: [span('A', 0), span('B', 10)] });
assert.ok(overlapped.failures >= 1, 'decks 10 m apart are a failing overlap');
assert.equal(failureExitCode(overlapped.failures), 1);
assert.equal(failureExitCode(0), 0, 'informational findings do not fail the process');
const sunk = assessBridges({ water: channel, bridges: [{ n: 'SUNK', pts: [[-10, 0], [10, 0]] }] });
assert.ok(sunk.failures >= 1, 'a span with abutments in the water fails');

const pond = [{ n: 'pond', f: [[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]] }];
const submerged = assessDryProbes(
  { water: pond, buildings: [{ n: 'PNC Park', f: [[5, 5], [10, 5], [10, 10], [5, 10], [5, 5]] }] },
  [['PNC Park']],
);
assert.equal(submerged.probes[0].status, 'centre');
assert.equal(submerged.failures, 1);
assert.equal(failureExitCode(submerged.failures), 1);
const edgeOnly = assessDryProbes(
  { water: pond, buildings: [{ n: 'PNC Park', f: [[9, 9], [40, 40], [42, 40], [42, 42], [9, 9]] }] },
  [['PNC Park']],
);
assert.equal(edgeOnly.probes[0].status, 'edge');
assert.equal(edgeOnly.failures, 0);
assert.ok(edgeOnly.infos > 0);
assert.equal(failureExitCode(edgeOnly.failures), 0, 'an edge in the water is informational');
const missing = assessDryProbes({ water: [], buildings: [] }, [['PNC Park']]);
assert.equal(missing.failures, 1);
assert.equal(failureExitCode(missing.failures), 1);

const wet = (x, z) => x >= 0 && x <= 30 && z >= 0 && z <= 30;
const coverage = assessCentreline(
  wet,
  new Map([
    ['Wet River', [[[5, 5], [5, 20]]]],
    ['Dry River', [[[100, 100], [100, 180]]]],
  ]),
  { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 },
);
assert.equal(coverage.rivers.find((river) => river.name === 'Wet River').dry, 0);
assert.ok(coverage.rivers.find((river) => river.name === 'Dry River').dry > 0);
assert.equal(coverage.failures, 1);
assert.equal(failureExitCode(coverage.failures), 1);

const shipped = readData();
assert.equal(assessBridges(shipped).failures, 0, 'shipped bridges stay inside the acceptance thresholds');
assert.equal(assessDryProbes(shipped).failures, 0, 'shipped dry probes stay dry');

function runScript(name) {
  const script = fileURLToPath(new URL(`./${name}`, import.meta.url));
  return spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
}
const bridgeRun = runScript('verify-bridges.mjs');
assert.equal(bridgeRun.status, 0, bridgeRun.stderr || bridgeRun.stdout);
assert.match(bridgeRun.stdout, /0 bridges flagged/);
const waterRun = runScript('verify-water.mjs');
assert.equal(waterRun.status, 0, waterRun.stderr || waterRun.stdout);
assert.match(waterRun.stdout, /0 failing, 0 informational/);

const terrainSrc = readFileSync(new URL('./verify-terrain.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(terrainSrc, /\/workspace/, 'terrain verifier must not hard-code /workspace');
assert.match(terrainSrc, /from '\.\.\/src\/geo\.js'/);
assert.match(terrainSrc, /from '\.\/osm\.mjs'/);
const terrainData = JSON.parse(readFileSync(join(ROOT, 'public/data/pittsburgh.json'), 'utf8'));
const terrain = makeTerrain(terrainData.terrain);
assert.ok(Number.isFinite(terrain(330, 190)));
assert.equal(unproject(0, 0).length, 2);

assert.equal(typeof polygonClipping.intersection, 'function');

const order = [];
const fakePass = {
  dispose() {
    order.push('pass');
  },
  materialHighPassFilter: {
    dispose() {
      order.push('high');
    },
  },
};
disposeComposerResources({
  passes: [fakePass],
  dispose() {
    order.push('composer');
  },
});
assert.deepEqual(order, ['pass', 'high', 'composer']);
disposeComposerResources(null);

const bloom = new UnrealBloomPass(new THREE.Vector2(32, 32), 0.2, 0.4, 0.85);
const output = new OutputPass();
const renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
let brightDisposed = false;
let highPassDisposed = false;
let outputDisposed = false;
let composerDisposed = false;
const disposeBright = bloom.renderTargetBright.dispose.bind(bloom.renderTargetBright);
bloom.renderTargetBright.dispose = () => {
  brightDisposed = true;
  disposeBright();
};
const disposeHigh = bloom.materialHighPassFilter.dispose.bind(bloom.materialHighPassFilter);
bloom.materialHighPassFilter.dispose = () => {
  highPassDisposed = true;
  disposeHigh();
};
const disposeOutput = output.dispose.bind(output);
output.dispose = () => {
  outputDisposed = true;
  disposeOutput();
};
disposeComposerResources({
  passes: [renderPass, bloom, output],
  dispose() {
    composerDisposed = true;
  },
});
assert.equal(brightDisposed, true, 'bloom mip targets are disposed with the pass');
assert.equal(highPassDisposed, true, 'bloom high-pass material is disposed');
assert.equal(outputDisposed, true, 'output pass is disposed');
assert.equal(composerDisposed, true);

function straightRoad() {
  const life = createCityLife({ streets: [], buildings: [] }, () => 0, { inside: () => false }, new THREE.Scene(), true, {
    roads: [{ highway: 'primary', oneway: 'yes', name: 'Main', c: [[0, 0], [0, 40], [0, 80]] }],
    signals: [],
  });
  const segA = life.segments.find((s) => s.a[1] === 0 && s.b[1] === 40);
  const segB = life.segments.find((s) => s.a[1] === 40 && s.b[1] === 80);
  const [lead, follow] = life.vehicles;
  return { life, segA, segB, lead, follow };
}

function along(agent, segA, segB) {
  if (agent.s === segA) return agent.d * segA.length - segA.length;
  if (agent.s === segB) return agent.d * segB.length;
  const p = samplePath(agent.s.path, agent.d * agent.s.length);
  throw new Error(`agent left the test road at ${p.x},${p.z}`);
}

function leadAhead(follow, lead, segA, segB) {
  return along(lead, segA, segB) - along(follow, segA, segB);
}

function place(agent, segA, segB, { speed = 0, d = 0, segment = segA } = {}) {
  agent.s = segment;
  agent.d = d;
  agent.speed = speed;
  agent.velocity = speed;
}

const held = straightRoad();
place(held.lead, held.segA, held.segB, { segment: held.segB, d: 0, speed: 0 });
place(held.follow, held.segA, held.segB, { segment: held.segA, d: (40 - 10) / 40, speed: 40 });
assert.ok(leadAhead(held.follow, held.lead, held.segA, held.segB) > 6);
held.life.update(1, 0, 0);
const heldGap = leadAhead(held.follow, held.lead, held.segA, held.segB);
assert.ok(heldGap >= 6 - 1e-6, `follower jumped the stopped car at the join (gap ${heldGap})`);
assert.equal(held.follow.s, held.segA, 'a car stopped on the next segment keeps the follower on this one');

const entry = straightRoad();
place(entry.lead, entry.segA, entry.segB, { segment: entry.segB, d: 12 / 40, speed: 0 });
place(entry.follow, entry.segA, entry.segB, { segment: entry.segA, d: (40 - 10) / 40, speed: 12 });
let entryMin = leadAhead(entry.follow, entry.lead, entry.segA, entry.segB);
for (let i = 0; i < 80; i++) {
  entry.life.update(0.05, i, 0);
  entryMin = Math.min(entryMin, leadAhead(entry.follow, entry.lead, entry.segA, entry.segB));
}
const entryGap = leadAhead(entry.follow, entry.lead, entry.segA, entry.segB);
assert.equal(entry.follow.s, entry.segB, 'the follower enters once the next segment has room');
assert.ok(entryMin >= 6 - 1e-6, `cross-segment gap collapsed to ${entryMin}`);
assert.ok(entryGap < 6.5, `follower should close to the 6 m gap, still ${entryGap} m back`);

const cruise = straightRoad();
place(cruise.lead, cruise.segA, cruise.segB, { segment: cruise.segB, d: 0.95, speed: 0 });
place(cruise.follow, cruise.segA, cruise.segB, { segment: cruise.segA, d: 0.5, speed: 12 });
let cruiseMin = Infinity;
for (let i = 0; i < 80; i++) {
  cruise.life.update(0.05, i, 0);
  cruiseMin = Math.min(cruiseMin, leadAhead(cruise.follow, cruise.lead, cruise.segA, cruise.segB));
}
assert.ok(cruise.follow.s === cruise.segB, 'an open downstream segment is entered');
assert.ok(cruiseMin >= 6 - 1e-6, `following distance dipped to ${cruiseMin}`);

const same = straightRoad();
place(same.lead, same.segA, same.segB, { segment: same.segA, d: 0.85, speed: 0 });
place(same.follow, same.segA, same.segB, { segment: same.segA, d: 0.2, speed: 12 });
let sameMin = Infinity;
for (let i = 0; i < 120; i++) {
  same.life.update(0.05, i, 0);
  sameMin = Math.min(sameMin, (same.lead.d - same.follow.d) * same.segA.length);
}
assert.equal(same.follow.s, same.segA);
assert.ok(sameMin >= 6 - 1e-6, `same-segment gap dipped to ${sameMin}`);

console.log('Passed: optional data fallbacks, verifier exit codes, postprocessing disposal, and cross-segment queues.');
