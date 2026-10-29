// Round-3 review screenshots against the mock UI (`npm run dev`, ?mock=1): poster frame, voice fallback dock,
// phone point card, hand-off form, stopped Claude session. Usage: NODE_PATH=<playwright node_modules> node scripts/screens-r3.mjs <devServerUrl> <outDir> [chromiumPath]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const [base, out, executablePath] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: screens-r3.mjs <baseUrl> <outDir> [chromiumPath]');
mkdirSync(out, { recursive: true });
const SLUG = 'engine-crowning-rxpjnm2ehx';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: executablePath || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

async function open(kind) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[kind], hasTouch: kind === 'phone', isMobile: kind === 'phone', locale: 'de-DE' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.error(`[${kind}] pageerror:`, e.message));
  await p.goto(`${base}/?mock=1&auth=1&x=${SLUG}`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.__ready === true, null, { timeout: 20000 });
  await wait(900);
  return p;
}
const shot = (p, name) => p.screenshot({ path: `${out}/r3-${name}.png` }).then(() => console.log('saved', name));
const tab = (p, label) => p.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: label, exact: true }).click();

for (const kind of ['desktop', 'phone']) {
  let p = await open(kind);
  await shot(p, `${kind}-poster`);
  if (kind === 'phone') await tab(p, 'Erklärung');
  await p.getByRole('button', { name: 'Abspielen' }).first().click();
  await wait(2500);
  await p.keyboard.press('Space');
  await p.frameLocator('iframe').locator('.pt').first().click({ force: true });
  await wait(1200);
  if (kind === 'phone') {
    await p.locator('.scroll-y').first().evaluate((el) => el.scrollTo(0, 0));
    await wait(300);
  }
  await shot(p, `${kind}-point-card`);
  await p.context().close();

  p = await open(kind);
  if (kind === 'phone') await tab(p, 'Chat');
  await p.keyboard.press('v');
  await wait(6800);
  await shot(p, `${kind}-voice-fallback-dock`);
  await p.context().close();

  p = await open(kind);
  if (kind === 'phone') await tab(p, 'Live');
  await p.getByRole('tab', { name: /Claude/ }).click();
  await p.locator('#live-panel-claude').getByRole('button', { name: /Desk-Link in Erklärseiten/ }).click();
  await wait(2600);
  await shot(p, `${kind}-claude-running`);
  await p.getByRole('button', { name: 'Stopp', exact: true }).click();
  await wait(1200);
  await shot(p, `${kind}-claude-stopped`);
  await p.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await wait(400);
  await p.locator('#live-panel-claude').getByRole('button', { name: /Neue/ }).first().click();
  await wait(600);
  await shot(p, `${kind}-handoff-form`);
  await p.context().close();
}
await browser.close();
