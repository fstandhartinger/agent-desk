import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { connectFakeBridge, login, readSse, setEnv, startGateway } from './helpers/env.js';

const SID = 'd20261024-abc123';
const ev = (seq, kind = 'text', extra = {}) => ({ seq, ts: '2026-10-24T09:00:00Z', kind, ...extra });
const STORED = [ev(1, 'status', { state: 'running' }), ev(2, 'user', { text: 'los' }), ev(3, 'text', { text: 'a' }), ev(4, 'text', { text: 'b' }), ev(5, 'result')];

setEnv();
let gw;
let bridge;
let cookie;
let sessions = [];
before(async () => {
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
  bridge = await connectFakeBridge(gw.port, {
    'claude.list': () => sessions,
    'claude.start': ({ title }) => ({ sid: title === 'bad' ? 'x' : SID }),
    'claude.send': () => ({ ok: true }),
    'claude.stop': () => ({ ok: true }),
    'claude.get': ({ sinceSeq }) => ({ events: STORED.filter((e) => e.seq > sinceSeq) }),
    'audit.append': () => ({ ok: true }),
  });
});
after(() => { bridge.ws.close(); gw.close(); });

const call = (path, body, method = 'POST') => fetch(`${gw.base}/api/claude/sessions${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
const lastRequest = (method) => bridge.requests.filter((r) => r.method === method).at(-1);

describe('session control', () => {
  it('starts a session with page context and chat context, defaulting to sonnet', async () => {
    const res = await call('', { title: 'Test', prompt: 'Bitte prüfe X', page: { slug: 'demo-slug', t: 12.5, sceneId: 'a', evil: 1 }, chatContext: 'user: hi' });
    assert.deepEqual(await res.json(), { sid: SID });
    assert.deepEqual(lastRequest('claude.start').params, { title: 'Test', prompt: 'Bitte prüfe X', page: { slug: 'demo-slug', t: 12.5, sceneId: 'a' }, chatContext: 'user: hi', model: 'sonnet', effort: 'medium' });
  });

  it('sends follow-ups and stops, with audit lines mirrored to the bridge', async () => {
    assert.equal((await call(`/${SID}/messages`, { text: 'weiter' })).status, 200);
    assert.deepEqual(lastRequest('claude.send').params, { sid: SID, text: 'weiter' });
    assert.equal((await call(`/${SID}/stop`, {})).status, 200);
    assert.deepEqual(lastRequest('claude.stop').params, { sid: SID });
    await new Promise((r) => setTimeout(r, 50));
    const actions = bridge.requests.filter((r) => r.method === 'audit.append').map((r) => r.params.action);
    assert.ok(['claude.start', 'claude.send', 'claude.stop'].every((a) => actions.includes(a)), actions.join());
  });

  it('validates input and session ids', async () => {
    assert.equal((await call('', { prompt: '' })).status, 400);
    assert.equal((await call('', { prompt: 'x', model: 'gpt' })).status, 400);
    assert.equal((await call('', { prompt: 'x', host: '../evil' })).status, 400);
    assert.equal((await call('/..%2Fetc/stop', {})).status, 400);
    assert.equal((await call(`/${SID}/messages`, { text: '' })).status, 400);
  });

  it('refuses a 4th concurrent session and the 26th start of the day', async () => {
    sessions = [1, 2, 3].map((n) => ({ sid: `s${n}`, state: 'running' }));
    const full = await call('', { prompt: 'noch eine' });
    assert.equal(full.status, 429);
    sessions = [];
    const { limits } = await import('../src/limits.js');
    limits.rate.clear();
    for (let i = 0; i < 25; i += 1) assert.equal((await call('', { prompt: `n${i}` })).status, 200);
    assert.equal((await call('', { prompt: 'zu viel' })).status, 429);
    limits.rate.clear();
  });

  it('reports an offline bridge as 503', async () => {
    const res = await fetch(`${gw.base}/api/claude/sessions?host=other`, { headers: { cookie } });
    assert.equal(res.status, 503);
  });

  it('lists sessions', async () => {
    sessions = [{ sid: SID, state: 'idle' }];
    assert.deepEqual(await (await call('', undefined, 'GET')).json(), sessions);
    sessions = [];
  });
});

describe('event stream', () => {
  it('replays everything from the start, then streams live events', async () => {
    const res = await call(`/${SID}/events`, undefined, 'GET');
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    setTimeout(() => bridge.emit(`claude:${SID}`, ev(6, 'text_delta', { text: 'live' })), 100);
    const events = await readSse(res, (e) => e.length >= 6);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(events.map((e) => e._id), ['1', '2', '3', '4', '5', '6']);
  });

  it('honours Last-Event-ID and ?since= and drops duplicates', async () => {
    const res = await fetch(`${gw.base}/api/claude/sessions/${SID}/events`, { headers: { cookie, 'last-event-id': '3' } });
    setTimeout(() => { bridge.emit(`claude:${SID}`, STORED[4]); bridge.emit(`claude:${SID}`, ev(6)); }, 100);
    const events = await readSse(res, (e) => e.length >= 3);
    assert.deepEqual(events.map((e) => e.seq), [4, 5, 6]);
    const since = await fetch(`${gw.base}/api/claude/sessions/${SID}/events?since=4`, { headers: { cookie } });
    assert.deepEqual((await readSse(since, (e) => e.length >= 1)).map((e) => e.seq), [5]);
  });

  it('fills the gap after the bridge reconnects', async () => {
    const res = await call(`/${SID}/events`, undefined, 'GET');
    const reading = readSse(res, (e) => e.some((x) => x.seq === 7), 4000);
    await new Promise((r) => setTimeout(r, 150));
    STORED.push(ev(7, 'text', { text: 'missed while offline' }));
    bridge.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    bridge = await connectFakeBridge(gw.port, { 'claude.get': ({ sinceSeq }) => ({ events: STORED.filter((e) => e.seq > sinceSeq) }) });
    const events = await reading;
    assert.deepEqual(events.map((e) => e.seq).filter(Boolean), [1, 2, 3, 4, 5, 7]);
  });
});
