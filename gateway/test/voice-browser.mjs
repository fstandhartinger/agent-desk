// Live browser proof of realtime voice (real vendors, no mocks): local gateway + local bridge (BRIDGE_HOST=lechonk-dev)
// serving the built web app, driven by Chromium with a fake microphone playing the German fixtures.
//   cd web && npm run build && cd ../gateway && node test/voice-browser.mjs [shotsDir]
// Needs GOOGLE_API_KEY (and XAI_API_KEY to see Grok fall back); writes screenshots to shotsDir, prints a JSON report.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const { chromium } = createRequire('/usr/lib/node_modules/')('playwright');
const root = path.resolve(import.meta.dirname, '../..');
const shots = path.resolve(process.argv[2] ?? path.join(root, 'docs/screens'));
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'voice-browser-'));
const CODE = crypto.randomBytes(9).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};

const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** WAV: 3 s lead-in, question, 4 s gap, job-status question (lands while the first answer is still playing), tail. */
function fakeMic(file) {
  const pcm = (n) => readFileSync(path.join(import.meta.dirname, `fixtures/${n}-de.pcm`));
  const silence = (s) => Buffer.alloc(Math.round(24000 * 2 * s));
  const data = Buffer.concat([silence(3), pcm('question'), silence(4), pcm('job-status'), silence(8)]);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(24000, 24); hdr.writeUInt32LE(48000, 28);
  hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([hdr, data]));
}

async function startStack(env = {}) {
  const port = await freePort();
  const token = crypto.randomBytes(16).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const children = [];
  const run = (cmd, args, cwd, extra) => {
    const c = spawn(cmd, args, { cwd, env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    c.logs = '';
    for (const s of [c.stdout, c.stderr]) s.on('data', (d) => { c.logs += d; });
    children.push(c);
    return c;
  };
  const gw = run('node', ['src/server.js'], path.join(root, 'gateway'), {
    PORT: String(port), DESK_ORIGIN: origin, DESK_ACCESS_CODE: CODE, DESK_SESSION_SECRET: crypto.randomBytes(16).toString('hex'),
    BRIDGE_TOKEN: token, DESK_PUBLIC_DIR: path.join(root, 'web/dist'), ...env,
  });
  run('node', ['src/bridge.js'], path.join(root, 'bridge'), {
    DESK_URL: `ws://127.0.0.1:${port}/bridge`, BRIDGE_TOKEN: token, BRIDGE_HOST: process.env.BRIDGE_HOST ?? 'lechonk' /* the hub addresses tools to host "lechonk"; this bridge only talks to the local gateway */,
    DESK_AUDIT_DIR: path.join(work, 'audit'), DESK_SESSIONS_DIR: path.join(work, 'sessions'),
  });
  for (let i = 0; i < 50; i++) {
    try {
      const h = await (await fetch(`${origin}/healthz`)).json();
      if (h.bridges?.length) return { origin, gw, stop: () => children.forEach((c) => c.kill('SIGTERM')) };
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`stack did not come up: ${gw.logs}`);
}

// Records the player worklet's reports (RMS, buffered seconds), flush posts and WS frame timing inside the page.
const INSTRUMENT = () => {
  const w = window;
  w.__v = { pcm: { maxRms: 0, maxBuffered: 0, msgs: 0 }, flushes: [], buffered: 0, ws: [], firstBinary: null, t0: performance.now() };
  const Orig = w.AudioWorkletNode;
  w.AudioWorkletNode = class extends Orig {
    constructor(ctx, name, opts) {
      super(ctx, name, opts);
      if (name !== 'pcm-player') return;
      this.port.addEventListener('message', (e) => {
        const d = e.data;
        w.__v.pcm.msgs++;
        w.__v.pcm.maxRms = Math.max(w.__v.pcm.maxRms, d.rms);
        w.__v.pcm.maxBuffered = Math.max(w.__v.pcm.maxBuffered, d.buffered);
        w.__v.buffered = d.buffered;
      });
      this.port.start();
      const post = this.port.postMessage.bind(this.port);
      this.port.postMessage = (m, t) => { if (m === 'flush') w.__v.flushes.push([Math.round(performance.now() - w.__v.t0), +w.__v.buffered.toFixed(2)]); return post(m, t); };
    }
  };
  const OrigWs = w.WebSocket;
  w.WebSocket = class extends OrigWs {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (e) => {
        const t = Math.round(performance.now() - w.__v.t0);
        if (typeof e.data === 'string') { try { w.__v.ws.push([t, JSON.parse(e.data).type]); } catch { /* ignore */ } }
        else if (w.__v.firstBinary === null) w.__v.firstBinary = t;
      });
    }
  };
};

async function openDesk(browser, stack, { viewport, option }) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'] });
  await ctx.addInitScript(INSTRUMENT);
  if (option) await ctx.addInitScript((o) => localStorage.setItem('desk.voiceOption.v1', JSON.stringify(o)), option);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${stack.origin}/#k=${CODE}`);
  await page.waitForSelector('textarea', { timeout: 20_000 });
  return { ctx, page };
}

const state = (page) => page.evaluate(() => document.querySelector('[role=status][aria-label^="Sprachmodus"]')?.getAttribute('aria-label') ?? null);
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const snap = async (page, name) => { await page.screenshot({ path: path.join(shots, `voice-${name}.png`) }); };

