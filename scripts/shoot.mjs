/**
 * Screenshot the scene at named camera presets.
 *
 * The app builds ~7,500 articulated buildings on load, which under software
 * WebGL takes far longer than Chrome's --screenshot flag will wait, and the
 * render loop never idles so --virtual-time-budget never settles either. So
 * drive Chrome over CDP instead and poll until the loading overlay is hidden.
 *
 * One browser per view. Reusing a browser across views leaked enough
 * SwiftShader memory that later tabs died mid-load, and a dead tab only ever
 * reports "not attached to an active page", which points nowhere near the cause.
 *
 *   node scripts/shoot.mjs <baseUrl> <outDir> [view ...]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const base = process.argv[2] || 'http://localhost:5177/';
const outDir = process.argv[3] || '/tmp/shots';
const views = process.argv.slice(4);
const wanted = views.length ? views : ['aerial', 'downtown', 'point', 'stadiums', 'bridges'];

const WIDTH = Number(process.env.SHOT_WIDTH || 1600);
const HEIGHT = Number(process.env.SHOT_HEIGHT || 900);
const READY_TIMEOUT_MS = Number(process.env.SHOT_READY_MS || 180000);
const ATTEMPTS = Number(process.env.SHOT_ATTEMPTS || 2);

mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(profile) {
  return spawn(
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
      `--user-data-dir=${profile}`,
      // Port 0 lets Chrome pick, and it writes the choice into the profile.
      // Fixing or guessing a port raced with concurrent runs.
      '--remote-debugging-port=0',
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

async function endpoint(profile) {
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

/** Any single CDP call can wedge behind a slow frame; never block the run on one. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`${label} timed out after ${ms} ms`);
    }),
  ]);
}

async function shoot(view) {
  const profile = `/tmp/shoot-profile-${process.pid}-${view}`;
  rmSync(profile, { recursive: true, force: true });
  const chrome = launch(profile);
  let ws;
  try {
    ws = new WebSocket(await endpoint(profile));
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p, timeout = 30000) => withTimeout(cdp.send(m, p, sessionId), timeout, m);

    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call('Page.navigate', { url: `${base}#${view}` });

    const started = Date.now();
    let ready = false;
    let lastMsg = '';
    while (Date.now() - started < READY_TIMEOUT_MS) {
      await sleep(2500);
      let state;
      try {
        const r = await call(
          'Runtime.evaluate',
          {
            expression: `JSON.stringify({
              hidden: !!(document.getElementById('loader') || {}).classList?.contains('hide'),
              text: (document.querySelector('#loader .loader-text') || {}).textContent || '',
              layers: (document.querySelector('#layers') || {}).textContent || '',
            })`,
            returnByValue: true,
          },
          20000,
        );
        state = r?.result?.value;
      } catch {
        continue;
      }
      if (!state) continue;
      const s = JSON.parse(state);
      lastMsg = (s.text || s.layers).trim();
      if (s.hidden) {
        ready = true;
        break;
      }
    }
    if (!ready) throw new Error(`never finished loading (${lastMsg})`);

    // Let the water animation and a couple of shadow frames settle.
    await sleep(3500);
    const shot = await call('Page.captureScreenshot', { format: 'png' }, 120000);
    const path = `${outDir}/${view}.png`;
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    return path;
  } finally {
    ws?.close();
    chrome.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }
}

let failures = 0;
for (const view of wanted) {
  let done = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !done; attempt++) {
    const started = Date.now();
    try {
      const path = await shoot(view);
      console.log(`  ${view}: ${path} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
      done = true;
    } catch (err) {
      const tag = attempt < ATTEMPTS ? 'retrying' : 'FAILED';
      console.log(`  ${view}: ${tag} — ${err.message}`);
    }
  }
  if (!done) failures++;
}
process.exit(failures ? 1 : 0);
