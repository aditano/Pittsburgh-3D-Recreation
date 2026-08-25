/**
 * Screenshot `landmark-preview.html`, which renders one district in a single
 * frame with no animation loop. Much cheaper than the full scene, and because
 * nothing is competing for the main thread afterwards, CDP stays responsive.
 *
 *   node scripts/preview.mjs <outPng> "<query string>"
 *
 * The query string is passed through to the preview page, e.g.
 *   node scripts/preview.mjs /tmp/acrisure.png "b=Acrisure&az=1.9&el=0.22&r=320"
 *
 * Recognised params: b (building name substring), x / z (explicit anchor when
 * there is no matching name), r (radius in metres), az / el (camera azimuth and
 * elevation in radians), d (camera distance), zoom, top.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { blackFraction, decode } from './png.mjs';

const out = process.argv[2] || '/tmp/preview.png';
const query = process.argv[3] || '';
const baseUrl = process.env.PREVIEW_BASE || 'http://127.0.0.1:5177';
const url = `${baseUrl}/landmark-preview.html${query ? `?${query}` : ''}`;

// Same ceiling as scripts/shoot.mjs: SwiftShader drops tiles above this.
const WIDTH = Number(process.env.SHOT_WIDTH || 960);
const HEIGHT = Number(process.env.SHOT_HEIGHT || 540);
const profile = `/tmp/preview-profile-${process.pid}`;

mkdirSync(dirname(out), { recursive: true });

const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    // Port 0 lets Chrome pick and write the choice into the profile. Guessing a
    // port raced with concurrent runs: the loser attached to the other run's
    // browser and then failed every call with "not attached to an active page".
    '--remote-debugging-port=0',
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const wsUrl = await endpoint();
const ws = new WebSocket(wsUrl);
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
await call('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});

const errors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params?.exceptionDetails?.exception?.description || 'exception');
  }
});

await call('Page.navigate', { url });

let hud = '';
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const r = await call('Runtime.evaluate', {
    expression: `JSON.stringify({ ready: !!window.__ready, hud: (document.getElementById('hud')||{}).textContent || '' })`,
    returnByValue: true,
  });
  const s = r?.result?.value ? JSON.parse(r.result.value) : null;
  if (!s) continue;
  hud = s.hud;
  if (s.ready) {
    ready = true;
    break;
  }
}

if (!ready) {
  console.log(`FAILED: preview never signalled ready. ${errors.join(' | ')}`);
  ws.close();
  chrome.kill('SIGKILL');
  process.exit(1);
}

await sleep(600);
const shot = await call('Page.captureScreenshot', { format: 'png' });
const buf = Buffer.from(shot.data, 'base64');
const black = blackFraction(decode(buf));
if (black > 0.02) {
  console.log(
    `FAILED: ${(black * 100).toFixed(0)}% of the frame is #000000; the rasteriser dropped tiles.`,
  );
  ws.close();
  chrome.kill('SIGKILL');
  process.exit(1);
}
writeFileSync(out, buf);
console.log(`${out}  ${hud}`);
if (errors.length) console.log(`  console errors: ${errors.join(' | ')}`);

ws.close();
chrome.kill('SIGKILL');
