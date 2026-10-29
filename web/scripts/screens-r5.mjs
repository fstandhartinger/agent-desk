// Round-5 screenshots of the canvas inside the real desk (mock backend, `npm run dev`): Live panel with bus history,
// a chat question that draws (pending → ready), the enlarge overlay, the Gate's Telegram-link states, and a real PNG
// export download from the demo page.
// Usage: NODE_PATH=<playwright node_modules> node scripts/screens-r5.mjs <devServerUrl> <outDir>
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: screens-r5.mjs <baseUrl> <outDir>');
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEW = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
const errors = [];
const shot = (p, name) => p.screenshot({ path: `${out}/${name}.png` }).then(() => console.log('saved', name));

async function open(kind, query) {
  const ctx = await browser.newContext({ viewport: VIEW[kind], isMobile: kind === 'phone', hasTouch: kind === 'phone', locale: 'de-DE', acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${kind}: ${e.message}`));
  await p.goto(`${base}/?mock=1&${query}`, { waitUntil: 'networkidle' });
  await wait(1500);
  return p;
}

for (const kind of ['desktop', 'phone']) {
  // 1. Desk with the canvas history from the bus.
  let p = await open(kind, 'auth=1');
  if (kind === 'phone') await p.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: 'Live', exact: true }).click();
  await wait(2200);
  await shot(p, `desk-${kind}-canvas`);
  // 2. A chat question → pending frame → ready donut.
  if (kind === 'phone') await p.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: 'Chat', exact: true }).click();
  const box = p.getByPlaceholder(/Frag den Desk/);
  await box.fill('Wofür geben wir das Geld aus?');
  await box.press('Enter');
  if (kind === 'phone') {
    await wait(600);
    await shot(p, `desk-${kind}-live-badge`);
    await p.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: 'Live', exact: true }).click();
    await wait(200);
  } else await wait(700);
  await shot(p, `desk-${kind}-pending`);
  await wait(3600);
  await shot(p, `desk-${kind}-ready`);
  // 3. Enlarge.
  await p.getByRole('button', { name: 'Groß anzeigen' }).click();
  await wait(1800);
  await shot(p, `desk-${kind}-expanded`);
  await p.keyboard.press('Escape');
  await p.context().close();

  // 4. Gate from an explainer link: explanation + button, success and rate limit.
  p = await open(kind, 'x=live-desk-intro&t=12');
  await shot(p, `gate-${kind}-deeplink`);
  await p.getByRole('button', { name: 'Neuen Login-Link per Telegram schicken' }).click();
  await wait(900);
  await shot(p, `gate-${kind}-link-sent`);
  await p.context().close();
  p = await open(kind, 'x=live-desk-intro&linkLimit=1');
  await p.getByRole('button', { name: 'Neuen Login-Link per Telegram schicken' }).click();
  await wait(900);
  await shot(p, `gate-${kind}-link-429`);
  await p.context().close();
}

// 5. PNG export: a real download from the demo page.
for (const f of ['pie', 'architecture']) {
  const ctx = await browser.newContext({ viewport: VIEW.desktop, acceptDownloads: true });
  const p = await ctx.newPage();
  await p.goto(`${base}/canvas-demo.html?f=${f}`, { waitUntil: 'networkidle' });
  await wait(2500);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Als PNG speichern' }).click()]);
  await dl.saveAs(`${out}/export-${dl.suggestedFilename()}`);
  console.log('exported', dl.suggestedFilename());
  await ctx.close();
}
await browser.close();
if (errors.length) { console.error('page errors:\n' + errors.join('\n')); process.exitCode = 1; }
