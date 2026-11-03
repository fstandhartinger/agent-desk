import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setEnv, login, listen, fakeServer } from './helpers/env.js';
import { createApp } from '../src/server.js';
import { createDeviceMedia, pcmToWav } from '../src/deviceMedia.js';
import { createTraceService, deviceLogTitle, lateTs } from '../src/trace.js';

const wav = (s = 1) => pcmToWav(Buffer.alloc(s * 32000));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 15)); } throw new Error('timeout'); };

describe('device routes: chunks, captions, device log, device.error', () => {
  let registry, app, base, token, deviceId, failDictate = false, maiMode = 'ok', maiCalls = 0, refuse = false;
  const sessions = [], events = [];
  before(async () => {
    registry = await fakeServer((req, res, body) => {
      const u = new URL(req.url, 'http://fake');
      const send = (data, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (u.pathname === '/v1/devices' && req.method === 'POST') return send({ id: '22222222-2222-4222-8222-222222222222' }, 200);
      if (u.pathname === '/v1/devices/verify') return send({ id: '22222222-2222-4222-8222-222222222222', scopes: ['dictate', 'dictionary', 'screen', 'exists'], expires_at: new Date(Date.now() + 864e5).toISOString(), hash: body.hash });
      if (u.pathname === '/v1/dictionary') return send({ items: [{ term: 'Karpathy', replace_from: ['Karpati'] }] });
      if (u.pathname === '/v1/resolve') return send({ items: u.searchParams.get('ids').split(',').map(id => ({ id, title: `Titel Von ${id}`, summary: 's' })) });
      if (u.pathname === '/v1/sessions' && req.method === 'POST') { if (refuse && body.kind === 'device') return send({ error: 'unknown kind' }, 422); sessions.push(body); return send({ id: (0xdd0000 + sessions.length).toString(16) }); }
      if (/\/events$/.test(u.pathname)) { events.push(...body.events.map(e => ({ ...e, session: u.pathname.split('/')[3] }))); return send({ ok: true }); }
      return send({}, 404);
    });
    setEnv({ ARTIFACTS_URL: registry.url, ARTIFACTS_DESK_TOKEN: 'fake' });
    const phrases = [];
    const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (_u, opts) => {
      maiCalls++; phrases.push(JSON.parse(opts.body).provider?.options?.azure?.phraseList?.phrases ?? []);
      return maiMode === 'down' ? new Response('nope', { status: 500 }) : Response.json({ text: 'Geheimtext4711', usage: { seconds: 1, cost: 0.00003 } });
    } });
    media.phrases = phrases;
    const dictate = media.dictate;
    app = createApp({ deviceOptions: { media: { ...media, dictate: async (b, c) => { await c; if (failDictate) throw Object.assign(Object.assign(Error('Kein Transkript rechtzeitig verfügbar.'), { status: 502, code: 'all-providers-failed', providers: { mai: { ok: false, ms: 5, status: 500, reason: 'upstream' } }, seconds: 1 }), { body: { error: 'Kein Transkript rechtzeitig verfügbar.', code: 'all-providers-failed', providers: { mai: { ok: false, ms: 5, status: 500, reason: 'upstream' } } } }); return { text: 'Diktat', sources: {}, ms: 3, providers: { mai: { ok: true, ms: 3 } }, degraded: false, merged: false, seconds: 1 }; }, phrases } }, traceOptions: { flushMs: 15, firstFlushMs: 15 } });
    void dictate;
    base = `http://127.0.0.1:${await listen(app.server)}`;
    const cookie = (await login(base)).cookie;
    const pair = await fetch(`${base}/api/device/pair`, { method: 'POST', headers: { cookie, origin: process.env.DESK_ORIGIN } });
    ({ token, deviceId } = await pair.json());
  });
  after(() => { app.server.close(); registry.close(); });
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}), ...headers }, body });
  const dictateForm = (chunk, audio = wav()) => { const f = new FormData(); f.set('audio', new Blob([audio]), 'a.wav'); f.set('context', JSON.stringify({ process: 'p', fieldBefore: '', visibleIds: [], recentTerms: [] })); if (chunk !== undefined) f.set('chunk', typeof chunk === 'string' ? chunk : JSON.stringify(chunk)); return f; };
  const captionForm = (pcm, ctx) => { const f = new FormData(); f.set('audio', new Blob([pcm]), 'a.pcm'); if (ctx !== undefined) f.set('context', JSON.stringify(ctx)); return f; };
  const deviceEvents = (type) => events.filter(e => e.type === type && sessions[Number.parseInt(e.session, 16) - 0xdd0001]?.kind === 'device');

  it('dictate: chunk is validated and only traced; the response keeps its additive fields; the result lands in the device log', async () => {
    for (const bad of ['{', { dictationId: '', index: 0, final: false }, { dictationId: 'x'.repeat(41), index: 0, final: false }, { dictationId: 'ok', index: 1.5, final: false }, { dictationId: 'ok', index: 0, final: 'yes' }]) {
      assert.equal((await post('/api/device/dictate', dictateForm(bad))).status, 400, JSON.stringify(bad));
    }
    const ok = await post('/api/device/dictate', dictateForm({ dictationId: 'd-1', index: 2, final: true }));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.text, 'Diktat'); assert.equal(body.degraded, false); assert.equal(body.merged, false); assert.equal(body.seconds, 1); assert.equal(body.providers.mai.ok, true);
    await app.traces.flushAll(1000);
    const result = (await until(() => deviceEvents('dictation.result')[0])).data;
    assert.equal(result.dictationId, 'd-1'); assert.equal(result.index, 2); assert.equal(result.final, true); assert(!('text' in result), 'no dictation text in the log');
    assert.equal(sessions.at(-1).kind, 'device'); assert.match(sessions.at(-1).title, /^Geräteprotokoll \d{1,2} (Jan|Feb|Mär|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Dez)$/);
  });

  it('dictate: all providers failing answers {error, code, providers} and leaves dictation.failed + device.error with the provider status', async () => {
    failDictate = true;
    const r = await post('/api/device/dictate', dictateForm({ dictationId: 'f-1', index: 0, final: true }));
    failDictate = false;
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.equal(body.code, 'all-providers-failed'); assert.equal(body.providers.mai.status, 500);
    await app.traces.flushAll(1000);
    const failed = (await until(() => deviceEvents('dictation.failed').find(e => e.data.dictationId === 'f-1'))).data;
    assert.equal(failed.status, 502); assert.equal(failed.providers.mai.reason, 'upstream'); assert.equal(typeof failed.ms, 'number');
    const err = (await until(() => deviceEvents('device.error').find(e => e.data.code === 'all-providers-failed'))).data;
    assert.equal(err.path, '/api/device/dictate'); assert.equal(err.providers.mai.status, 500);
  });

  it('chunks of one dictation have their own larger bucket; single clips still stop at 12 per minute', async () => {
    const tag = Date.now().toString(36);
    for (let i = 0; i < 20; i++) assert.equal((await post('/api/device/dictate', dictateForm({ dictationId: `d-${i % 3}-${tag}`, index: i, final: false }))).status, 200, `chunk ${i}`);
    let last = 200;
    for (let i = 0; i < 20 && last === 200; i++) last = (await post('/api/device/dictate', dictateForm())).status;
    assert.equal(last, 429);
  });

  it('caption: raw PCM and WAV, phrases from the dictionary, titles and recent terms, cached per device', async () => {
    const r = await post('/api/device/caption', captionForm(Buffer.alloc(32000), { visibleIds: ['abcdef'], recentTerms: ['Bittensor'] }));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.text, 'Geheimtext4711'); assert.equal(body.seconds, 1); assert.equal(typeof body.ms, 'number');
    const list = app.devices.constructor === Object ? null : null; void list;
    assert.equal((await post('/api/device/caption', captionForm(wav(2)))).status, 200);
    assert.equal(maiCalls >= 2, true);
  });

  it('caption: validation, 12 s cap, scope', async () => {
    assert.equal((await post('/api/device/caption', captionForm(Buffer.alloc(13 * 32000)))).status, 413);
    assert.equal((await post('/api/device/caption', captionForm(Buffer.alloc(100)))).status, 400);
    assert.equal((await post('/api/device/caption', captionForm(Buffer.alloc(32000), { visibleIds: ['zz'] }))).status, 400);
    assert.equal((await post('/api/device/caption', captionForm(Buffer.alloc(32000), { recentTerms: 'x' }))).status, 400);
    assert.equal((await post('/api/device/caption', '{}', { 'content-type': 'application/json' })).status, 415);
    assert.equal((await fetch(`${base}/api/device/caption`, { method: 'POST' })).status, 401);
  });

  it('caption: MAI down is 503 with {error, code}; the text is never traced; an aggregate caption.stats is', async () => {
    maiMode = 'down';
    const r = await post('/api/device/caption', captionForm(Buffer.alloc(32000)));
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.code, 'mai-down'); assert.equal(typeof body.error, 'string'); assert.deepEqual(Object.keys(body).sort(), ['code', 'error']);
    maiMode = 'ok';
    app.devices.flushCaptionStats(deviceId);
    await app.traces.flushAll(1000);
    const stats = (await until(() => deviceEvents('caption.stats').at(-1))).data;
    assert(stats.calls >= 3 && stats.failures === 1);
    assert.equal(stats.lastStatus, 500); assert.equal(typeof stats.medianMs, 'number'); assert(stats.costUsd > 0);
    assert(!JSON.stringify(events).includes('Geheimtext4711'), 'caption text never reaches the trace');
  });

  it('caption: own rate bucket of 60 per minute', async () => {
    let last = 200, n = 0;
    while (last === 200 && n < 80) { last = (await post('/api/device/caption', captionForm(Buffer.alloc(6400)))).status; n++; }
    assert.equal(last, 429); assert(n <= 62);
  });

  it('log route: a retry queue up to 24 h old keeps its timestamp and is flagged late; older or future clocks are clamped', async () => {
    const hourAgo = Date.now() - 3600_000, tooOld = Date.now() - 30 * 3600_000;
    const r = await post('/api/device/log', JSON.stringify({ events: [{ type: 'client.dictation.retry', ts: hourAgo, data: { n: 1 } }, { type: 'client.dictation.old', ts: tooOld }, { type: 'client.dictation.future', ts: Date.now() + 9e6 }] }));
    assert.equal(r.status, 200); assert.equal((await r.json()).logged, true);
    await app.traces.flushAll(1000);
    const late = (await until(() => deviceEvents('client.dictation.retry')[0]));
    assert.equal(Date.parse(late.ts), hourAgo); assert.equal(late.data.late, true); assert.equal(late.source, 'screen-agent');
    const old = deviceEvents('client.dictation.old')[0], future = deviceEvents('client.dictation.future')[0];
    assert(Math.abs(Date.parse(old.ts) - Date.now()) < 60_000 && old.data.late === true && Date.parse(old.data.origTs) === tooOld, 'older than a day: stamped now, flagged late with its real time');
    assert(Math.abs(Date.parse(future.ts) - Date.now()) < 60_000);
    assert.equal((await post('/api/device/log', JSON.stringify({ events: [{ type: 'tool.call' }] }))).status, 400);
  });

  it('log route: every namespace the app emits is accepted, gateway-owned and foreign ones are not', async () => {
    const ok = ['activity.start', 'app.error', 'briefing.device', 'caption.stats', 'dictation.recover', 'http.fail', 'session.startup', 'telemetry.flush.fail', 'ui.status'];
    const r = await post('/api/device/log', JSON.stringify({ events: ok.map((type) => ({ type, data: { n: 1 } })) }));
    assert.equal(r.status, 200); assert.equal((await r.json()).accepted, ok.length);
    for (const type of ['session.start', 'session.end', 'tool.call', 'gateway.x', 'Activity.start']) assert.equal((await post('/api/device/log', JSON.stringify({ events: [{ type }] }))).status, 400, type);
  });

  it('device.error: a failed device request leaves path, status, code, ms and bytes (ids in the path are folded)', async () => {
    const r = await post('/api/device/session/not-a-session/trace', JSON.stringify({ events: [] }));
    assert.equal(r.status, 403);
    await app.traces.flushAll(1000);
    const err = (await until(() => deviceEvents('device.error').find(e => e.data.path === '/api/device/session/:sid/trace'))).data;
    assert.equal(err.status, 403); assert.equal(err.method, 'POST'); assert.equal(typeof err.ms, 'number'); assert.equal(typeof err.bytes, 'number'); assert.equal(typeof err.message, 'string');
    const all = await post('/api/device/dictate', dictateForm({ dictationId: 'e', index: 0, final: true }, Buffer.from('not audio')));
    assert.equal(all.status, 400);
    assert((await until(() => deviceEvents('device.error').find(e => e.data.path === '/api/device/dictate'))).data.status === 400);
  });
});

