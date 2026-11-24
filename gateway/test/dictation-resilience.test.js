// 24 Nov 2026: a registry/DNS stall made every device request a 502 (the tail chunk of a 115 s dictation was lost) and every retry of the
// dictation was a 400 "chunk-order". Device auth now falls back to the last good check while the registry is unreachable, and chunk uploads are
// idempotent. Synthetic data only (public repo).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setEnv, login, listen, fakeServer } from './helpers/env.js';
import { createApp } from '../src/server.js';
import { deviceError, pcmToWav } from '../src/deviceMedia.js';

const wav = (fill = 0) => pcmToWav(Buffer.alloc(32000, fill));
const DEVICE = '33333333-3333-4333-8333-333333333333';

describe('dictation resilience (registry stalls, idempotent chunks)', () => {
  let registry, app, base, token, loginCookie, clock = Date.now(), mode = 'up', revoked = false, holds = null, failNext = 0, hangOnce = false;
  const calls = [];
  before(async () => {
    registry = await fakeServer((req, res, body) => {
      const u = new URL(req.url, 'http://fake');
      const send = (data, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (mode === 'down') return send({ error: 'unavailable' }, 503);
      if (mode === 'hang') return; // never answers: the gateway's timeout fires, like the DNS stall
      if (hangOnce && u.pathname === '/v1/devices/verify') { hangOnce = false; return; } // one dropped lookup, the next one answers
      if (u.pathname === '/v1/devices' && req.method === 'POST') return send({ id: DEVICE });
      if (u.pathname === '/v1/devices/verify') return revoked ? send({}, 404) : send({ id: DEVICE, scopes: ['dictate', 'dictionary', 'screen', 'exists'], expires_at: new Date(clock + 864e5).toISOString() });
      if (u.pathname === '/v1/dictionary') return send({ items: [] });
      if (u.pathname === '/v1/resolve') return send({ items: [] });
      return send({}, 404);
    });
    setEnv({ ARTIFACTS_URL: registry.url, ARTIFACTS_DESK_TOKEN: 'fake' });
    const media = {
      dictate: async (buffer, ctx, _dict, opts) => {
        calls.push(opts);
        if (holds) await new Promise(resolve => holds.push(resolve));
        if (failNext > 0) { failNext--; throw Object.assign(deviceError('Kein Transkript.', 502), { code: 'all-providers-failed', body: { error: 'Kein Transkript.', code: 'all-providers-failed' } }); }
        return { text: `Teil ${calls.length}`, ms: 1, seconds: 1, providers: {}, degraded: false, merged: false };
      },
    };
    app = createApp({ deviceOptions: { now: () => clock, media } });
    base = `http://127.0.0.1:${await listen(app.server)}`;
    const { cookie } = await login(base); loginCookie = cookie;
    ({ token } = await (await fetch(base + '/api/device/pair', { method: 'POST', headers: { cookie, origin: process.env.DESK_ORIGIN } })).json());
  });
  after(() => { app.server.close(); registry.close(); });
  const form = (chunk, fill = 0) => { const f = new FormData(); f.set('audio', new Blob([wav(fill)]), 'a.wav'); f.set('context', JSON.stringify({ process: 'p', fieldBefore: '', visibleIds: [], recentTerms: [] })); if (chunk) f.set('chunk', JSON.stringify(chunk)); return f; };
  const dictate = (chunk, fill = 0) => fetch(base + '/api/device/dictate', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form(chunk, fill) });
  const tick = () => { clock += 60_001; }; // past the one-minute check and the per-minute rate buckets

  it('a device-bound web session survives a registry outage (/api/auth/me), minting one still needs the registry', async () => {
    mode = 'up'; // first test: the fake clock is still real time (a cookie issued over 60 s ahead of the real clock is refused)
    const minted = await fetch(base + '/api/device/web-session', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(minted.status, 200);
    const cookie = `desk_s=${(await minted.json()).cookie}`;
    assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie } })).status, 200);
    tick(); mode = 'down';
    try {
      assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie } })).status, 200, 'was 503 "Registry ist vorübergehend nicht erreichbar."');
      assert.equal((await fetch(base + '/api/device/web-session', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 503);
    } finally { mode = 'up'; }
  });

  it('a registry that cannot be reached does not fail a dictation chunk of a device checked before (stale check, logged)', async () => {
    tick(); mode = 'up';
    assert.equal((await dictate({ dictationId: 'r-1', index: 0, final: false })).status, 200);
    tick(); mode = 'down';
    try {
      const r = await dictate({ dictationId: 'r-1', index: 1, final: true });
      assert.equal(r.status, 200, 'was 502 "Registry ist nicht erreichbar." before');
      assert.equal((await r.json()).text.startsWith('Teil'), true);
    } finally { mode = 'up'; }
  });

  it('a hanging registry (the DNS stall) costs one 3 s wait, then requests within 10 s use the last good check at once', async () => {
    tick(); mode = 'up';
    assert.equal((await dictate()).status, 200);
    tick(); mode = 'hang';
    try {
      let t0 = Date.now();
      assert.equal((await dictate({ dictationId: 'h-1', index: 0, final: true })).status, 200);
      assert(Date.now() - t0 >= 2900, 'the first request waited for the registry');
      t0 = Date.now();
      assert.equal((await dictate({ dictationId: 'h-2', index: 0, final: true })).status, 200);
      assert(Date.now() - t0 < 1500, `no second 3 s wait, took ${Date.now() - t0} ms`);
    } finally { mode = 'up'; }
  });

  it('the fallback ends after the grace (30 min) and never covers a device the registry refuses', async () => {
    tick(); mode = 'up';
    assert.equal((await dictate()).status, 200);
    clock += 31 * 60_000; mode = 'down';
    try { assert.equal((await dictate()).status, 502, 'no good check within the grace: the registry outage shows'); }
    finally { mode = 'up'; }
    assert.equal((await dictate()).status, 200);
    tick(); revoked = true;
    try { assert.equal((await dictate()).status, 401, 'a revocation in the registry holds from the first check after the minute'); }
    finally { revoked = false; }
  });

  it('a device without a good check yet survives one stalled lookup: the check is asked again after 2.5 s (cold start after a deploy)', async () => {
    tick(); mode = 'up';
    const fresh = (await (await fetch(base + '/api/device/pair', { method: 'POST', headers: { cookie: loginCookie, origin: process.env.DESK_ORIGIN } })).json()).token;
    hangOnce = true;
    const t0 = Date.now();
    const r = await fetch(base + '/api/device/dictate', { method: 'POST', headers: { authorization: `Bearer ${fresh}` }, body: form({ dictationId: 'cold-1', index: 0, final: true }) });
    const ms = Date.now() - t0;
    assert.equal(r.status, 200, 'was a 502 after 3 s');
    assert(ms >= 2400 && ms < 4500, `one 2.5 s try, then the answer: ${ms} ms`);
    assert.equal(hangOnce, false);
  });

  it('a chunk sent again gets the stored answer (200, replay) without a second recognition; indices may come in any order', async () => {
    tick(); mode = 'up';
    const id = 'i-1', results = [];
    for (const index of [0, 1, 2]) { const r = await dictate({ dictationId: id, index, final: false }); assert.equal(r.status, 200); results.push(await r.json()); }
    const before = calls.length;
    // the 24 Nov retry: the whole dictation again from index 0 with the same id (was a 400 chunk-order for every chunk)
    for (const index of [0, 1, 2]) {
      const r = await dictate({ dictationId: id, index, final: false });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.replay, true); assert.equal(body.text, results[index].text);
    }
    assert.equal(calls.length, before, 'no recogniser ran for a replay');
    assert.equal((await dictate({ dictationId: id, index: 5, final: true })).status, 200);
    const gap = await dictate({ dictationId: id, index: 3, final: false }); // an earlier index that was never sent: accepted
    assert.equal(gap.status, 200); assert.equal((await gap.json()).replay, undefined);
  });

  it('the same index with other audio (a retry that cut the recording differently) is recognised again and replaces the stored answer', async () => {
    tick(); mode = 'up';
    const id = 'a-1';
    const first = await (await dictate({ dictationId: id, index: 0, final: false })).json();
    const before = calls.length;
    const other = await dictate({ dictationId: id, index: 0, final: false }, 1);
    assert.equal(other.status, 200);
    const body = await other.json();
    assert.equal(body.replay, undefined); assert.notEqual(body.text, first.text);
    assert.equal(calls.length, before + 1);
    const again = await (await dictate({ dictationId: id, index: 0, final: false }, 1)).json();
    assert.equal(again.replay, true); assert.equal(again.text, body.text);
  });

  it('a failed chunk is recognised again on its retry, alone, after later chunks', async () => {
    tick(); mode = 'up';
    const id = 'f-1';
    assert.equal((await dictate({ dictationId: id, index: 0, final: false })).status, 200);
    failNext = 1;
    assert.equal((await dictate({ dictationId: id, index: 1, final: true })).status, 502);
    const before = calls.length;
    const retry = await dictate({ dictationId: id, index: 1, final: true });
    assert.equal(retry.status, 200); assert.equal((await retry.json()).replay, undefined);
    assert.equal(calls.length, before + 1);
  });

  it('a retry of a chunk that is still running waits for it instead of a second recognition or a 429', async () => {
    tick(); mode = 'up';
    holds = [];
    const first = dictate({ dictationId: 'p-1', index: 0, final: true });
    while (holds.length < 1) await new Promise(r => setTimeout(r, 5));
    const second = dictate({ dictationId: 'p-1', index: 0, final: true });
    await new Promise(r => setTimeout(r, 50));
    const release = holds; holds = null; release.forEach(r => r());
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal((await b.json()).replay, true);
    assert.equal(release.length, 1, 'one recognition');
  });

  it('a dictation still has at most 60 different chunks; replays of stored ones stay possible', async () => {
    const id = 'l-1';
    for (let index = 0; index < 60; index++) {
      if (index % 50 === 0) tick();
      assert.equal((await dictate({ dictationId: id, index, final: false })).status, 200, `chunk ${index}`);
    }
    tick();
    const over = await dictate({ dictationId: id, index: 60, final: true });
    assert.equal(over.status, 429); assert.equal((await over.json()).code, 'chunk-limit');
    assert.equal((await dictate({ dictationId: id, index: 7, final: false })).status, 200);
  });
});
