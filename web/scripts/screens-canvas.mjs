// Round-5 canvas screenshots from the dev-only demo (`npm run dev`, /canvas-demo.html): every fixture at 1440×900 and
// 390×844, the pending/error/empty frames and the same-id update sequence (3 steps).
// Usage: NODE_PATH=<playwright node_modules> node scripts/screens-canvas.mjs <devServerUrl> <outDir> [only]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const [base, out, only] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: screens-canvas.mjs <baseUrl> <outDir> [fixture]');
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FIX = ['flow', 'architecture', 'pie', 'sequence', 'bar', 'line', 'table', 'timeline', 'sankey', 'custom_svg'];
const VIEW = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const browser = await chromium.launch();
const errors = [];

async function shot(kind, query, name, settle = 2600) {
  const ctx = await browser.newContext({ viewport: VIEW[kind], deviceScaleFactor: 1, isMobile: kind === 'phone', hasTouch: kind === 'phone', locale: 'de-DE' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await p.goto(`${base}/canvas-demo.html?${query}`, { waitUntil: 'networkidle' });
  await wait(settle);
  await p.screenshot({ path: `${out}/${name}.png` });
  console.log('saved', name);
  return { p, ctx };
}

for (const kind of ['desktop', 'phone']) {
  for (const f of FIX) {
    if (only && only !== f) continue;
    const { ctx } = await shot(kind, `f=${f}&by=${f === 'architecture' ? 'claude' : f === 'pie' ? 'voice&provider=xai' : 'voice&provider=gemini'}`, `${kind}-${f}`);
    await ctx.close();
  }
  if (only && only !== 'states') continue;
  for (const [q, n] of [['pending=1', 'pending'], ['error=1', 'error'], ['empty=1', 'empty']]) {
    const { ctx } = await shot(kind, q, `${kind}-${n}`, 1400);
    await ctx.close();
  }
  // Update sequence: same id, 3 steps; one frame after each step settles plus one mid-tween frame.
  const { p, ctx } = await shot(kind, 'seq=1&step=1', `${kind}-update-1`, 2600);
  await p.evaluate(() => window.__step(2));
  await wait(330);
  await p.screenshot({ path: `${out}/${kind}-update-2-midtween.png` });
  await wait(2200);
  await p.screenshot({ path: `${out}/${kind}-update-2.png` });
  await p.evaluate(() => window.__step(3));
  await wait(2600);
  await p.screenshot({ path: `${out}/${kind}-update-3.png` });
  console.log('saved update sequence', kind);
  await ctx.close();
}
await browser.close();
if (errors.length) { console.error('page errors:\n' + errors.join('\n')); process.exitCode = 1; }
