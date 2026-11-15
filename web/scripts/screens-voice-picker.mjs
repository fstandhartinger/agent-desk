// Mock UI + real gateway catalog; no vendor calls. Optional PLAYWRIGHT_PACKAGE points to an installed package.
// node scripts/screens-voice-picker.mjs http://127.0.0.1:5179 ../docs/screens [chromiumPath]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { voiceCatalog } from '../../gateway/src/voice/voices.js';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const [base, out = '../docs/screens', executablePath] = process.argv.slice(2);
if (!base) throw new Error('Pass a Vite dev-server URL');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  for (const [kind, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
    const context = await browser.newContext({ viewport, locale: 'de-DE', isMobile: kind === 'mobile', hasTouch: kind === 'mobile' });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/?mock=1&auth=1`);
      await page.getByLabel('Sprachmodell wählen').waitFor();
      await page.evaluate((catalog) => {
        // The dev-only mock handles all other routes. Use the actual catalog for this new route.
        const fetch = window.fetch.bind(window);
        window.fetch = async (input, init) => String(input) === '/api/voices'
          ? new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } }) : fetch(input, init);
      }, voiceCatalog());
      await page.getByLabel('Sprachmodell wählen').click();
      await page.getByRole('menuitemradio', { name: /Gemini 3.8 Live Extended/ }).click();
      await page.getByRole('menuitemradio', { name: 'Stimme Sulafat', exact: true }).waitFor();
      assert.equal(await page.getByRole('menuitemradio', { name: /^Stimme / }).count(), 30);
      const menu = page.getByRole('menu');
      const box = await menu.boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${kind}: picker stays in viewport`);
      assert.ok(await menu.evaluate((el) => el.scrollHeight > el.clientHeight), '30 voices scroll');
      await page.getByRole('menuitemradio', { name: 'Stimme Sulafat', exact: true }).click();
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('desk.voiceNames.v1')).gemini), 'Sulafat');
      await menu.evaluate((el) => { el.scrollTop = 0; });
      await page.screenshot({ path: `${out}/voice-picker-${kind}.png` });
      // Reopening remembers the tick, and switching Gemini variants retains the voice.
      await page.keyboard.press('Escape');
      assert.equal(await menu.count(), 0);
      await page.getByLabel('Sprachmodell wählen').click();
      await page.getByRole('menuitemradio', { name: /Gemini 3.8 Live fast/ }).click();
      assert.equal(await page.getByRole('menuitemradio', { name: 'Stimme Sulafat', exact: true }).getAttribute('aria-checked'), 'true');
      // Media controls use a test-only catalog and stubbed playback, never a vendor or a fabricated voice recording.
      await page.evaluate(async (catalog) => {
        // Reuse the page's HMR URLs; importing a second unversioned module would create another store.
        const loaded = (name) => performance.getEntriesByType('resource').findLast((e) => new URL(e.name).pathname === `/src/lib/${name}.ts`)?.name ?? `/src/lib/${name}.ts`;
        const { installVoiceCatalog, voiceNamesStore } = await import(loaded('voiceNames'));
        const { voiceStore } = await import(loaded('voice'));
        catalog.providers.gemini.voices.forEach((v) => { v.sample = ['Sulafat', 'Charon'].includes(v.id) ? `/voice-samples/gemini/${v.id}.mp3` : null; });
        installVoiceCatalog(catalog);
        voiceNamesStore.set((s) => ({ ...s, active: { provider: 'gemini', id: 'Sulafat' } }));
        voiceStore.set((s) => ({ ...s, state: 'listening', active: 'gemini-fast' }));
        window.__media = [];
        HTMLMediaElement.prototype.play = async function () { window.__media.push(['play', this.getAttribute('src')]); };
        HTMLMediaElement.prototype.pause = function () { window.__media.push(['pause']); };
      }, voiceCatalog());
      await page.getByRole('button', { name: 'Sulafat anhören', exact: true }).click();
      await page.getByRole('button', { name: 'Sulafat stoppen', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Charon anhören', exact: true }).click();
      await page.getByRole('button', { name: 'Charon stoppen', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Sulafat stoppen', exact: true }).count(), 0);
      await page.getByRole('menuitemradio', { name: 'Stimme Charon', exact: true }).click();
      assert.equal(await page.getByText('gilt ab der nächsten Sitzung', { exact: true }).count(), 1);
      await page.keyboard.press('Escape');
      const media = await page.evaluate(() => window.__media);
      assert.equal(media.filter(([type]) => type === 'play').length, 2);
      assert.equal(media.at(-1)[0], 'pause', 'closing picker stops playback');
      await page.getByLabel('Sprachmodell wählen').click();
      await page.getByText('gilt ab der nächsten Sitzung', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(`${kind}: screenshot saved; 30 voices, viewport, scroll, persistence, Gemini variants, Escape, one-at-a-time playback, stop-on-close and next-session notice passed`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
