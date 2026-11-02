// Browser checks with separate app/browser contexts. Native transport and management API are deterministic fixtures.
// Usage: NODE_PATH=<playwright directory> node scripts/test-pairing.mjs <vite URL> <output directory>
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const [base, out = 'pairing-evidence'] = process.argv.slice(2);
if (!base) throw new Error('Pass the Vite server URL.');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const contexts = [];
const pairId = 'p'.repeat(43);
const callbackUrl = `http://127.0.0.1:45678/ScreenAgent/${'r'.repeat(43)}/?proof=${'v'.repeat(43)}`;
async function context(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 600, height: 800 }, ...options });
  contexts.push(ctx);
  return ctx;
}
try {
  const app = await context();
  await app.addInitScript(() => {
    window.nativeMessages = [];
    window.nativeListeners = [];
    Object.defineProperty(window, 'chrome', { value: { webview: {
      postMessage(msg) { window.nativeMessages.push(msg); },
      addEventListener(_type, listener) { window.nativeListeners.push(listener); },
      removeEventListener(_type, listener) { window.nativeListeners = window.nativeListeners.filter(x => x !== listener); },
    } } });
  });
  const appPage = await app.newPage();
  let appAuthCalls = 0;
  await app.route('**/api/**', async route => { appAuthCalls++; await route.fulfill({ status: 401, json: {} }); });
  await appPage.goto(base + '/device?companion=1');
  await appPage.getByRole('button', { name: 'Im Browser verbinden' }).waitFor();
  await appPage.screenshot({ path: out + '/app-ready.png' });
  await appPage.getByRole('button', { name: 'Im Browser verbinden' }).click();
  assert.deepEqual(await appPage.evaluate(() => window.nativeMessages), [{ type: 'pairing-start' }]);
  assert.equal(appAuthCalls, 0, 'app first-run must not need a cookie in its own store');
  assert.equal(await appPage.locator('input').count(), 0, 'no manual secret input in app');
  assert.equal(await appPage.getByText('Du kommst von einer Erklärseite').count(), 0);
  assert.equal(await appPage.getByRole('button').first().isDisabled(), true);
  await appPage.screenshot({ path: out + '/app-pending.png' });
  await appPage.evaluate(() => window.nativeListeners.forEach(fn => fn({ data: { type: 'pairing-status', state: 'error', text: 'Verbindungslink abgelaufen. Bitte erneut versuchen.' } })));
  await appPage.getByRole('alert').getByText('Verbindungslink abgelaufen. Bitte erneut versuchen.').waitFor();
  assert.equal(await appPage.getByRole('button', { name: 'Im Browser verbinden' }).isEnabled(), true);
  await appPage.screenshot({ path: out + '/app-first-run.png' });
  console.log('PASS app first-run without cookie, no secret field, pending and error/retry');

  const normal = await context();
  let signedIn = false, linkNext = '', confirms = 0, callbackVisits = 0;
  await normal.route('http://127.0.0.1:45678/**', async route => {
    assert.equal(route.request().url(), callbackUrl);
    callbackVisits++;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<script>history.replaceState(null,"","/ScreenAgent/connected")</script><h1>Screen Agent verbunden</h1><p>Du kannst dieses Fenster schließen.</p>' });
  });
  await normal.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let status = 200, json = {};
    if (path === '/api/auth/me') { status = signedIn ? 200 : 401; json = { ok: signedIn, sid: 'test-session' }; }
    else if (path === '/api/auth/login') { signedIn = true; json = { ok: true }; }
    else if (path === '/api/auth/request-link') { linkNext = route.request().postDataJSON().next; status = 202; json = { ok: true, status: 'queued' }; }
    else if (!signedIn) status = 401;
    else if (path === '/api/device/list') json = { devices: [] };
    else if (path === '/api/device/learned') json = { items: [] };
    else if (path === '/api/device/pairing/confirm') { assert.deepEqual(route.request().postDataJSON(), { pairId }); confirms++; json = { ok: true, callbackUrl }; }
    await route.fulfill({ status, json });
  });
  const page = await normal.newPage();
  await page.goto(base + '/device?pair=' + pairId);
  await page.getByRole('heading', { name: 'Screen Agent verbinden', exact: true }).waitFor();
  assert.equal(await page.getByText('Du kommst von einer Erklärseite').count(), 0);
  await page.getByRole('button', { name: 'Neuen Login-Link per Telegram schicken' }).click();
  await page.getByRole('button', { name: 'Link ist unterwegs' }).waitFor();
  assert.equal(linkNext, '/device?pair=' + pairId);
  await page.screenshot({ path: out + '/browser-login.png' });
  // Open the Telegram URL in another tab, as on Florian's laptop.
  const telegram = await normal.newPage();
  await telegram.goto(base + linkNext + '#k=fake-fixture-login');
  await telegram.getByRole('button', { name: 'Dieses Gerät verbinden', exact: true }).click();
  await telegram.getByRole('heading', { name: 'Screen Agent verbunden', exact: true }).waitFor();
  assert.equal(confirms, 1);
  assert.equal(callbackVisits, 1, 'confirmation navigates once to the app loopback proof listener');
  assert.equal(telegram.url(), 'http://127.0.0.1:45678/ScreenAgent/connected', 'local success page removes the consumed proof');
  assert.equal(new URL(telegram.url()).hash, '', 'login secret removed');
  assert.equal(await telegram.locator('code').count(), 0, 'no device token shown');
  await telegram.screenshot({ path: out + '/browser-confirmed.png' });
  console.log('PASS separate browser login, queued delivery, next preserved, one loopback confirmation, no copied token');

  const management = await normal.newPage();
  await management.goto(base + '/device');
  await management.getByText('Verbundene Geräte', { exact: true }).waitFor();
  assert.equal(await management.getByRole('button', { name: 'Dieses Gerät verbinden', exact: true }).count(), 0);
  assert.equal(await management.locator('code').count(), 0);
  await management.goto(base + '/device?pair=invalid');
  await management.getByRole('alert').getByText(/Verbindungslink ist ungültig/).waitFor();
  assert.equal(confirms, 1, 'invalid and management entries cannot mint a device credential');
  console.log('PASS management and invalid entry cannot create or display a token');
} finally {
  await Promise.all(contexts.map(ctx => ctx.close()));
  await browser.close();
}
