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
import { blackFraction, decode } from './png.mjs';

const base = process.argv[2] || 'http://localhost:5177/';
const outDir = process.argv[3] || '/tmp/shots';
const views = process.argv.slice(4);
const wanted = views.length ? views : ['aerial', 'downtown', 'point', 'stadiums', 'bridges'];

// 960x540 is the largest frame this scene reliably completes under SwiftShader;
// 1280x720 loses roughly half the viewport to dropped tiles. See the pixel check
// below before raising it.
const WIDTH = Number(process.env.SHOT_WIDTH || 960);
const HEIGHT = Number(process.env.SHOT_HEIGHT || 540);
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
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* leftover profile */
  }
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

    // Confirm the page actually honoured the requested preset. An unknown name
    // silently falls back to `downtown`, which is how four "different" views
    // came back byte-identical and got read as a rendering bug for hours.
    const active = await call(
      'Runtime.evaluate',
      {
        expression: `JSON.stringify({
          active: (document.querySelector('#nav button.active') || {}).dataset?.view || null,
          known: [...document.querySelectorAll('#nav button[data-view]')].map((b) => b.dataset.view),
        })`,
        returnByValue: true,
      },
      20000,
    );
    const nav = JSON.parse(active?.result?.value || '{}');
    if (nav.active && nav.active !== view) {
      throw new Error(`page fell back to "${nav.active}"; known views: ${(nav.known || []).join(', ')}`);
    }

    /**
     * Wait on presented frames, not on the clock.
     *
     * Software rendering runs this scene at well under one frame per second, so
     * the old fixed 3.5 s sleep bought about two frames and `captureScreenshot`
     * came back mid-composite: whole bands of the viewport were still blank,
     * which looked exactly like a black slab of geometry sitting over downtown.
     * Counting `requestAnimationFrame` callbacks from inside the page measures
     * the thing we actually need - that a full frame has been presented since
     * the camera stopped moving.
     */
    await call('Runtime.evaluate', {
      expression: `window.__shotFrames = 0;
        (function count() { window.__shotFrames++; requestAnimationFrame(count); })();`,
    });
    const FRAMES = 6;
    const frameDeadline = Date.now() + 180000;
    let frames = 0;
    while (frames < FRAMES && Date.now() < frameDeadline) {
      await sleep(1000);
      const r = await call(
        'Runtime.evaluate',
        { expression: 'window.__shotFrames | 0', returnByValue: true },
        20000,
      ).catch(() => null);
      frames = r?.result?.value ?? frames;
    }
    if (frames < FRAMES) throw new Error(`only ${frames} frames in 180 s; renderer is stalled`);

    const shot = await call('Page.captureScreenshot', { format: 'png' }, 120000);
    const buf = Buffer.from(shot.data, 'base64');

    /**
     * Reject captures the rasteriser gave up on.
     *
     * SwiftShader drops whole tiles when a frame is heavy enough, leaving them
     * at pure black, and nothing in WebGL reports it: no context loss, no GL
     * error, no console output, and the frame is stable across a minute so it
     * does not look like a compositing race either. It reads as an enormous
     * black slab of geometry parked over the middle of the city. This scene
     * crosses that threshold somewhere between 960x540 and 1280x720, hence the
     * default below. Checking the pixels is the only way to catch it.
     */
    const black = blackFraction(decode(buf));
    if (black > 0.02) {
      throw new Error(
        `${(black * 100).toFixed(0)}% of the frame is #000000; the rasteriser dropped tiles. ` +
          `Try a smaller SHOT_WIDTH/SHOT_HEIGHT than ${WIDTH}x${HEIGHT}.`,
      );
    }

    const path = `${outDir}/${view}.png`;
    writeFileSync(path, buf);
    return path;
  } finally {
    ws?.close();
    chrome.kill('SIGKILL');
    // Chrome's I/O threads outlive the signal by a moment and recreate files
    // under the profile as it unwinds, so a recursive delete here races them and
    // throws ENOTEMPTY. Letting that escape reported a successful screenshot as
    // a failure, so the profile is left for /tmp to reap instead.
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* leftover profile, harmless */
    }
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
