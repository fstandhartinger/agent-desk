import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runVoiceSession, HARD_CAP_MS, USAGE_TICK_MS } from '../src/voice/session.js';

function harness(t, { limit = { ok: true }, runTool } = {}) {
  const ws = new EventEmitter();
  ws.OPEN = 1; ws.CONNECTING = 0; ws.readyState = 1;
  ws.sent = [];
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  ws.close = () => { ws.readyState = 3; };
  const audits = [];
  const costs = [];
  const results = [];
  let emit;
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
    sid: 's1', toolDefs: [], audit: (e) => audits.push(e), makeCtx: (p) => ({ page: p }),
    limits: { check: () => limit, addCost: (c) => costs.push(c) },
    createViz: () => ({ noteTurn: (t) => noted.push(t), noteEvent: (e) => noted.push(e), close() {} }),
    runTool: runTool ?? (async () => ({ summary: 's', content: 'x'.repeat(5000) })),
  };
  runVoiceSession(ws, deps, { provider: 'gemini', apiKey: 'k', create: (_o, e) => ((emit = e), adapter) });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  t.after(() => msg({ type: 'stop' }));
  return { ws, msg, audits, costs, results, adapterCalls, noted, emit: (e) => emit(e) };
}
const types = (h) => h.ws.sent.filter((m) => !Buffer.isBuffer(m)).map((m) => m.type);

test('limit denial: error to the browser, adapter never created, no audit start', (t) => {
  const h = harness(t, { limit: { ok: false, retryAfter: 120 } });
  h.msg({ type: 'start' });
  assert.deepEqual(types(h), ['error', 'closed']);
  assert.equal(h.audits.length, 0);
});

test('tool call: start/done events, truncated to 2500 chars, result handed back, viz fed', async (t) => {
  const h = harness(t);
  h.msg({ type: 'start', page: { slug: 'a' } });
  h.emit({ t: 'ready', model: 'm' });
  h.emit({ t: 'tool_call', id: 'c1', name: 'job_status', args: { name: 'j' } });
  await new Promise((r) => setImmediate(r));
  const tools = h.ws.sent.filter((m) => m.type === 'tool');
  assert.deepEqual(tools.map((t) => t.status), ['start', 'done']);
  assert.equal(h.results[0][2].length, 2500);
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

test('usage ticks every 10 s add cost; 30 min hard cap closes the session', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const h = harness(t);
  h.msg({ type: 'start' });
  h.emit({ t: 'ready', model: 'm' });
  t.mock.timers.tick(USAGE_TICK_MS);
  assert.equal(h.ws.sent.filter((m) => m.type === 'usage').length, 1);
  assert.ok(h.costs[0] > 0);
  t.mock.timers.tick(HARD_CAP_MS);
  assert.ok(h.ws.sent.some((m) => m.type === 'error' && /30 Minuten/.test(m.message)));
  assert.equal(types(h).at(-1), 'closed');
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
