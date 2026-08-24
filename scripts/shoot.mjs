/**
 * Screenshot the scene at named camera presets.
 *
 * The app builds ~7,500 articulated buildings on load, which under software
 * WebGL takes far longer than Chrome's --screenshot flag will wait, and the
 * render loop never idles so --virtual-time-budget never settles either. So
 * drive Chrome over CDP instead and poll until the loading overlay is hidden
 * and a few frames have gone by.
 *
 *   node scripts/shoot.mjs <baseUrl> <outDir> [view ...]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] || 'http://localhost:5177/';
const outDir = process.argv[3] || '/tmp/shots';
const views = process.argv.slice(4);
const wanted = views.length ? views : ['aerial', 'downtown', 'point', 'stadiums', 'bridges'];

const PORT = 9333;
const WIDTH = 1600;
const HEIGHT = 900;
const READY_TIMEOUT_MS = 300000;

mkdirSync(outDir, { recursive: true });

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
    // Its own profile, or it silently refuses the debugging port whenever
    // another Chrome already holds the default one.
    `--user-data-dir=/tmp/shoot-profile-${process.pid}`,
    `--remote-debugging-port=${PORT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('Chrome never exposed a debugging port');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const wsUrl = await endpoint();
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const cdp = new Cdp(ws);

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p) => cdp.send(m, p, sessionId);

await call('Page.enable');
await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});

const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

let failures = 0;
for (const view of wanted) {
  await call('Page.navigate', { url: `${base}#${view}` });
  const started = Date.now();
  let ready = false;
  let lastMsg = '';
  while (Date.now() - started < READY_TIMEOUT_MS) {
    await sleep(2000);
    const state = await evaluate(`(() => {
      const l = document.getElementById('loader');
      const t = l && l.querySelector('.loader-text');
      return JSON.stringify({
        hidden: !!(l && l.classList.contains('hide')),
        text: t ? t.textContent.trim() : '',
        layers: (document.querySelector('#layers') || {}).textContent || '',
      });
    })()`);
    if (!state) continue;
    const s = JSON.parse(state);
    lastMsg = s.text || s.layers;
    if (s.hidden) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    console.log(`  ${view}: TIMED OUT after ${((Date.now() - started) / 1000).toFixed(0)}s (${lastMsg})`);
    failures++;
    continue;
  }
  // Let a few frames land so the water animation and shadows settle.
  await sleep(4000);
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  const path = `${outDir}/${view}.png`;
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  console.log(`  ${view}: ${path} (${((Date.now() - started) / 1000).toFixed(0)}s, ${lastMsg})`);
}

ws.close();
chrome.kill('SIGKILL');
process.exit(failures ? 1 : 0);
