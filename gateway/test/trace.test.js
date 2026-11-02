// Session trace (docs/TRACE.md): the service against a fake registry, the session_trace tool, the chat trace, the device route,
// the lookup route, plus the two small log fixes (entity guard on ordinary words, no early drawing for yes/no questions).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { completionStream, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';
import { syn } from './synthetic.js';

setEnv();
const { createTraceService, boundData, describeSession, timelineLines, localDiagnosis, MAX_BUFFER } = await import('../src/trace.js');
const { runTool, TOOL_DEFS } = await import('../src/tools.js');
const { isYesNoQuestion } = await import('../src/canvas.js');
const { createCorpus, unknownEntities } = await import('../src/entityGuard.js');
const { buildInstructions } = await import('../src/prompt.js');
const { buildInstructions: voiceInstructions } = await import('../src/voice/instructions.js');

const SECRET = syn('sk-o·r-v1·-012·3456·789a·bcde·f012·3456·789a·bcde·f');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ENV = { ARTIFACTS_URL: 'http://registry.test', ARTIFACTS_DESK_TOKEN: 'fake', SOURCE_COMMIT: 'abc1234' };

/** A fetch that plays the registry of the contract; `fail` makes it answer 503. */
function fakeRegistry() {
  const reg = { sessions: [], events: [], calls: [], fail: false, nextId: 0 };
  reg.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    reg.calls.push({ method: init.method ?? 'GET', path: u.pathname + u.search, body, auth: init.headers?.authorization });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (reg.fail) return json({}, 503);
    if (u.pathname === '/v1/sessions' && init.method === 'POST') { reg.sessions.push(body); return json({ id: (0x3f9c20 + reg.nextId++).toString(16).padStart(6, '0') }); }
    const ev = /^\/v1\/sessions\/([0-9a-f]{6})\/events$/.exec(u.pathname);
    if (ev && init.method === 'POST') { reg.events.push(...body.events); return json({ ok: true }); }
    if (/\/trace$/.test(u.pathname)) return json({ events: reg.events });
    if (/\/diagnosis$/.test(u.pathname)) return json({ diagnosis: reg.diagnosis ?? 'Eine Frage blieb ohne Antwort (Zug 2).' });
    if (u.pathname === '/v1/sessions/lookup') return u.searchParams.get('q') === 'nope' ? json({}, 404) : json({ id: '3f9c20', title: 'Voice-Sitzung 2 Nov 13:21 (openai)' });
    return json({}, 404);
  };
  return reg;
}
const svc = (reg, extra = {}) => createTraceService({ env: ENV, fetchImpl: reg.fetch, log: (l) => reg.logs.push(l), flushMs: 20, firstFlushMs: 20, ...extra });
const start = (t, extra = {}) => t.event('session.start', { provider: 'openai', slug: 'demo', title: 'Demo', client: { app: 'web', version: '1.2', commit: 'c0ffee1', device: 'laptop' }, entry: { path: 'card>interactive>desk', card: 'a#aaaaaa', page_aid: 'a#bbbbbb', element: 'a#cccccc', screen_ids: ['a#dddddd'] }, voice: 'x', lang: 'de', ...extra });

