import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { connectFakeBridge, login, setEnv, startGateway } from './helpers/env.js';

setEnv({ EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
let gw;
let cookie;
let bridge;
before(async () => {
  gw = await startGateway();
  cookie = (await login(gw.base, { 'x-forwarded-for': '10.7.7.7' })).cookie;
});
after(() => { bridge?.ws.close(); gw.close(); });

const send = (path, { method = 'POST', body, headers = {}, auth = true } = {}) => fetch(`${gw.base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(auth ? { cookie } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const errorOf = async (res) => (await res.json()).error;
const ENGLISH = /\b(invalid|required|not found|too many|login|unavailable|failed|limit reached|must be|bad )\b/i;

describe('user-facing error texts are German', () => {
  it('wrong code, missing login, unknown route, bad origin', async () => {
    const wrong = await send('/api/auth/login', { body: { code: 'falsch' }, auth: false, headers: { 'x-forwarded-for': '10.7.7.8' } });
    assert.equal(await errorOf(wrong), 'Code stimmt nicht');
    assert.equal(await errorOf(await send('/api/chat', { auth: false })), 'Bitte zuerst anmelden');
    assert.equal(await errorOf(await send('/api/nope', { method: 'GET' })), 'Nicht gefunden');
    assert.equal(await errorOf(await send('/api/auth/login', { body: {}, auth: false, headers: { origin: 'https://evil.example' } })), 'Anfrage von einer fremden Seite abgelehnt');
  });

  it('rate limits name the wait in minutes', async () => {
    const { limits } = await import('../src/limits.js');
    const { readSession } = await import('../src/auth.js');
    const { sid } = readSession({ headers: { cookie } });
    limits.rate.set(`chat:${sid}`, Array.from({ length: 40 }, () => Date.now() - 60_000));
    const res = await send('/api/chat', { body: { messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(res.status, 429);
    assert.match(await errorOf(res), /^Zu viele Nachrichten – bitte in (9|10) Minuten erneut$/);
    limits.rate.clear();
    limits.addCost(1e6);
    assert.equal(await errorOf(await send('/api/chat', { body: { messages: [{ role: 'user', content: 'x' }] } })), 'Das Tageslimit für Kosten ist erreicht');
    limits.cost.clear();
  });

  it('validation errors, broken JSON, offline bridge', async () => {
    assert.equal(await errorOf(await send('/api/chat', { body: { messages: [] } })), 'Die Nachrichtenliste ist ungültig: sie muss mit einer Nachricht von dir enden');
    assert.equal(await errorOf(await send('/api/chat', { body: '{kaputt' })), 'Die Anfrage ist kein gültiges JSON');
    assert.equal(await errorOf(await send('/api/claude/sessions', { body: { prompt: '' } })), 'Bitte eine Aufgabe angeben (höchstens 20.000 Zeichen)');
    const offline = await send('/api/claude/sessions', { method: 'GET' });
    assert.equal(offline.status, 503);
    assert.equal(await errorOf(offline), 'Die Werkstatt-Verbindung (lechonk) ist offline');
    assert.equal(await errorOf(await send('/api/explainer/BAD/x', { method: 'GET' })), 'Ungültiger Pfad der Erklärseite');
  });

  it('no error string produced by these endpoints is English', async () => {
    const results = await Promise.all([
      send('/api/transcribe', { headers: { 'content-type': 'text/plain' }, body: 'x' }),
      send('/api/claude/sessions/zzz/stop'),
      send('/api/auth/me', { method: 'PUT', auth: false }),
      send('/api/explainer/abc/points.json', { method: 'POST' }),
    ]);
    for (const res of results) {
      const text = await errorOf(res);
      assert.ok(text && !ENGLISH.test(text), `${res.status}: ${text}`);
    }
  });
});
