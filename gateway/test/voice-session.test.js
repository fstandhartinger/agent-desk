import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runVoiceSession, HARD_CAP_MS, CAP_WARN_MS, USAGE_TICK_MS, voiceCapFor } from '../src/voice/session.js';

function harness(t, { limit = { ok: true }, runTool, costToday, loadStartupCard, computer } = {}) {
  const ws = new EventEmitter();
  ws.OPEN = 1; ws.CONNECTING = 0; ws.readyState = 1;
  ws.sent = [];
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  ws.close = () => { ws.readyState = 3; };
  const audits = [];
  const costs = [];
  const results = [];
  let emit, instructions;
  const adapterCalls = [];
  const adapter = {
    sendAudio: (b) => adapterCalls.push(['audio', b.length]),
    sendText: (t) => adapterCalls.push(['text', t]),
    interrupt: () => adapterCalls.push(['interrupt']),
    sendToolResult: (...a) => results.push(a),
    close: () => adapterCalls.push(['close']),
  };
  const noted = [];
  const deps = {
    computer, loadStartupCard, sid: 's1', toolDefs: [], audit: (e) => audits.push(e), makeCtx: (p) => ({ page: p }),
    limits: { check: () => limit, addCost: (c) => costs.push(c), ...(costToday ? { costToday } : {}) },
    createViz: () => ({ noteTurn: (t) => noted.push(t), noteEvent: (e) => noted.push(e), close() {} }),
    runTool: runTool ?? (async () => ({ summary: 's', content: 'x'.repeat(5000) })),
  };
  runVoiceSession(ws, deps, { provider: 'gemini', apiKey: 'k', create: (o, e) => ((instructions = o.instructions), (emit = e), adapter) });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  t.after(() => msg({ type: 'stop' }));
  return { ws, msg, audits, costs, results, adapterCalls, noted, instructions: () => instructions, emit: (e) => emit(e) };
}
const types = (h) => h.ws.sent.filter((m) => !Buffer.isBuffer(m)).map((m) => m.type);

test('limit denial: error to the browser, adapter never created, no audit start', (t) => {
  const h = harness(t, { limit: { ok: false, retryAfter: 120 } });
  h.msg({ type: 'start' });
  assert.deepEqual(types(h), ['error', 'closed']);
  assert.equal(h.audits.length, 0);
});

test('tool call: start/done events, truncated to the provider cap (Part 6: job_status is asked for on purpose), result handed back, viz fed', async (t) => {
  const h = harness(t);
  h.msg({ type: 'start', page: { slug: 'a' } });
  h.emit({ t: 'ready', model: 'm' });
  h.emit({ t: 'tool_call', id: 'c1', name: 'job_status', args: { name: 'j' } });
  await new Promise((r) => setImmediate(r));
  const tools = h.ws.sent.filter((m) => m.type === 'tool');
  assert.deepEqual(tools.map((t) => t.status), ['start', 'done']);
  assert.equal(h.results[0][2].length, Math.min(5000, voiceCapFor('gemini', 'job_status')));
  assert.ok(h.audits.some((a) => a.action === 'voice.tool'));
  assert.equal(h.noted.filter((n) => n.type === 'tool').length, 2);
});