describe('trace service', () => {
  it('creates the session from session.start, then ships events in order with gateway commit, model and device', async () => {
    const reg = fakeRegistry(); reg.logs = [];
    const t = svc(reg).open({ provider: 'openai', kind: 'voice' });
    start(t);
    t.event('session.ready', { provider: 'openai', model: 'gpt-live' });
    t.event('turn.user.start', { turn: 1, trigger: 'vad' });
    t.event('transcript.user.final', { turn: 1, text: 'Hallo Desk' });
    const info = await t.ready;
    assert.match(info.aid, /^a#[0-9a-f]{6}$/);
    await t.close();
    assert.equal(reg.calls[0].path, '/v1/sessions');
    assert.equal(reg.calls[0].auth, 'Bearer fake');
    assert.deepEqual(reg.sessions[0], {
      kind: 'voice', provider: 'openai', model: 'gpt-live', slug: 'demo', title: 'Demo', page_aid: 'a#bbbbbb', card: 'a#aaaaaa', element: 'a#cccccc',
      entry: { path: 'card>interactive>desk', page_aid: 'a#bbbbbb', card: 'a#aaaaaa', element: 'a#cccccc' }, device: 'laptop', client: { app: 'web', version: '1.2', commit: 'c0ffee1' }, screen_ids: ['a#dddddd'], gateway_commit: 'abc1234',
    });
    assert.deepEqual(reg.events.map((e) => e.type), ['session.start', 'session.ready', 'turn.user.start', 'transcript.user.final']);
    assert.deepEqual(reg.events.map((e) => e.seq), [1, 2, 3, 4]);
    assert.deepEqual(reg.events.map((e) => e.turn), [null, null, 1, 1]);
    assert.equal(reg.events[3].data.text, 'Hallo Desk');
    assert.equal(reg.events[3].source, 'gateway');
    assert.ok(!reg.logs.length, 'no fallback line when everything was shipped');
  });

  it('flushes at 50 events without waiting for the timer', async () => {
    const reg = fakeRegistry(); reg.logs = [];
    const t = svc(reg, { flushMs: 60_000, firstFlushMs: 60_000 }).open({ provider: 'xai', kind: 'voice' });
    start(t);
    for (let i = 0; i < 60; i += 1) t.event('vad.speech_started', { turn: i });
    await wait(50);
    assert.ok(reg.events.length >= 50, `shipped ${reg.events.length}`);
    await t.close();
    assert.equal(reg.events.length, 61);
  });

  it('keeps seq monotonic per source and tags client events', async () => {
    const reg = fakeRegistry(); reg.logs = [];
    const t = svc(reg).open({ provider: 'openai' });
    start(t);
    const sent = Date.now() - 60_000;
    t.client({ ts: sent, type: 'ws.close', data: { code: 1006 } });
    t.client({ ts: 4_000_000_000_000, type: 'client.clock', data: {} }); // a wrong clock must not decide retention
    t.event('barge_in', { turn: 1 });
    t.client({ type: 'client.audio_device', data: { name: 'Mikro' } });
    await t.close();
    const by = (src) => reg.events.filter((e) => e.source === src);
    assert.deepEqual(by('gateway').map((e) => e.seq), [1, 2]);
    assert.deepEqual(by('client').map((e) => [e.seq, e.type]), [[1, 'client.ws.close'], [2, 'client.clock'], [3, 'client.audio_device']]);
    assert.equal(by('client')[0].ts, new Date(sent).toISOString());
    assert.ok(Date.parse(by('client')[1].ts) < Date.now() + 1000);
  });

  it('redacts secrets, caps sizes, stores no tool results, audio, images or base64', async () => {
    const reg = fakeRegistry(); reg.logs = [];
    const t = svc(reg).open({ provider: 'openai' });
    start(t);
    t.event('transcript.user.final', { turn: 1, text: `mein key ist ${SECRET} und ${'wort '.repeat(2000)}` });
    t.event('tool.call', { turn: 1, id: 'c1', name: 'read_file', args: { path: '/x', blob: 'q'.repeat(5000) } });
    t.event('tool.done', { turn: 1, id: 'c1', name: 'read_file', ok: true, ms: 12, result: 'GEHEIMER INHALT'.repeat(100), chars: 1500 });
    t.event('screen.frame', { audio: 'AAAA'.repeat(100), image: Buffer.alloc(3000, 1).toString('base64'), note: `data:image/png;base64,${'A'.repeat(500)}`, ok: true });
    t.event('provider.error', { message: 'x'.repeat(20_000) });
    await t.close();
    const raw = JSON.stringify(reg.events);
    assert.ok(!raw.includes(SECRET), 'secret never leaves');
    const said = reg.events.find((e) => e.type === 'transcript.user.final').data.text;
    assert.ok(said.length <= 4097 && said.length > 4000, `transcript kept up to 4 KB (${said.length})`);
    const call = reg.events.find((e) => e.type === 'tool.call').data;
    assert.ok(JSON.stringify(call.args).length <= 2000, 'tool args capped');
    const done = reg.events.find((e) => e.type === 'tool.done').data;
    assert.equal(done.result, undefined);
    assert.equal(done.resultChars, 1500);
    assert.ok(!raw.includes('GEHEIMER'));
    const frame = reg.events.find((e) => e.type === 'screen.frame').data;
    assert.match(frame.audio, /ausgelassen/);
    assert.match(frame.image, /ausgelassen/);
    assert.match(frame.note, /binär ausgelassen/);
    assert.equal(frame.ok, true);
    for (const e of reg.events) assert.ok(JSON.stringify(e.data).length <= 8192, e.type);
    assert.ok(JSON.stringify(boundData({ a: Array.from({ length: 50 }, () => 'y'.repeat(900)) })).length <= 8192);
    assert.equal(reg.events.find((e) => e.type === 'provider.error').data.message.length, 1001);
  });

  it('survives a registry outage: no throw, bounded buffer with trace.dropped, one stdout line, later recovery ships the rest', async () => {
    const reg = fakeRegistry(); reg.logs = []; reg.fail = true;
    const t = svc(reg).open({ provider: 'openai' });
    start(t);
    assert.doesNotThrow(() => { for (let i = 0; i < MAX_BUFFER + 300; i += 1) t.event('vad.speech_started', { turn: i }); });
    await wait(60);
    reg.fail = false;
    await t.flush();
    assert.ok(reg.events.length <= MAX_BUFFER + 1, `shipped ${reg.events.length}`);
    const dropped = reg.events.find((e) => e.type === 'trace.dropped');
    assert.ok(dropped && dropped.data.count >= 301, JSON.stringify(dropped));
    assert.ok(!reg.events.some((e) => e.type === 'session.start' && e.seq !== 1));
    await t.close();
    assert.equal(reg.logs.length, 0, 'recovered: no fallback line');

    const reg2 = fakeRegistry(); reg2.logs = []; reg2.fail = true;
    const u = svc(reg2).open({ provider: 'xai' });
    start(u); u.event('turn.unanswered', { turn: 3, reason: 'timeout' });
    await u.close();
    assert.equal(reg2.logs.length, 1);
    assert.match(reg2.logs[0], /^trace-fallback \{/);
    assert.equal(JSON.parse(reg2.logs[0].slice('trace-fallback '.length)).unsent, 2);
    assert.deepEqual(await u.ready, {}, 'ready resolves (empty) instead of hanging');
    u.event('barge_in', {}); // after close: ignored, no throw
  });

  it('without a registry the session path stays silent and one line is written at the end', async () => {
    const logs = [];
    const t = createTraceService({ env: {}, fetchImpl: () => { throw new Error('must not be called'); }, log: (l) => logs.push(l) }).open({ provider: 'gemini' });
    assert.deepEqual(await t.ready, {});
    start(t); t.event('mic.mute', { turn: 1, source: 'dock' });
    await t.close();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /registry-not-configured/);
  });

  it('flushAll (SIGTERM) ships every open trace and marks it interrupted', async () => {
    const reg = fakeRegistry(); reg.logs = [];
    const s = svc(reg, { flushMs: 60_000, firstFlushMs: 60_000 });
    const a = s.open({ provider: 'openai' }); const b = s.chat('k1', { provider: 'text' });
    start(a); start(b, { provider: 'text' });
    a.event('turn.user.start', { turn: 1 });
    await s.flushAll(2000);
    assert.equal(reg.sessions.length, 2);
    assert.equal(reg.events.filter((e) => e.type === 'session.interrupted').length, 2);
    assert.equal(reg.events.filter((e) => e.type === 'session.start').length, 2);
  });

  it('chat traces are shared by conversation key and idle out', async () => {
    const reg = fakeRegistry(); reg.logs = [];
    const s = svc(reg, { chatIdleMs: 40 });
    const a = s.chat('sid\0c1', { provider: 'text' });
    assert.equal(s.chat('sid\0c1', { provider: 'text' }), a);
    assert.notEqual(s.chat('sid\0c2', { provider: 'text' }), a);
    assert.equal(a.kind, 'chat');
    await wait(120);
    assert.ok(a.closed);
    assert.notEqual(s.chat('sid\0c1', { provider: 'text' }), a, 'a new trace after idle');
  });

  it('attaches Screen Agent events to the voice trace of the sid; earlier ones wait in a small buffer', async () => {
    const reg = fakeRegistry(); reg.logs = [];
    const s = svc(reg);
    assert.equal(s.attach('sid1', [{ type: 'hotkey.down', data: { key: 'F9' } }]), false);
    const t = s.open({ provider: 'openai', kind: 'voice', sid: 'sid1' });
    start(t);
    assert.equal(s.attach('sid1', [{ type: 'screen.frame', data: { decision: 'sent' }, ts: '2026-11-02T10:00:00.000Z' }]), true);
    await t.close();
    assert.deepEqual(reg.events.filter((e) => e.source === 'screen-agent').map((e) => [e.seq, e.type]), [[1, 'hotkey.down'], [2, 'screen.frame']]);
    assert.equal(s.attach('sid1', [{ type: 'hotkey.up', data: {} }]), false, 'closed trace is unbound');
  });
});

describe('session_trace tool and describeSession', () => {
  it('is a registered tool and both prompts tell the agent to use it', () => {
    const def = TOOL_DEFS.find((t) => t.name === 'session_trace');
    assert.ok(def);
    assert.deepEqual(Object.keys(def.parameters.properties), ['which']);
    assert.match(buildInstructions(null), /warum kam eben keine Antwort[\s\S]*session_trace/);
    assert.match(voiceInstructions(null, new Date(), { provider: 'openai' }), /session_trace/);
  });

  it('"current" flushes first and returns diagnosis plus the last 40 lines', async () => {
    const reg = fakeRegistry(); reg.logs = [];
    const s = svc(reg, { flushMs: 60_000, firstFlushMs: 60_000 });
    const t = s.open({ provider: 'openai', kind: 'voice', sid: 'sid1' });
    start(t);
    for (let i = 1; i <= 50; i += 1) t.event('transcript.user.final', { turn: i, text: `Frage ${i}` });
    t.event('turn.unanswered', { turn: 50, reason: 'no-answer', question: 'Frage 50' });
    const res = await runTool('session_trace', { which: 'current' }, { traces: s, trace: () => t, audit() {} });
    assert.equal(res.ok, true, res.content);
    assert.match(res.content, /^Sitzung a#[0-9a-f]{6}\nDiagnose: Eine Frage blieb ohne Antwort/);
    const lines = res.content.split('\n').filter((l) => /^\+/.test(l));
    assert.equal(lines.length, 40);
    assert.match(lines.at(-1), /turn\.unanswered no-answer/);
    assert.ok(reg.events.length >= 52, 'flushed before reading');
  });

  it('"current" falls back to the local ring and its own diagnosis when the registry is down', async () => {
    const reg = fakeRegistry(); reg.logs = []; reg.fail = true;
    const s = svc(reg);
    const t = s.open({ provider: 'xai', kind: 'voice' });
    start(t); t.event('turn.unanswered', { turn: 2, reason: 'silence' }); t.event('tool.error', { turn: 2, id: 'c', name: 'read_file', ms: 9, error: 'boom' });
    const text = await describeSession({ which: 'current', service: s, current: t });
    assert.match(text, /lokaler Verlauf/);
    assert.match(text, /1 Frage\(n\) ohne Antwort/);
    assert.match(text, /1 Werkzeugfehler/);
    assert.match(text, /tool\.error read_file/);
  });

  it('"last" and an a#id go through the registry lookup; unknown ones are reported plainly', async () => {
    const reg = fakeRegistry(); reg.logs = [];
    reg.events.push({ seq: 1, ts: '2026-11-02T10:00:00.000Z', source: 'gateway', turn: 1, type: 'tool.done', data: { name: 'list_jobs', ok: true, ms: 40, chars: 900 } });
    const s = svc(reg);
    const last = await describeSession({ which: 'last', service: s });
    assert.match(last, /^Sitzung a#3f9c20/);
    assert.match(last, /\+0\.0s t1 tool\.done list_jobs 40ms 900 Zeichen/);
    assert.ok(reg.calls.some((c) => c.path === '/v1/sessions/lookup?q=last'));
    assert.match(await describeSession({ which: 'nope', service: s }), /Keine Sitzung zu "nope"/);
    assert.match(await describeSession({ which: 'last', service: createTraceService({ env: {} }) }), /nicht eingerichtet/);
    assert.match(await describeSession({ which: 'current', service: s }), /Keine laufende Sitzung/);
  });

  it('timeline and diagnosis helpers read the contract event types', () => {
    const events = [
      { seq: 1, ts: '2026-11-02T10:00:00.000Z', source: 'gateway', turn: null, type: 'mic.mute', data: { source: 'hotkey' } },
      { seq: 2, ts: '2026-11-02T10:00:02.500Z', source: 'screen-agent', turn: null, type: 'hotkey.down', data: { key: 'F9' } },
    ];
    assert.deepEqual(timelineLines(events), ['+0.0s mic.mute source=hotkey', '+2.5s screen-agent hotkey.down key=F9']);
    assert.match(localDiagnosis(events), /Mikrofon 1x stummgeschaltet/);
    assert.equal(localDiagnosis([]), 'Keine Auffälligkeiten im Verlauf.');
  });
});

describe('gateway routes', () => {
  let registry; let gw; let cookie; let openrouter; let sid; let token; let rows; let script;
  before(async () => {
    rows = [];
    const sessions = []; const events = [];
    registry = await fakeServer((req, res, body) => {
      const u = new URL(req.url, 'http://fake');
      const send = (data, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (u.pathname === '/v1/devices' && req.method === 'POST') { rows.push({ ...body, id: '11111111-1111-4111-8111-111111111111', expires_at: new Date(body.expires_at).toISOString() }); return send({ id: rows[0].id }); }
      if (u.pathname === '/v1/devices/verify') { const row = rows.find((r) => r.hash === body.hash); return row ? send(row) : send({}, 404); }
      if (u.pathname === '/v1/sessions' && req.method === 'POST') { sessions.push(body); return send({ id: (0xabc000 + sessions.length).toString(16) }); }
      if (/\/events$/.test(u.pathname)) { events.push(...body.events); return send({ ok: true }); }
      if (/\/trace$/.test(u.pathname)) return send({ events });
      if (/\/diagnosis$/.test(u.pathname)) return send({ diagnosis: 'alles gut' });
      if (u.pathname === '/v1/sessions/lookup') return u.searchParams.get('q') === 'nope' ? send({}, 404) : send({ id: 'abc001', title: 'Chat-Sitzung' });
      return send({}, 404);
    });
    registry.sessions = sessions; registry.events = events;
    openrouter = await fakeServer((req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script()));
    setEnv({ ARTIFACTS_URL: registry.url, ARTIFACTS_DESK_TOKEN: 'fake', SOURCE_COMMIT: 'deadbee', OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
    gw = await startGateway();
    cookie = (await login(gw.base)).cookie;
    sid = (await (await fetch(`${gw.base}/api/auth/me`, { headers: { cookie } })).json()).sid;
    const pair = await fetch(`${gw.base}/api/device/pair`, { method: 'POST', headers: { cookie, origin: process.env.DESK_ORIGIN } });
    ({ token } = await pair.json());
  });
  after(() => { gw.close(); registry.close(); openrouter.close(); });

  let deviceSid;
  const device = (body, headers = {}) => fetch(`${gw.base}/api/device/session/${deviceSid}/trace`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('chat: the session id travels in the SSE stream; events cover the user message, tool call and assistant answer', async () => {
    let n = 0;
    script = () => (n++ === 0 ? completionStream({ toolCalls: [{ id: 'call_1', name: 'desk_status', args: '{}' }] }) : completionStream({ text: 'Alles läuft.', cost: 0.0004 }));
    const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'conv-1', messages: [{ role: 'user', content: 'Läuft der Desk?' }] }) });
    const events = await readSse(res, (e) => e.some((x) => x.type === 'session') && e.some((x) => x.type === 'done'), 8000);
    const session = events.find((e) => e.type === 'session');
    assert.match(session.aid, /^a#abc00[0-9a-f]$/);
    assert.ok(events.findIndex((e) => e.type === 'done') >= 0);
    await gw.traces.flushAll(2000);
    assert.equal(registry.sessions[0].kind, 'chat');
    assert.equal(registry.sessions[0].model, 'test/model');
    assert.equal(registry.sessions[0].gateway_commit, 'deadbee');
    const types = registry.events.map((e) => e.type);
    for (const t of ['session.start', 'transcript.user.final', 'response.created', 'tool.call', 'tool.done', 'transcript.assistant.final', 'response.done']) assert.ok(types.includes(t), `${t} in ${types}`);
    const done = registry.events.find((e) => e.type === 'tool.done');
    assert.equal(done.data.name, 'desk_status');
    assert.ok(done.data.ms >= 0 && done.data.chars > 0);
    assert.equal(done.data.result, undefined);
  });

  it('device trace route: scope, validation, rate limit and attachment to the voice session of the sid', async () => {
    const other = (await login(gw.base)).cookie; // a session of its own: the chat test above left a chat trace bound to `sid`
    deviceSid = (await (await fetch(`${gw.base}/api/auth/me`, { headers: { cookie: other } })).json()).sid;
    assert.notEqual(deviceSid, sid);
    assert.equal((await fetch(`${gw.base}/api/device/session/${deviceSid}/trace`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await device({ events: 'x' })).status, 400);
    assert.equal((await device({ events: [{ type: 'Bad Type' }] })).status, 400);
    assert.equal((await device({ events: [{ type: 'screen.frame', data: [1] }] })).status, 400);
    assert.equal((await device({ events: Array.from({ length: 101 }, () => ({ type: 'screen.frame' })) })).status, 400);
    assert.equal((await device({ events: [{ type: 'tool.call' }] })).status, 400, 'a client may not forge gateway event types');
    const parked = await device({ events: [{ type: 'hotkey.down', data: { key: 'F9' } }] });
    assert.deepEqual(await parked.json(), { ok: true, accepted: 1, attached: false });
    const voice = gw.traces.open({ provider: 'openai', kind: 'voice', sid: deviceSid });
    voice.event('session.start', { provider: 'openai', client: { app: 'screen-agent', version: '0.4.0', commit: 'ab12cd3', device: 'win-pc' }, entry: { path: 'screen-agent' } });
    const ok = await device({ events: [{ type: 'screen.frame', data: { decision: 'deduped', ids: ['a#abcdef'] }, ts: Date.now() }] });
    assert.deepEqual(await ok.json(), { ok: true, accepted: 1, attached: true });
    await voice.close();
    const shipped = registry.events.filter((e) => e.source === 'screen-agent').map((e) => e.type);
    assert.deepEqual(shipped, ['hotkey.down', 'screen.frame']);
    let last = 200;
    for (let i = 0; i < 70 && last === 200; i += 1) last = (await device({ events: [] })).status;
    assert.equal(last, 429, 'rate limited');
  });

  it('GET /api/session-lookup needs the login, validates q and proxies the registry', async () => {
    const url = (q, extra = '') => `${gw.base}/api/session-lookup?q=${encodeURIComponent(q)}${extra}`;
    assert.equal((await fetch(url('last'))).status, 401);
    const ok = await fetch(url('last'), { headers: { cookie } });
    assert.deepEqual(await ok.json(), { id: 'abc001', title: 'Chat-Sitzung' });
    assert.equal((await fetch(url('x'.repeat(100)), { headers: { cookie } })).status, 400);
    assert.equal((await fetch(url('a b;rm'), { headers: { cookie } })).status, 400);
    assert.equal((await fetch(url('nope'), { headers: { cookie } })).status, 404);
    const full = await (await fetch(url('a#abc001', '&full=1'), { headers: { cookie } })).json();
    assert.match(full.summary, /^Sitzung a#abc001\nDiagnose: alles gut/);
  });
});

describe('small log fixes', () => {
  it('entity guard: ordinary words next to sourced acronyms or names are no invented entities', () => {
    const check = (rich, label) => unknownEntities({ title: label, nodes: [{ id: 'a', label }] }, createCorpus({ rich }));
    assert.deepEqual(check('Die Antwort kam vom WARM-Pfad (WARM). Der Browser-Tab zeigt TAG und TAO.', 'Warum'), []);
    assert.deepEqual(check('TAG TAO und WAR', 'Tab'), []);
    assert.deepEqual(check('Coldkey „Warm“', 'Warum'), []);
    // the guard still catches a real misspelt name
    assert.deepEqual(check('Coldkey „kappa“ und BlauWerk', 'Kapa'), ['Kapa']);
  });

  it('yes/no questions: no early drawing; explanations, comparisons and drawing requests still draw', () => {
    for (const q of ['Läuft der Job noch?', 'Ist die Bridge verbunden?', 'Hat Florian das entschieden?', 'Is the gateway up?', 'Gibt es neue Mails?', 'Kann der Desk das?']) assert.equal(isYesNoQuestion(q), true, q);
    for (const q of ['Wie funktioniert der Login?', 'Kannst du mir das aufzeichnen?', 'Ist A besser als B, und warum?', 'Warum läuft das nicht?', 'Zeig mir die Architektur', 'Was kostet der Desk?', 'Läuft der Job noch? Erkläre den Ablauf.', 'Läuft der Job noch', 'Hat sich etwas geändert, oder bleibt es wie vorher?']) assert.equal(isYesNoQuestion(q), false, q);
  });
});