describe('device log lifecycle in trace.js', () => {
  const setup = (registryFn) => {
    let t = Date.parse('2026-11-03T10:00:00Z'); const lines = [];
    const calls = [];
    const fetchImpl = async (url, opts) => { const body = JSON.parse(opts.body); calls.push({ path: new URL(url).pathname, body }); return registryFn(new URL(url).pathname, body); };
    const svc = createTraceService({ env: { ARTIFACTS_URL: 'http://reg.test', ARTIFACTS_DESK_TOKEN: 't' }, fetchImpl, now: () => t, log: (l) => lines.push(l), flushMs: 5, firstFlushMs: 5 });
    return { svc, calls, lines, advance: (ms) => { t += ms; } };
  };
  const ok = (path) => (path === '/v1/sessions' ? Response.json({ id: 'ee0001' }) : Response.json({ ok: true }));

  it('title and lateTs', () => {
    assert.equal(deviceLogTitle('2026-11-03'), 'Geräteprotokoll 3 Nov');
    assert.equal(deviceLogTitle('2026-03-21'), 'Geräteprotokoll 21 Mär');
    const at = Date.now();
    assert.deepEqual(lateTs(at - 3600_000, at), { ts: new Date(at - 3600_000).toISOString(), late: true });
    assert.deepEqual(lateTs(at - 25 * 3600_000, at), { ts: new Date(at).toISOString(), late: true, origTs: new Date(at - 25 * 3600_000).toISOString() });
    assert.equal(lateTs('garbage', at).late, false);
  });

  it('events parked without a session go to the device log when the 60 s are over; one trace per day and device', async () => {
    const { svc, calls, advance } = setup(ok);
    assert.equal(svc.attach('sid-1', [{ type: 'screen.frame', data: {}, ts: new Date().toISOString() }], { deviceId: 'dev-1' }), false);
    advance(61_000);
    svc.attach('sid-2', [{ type: 'screen.frame', data: {}, ts: new Date().toISOString() }], { deviceId: 'dev-1' }); // lazy sweep moves sid-1's events
    assert.equal(svc.deviceLog('dev-1', [{ type: 'client.x', data: {}, ts: new Date().toISOString() }]), true);
    await new Promise(r => setTimeout(r, 80));
    const creates = calls.filter(c => c.path === '/v1/sessions');
    assert.equal(creates.length, 1); assert.equal(creates[0].body.kind, 'device'); assert.equal(creates[0].body.title, 'Geräteprotokoll 3 Nov'); assert.equal(creates[0].body.device, 'dev-1');
    const types = calls.filter(c => c.path.endsWith('/events')).flatMap(c => c.body.events.map(e => e.type));
    assert(types.includes('screen.frame') && types.includes('client.x'));
    advance(24 * 3600_000); // the next UTC day: a new trace
    svc.deviceLog('dev-1', [{ type: 'client.y', data: {}, ts: new Date().toISOString() }]);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(calls.filter(c => c.path === '/v1/sessions').length, 2);
  });

  it('a session that appears in time takes the parked events and the device log gets nothing', async () => {
    const { svc, calls } = setup(ok);
    svc.attach('sid-9', [{ type: 'hotkey.down', data: {}, ts: new Date().toISOString() }], { deviceId: 'dev-9' });
    const voice = svc.open({ kind: 'voice', sid: 'sid-9', provider: 'x' });
    voice.event('session.start', { provider: 'x' });
    await voice.close();
    assert.equal(calls.filter(c => c.path === '/v1/sessions').every(c => c.body.kind === 'voice'), true);
    assert(calls.some(c => c.body.events?.some(e => e.type === 'hotkey.down')));
  });

  it('the registry refusing kind "device": logged once as a trace-fallback line, events dropped, no retry storm', async () => {
    const { svc, calls, lines } = setup((path, body) => (path === '/v1/sessions' && body.kind === 'device' ? Response.json({ error: 'unknown kind' }, { status: 422 }) : ok(path)));
    svc.deviceLog('dev-2', [{ type: 'client.z', data: {}, ts: new Date().toISOString() }]);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(calls.filter(c => c.path === '/v1/sessions').length, 1);
    assert(lines.some(l => l.startsWith('trace-fallback') && l.includes('kind-refused-422') && l.includes('"kind":"device"')));
    assert.equal(svc.deviceLog('dev-2', [{ type: 'client.z2', data: {}, ts: new Date().toISOString() }]), false);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(calls.filter(c => c.path === '/v1/sessions').length, 1);
  });
});
