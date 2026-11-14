// Screenshots of the 14 Nov canvas forms (points, stat, stacked bar) from the dev-only demo (`npm run dev`, /canvas-demo.html)
// at a phone (390×640) and a desktop (1280×720) stage. The demo page has no voice session, so the points reveal with their
// 120 ms stagger; `points-partial` shows the speech-synced state (only the first row visible) through window.__show.
// Usage: NODE_PATH=<playwright node_modules> node scripts/screens-forms.mjs <devServerUrl> <outDir> [only]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const [base, out, only] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: screens-forms.mjs <baseUrl> <outDir> [fixture]');
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FIX = ['points', 'stat', 'stacked'];
const VIEW = { phone: { width: 390, height: 640 }, desktop: { width: 1280, height: 720 } };
const browser = await chromium.launch();
const errors = [];

for (const [kind, viewport] of Object.entries(VIEW)) {
  for (const f of FIX) {
    if (only && only !== f) continue;
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: kind === 'phone', hasTouch: kind === 'phone', locale: 'de-DE' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${kind}-${f}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${kind}-${f}: ${m.text()}`); });
    await p.goto(`${base}/canvas-demo.html?f=${f}&by=voice&provider=xai`, { waitUntil: 'networkidle' });
    await wait(3000);
    await p.screenshot({ path: `${out}/${f}-${viewport.width}x${viewport.height}.png` });
    console.log('saved', `${f}-${viewport.width}x${viewport.height}`);
    await ctx.close();
  }
}

// Speech-synced reveal in a real browser: drive the speech cursor store (the same module instance the app uses) like a voice
// session would, and check what the animator does with the rows (opacity per row), plus a screenshot of the partial state.
const TEXT = 'Es gibt drei Gründe dafür. Erstens, die Prüfbarkeit: ein Eintrag, ein Start. Zweitens: Die Belohnung ist fest, niemand rechnet nach. Und drittens die Vorfahren, sie werden nicht bezahlt.';
if (!only || only === 'points') {
  for (const [kind, viewport] of Object.entries(VIEW)) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: kind === 'phone', hasTouch: kind === 'phone', locale: 'de-DE' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${kind}-sync: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${kind}-sync: ${m.text()}`); });
    await p.goto(`${base}/canvas-demo.html?f=points&by=voice&provider=xai`, { waitUntil: 'networkidle' });
    await wait(3000);
    // rows' opacity: the first <text> of every row (numerals are 1/2/3, so use the label texts)
    const rows = () => p.evaluate(() => [...document.querySelectorAll('svg.cv-svg text')].filter((t) => /^(Prüfbarkeit|Feste Belohnung|Vorfahren)/.test(t.textContent ?? '')).map((t) => Number(getComputedStyle(t).opacity)));
    console.log(kind, 'no voice session: rows', JSON.stringify(await rows()));
    await p.evaluate(async ({ text }) => {
      const sc = await import('/src/lib/speechCursor.ts');
      window.__sc = sc;
      sc.noteSpecTurn('warum-gleich-teilen', 5);
      sc.speechCursor.set((s) => ({ ...s, active: true, turn: 5, text, spokenChars: 0, speaking: true }));
    }, { text: TEXT });
    await wait(900);
    console.log(kind, 'voice active, nothing spoken: rows', JSON.stringify(await rows()));
    await p.screenshot({ path: `${out}/points-partial-1-${viewport.width}x${viewport.height}.png` });
    await p.evaluate((n) => window.__sc.speechCursor.set((s) => ({ ...s, spokenChars: n })), TEXT.indexOf('Zweitens'));
    await wait(110);
    console.log(kind, '110 ms after the 2nd cue: rows', JSON.stringify(await rows()));
    await wait(500);
    console.log(kind, '600 ms after the 2nd cue: rows', JSON.stringify(await rows()));
    await p.screenshot({ path: `${out}/points-partial-2-${viewport.width}x${viewport.height}.png` });
    // the answer ends: speaking false for > 1.5 s shows the rest
    await p.evaluate(() => window.__sc.speechCursor.set((s) => ({ ...s, speaking: false })));
    await wait(2300);
    console.log(kind, 'speech over (1.5 s idle): rows', JSON.stringify(await rows()));
    // a new user turn: a still-visible sync canvas shows everything at once
    await ctx.close();
  }
}
await browser.close();
if (errors.length) { console.error('page errors:\n' + errors.join('\n')); process.exitCode = 1; }