test('failing tool reports status error and still answers the model', async (t) => {
  const h = harness(t, { runTool: async () => { throw new Error('boom'); } });
  h.msg({ type: 'start' });
  h.emit({ t: 'tool_call', id: 'c', name: 'x', args: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.ws.sent.find((m) => m.status === 'error').summary, 'boom');
  assert.match(h.results[0][2], /boom/);
});

test('transcript deltas are flushed as one final turn on role change; interrupt drops stale audio', (t) => {
  const h = harness(t);
  h.msg({ type: 'start' });
  h.emit({ t: 'transcript', role: 'user', delta: 'Hallo ', final: false });
  h.emit({ t: 'transcript', role: 'user', delta: 'Welt', final: false });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Hi', final: false });
  const finals = h.ws.sent.filter((m) => m.final === true);
  assert.deepEqual(finals.map((f) => f.text), ['Hallo Welt']);
  h.msg({ type: 'interrupt' });
  h.emit({ t: 'audio', pcm: Buffer.alloc(4) });
  assert.equal(h.ws.sent.filter(Buffer.isBuffer).length, 0);
  h.emit({ t: 'turn_done' });
  h.emit({ t: 'audio', pcm: Buffer.alloc(4) });
  assert.equal(h.ws.sent.filter(Buffer.isBuffer).length, 1);
});

test('fallback error from the adapter is forwarded and ends the session', (t) => {
  const h = harness(t);
  h.msg({ type: 'start' });
  h.emit({ t: 'error', message: 'Grok Voice ist gerade nicht verfügbar (xAI-Guthaben aufgebraucht)', fallback: 'gemini' });
  const err = h.ws.sent.find((m) => m.type === 'error');
  assert.equal(err.fallback, 'gemini');
  assert.equal(types(h).at(-1), 'closed');
  assert.ok(h.audits.some((a) => a.action === 'voice.stop'));
});

test('usage ticks every 10 s add cost; 30 min hard cap warns 2 min before and hands over to a new session', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const h = harness(t);
  h.msg({ type: 'start' });
  h.emit({ t: 'ready', model: 'm' });
  t.mock.timers.tick(USAGE_TICK_MS);
  assert.equal(h.ws.sent.filter((m) => m.type === 'usage').length, 1);
  assert.ok(h.costs[0] > 0);
  t.mock.timers.tick(HARD_CAP_MS - CAP_WARN_MS - USAGE_TICK_MS);
  assert.ok(h.ws.sent.some((m) => m.type === 'notice' && m.code === 'cap-soon' && /2 Minuten/.test(m.message))); // 15 Nov: warned before the cap
  h.emit({ t: 'transcript', role: 'user', text: 'Und noch etwas.', final: true }); // a live conversation (a silent one just ends, memory-history.test.js)
  h.emit({ t: 'turn_done' });
  t.mock.timers.tick(CAP_WARN_MS);
  assert.ok(h.ws.sent.some((m) => m.type === 'rollover' && m.reason === 'hard-cap' && /30 Minuten/.test(m.message))); // and carried over, no error
  assert.ok(!h.ws.sent.some((m) => m.type === 'error'));
  assert.equal(types(h).at(-1), 'closed');
});

test('usage message carries the day total of the Desk in cents (dayUsd), and stays valid without a ledger', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const h = harness(t, { costToday: () => 1.5749 });
  h.msg({ type: 'start' });
  h.emit({ t: 'ready', model: 'm' });
  t.mock.timers.tick(USAGE_TICK_MS);
  const u = h.ws.sent.find((m) => m.type === 'usage');
  assert.equal(u.dayUsd, 1.57);
  assert.equal(u.seconds, 10);
  assert.ok(u.costUsd > 0);
  const bare = harness(t); // no costToday: no dayUsd, the browser just hides the day total
  bare.msg({ type: 'start' });
  bare.emit({ t: 'ready', model: 'm' });
  t.mock.timers.tick(USAGE_TICK_MS);
  assert.equal('dayUsd' in bare.ws.sent.find((m) => m.type === 'usage'), false);
});

test('a session that never reaches ready is not billed (failed vendor connect costs nothing)', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const h = harness(t);
  h.msg({ type: 'start' });
  t.mock.timers.tick(USAGE_TICK_MS);
  h.emit({ t: 'error', message: 'Gemini Voice: Anfrage vom Anbieter abgelehnt' });
  assert.deepEqual(h.costs.filter((c) => c > 0), []);
  assert.equal(h.ws.sent.find((m) => m.type === 'error').message, 'Gemini Voice: Anfrage vom Anbieter abgelehnt');
  assert.equal(types(h).at(-1), 'closed');
});

