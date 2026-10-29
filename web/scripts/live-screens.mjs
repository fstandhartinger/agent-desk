// Screenshots of this UI against the live gateway (dev server started with DESK_API=https://desk.app.mintapis.com).
// Logs in through the #k= link with DESK_ACCESS_CODE from the environment; the code is never printed or stored.
// Usage: DESK_ACCESS_CODE=… NODE_PATH=<playwright dir> node scripts/live-screens.mjs http://localhost:<port> <outDir>
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const [base, out = '../docs/screens'] = process.argv.slice(2);
const code = process.env.DESK_ACCESS_CODE;
if (!base || !code) throw new Error('usage: DESK_ACCESS_CODE=… live-screens.mjs <devServerUrl> [outDir]');
mkdirSync(out, { recursive: true });
const SLUG = process.env.DESK_SLUG ?? 'engine-crowning-rxpjnm2ehx';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const scrub = (s) => String(s).split(code).join('<CODE>');

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('pageerror:', scrub(e.message)));
const shot = async (name) => {
  await p.screenshot({ path: `${out}/r2-live-${name}.png` });
  console.log('saved', name);
};

await p.goto(`${base}/?x=${SLUG}#k=${encodeURIComponent(code)}`, { waitUntil: 'networkidle' });
await p.getByRole('button', { name: 'Verlauf öffnen' }).waitFor({ timeout: 15000 });
if (await p.evaluate(() => location.hash)) throw new Error('login hash was not stripped');
await p.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.__ready === true, null, { timeout: 20000 });
await wait(2500);
await shot('desktop-1440-start');

await p.getByLabel('Nachricht', { exact: true }).fill(process.env.DESK_QUESTION ?? 'Welche Jobs laufen gerade?');
await p.keyboard.press('Enter');
const t0 = Date.now();
const status = p.getByRole('status').filter({ hasText: /\S/ });
await Promise.race([status.first().waitFor({ timeout: 8000 }).then(() => console.log(`status line after ${Date.now() - t0} ms`)), wait(8000)]).catch(() => {});
await wait(1500);
await shot('desktop-1440-streaming');
await p.getByTestId('model-badge').last().waitFor({ timeout: 90000 }).catch(() => console.log('no model badge (answer failed?)'));
console.log(`answer done after ${Date.now() - t0} ms`);
await p.locator('.group\\/msg').last().hover();
await shot('desktop-1440-answer');

await p.getByRole('tab', { name: /Claude/ }).click();
await wait(1500);
await shot('desktop-1440-claude-list');
const first = p.locator('#live-panel-claude li button').first();
if (await first.count()) {
  await first.click();
  await wait(3000);
  await shot('desktop-1440-claude-session');
}

await p.getByRole('button', { name: 'Verlauf öffnen' }).click();
await wait(500);
await shot('desktop-1440-history');
await p.keyboard.press('Escape');

await p.getByRole('button', { name: 'Kino', exact: true }).click();
await wait(600);
await shot('desktop-1440-kino');
await p.getByRole('button', { name: 'Kino', exact: true }).click();

await p.setViewportSize({ width: 1920, height: 1080 });
await wait(800);
await shot('desktop-1920');

await p.setViewportSize({ width: 390, height: 844 });
await wait(800);
await shot('phone-chat');
await p.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: 'Erklärung', exact: true }).click();
await wait(500);
await shot('phone-explainer');
await p.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: 'Live', exact: true }).click();
await wait(500);
await shot('phone-live');

await browser.close();
