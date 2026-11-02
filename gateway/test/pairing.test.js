import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import crypto from 'node:crypto';
import { setEnv, login, listen, fakeServer } from './helpers/env.js';
import { createApp } from '../src/server.js';
let clock = Date.now(), base, app, registry, browserCookie;
const rows = [];
let outage = false;
before(async () => {
  registry = await fakeServer((req, res, body) => {
    let result;
    if(outage && req.url === '/v1/devices/verify') return res.writeHead(503).end('{}');
    if (req.url === '/v1/devices' && req.method === 'POST') {
      const row = { ...body, id: crypto.randomUUID(), expires_at: new Date(body.expires_at).toISOString() };
      rows.push(row); result = { id: row.id };
    } else if (req.url === '/v1/devices/verify') {
      result = rows.find(r => r.hash === body.hash && !r.revoked_at);
      if (!result) return res.writeHead(404).end('{}');
    } else if (req.method === 'DELETE') { rows.find(r => req.url.endsWith(r.id)).revoked_at = new Date(clock).toISOString(); result = { ok: true }; }
    else result = { devices: rows.map(({ hash, ...r }) => r) };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  setEnv({ ARTIFACTS_URL: registry.url, ARTIFACTS_DESK_TOKEN: 'synthetic-registry-key' });
  app = createApp({ deviceOptions: { now: () => clock } });
  base = `http://127.0.0.1:${await listen(app.server)}`;
  browserCookie = (await login(base)).cookie;
});
after(() => { app.server.close(); registry.close(); });
const callbackUrl = 'http://127.0.0.1:48653/ScreenAgent/' + 'c'.repeat(43) + '/';
const post = (p, body = {}, headers = {}) => fetch(base + '/api/device/' + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const confirm = pairId => post('pairing/confirm', { pairId }, { cookie: browserCookie, origin: process.env.DESK_ORIGIN });
test('two isolated stores pair by browser approval and native poll, once; bootstrap signs WebView in and registry revoke invalidates its cookie', async () => {
  const start = await post('pairing/start', { callbackUrl }); assert.equal(start.status, 200);
  const { pairId, pollToken, browserUrl, expiresAt } = await start.json();
  assert.equal(new URL(browserUrl).searchParams.get('pair'), pairId);
  assert(!browserUrl.includes(pollToken)); assert.equal(expiresAt, clock + 300000);
  assert.equal((await post('pairing/poll', { pairId, pollToken })).status, 202);
  assert.equal((await post('pairing/confirm', { pairId })).status, 401);
  assert.equal((await post('pairing/confirm', { pairId }, { cookie: browserCookie })).status, 403);
  assert.equal((await post('pairing/confirm', { pairId }, { cookie: browserCookie, origin: 'https://foreign.test' })).status, 403);
  const approval = await confirm(pairId); assert.equal(approval.status, 200);
  const approvalProof = new URL((await approval.json()).callbackUrl).searchParams.get('proof');
  assert.equal((await post('pairing/poll', { pairId, pollToken })).status, 202, 'remote app with its own poll secret still lacks browser-only local proof');
  assert.equal((await post('pairing/poll', { pairId, pollToken: 'z'.repeat(43) })).status, 410);
  const polls = await Promise.all([post('pairing/poll', { pairId, pollToken, approvalProof }), post('pairing/poll', { pairId, pollToken, approvalProof })]);
  assert.equal(polls.filter(r => r.status === 200).length, 1);
  const credentials = await polls.find(r => r.status === 200).json();
  assert.equal(rows.length, 1); assert(!JSON.stringify(rows).includes(credentials.token));
  assert.equal((await post('pairing/poll', { pairId, pollToken })).status, 410);
  assert.equal((await confirm(pairId)).status, 410);
  assert.equal((await post('web-session', {}, { cookie: browserCookie })).status, 401);
  const bootstrap = await post('web-session', {}, { authorization: `Bearer ${credentials.token}` });
  assert.equal(bootstrap.status, 200);
  const { cookie } = await bootstrap.json();
  const embeddedCookie = 'desk_s=' + cookie;
  for (const route of ['pair', 'pairing/confirm']) assert.equal((await post(route, { pairId }, { cookie: embeddedCookie, origin: process.env.DESK_ORIGIN })).status, 403);
  assert.equal((await fetch(base + '/api/device/list', { headers: { cookie: embeddedCookie } })).status, 403);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie: embeddedCookie } })).status, 200);
  outage = true;
  assert.equal((await post('web-session', {}, { authorization: `Bearer ${credentials.token}` })).status, 503, 'outage must not erase DPAPI by pretending to be revocation');
  assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie: embeddedCookie } })).status, 503);
  outage = false;
  assert.equal((await fetch(base + '/api/device/revoke/' + credentials.deviceId, { method:'DELETE', headers:{ cookie:embeddedCookie, origin:process.env.DESK_ORIGIN } })).status, 403);
  const revoked = await fetch(base + '/api/device/revoke/' + credentials.deviceId, { method: 'DELETE', headers: { cookie: browserCookie, origin: process.env.DESK_ORIGIN } });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie: embeddedCookie } })).status, 401);
  assert.equal((await post('web-session', {}, { authorization: `Bearer ${credentials.token}` })).status, 401);
});
test('nonce expires, invalid bodies stay bounded, start limits enforce five per minute and foreign origins cannot start', async () => {
  clock += 60001;
  assert.equal((await post('pairing/start', {}, { origin: 'https://foreign.test' })).status, 403);
  const p = await (await post('pairing/start', { callbackUrl })).json();
  clock += 300001;
  assert.equal((await confirm(p.pairId)).status, 410);
  assert.equal((await post('pairing/poll', p)).status, 410);
  assert.equal((await post('pairing/poll', { pairId: 'short' })).status, 410);
  for (let i = 0; i < 5; i++) assert.equal((await post('pairing/start', { callbackUrl })).status, 200);
  assert.equal((await post('pairing/start', { callbackUrl })).status, 429);
});

test('callback URLs cannot leave loopback and proof guesses consume the one-time transaction', async () => {
  clock += 60001;
  for (const callbackUrl of ['https://foreign.test/', ...['0','80','1023','65536','99999','001234'].map(port=>'http://127.0.0.1:'+port+'/ScreenAgent/'+'a'.repeat(43)+'/'), 'http://localhost:48653/ScreenAgent/'+'a'.repeat(43)+'/', 'http://127.0.0.1:80/ScreenAgent/'+'a'.repeat(43)+'/', 'http://127.0.0.1:48653/ScreenAgent/'+'a'.repeat(43)+'/?x=y']) assert.equal((await post('pairing/start', {callbackUrl}, {'x-forwarded-for':'validation-'+callbackUrl})).status, 400);
  clock += 60001;
  const p = await (await post('pairing/start', {callbackUrl})).json();
  assert.equal((await confirm(p.pairId)).status, 200);
  for(let i=0;i<3;i++) assert.equal((await post('pairing/poll', {...p, approvalProof:'z'.repeat(43)})).status, 410);
  assert.equal((await confirm(p.pairId)).status, 410);
});
