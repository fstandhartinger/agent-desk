// Review screenshots of the mock UI (no backend needed). ?mock=1 exists only on the dev server (`npm run dev`).
// Usage: NODE_PATH=<playwright node_modules> node scripts/screens.mjs <devServerUrl> <outDir> [chromiumPath]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

// ESM ignores NODE_PATH; resolve playwright through it explicitly.
const { chromium } = createRequire(import.meta.url)('playwright');

const [base, out, executablePath] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: screens.mjs <baseUrl> <outDir> [chromiumPath]');
mkdirSync(out, { recursive: true });
const SLUG = 'engine-crowning-rxpjnm2ehx';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: executablePath || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
});

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

async function page(kind, query) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[kind], deviceScaleFactor: 1, hasTouch: kind === 'mobile', isMobile: kind === 'mobile', locale: 'de-DE' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.error(`[${kind}] pageerror:`, e.message));
  p.on('console', (m) => m.type() === 'error' && console.error(`[${kind}] console:`, m.text()));
  await p.goto(`${base}/?${query}`, { waitUntil: 'networkidle' });
  return p;
}

async function stageReady(p) {
  await p.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.__ready === true, null, { timeout: 20000 });
  await wait(500);
}

const shot = (p, name) => p.screenshot({ path: `${out}/${name}.png` }).then(() => console.log('saved', name));
const tab = (p, label) => p.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: label, exact: true }).click();

for (const kind of ['desktop', 'mobile']) {
  // 1 gate
  let p = await page(kind, 'mock=1');
  await p.getByPlaceholder('Zugangscode').fill('desk-demo-code-1234');
  await wait(400);
  await shot(p, `${kind}-1-gate`);
  await p.context().close();

  // 2 explainer + chat streaming
  p = await page(kind, `mock=1&auth=1&x=${SLUG}`);
  await stageReady(p);
  if (kind === 'mobile') await tab(p, 'Erklärung');
  await p.getByRole('button', { name: 'Abspielen' }).first().click();
  await wait(5200);
  await p.keyboard.press('Space');
  if (kind === 'mobile') await tab(p, 'Chat');
  await p.getByLabel('Nachricht', { exact: true }).fill('Welche Jobs laufen gerade und wie ist der Stand?');
  await p.keyboard.press('Enter');
  await wait(2900);
  await shot(p, `${kind}-2-explainer-chat-streaming`);

  // 3 point clicked inside the stage
  if (kind === 'mobile') await tab(p, 'Erklärung');
  await wait(1800);
  const frame = p.frameLocator('iframe');
  await frame.locator('.pt').first().click({ force: true });
  await wait(600);
  await shot(p, `${kind}-3-point-clicked`);
  if (kind === 'mobile') {
    await tab(p, 'Chat');
    await wait(300);
    await shot(p, `${kind}-3b-point-chip-in-composer`);
  }

  // 4 Claude Code tab with a running session
  if (kind === 'mobile') await tab(p, 'Live');
  await p.getByRole('tab', { name: /Claude/ }).click();
  await p.locator('#live-panel-claude').getByRole('button', { name: /Desk-Link in Erklärseiten/ }).click();
  await wait(2600);
  await shot(p, `${kind}-4-claude-session`);
  await p.context().close();

  // 5 voice active
  p = await page(kind, `mock=1&auth=1&x=${SLUG}`);
  await stageReady(p);
  if (kind === 'mobile') await tab(p, 'Chat');
  await p.keyboard.press('v');
  await wait(kind === 'desktop' ? 6800 : 6800);
  await shot(p, `${kind}-5-voice-active`);
  await p.context().close();
}

await browser.close();