async function waitFor(page, label, fn, timeout = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function conversation(browser, stack, name, { option, viewport = { width: 1440, height: 900 }, expectFallback = false }) {
  const { ctx, page } = await openDesk(browser, stack, { viewport, option });
  const out = { name, option, states: new Set() };
  const poll = setInterval(async () => { try { const s = await state(page); if (s) out.states.add(s); } catch { /* page closing */ } }, 100);
  await page.keyboard.press('v');
  await waitFor(page, 'voice dock', async () => (await state(page)) !== null, 15_000);
  if (expectFallback) {
    await waitFor(page, 'fallback notice', async () => /übernimmt/.test(await bodyText(page)), 20_000);
    out.fallbackVisible = (await bodyText(page)).match(/[^\n]*übernimmt[^\n]*/)?.[0];
    await snap(page, `${name}-fallback`);
  }
  await waitFor(page, 'listening', async () => /Ich höre zu/.test((await state(page)) ?? ''), 30_000);
  const tReady = Date.now();
  await snap(page, `${name}-listening`);
  await waitFor(page, 'user transcript', async () => /Explainer-Video/.test(await bodyText(page)), 40_000);
  out.userTranscript = true;
  await waitFor(page, 'speaking', async () => /Spricht/.test((await state(page)) ?? ''), 40_000);
  out.firstSpeakingMs = Date.now() - tReady;
  await sleep(1200);
  await snap(page, `${name}-speaking`);
  // second utterance (job question) arrives while the first answer is playing -> barge-in
  const CHIP = /(Job-Status|Jobs auflisten|Kerndokument lesen|Dateien durchsuchen|Board-Themen)/g;
  await waitFor(page, 'tool chip', async () => CHIP.test(await bodyText(page)), 60_000).catch(() => {});
  out.toolChips = [...new Set((await bodyText(page)).match(CHIP))];
  await snap(page, `${name}-tool`);
  await waitFor(page, 'second answer finished', async () => /Ich höre zu|Denke/.test((await state(page)) ?? '') && (await page.evaluate(() => window.__v.pcm.msgs)) > 0, 60_000).catch(() => {});
  await sleep(4000);
  const v = await page.evaluate(() => window.__v);
  out.audio = v.pcm;
  out.flushes = v.flushes;
  out.firstBinaryAfterReadyMs = (() => { const r = v.ws.find(([, t]) => t === 'ready'); return r && v.firstBinary != null ? v.firstBinary - r[0] : null; })();
  out.wsTypes = [...new Set(v.ws.map(([, t]) => t))];
  out.finalText = (await bodyText(page)).slice(0, 1500);
  if (expectFallback) {
    await page.locator('[aria-label="Sprachmodell wählen"]').click();
    await sleep(500);
    out.picker = (await page.locator('[role=menuitemradio]').allInnerTexts()).map((t) => t.replace(/\n+/g, ' / '));
    await snap(page, `${name}-picker`);
  }
  clearInterval(poll);
  out.states = [...out.states];
  await ctx.close();
  return out;
}

async function failureFlow(browser, stack, name, option, viewport = { width: 1440, height: 900 }) {
  const { ctx, page } = await openDesk(browser, stack, { viewport, option });
  await page.keyboard.press('v');
  await waitFor(page, 'error state', async () => /Verbindung gestört/.test(await bodyText(page)), 25_000);
  const out = { name, errorText: (await bodyText(page)).match(/Verbindung gestört[\s\S]{0,260}/)?.[0].replace(/\n+/g, ' | '), retryButton: (await page.locator('button:has-text("Erneut versuchen")').count()) > 0 };
  out.pickerLabel = await page.evaluate(() => document.querySelector('[aria-label^="Live sprechen mit"]')?.getAttribute('aria-label'));
  await sleep(4800); // the toast (4.2 s) is gone; the dock itself keeps the message
  await snap(page, name);
  await page.locator('button:has-text("Erneut versuchen")').click();
  await sleep(1500);
  out.retried = await waitFor(page, 'retry attempt', async () => /Verbinde|Verbindung gestört/.test(await bodyText(page)), 10_000).then(() => true, () => false);
  await ctx.close();
  return out;
}

const only = process.env.ONLY?.split(',');
const want = (n) => !only || only.includes(n);
const micFile = path.join(work, 'mic.wav');
fakeMic(micFile);
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}%noloop`, '--autoplay-policy=no-user-gesture-required'] });
const main = await startStack();
try {
  if (want('gemini')) report.geminiExtended = await conversation(browser, main, 'gemini-extended', { option: 'gemini' });
  if (want('fast')) report.geminiFast = await conversation(browser, main, 'gemini-fast', { option: 'gemini-fast' });
  if (want('grok')) report.grokFallback = await conversation(browser, main, 'grok-fallback', { option: 'xai', expectFallback: true });
  if (want('phone')) report.phone = await conversation(browser, main, 'phone', { option: 'gemini-fast', viewport: { width: 390, height: 844 } });
  if (want('fail')) {
    const broken = await startStack({ GOOGLE_API_KEY: 'invalid-key-for-test' });
    try {
      report.geminiBroken = await failureFlow(browser, broken, 'gemini-broken', 'gemini');
      report.geminiBrokenPhone = await failureFlow(browser, broken, 'gemini-broken-phone', 'gemini', { width: 390, height: 844 });
      report.fallbackFailed = await failureFlow(browser, broken, 'grok-fallback-failed', 'xai');
    } finally { broken.stop(); }
  }
} finally {
  main.stop();
  await browser.close();
}
console.log(JSON.stringify(report, null, 1));
