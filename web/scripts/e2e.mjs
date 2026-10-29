// UI regression checks against the dev server with ?mock=1 (layout and behaviour the unit tests cannot see).
// Every check maps to a round-1 critic defect or a round-2 feature. Screenshots go to <outDir>/r2-*.png.
// Usage: NODE_PATH=<dir with playwright> node scripts/e2e.mjs <devServerUrl> [outDir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const [base, out = '../docs/screens'] = process.argv.slice(2);
if (!base) throw new Error('usage: e2e.mjs <devServerUrl> [outDir]');
mkdirSync(out, { recursive: true });

const SLUG = 'engine-crowning-rxpjnm2ehx';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });

async function open(viewport, query, mobile = false) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, locale: 'de-DE' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`       pageerror: ${e.message}`));
  await p.goto(`${base}/?${query}`, { waitUntil: 'networkidle' });
  return p;
}
const shot = (p, name) => p.screenshot({ path: `${out}/r2-${name}.png` });
const box = async (loc) => {
  const b = await loc.boundingBox();
  if (!b) throw new Error('element not visible');
  return b;
};
const stageReady = (p) => p.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.__ready === true, null, { timeout: 20000 });
const stageBox = (p) => box(p.locator('iframe[title="Erklär-Animation"]').locator('..'));
const mobileTab = (p, label) => p.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: label, exact: true }).click();

async function ask(p, text) {
  await p.getByLabel('Nachricht', { exact: true }).fill(text);
  await p.keyboard.press('Enter');
}

// ── Gate ────────────────────────────────────────────────────────────────────────────
console.log('gate');
{
  const p = await open({ width: 1440, height: 900 }, 'mock=1');
  const code = p.getByPlaceholder('Zugangscode');
  await check('D11 wrong code shows German text', async () => {
    await code.fill('falsch');
    await p.keyboard.press('Enter');
    await p.getByText('Dieser Zugangscode stimmt nicht.').waitFor({ timeout: 3000 });
  });
  await check('D11 lockout shows German text, retry time and a disabled countdown button', async () => {
    await code.fill('gesperrt');
    await p.keyboard.press('Enter');
    await p.getByText('Zu viele Versuche – erneut möglich in 15 min.').waitFor({ timeout: 3000 });
    const btn = p.getByRole('button', { name: /Gesperrt – erneut in 15 min/ });
    expect(await btn.isDisabled(), 'submit not disabled during lockout');
    await shot(p, 'gate-lockout');
  });
  await check('D12 login link works in an already open gate tab (hashchange)', async () => {
    await p.evaluate(() => (location.hash = '#k=richtiger-code'));
    await p.getByRole('button', { name: 'Verlauf öffnen' }).waitFor({ timeout: 5000 });
    expect(!(await p.evaluate(() => location.hash)), 'login hash not stripped');
  });
  await p.context().close();
}