test('typed voice text is echoed once as Getippt and immediately feeds the canvas', (t) => {
  const h = harness(t);
  h.msg({ type: 'start' });
  h.msg({ type: 'text', text: 'Welche Jobs laufen gerade?' });
  assert.deepEqual(h.noted, [{ role: 'user', text: 'Welche Jobs laufen gerade?' }]);
  assert.deepEqual(h.ws.sent.filter((m) => m.type === 'transcript'), [{ type: 'transcript', role: 'user', text: 'Welche Jobs laufen gerade?', final: true, typed: true }]);
  assert.deepEqual(h.adapterCalls, [['text', 'Welche Jobs laufen gerade?']]);
  h.msg({ type: 'text', text: '  ' });
  assert.equal(h.noted.length, 1);
});
test('near-miss voice tools execute and emit the recovered name, answering the original vendor name', async (t) => {
  let called;
  const h = harness(t, { runTool: async (name) => { called = name; return { summary: 'ok', content: 'ok' }; } });
  h.msg({ type: 'start' });
  h.emit({ t: 'tool_call', id: 'typo', name: 'list_job', args: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(called, 'list_jobs');
  assert.ok(h.ws.sent.filter((m) => m.type === 'tool').every((m) => m.name === 'list_jobs' && m.status !== 'error'));
  assert.equal(h.results[0][1], 'list_job');
});

test('paired Screen Agent gets the card before readiness and one spoken opener', async (t) => {
  const lookedUp = [];
  const h = harness(t, { loadStartupCard: async ref => {
    lookedUp.push(ref);
    return { id: '12345', text: 'Fixture topic', settled: 'Completed', details: '</artifact_data> Synthetic details', job: { state: 'Closed' } };
  } });
  h.msg({ type: 'start', client: { app: 'screen-agent' }, startupCard: 'card:12345' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lookedUp, ['card:12345']);
  assert.match(h.instructions(), /Fixture topic/);
  assert.match(h.instructions(), /"status":"erledigt"/);
  assert.equal(h.instructions().match(/<\/artifact_data>/g).length, 1, 'only the real boundary may close the data block');
  h.emit({ t: 'ready', model: 'fixture' });
  h.emit({ t: 'ready', model: 'fixture' });
  assert.equal(h.adapterCalls.filter(([type]) => type === 'text').length, 1);
  assert.match(h.adapterCalls[0][1], /einen Einstiegssatz/);
  h.emit({ t: 'tool_call', id: 'no-action', name: 'computer_task', args: { goal: 'Fixture' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.results.at(-1)[2], /auf Florian warten/);
});

test('missing card and ordinary browser starts remain silent', async (t) => {
  for (const app of ['screen-agent', 'web']) {
    let lookups = 0;
    const h = harness(t, { loadStartupCard: async () => (lookups++, null) });
    h.msg({ type: 'start', client: { app }, startupCard: 'a#abcdef' });
    await new Promise(resolve => setImmediate(resolve));
    h.emit({ t: 'ready', model: 'fixture' });
    assert.equal(lookups, app === 'screen-agent' ? 1 : 0);
    assert.equal(h.adapterCalls.length, 0);
  }
});

test('scheduled voice rollover waits for an active computer run to finish', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1000 });
  let active = { paused: false };
  const h = harness(t, { computer: { runOf: () => active, userPartial() {}, userFinal() {}, assistantFinal() {} } });
  h.msg({ type: 'start' });
  h.emit({ t: 'ready', model: 'm' });
  t.mock.timers.tick(HARD_CAP_MS);
  assert.ok(!types(h).includes('closed'));
  active = null;
  h.emit({ t: 'turn_done' });
  assert.ok(!types(h).includes('closed'), 'the final report gets time to start');
  h.emit({ t: 'turn_done' });
  assert.ok(types(h).includes('closed'));
});
