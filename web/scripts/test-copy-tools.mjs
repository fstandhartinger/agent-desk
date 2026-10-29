// Isolated browser regression: no production APIs or vendor inference. Run on LeChonk.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
const { chromium } = createRequire('/srv/heavy/tools/pw/package.json')('playwright');
const out = process.argv[2] || '../copy-evidence';
mkdirSync(out, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const results = [];
try {
  // A real 1920×1080 PNG, distinct from the live stage's middle state.
  const maker = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await maker.setContent('<body style="margin:0;background:#63d297;color:#111;font:80px sans-serif">FINAL SCENE B · 42%</body>');
  const png = await maker.screenshot();
  await maker.close();
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route('**/api/explainer/demo-copy/**', async (route) => {
      const file = route.request().url().split('/api/explainer/demo-copy/')[1];
      const timeline = { title: 'Copy tools browser check', duration: 60, scenes: [{ id: 'a', start: 0, end: 30, text: 'Anfang' }, { id: 'b', start: 30, end: 60, text: '42 Prozent' }], words: [{ w: 'Anfang.', s: 0, e: 1, scene: 'a' }, { w: 'Ergebnis.', s: 30, e: 31, scene: 'b' }] };
      const docs = {
        'timeline.json': timeline,
        'points.json': { page: { title: 'Copy tools browser check' }, points: { a: { title: 'Anfang' }, b: { title: 'Ergebnis' } } },
        'card.json': { card_id: 18917 },
        'metadata.json': { scenes: [{ id: 'a', start: 0, end: 30, endFrame: 'end-frames/000.png', text: 'Anfang' }, { id: 'b', start: 30, end: 60, endFrame: 'end-frames/001.png', text: 'Ergebnis\n42 Prozent' }] },
      };
      if (docs[file]) return route.fulfill({ json: docs[file] });
      if (file?.startsWith('end-frames/')) return route.fulfill({ contentType: 'image/png', body: png });
      if (file?.startsWith('stage.html')) return route.fulfill({ contentType: 'text/html', body: '<body style="background:#14141b;color:white;font:72px sans-serif">Live animation middle state<script>window.__ready=true;window.seekTo=t=>document.body.dataset.t=t;</script></body>' });
      if (file === 'audio.mp3') return route.fulfill({ status: 204 });
      return route.fulfill({ status: 404 });
    });
    await p.goto(`${base}/?mock=1&auth=1&x=demo-copy`);
    await p.getByTestId('copy-final-frame').waitFor();
    await p.getByRole('button', { name: 'Karte 18917 kopieren', exact: true }).last().click();
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), 'Karte 18917');
    await p.evaluate(() => { document.querySelector('audio').currentTime = 40; });
    await p.getByTestId('copy-final-frame').click();
    await p.getByText('Endbild kopiert', { exact: true }).waitFor();
    assert.deepEqual(await p.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const blob = await items[0].getType('image/png');
      const bitmap = await createImageBitmap(blob);
      return [items[0].types.includes('image/png'), bitmap.width, bitmap.height];
    }), [true, 1920, 1080]);
    await p.getByTestId('copy-slide-text').click();
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), 'Ergebnis\n42 Prozent');
    await p.locator('body').click({ position: { x: 2, y: 2 } });
    await p.keyboard.press('c');
    await p.waitForTimeout(200);
    assert.equal(await p.evaluate(async () => (await navigator.clipboard.read())[0].types.includes('image/png')), true);
    // Typing c in the composer must leave the clipboard alone.
    await p.evaluate(() => navigator.clipboard.writeText('typing sentinel'));
    if (width === 390) await p.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: 'Chat', exact: true }).click();
    await p.getByLabel('Nachricht', { exact: true }).fill('');
    await p.getByLabel('Nachricht', { exact: true }).press('c');
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), 'typing sentinel');
    if (width === 390) await p.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: 'Erklärung', exact: true }).click();
    await p.waitForTimeout(2000);
    await p.screenshot({ path: `${out}/desk-copy-${width}.png` });
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (width === 1440) {
      await p.getByRole('button', { name: 'Vollbild', exact: true }).click();
      await p.getByTestId('copy-final-frame').click();
      await p.locator('[data-fullscreen] [role=status]').getByText('Endbild kopiert').waitFor();
      await p.getByTestId('fs-exit').click();
    }
    // Real browser fallback: remove image clipboard support and observe a PNG download.
    await p.evaluate(() => { Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: undefined }); });
    const download = p.waitForEvent('download');
    await p.getByTestId('copy-final-frame').click();
    assert.match((await download).suggestedFilename(), /001\.png$/);
    await p.getByRole('button', { name: 'Andere Erklärung wählen', exact: true }).click();
    if (width === 1440) await p.getByRole('button', { name: 'Erklärung laden', exact: true }).click();
    await p.getByRole('button', { name: 'Karte 18917 kopieren', exact: true }).click();
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), 'Karte 18917');
    assert.equal(errors.length, 0, errors.join('\n'));
    results.push({ width, cardCopy: true, clipboardImage: 'image/png 1920x1080', sceneBText: true, shortcut: true, typingIgnored: true, downloadFallback: true, overflow: false, errors });
    await ctx.close();
  }
  writeFileSync(`${out}/report.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); await server.close(); }