// ── Desktop 1440 ────────────────────────────────────────────────────────────────────
console.log('desktop 1440×900');
{
  const p = await open({ width: 1440, height: 900 }, `mock=1&auth=1&x=${SLUG}`);
  await stageReady(p);
  await check('stage is the hero (≥ 42 % of the width)', async () => {
    const b = await stageBox(p);
    expect(b.width >= 0.42 * 1440, `stage ${Math.round(b.width)} px`);
  });
  await check('closed history sheet is clipped to the chat column (never over the stage)', async () => {
    const visible = await p.evaluate(() => {
      const d = document.querySelector('[role="dialog"][aria-label="Verlauf"]');
      const r = d.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 40);
      return d.contains(hit);
    });
    expect(!visible, 'history sheet is visible while closed');
  });
  await check('right-column tab labels never wrap', async () => {
    for (const t of await p.getByRole('tab').all()) {
      const b = await box(t);
      expect(b.height <= 40, `tab ${await t.textContent()} is ${b.height}px high`);
      expect(await t.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `tab ${await t.textContent()} overflows`);
    }
  });
  await check('D4 provider dots: failed = amber with reason, ok = green', async () => {
    const grok = p.locator('[aria-label="Sprachanbieter"] [data-health]').filter({ hasText: 'Grok' });
    await grok.waitFor({ timeout: 5000 });
    expect((await grok.getAttribute('data-health')) === 'failed', 'Grok not failed');
    expect((await grok.getAttribute('title')).includes('Guthaben'), 'no reason tooltip');
    const gem = p.locator('[aria-label="Sprachanbieter"] [data-health]').filter({ hasText: 'Gemini' });
    expect((await gem.getAttribute('data-health')) === 'ok', 'Gemini not ok');
  });
  await check('D4 header Claude count is live (1 running seeded session)', async () => {
    await p.getByText('· 1/3 Claude').waitFor({ timeout: 5000 });
  });
  await check('D13 click hint never covers the stage title and fades after 3 s', async () => {
    await p.getByRole('button', { name: 'Abspielen' }).first().click();
    const hint = p.getByTestId('click-hint');
    await hint.waitFor({ timeout: 3000 });
    const [h, s] = [await box(hint), await stageBox(p)];
    expect(h.y > s.y + s.height * 0.6, 'hint sits in the upper part of the stage');
    await shot(p, 'desktop-1440-playing');
    await wait(3700);
    expect((await hint.evaluate((el) => getComputedStyle(el).opacity)) === '0', 'hint still visible after 3.7 s');
    await p.keyboard.press('Space');
  });
  await check('status SSE event renders as an inline status line', async () => {
    await ask(p, 'Welche Jobs laufen gerade und wie ist der Stand?');
    await p.getByRole('status').filter({ hasText: 'Ich schaue kurz in die Jobs' }).waitFor({ timeout: 3000 });
    await shot(p, 'desktop-1440-status-line');
  });
  await check('model badge is readable and not truncated', async () => {
    const badge = p.getByTestId('model-badge').last();
    await badge.waitFor({ timeout: 15000 });
    await p.getByTestId('model-badge').last().hover();
    expect((await badge.textContent()).startsWith('deepseek-v4.1-flash'), await badge.textContent());
    expect(await badge.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'badge truncated');
    await shot(p, 'desktop-1440-chat-done');
  });
  await check('one-tap "An Claude übergeben" opens a prefilled Claude task', async () => {
    await p.locator('.group\\/msg').last().hover();
    await p.getByRole('button', { name: 'An Claude übergeben' }).last().click();
    const prompt = p.locator('#ct-prompt');
    await prompt.waitFor({ timeout: 3000 });
    const v = await prompt.inputValue();
    expect(v.includes('Antwort des Desks') && v.includes('Welche Jobs laufen gerade'), 'prompt not prefilled');
    expect((await p.getByRole('tab', { name: /Claude/ }).getAttribute('aria-selected')) === 'true', 'Claude tab not selected');
    await shot(p, 'desktop-1440-handoff');
    await p.getByRole('button', { name: 'Zurück', exact: true }).click();
  });
  await check('D5 Claude work map never overlaps the thread', async () => {
    await p.locator('#live-panel-claude').getByRole('button', { name: /Desk-Link in Erklärseiten/ }).click();
    await wait(6000);
    const map = await box(p.getByTestId('workmap'));
    const thread = await box(p.getByTestId('workmap').locator('xpath=following-sibling::div[1]'));
    expect(map.y + map.height <= thread.y + 1, `map bottom ${map.y + map.height} > thread top ${thread.y}`);
    await shot(p, 'desktop-1440-claude-session');
    await p.getByRole('button', { name: 'Zurück zur Liste' }).click();
  });
  await check('D16/D20 finished session: "1 Zug" and "≈ … API-Wert (Abo)"', async () => {
    await p.locator('#live-panel-claude').getByRole('button', { name: /Board-Zusammenfassung/ }).click();
    await p.getByText(/· 1 Zug$/).first().waitFor({ timeout: 5000 });
    await p.getByText(/≈ \$0\.44 API-Wert \(Abo\)/).first().waitFor({ timeout: 3000 });
  });
  // The work map header belongs to the viz slice (web/src/viz/WorkMap.tsx); this check stays red until it pluralises.
  await check('D16 work map header (r2-viz): no "1 Züge"', async () => {
    try {
      expect((await p.getByText(/\b1 Züge\b/).count()) === 0, '"1 Züge" in WorkMap header');
    } finally {
      await p.getByRole('button', { name: 'Zurück zur Liste' }).click();
    }
  });
  await check('history: new conversation, search, delete', async () => {
    await p.getByRole('button', { name: 'Neues Gespräch' }).first().click();
    await ask(p, 'Was hat Florian heute entschieden?');
    await p.getByTestId('model-badge').first().waitFor({ timeout: 15000 });
    await p.getByRole('button', { name: 'Verlauf öffnen' }).click();
    const dialog = p.getByRole('dialog', { name: 'Verlauf' });
    await dialog.getByText('Welche Jobs laufen gerade und wie ist der Stand?').waitFor({ timeout: 3000 });
    await dialog.getByText('Claude-Sitzungen').waitFor();
    await shot(p, 'desktop-1440-history');
    await dialog.getByLabel('Gespräche durchsuchen').fill('entschieden');
    await wait(150);
    expect((await dialog.getByText('Welche Jobs laufen gerade und wie ist der Stand?').count()) === 0, 'search did not filter');
    await dialog.getByLabel('Gespräche durchsuchen').fill('');
    const del = dialog.getByRole('button', { name: '„Welche Jobs laufen gerade und wie ist der Stand?“ löschen' });
    await del.click();
    await dialog.getByRole('button', { name: /wirklich löschen/ }).click();
    await wait(200);
    expect((await dialog.getByText('Welche Jobs laufen gerade und wie ist der Stand?').count()) === 0, 'not deleted');
    await p.keyboard.press('Escape');
  });
  await check('Kino: stage grows, chat floats beside it without covering it', async () => {
    const before = await stageBox(p);
    await p.getByRole('button', { name: 'Kino', exact: true }).click();
    await wait(450);
    const s = await stageBox(p);
    const chat = await box(p.getByRole('main', { name: 'Unterhaltung' }));
    expect(s.width > before.width * 1.2, `stage ${before.width} → ${s.width}`);
    expect(s.x + s.width <= chat.x, 'stage runs under the chat overlay');
    const kinoBtn = await box(p.getByRole('button', { name: 'Kino', exact: true }));
    expect(kinoBtn.x + kinoBtn.width <= chat.x, 'Kino button hidden under the chat overlay');
    await shot(p, 'desktop-1440-kino');
    await p.getByRole('button', { name: 'Chat ausblenden' }).click();
    await wait(450);
    const full = await stageBox(p);
    expect(full.width > s.width, 'stage did not grow without the chat');
    await shot(p, 'desktop-1440-kino-no-chat');
    await p.getByRole('button', { name: 'Chat einblenden' }).click();
    await p.keyboard.press('k');
    await wait(450);
    expect(Math.abs((await stageBox(p)).width - before.width) < 2, 'K did not leave Kino');
  });
  await p.context().close();
}

