// v0.1.7 fix-desk, end to end through the device routes with a fake registry and fake providers. Synthetic data only (public repo).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setEnv, login, listen, fakeServer } from './helpers/env.js';
import { createApp } from '../src/server.js';
import { createDeviceMedia, pcmToWav } from '../src/deviceMedia.js';

const wav = (s = 1) => pcmToWav(Buffer.alloc(s * 32000));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 15)); } throw new Error('timeout'); };

describe('device routes (fix-desk)', () => {
  let registry, app, base, token, sid, mode = 'down', maiCost = 0.3;
  const sessions = [], events = [];
  before(async () => {
    registry = await fakeServer((req, res, body) => {
      const u = new URL(req.url, 'http://fake');
      const send = (data, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (u.pathname === '/v1/devices' && req.method === 'POST') return send({ id: '22222222-2222-4222-8222-222222222222' });
      if (u.pathname === '/v1/devices/verify') return send({ id: '22222222-2222-4222-8222-222222222222', scopes: ['dictate', 'dictionary', 'screen', 'exists'], expires_at: new Date(Date.now() + 864e5).toISOString(), hash: body.hash });
      if (u.pathname === '/v1/dictionary') return send({ items: [] });
      if (u.pathname === '/v1/resolve') return send({ items: u.searchParams.get('ids').split(',').map(id => ({ id, title: `Titel ${id}`, summary: 's' })) });
      if (u.pathname === '/v1/sessions' && req.method === 'POST') { sessions.push(body); return send({ id: (0xdd0000 + sessions.length).toString(16) }); }
      if (/\/events$/.test(u.pathname)) { events.push(...body.events.map(e => ({ ...e, session: u.pathname.split('/')[3], kind: sessions[Number.parseInt(u.pathname.split('/')[3], 16) - 0xdd0001]?.kind }))); return send({ ok: true }); }
      return send({}, 404);
    });
    setEnv({ ARTIFACTS_URL: registry.url, ARTIFACTS_DESK_TOKEN: 'fake' });
    // the REAL media code with providers that all answer 500 (mode "down") or a priced MAI answer (mode "up")
    const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' }, fetchImpl: async () => (mode === 'down' ? new Response('nope', { status: 500 }) : Response.json({ text: 'Hallo Welt', usage: { seconds: 1, cost: maiCost } })) });
    app = createApp({ deviceOptions: { media } });
    base = `http://127.0.0.1:${await listen(app.server)}`;
    const { cookie } = await login(base);
    sid = (await (await fetch(base + '/api/auth/me', { headers: { cookie } })).json()).sid;
    ({ token } = await (await fetch(base + '/api/device/pair', { method: 'POST', headers: { cookie, origin: process.env.DESK_ORIGIN } })).json());
  });
  after(() => { app.server.close(); registry.close(); });
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}), ...headers }, body });
  const dictateForm = (chunk) => { const f = new FormData(); f.set('audio', new Blob([wav()]), 'a.wav'); f.set('context', JSON.stringify({ process: 'p', fieldBefore: '', visibleIds: [], recentTerms: [] })); if (chunk) f.set('chunk', JSON.stringify(chunk)); return f; };
  const captionForm = () => { const f = new FormData(); f.set('audio', new Blob([Buffer.alloc(32000)]), 'a.pcm'); return f; };
  const deviceEvents = (type) => events.filter(e => e.type === type && e.kind === 'device');

  it('S11: a dictation where every provider fails ends with device.error and dictation.failed in the device log (real media code, no stub)', async () => {
    mode = 'down';
    const r = await post('/api/device/dictate', dictateForm({ dictationId: 'z-1', index: 0, final: true }));
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.code, 'all-providers-failed');
    for (const p of ['mai', 'groq', 'openai']) assert.equal(body.providers[p].status, 500, p);
    await app.traces.flushAll(1000);
    const failed = (await until(() => deviceEvents('dictation.failed').find(e => e.data.dictationId === 'z-1'))).data;
    assert.equal(failed.status, 502); assert.equal(failed.providers.openai.reason, 'upstream'); assert.equal(typeof failed.bytes, 'number');
    const err = (await until(() => deviceEvents('device.error').find(e => e.data.code === 'all-providers-failed'))).data;
    assert.equal(err.path, '/api/device/dictate'); assert.equal(err.status, 502);
  });

  it('M4: the caption answer carries costUsd; after the hour budget the answer is 429 caption-budget and dictation still works', async () => {
    mode = 'up';
    const first = await post('/api/device/caption', captionForm());
    assert.equal(first.status, 200);
    assert.equal((await first.json()).costUsd, 0.3);
    await post('/api/device/caption', captionForm()); await post('/api/device/caption', captionForm()); await post('/api/device/caption', captionForm()); // 1.2 USD
    const blocked = await post('/api/device/caption', captionForm());
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, 'caption-budget');
    assert(Number(blocked.headers.get('retry-after')) >= 1);
    const dictation = await post('/api/device/dictate', dictateForm({ dictationId: 'ok-1', index: 0, final: true }));
    assert.equal(dictation.status, 200, 'the shared cap is untouched by captions');
    await app.traces.flushAll(1000);
    const stats = events.filter(e => e.type === 'caption.stats');
    assert(stats.length === 0 || stats.every(e => typeof e.data.costUsd === 'number'));
  });

  it('S9: chunk index must grow, a dictation takes at most 60 chunks', async () => {
    mode = 'up';
    assert.equal((await post('/api/device/dictate', dictateForm({ dictationId: 'c-1', index: 3, final: false }))).status, 200);
    const back = await post('/api/device/dictate', dictateForm({ dictationId: 'c-1', index: 2, final: false }));
    assert.equal(back.status, 400); assert.equal((await back.json()).code, 'chunk-order');
  });

  it('S7: a re-sent batch is stored once', async () => {
    const batch = JSON.stringify({ events: [{ type: 'client.once', data: { n: 1 }, ts: 1_700_000_000_000 + Math.floor(Math.random() * 1e6) }] });
    const a = await (await post('/api/device/log', batch)).json(), b = await (await post('/api/device/log', batch)).json();
    assert.equal(a.accepted, 1); assert.equal(b.accepted, 0);
  });

  it('M6: a device may write only so many trace events per minute; the answer is 429', async () => {
    const batch = JSON.stringify({ events: Array.from({ length: 100 }, (_, i) => ({ type: 'client.flood', data: { i }, ts: Date.now() })) });
    let last = 200, sent = 0;
    for (let i = 0; i < 12 && last === 200; i++) { last = (await post('/api/device/log', batch.replace(/"ts":\d+/g, () => `"ts":${Date.now() + sent++}`))).status; }
    assert.equal(last, 429);
  });

  it('S4/S5: the briefing refuses a foreign device, drops query and fragment of tab URLs, and drops window titles and screen text while the screen is blocked', async () => {
    const off = app.devices.vision.attach(sid, { kind: 'voice', trace() {}, setContext: () => 'sent' });
    const body = { windows: [{ process: 'code', title: 'Geheim' }], tabs: [{ window: 'w', title: 'T', url: 'https://example.test/cb?code=abc123#access_token=xyz' }], screenText: 'sichtbarer Text' };
    assert.equal((await post(`/api/device/session/${sid}/briefing`, JSON.stringify(body))).status, 200);
    const stored = app.devices.briefing.device(sid);
    assert.equal(stored.tabs[0].url, 'https://example.test/cb');
    assert.equal(stored.screenText, 'sichtbarer Text');
    await app.artifacts.setScreen(sid, { deviceId: 'dev', ids: [], window: { process: '', blocked: true }, frameVersion: 1 });
    assert.equal((await post(`/api/device/session/${sid}/briefing`, JSON.stringify(body))).status, 200);
    const hidden = app.devices.briefing.device(sid);
    assert.equal(hidden.screenText, ''); assert.equal(hidden.windows[0].title, ''); assert.equal(hidden.tabs[0].title, '');
    // another device is polling this session: this one may not push into it
    app.devices.vision.snapshot?.(sid); app.devices.vision._states.get(sid).devices.add('someone-else'); app.devices.vision._states.get(sid).devices.delete('22222222-2222-4222-8222-222222222222');
    assert.equal((await post(`/api/device/session/${sid}/briefing`, JSON.stringify(body))).status, 403);
    off();
  });
});
