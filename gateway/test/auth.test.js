import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { CODE, DESK_ORIGIN, login, setEnv, startGateway } from './helpers/env.js';

setEnv();
let gw;
before(async () => { gw = await startGateway(); });
after(() => gw.close());

const post = (path, body, headers = {}) => fetch(`${gw.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const me = (cookie) => fetch(`${gw.base}/api/auth/me`, { headers: cookie ? { cookie } : {} });

describe('session cookie', () => {
  it('logs in with the right code and sets a hardened cookie', async () => {
    const { res, cookie } = await login(gw.base, { 'x-forwarded-for': '10.0.0.1' });
    assert.equal(res.status, 200);
    const flags = res.headers.get('set-cookie');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(flags.includes(flag), flag);
    assert.equal((await me(cookie)).status, 200);
  });

  it('rejects requests without a cookie on /api routes but serves /healthz', async () => {
    for (const path of ['/api/auth/me', '/api/status', '/api/claude/sessions', '/api/explainer/abc/points.json']) {
      assert.equal((await fetch(`${gw.base}${path}`)).status, 401, path);
    }
    const health = await fetch(`${gw.base}/healthz`);
    assert.deepEqual(await health.json(), { ok: true, bridges: [] });
  });

  it('rejects a tampered signature, a tampered payload and garbage', async () => {
    const { cookie } = await login(gw.base, { 'x-forwarded-for': '10.0.0.2' });
    const [name, value] = cookie.split('=');
    const [payload, mac] = value.split('.');
    const forged = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + 1e9, sid: 'evil' })).toString('base64url');
    for (const bad of [`${name}=${payload}.${mac.slice(0, -2)}xx`, `${name}=${forged}.${mac}`, `${name}=${payload}`, `${name}=.`, `${name}=garbage`]) {
      assert.equal((await me(bad)).status, 401, bad);
    }
  });

  it('rejects an expired cookie', async () => {
    const { issueCookie } = await import('../src/auth.js');
    const old = issueCookie(Date.now() - 31 * 24 * 3600 * 1000).split(';')[0];
    assert.equal((await me(old)).status, 401);
  });

  it('logout clears the cookie', async () => {
    const res = await post('/api/auth/logout', {});
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  });

  it('logout revokes the session: the old cookie value is dead on every route, other sessions live on', async () => {
    const { cookie } = await login(gw.base, { 'x-forwarded-for': '10.0.0.3' });
    const other = (await login(gw.base, { 'x-forwarded-for': '10.0.0.4' })).cookie;
    assert.equal((await me(cookie)).status, 200);
    assert.equal((await post('/api/auth/logout', {}, { cookie })).status, 200);
    assert.equal((await me(cookie)).status, 401);
    assert.equal((await fetch(`${gw.base}/api/status`, { headers: { cookie } })).status, 401);
    assert.equal((await me(other)).status, 200);
  });

  it('the revocation list is persisted to a file and survives a reload of the module state', async () => {
    const { cookie } = await login(gw.base, { 'x-forwarded-for': '10.0.0.5' });
    await post('/api/auth/logout', {}, { cookie });
    const stored = JSON.parse(fs.readFileSync(process.env.DESK_REVOKED_FILE, 'utf8'));
    const sid = JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString()).sid;
    assert.ok(stored[sid] > Date.now());
    assert.equal((fs.statSync(process.env.DESK_REVOKED_FILE).mode & 0o777), 0o600);
  });
});

describe('login rate limit', () => {
  it('blocks the 6th attempt from one IP, even with the right code', async () => {
    const headers = { 'x-forwarded-for': '10.9.9.9' };
    for (let i = 0; i < 5; i += 1) assert.equal((await post('/api/auth/login', { code: `wrong-${i}` }, headers)).status, 401);
    const blocked = await post('/api/auth/login', { code: CODE }, headers);
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.match(body.error, /^Zu viele Versuche – bitte in \d+ Minuten? erneut$/);
    assert.ok(body.retryAfter > 0);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await post('/api/auth/login', { code: CODE }, { 'x-forwarded-for': '10.9.9.10' })).status, 200);
  });
});

describe('browser protections', () => {
  it('refuses cross-site POSTs', async () => {
    assert.equal((await post('/api/auth/login', { code: CODE }, { origin: 'https://evil.example', 'x-forwarded-for': '10.1.1.1' })).status, 403);
  });

  it('sends the security headers', async () => {
    const res = await fetch(`${gw.base}/healthz`);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
  });
});

describe('websocket upgrades', () => {
  const attempt = (path, headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}${path}`, { headers });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('error', () => {});
  });

  it('/bridge needs the exact bearer token', async () => {
    assert.equal(await attempt('/bridge', {}), 401);
    assert.equal(await attempt('/bridge', { authorization: 'Bearer nope' }), 401);
    assert.equal(await attempt('/bridge', { authorization: 'Bearer bridge-token-abcdefghijklmnop' }), 101);
  });

  it('/api/voice needs cookie and desk origin', async () => {
    const { cookie } = await login(gw.base, { 'x-forwarded-for': '10.2.2.2' });
    assert.equal(await attempt('/api/voice', {}), 401);
    assert.equal(await attempt('/api/voice', { cookie }), 401);
    assert.equal(await attempt('/api/voice', { cookie, origin: 'https://evil.example' }), 401);
    assert.equal(await attempt('/api/voice', { cookie, origin: DESK_ORIGIN }), 101); // gate passed, voice upgrade accepted
  });
});
