/**
 * Walk the live scene graph and report objects whose bounds are implausible.
 *
 * Written to chase a black slab that covered the middle of the `downtown` view.
 * A screenshot cannot tell you which of two dozen builders emitted a bad vertex,
 * and bisecting by commenting builders out costs a build and a 26 s capture per
 * guess. This attaches to the running page instead, traverses `window.__scene`,
 * and prints every mesh sorted by bounding-box volume with its material and
 * vertex count, which names the culprit in one pass.
 *
 *   node scripts/probe-scene.mjs [url]
 *
 * Requires a build with `window.__scene` exposed.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:5310/';
const profile = `/tmp/probe-profile-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--window-size=1024,640',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function endpoint() {
  const portFile = `${profile}/DevToolsActivePort`;
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if (!existsSync(portFile)) continue;
    const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    if (!port) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
  }
  throw new Error('Chrome never exposed a debugging port');
}

const ws = new WebSocket(await endpoint());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
});
const raw = (method, params = {}, sessionId) => {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

const { targetId } = await raw('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p) => raw(m, p, sessionId);

await call('Page.enable');
await call('Runtime.enable');
await call('Page.navigate', { url });

const PROBE = `(() => {
  const s = window.__scene;
  if (!s) return JSON.stringify({ error: 'no scene' });
  const THREE = window.__three;
  const rows = [];
  let nan = [];
  s.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isPoints && !o.isLine) return;
    const g = o.geometry;
    if (!g) return;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) return;
    const dx = bb.max.x - bb.min.x, dy = bb.max.y - bb.min.y, dz = bb.max.z - bb.min.z;
    const pos = g.attributes.position;
    let bad = 0;
    if (pos) {
      const a = pos.array;
      for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { bad++; if (bad < 3) nan.push(o.name || o.type); }
    }
    rows.push({
      name: o.name || '',
      type: o.type,
      mat: (o.material && (o.material.name || o.material.type)) || '',
      color: (o.material && o.material.color && o.material.color.getHexString) ? o.material.color.getHexString() : '',
      verts: pos ? pos.count : 0,
      dx: +dx.toFixed(1), dy: +dy.toFixed(1), dz: +dz.toFixed(1),
      min: [+bb.min.x.toFixed(1), +bb.min.y.toFixed(1), +bb.min.z.toFixed(1)],
      max: [+bb.max.x.toFixed(1), +bb.max.y.toFixed(1), +bb.max.z.toFixed(1)],
      vol: +(dx * dy * dz).toFixed(0),
      visible: o.visible,
    });
  });
  rows.sort((a, b) => b.vol - a.vol);
  return JSON.stringify({ total: rows.length, nan, rows: rows.slice(0, 30) });
})()`;

let out = null;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  const r = await call('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  const v = r?.result?.value;
  if (!v) continue;
  const parsed = JSON.parse(v);
  if (parsed.error) continue;
  if (parsed.total > 40) {
    out = parsed;
    break;
  }
}

if (!out) {
  console.log('scene never populated');
} else {
  console.log(`${out.total} drawable objects`);
  if (out.nan.length) console.log(`NON-FINITE POSITIONS in: ${out.nan.join(', ')}`);
  console.log('\nlargest by bounding volume:');
  for (const r of out.rows) {
    console.log(
      `  ${String(r.vol).padStart(14)}  ${`${r.dx}x${r.dy}x${r.dz}`.padEnd(26)} y ${String(r.min[1]).padStart(9)}..${String(r.max[1]).padEnd(9)} ${r.mat.padEnd(22)} #${r.color.padEnd(6)} v=${String(r.verts).padStart(7)} ${r.visible ? '' : 'HIDDEN '}${r.name}`,
    );
  }
}

ws.close();
chrome.kill('SIGKILL');