// ── Desktop 1920 ────────────────────────────────────────────────────────────────────
console.log('desktop 1920×1080');
{
  const p = await open({ width: 1920, height: 1080 }, `mock=1&auth=1&x=${SLUG}`);
  await stageReady(p);
  await check('1920: stage ≥ 42 % and nothing scrolls sideways', async () => {
    const b = await stageBox(p);
    expect(b.width >= 0.42 * 1920, `stage ${Math.round(b.width)} px`);
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
  });
  await ask(p, 'Welche Jobs laufen gerade und wie ist der Stand?');
  await p.getByTestId('model-badge').last().waitFor({ timeout: 15000 });
  await shot(p, 'desktop-1920');
  await p.getByRole('button', { name: 'Kino', exact: true }).click();
  await wait(500);
  await shot(p, 'desktop-1920-kino');
  await p.context().close();
}

// ── Phone 390 ───────────────────────────────────────────────────────────────────────
console.log('phone 390×844');
{
  const p = await open({ width: 390, height: 844 }, `mock=1&auth=1&x=${SLUG}`, true);
  await stageReady(p);
  await check('D17 menu ≥ 44 px', async () => {
    const b = await box(p.getByRole('button', { name: 'Menü' }));
    expect(b.height >= 44 && b.width >= 44, `${b.width}×${b.height}`);
  });
  await check('mobile player shows the time readout', async () => {
    const t = await box(p.getByLabel('Abspielzeit'));
    expect(t.width > 30, 'time readout hidden');
  });
  await check('FAB never covers the last chapter row', async () => {
    await p.locator('nav[aria-label="Kapitel"] li').last().scrollIntoViewIfNeeded();
    await p.evaluate(() => document.querySelectorAll('.scroll-y').forEach((el) => el.scrollTo(0, el.scrollHeight)));
    await wait(200);
    const row = await box(p.locator('nav[aria-label="Kapitel"] li').last());
    const fab = await box(p.getByRole('button', { name: /Live sprechen|Sprachsitzung beenden/ }));
    expect(row.y + row.height <= fab.y, `row bottom ${row.y + row.height} > FAB top ${fab.y}`);
    await shot(p, 'phone-explainer-end');
  });
  await mobileTab(p, 'Chat');
  await check('D17 composer buttons ≥ 44 px', async () => {
    for (const name of ['Diktieren', 'Senden', 'Sprachmodell wählen']) {
      const b = await box(p.getByRole('button', { name, exact: true }));
      expect(b.height >= 44, `${name}: ${b.height}px`);
    }
  });
  await check('phone: model badge not truncated', async () => {
    await ask(p, 'Welche Jobs laufen gerade und wie ist der Stand?');
    const badge = p.getByTestId('model-badge').last();
    await badge.waitFor({ timeout: 15000 });
    expect(await badge.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= innerWidth), 'badge truncated');
    await shot(p, 'phone-chat');
  });
  await mobileTab(p, 'Live');
  await check('D17 Live tabs ≥ 44 px and single-line', async () => {
    for (const t of await p.getByRole('tab').all()) {
      const b = await box(t);
      expect(b.height >= 44 && b.height <= 48, `${await t.textContent()}: ${b.height}px`);
    }
  });
  await check('one canvas empty text only (no duplicate)', async () => {
    expect((await p.getByText('Sobald gefragt, gesprochen oder gearbeitet wird').count()) === 0, 'duplicate empty text');
    await shot(p, 'phone-live');
  });
  await mobileTab(p, 'Chat');
  await p.getByRole('button', { name: 'Verlauf öffnen' }).click();
  await wait(400);
  await shot(p, 'phone-history');
  await p.context().close();
}

await browser.close();
const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
