// Round 10 (critic r9 F4): a voice model that stays silent after its tool results is asked again; Gemini gets the language
// reminder and the early illustrator's facts with its next tool result. Fake vendor sockets, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { setEnv } from './helpers/env.js';

setEnv({});
const { TOOL_DEFS } = await import('../src/tools.js');
const { createOpenAI } = await import('../src/voice/openai.js');
const { createXai } = await import('../src/voice/xai.js');
const { createGemini, LANGUAGE_HINT } = await import('../src/voice/gemini.js');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function vendor(t) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const received = [];
  let sock = null;
  wss.on('connection', (ws) => { sock = ws; ws.on('message', (d) => received.push(JSON.parse(d.toString()))); });
  t.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
  return { url: `ws://127.0.0.1:${wss.address().port}`, received, send: (obj) => sock.send(JSON.stringify(obj)) };
}
const creates = (v) => v.received.filter((m) => m.type === 'response.create').length;

test('openai: no assistant audio within the watchdog time after the tool results -> response.create again (at most twice), audio stops it', async (t) => {
  const v = await vendor(t);
  const events = [];
  const a = createOpenAI({ apiKey: 'k', instructions: 'x', tools: TOOL_DEFS, url: v.url, watchdogMs: () => 60 }, (e) => events.push(e));
  await tick(100);
  v.send({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'desk_status', arguments: '{}' } } });
  v.send({ type: 'response.event', event: { type: 'response.completed' } });
  await tick();
  a.sendToolResult('c1', 'desk_status', '{"ok":true}');
  await tick(20);
  assert.equal(creates(v), 1, 'the normal response.create after the outputs');
  await tick(250);
  assert.equal(creates(v), 3, 'two retries, then it stops');
  assert.deepEqual(events.filter((e) => e.t === 'watchdog').map((e) => e.n), [1, 2]);

  // a second round: audio arrives in time -> no retry
  v.send({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c2', name: 'ledger_spend', arguments: '{}' } } });
  v.send({ type: 'response.event', event: { type: 'response.completed' } });
  await tick();
  a.sendToolResult('c2', 'ledger_spend', '{}');
  await tick(20);
  v.send({ type: 'session.output_audio.delta', delta: Buffer.from([1, 0]).toString('base64') });
  await tick(150);
  assert.equal(creates(v), 4);
  a.close();
});

test('xai: the same watchdog after released tool results', async (t) => {
  const v = await vendor(t);
  const events = [];
  const a = createXai({ apiKey: 'k', instructions: 'x', tools: TOOL_DEFS, url: v.url, watchdogMs: () => 60 }, (e) => events.push(e));
  await tick(100);
  v.send({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'knowledge_read', arguments: '{}' });
  v.send({ type: 'response.done' });
  await tick();
  a.sendToolResult('c1', 'knowledge_read', 'x');
  await tick(100);
  assert.equal(creates(v), 2);
  assert.equal(events.filter((e) => e.t === 'watchdog').length, 1);
  a.close();
});

test('gemini: language reminder in every result, early facts ride along once, a silent model gets one German nudge', async (t) => {
  const v = await vendor(t);
  const events = [];
  const a = createGemini({ apiKey: 'k', instructions: 'x', tools: TOOL_DEFS, url: v.url, watchdogMs: () => 60 }, (e) => events.push(e));
  await tick(100);
  // round 12: the facts ride along when a tool call of the question is open (without one they go out at once: voice-r12)
  v.send({ toolCall: { functionCalls: [{ id: 'g1', name: 'search_files', args: {} }, { id: 'g2', name: 'read_file', args: {} }] } });
  await tick();
  a.addContext('### knowledge_read\nnotify --video verlangt einen Seitenlink.');
  a.sendToolResult('g1', 'search_files', 'a');
  a.sendToolResult('g2', 'read_file', 'b');
  await tick(10);
  const responses = v.received.filter((m) => m.toolResponse).map((m) => m.toolResponse.functionResponses[0].response);
  assert.equal(responses[0].hinweis, LANGUAGE_HINT);
  assert.match(responses[0].result, /DESK-FAKTEN[\s\S]*Seitenlink/); // round 12: inside the result text, like GPT-Live
  assert.doesNotMatch(responses[1].result, /DESK-FAKTEN/, 'facts are handed over once');
  await tick(150);
  const nudges = v.received.filter((m) => m.realtimeInput?.text);
  assert.equal(nudges.length, 1);
  assert.match(nudges[0].realtimeInput.text, /Beantworte jetzt Florians letzte Frage kurz auf Deutsch/);
  assert.deepEqual(events.filter((e) => e.t === 'watchdog').map((e) => e.n), [1]);
  // Gemini speaks in time -> no nudge
  a.sendToolResult('g3', 'search_files', 'c');
  await tick(10);
  v.send({ serverContent: { outputTranscription: { text: 'Die Sperre prüft' } } });
  await tick(120);
  assert.equal(v.received.filter((m) => m.realtimeInput?.text).length, 1);
  a.close();
});

test('the voice session audits the watchdog and tells the adapter about a new user turn', async () => {
  const { runVoiceSession } = await import('../src/voice/session.js');
  const { EventEmitter } = await import('node:events');
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send() {}, close() {} });
  const audits = [];
  let emit;
  let turns = 0;
  const deps = { runTool: async () => ({ ok: true, content: '' }), makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} }, audit: (a) => audits.push(a), toolDefs: [], sid: 's', createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }) };
  runVoiceSession(ws, deps, { provider: 'gemini', apiKey: 'k', create: (_o, e) => { emit = e; return { sendAudio() {}, sendText() {}, interrupt() {}, newTurn: () => { turns += 1; }, sendToolResult() {}, close() {} }; } });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'start' })), false);
  emit({ t: 'ready', model: 'm' });
  emit({ t: 'speech_started' });
  emit({ t: 'watchdog', n: 1 });
  assert.equal(turns, 1);
  assert.ok(audits.some((a) => a.action === 'voice.watchdog' && a.detail === 'gemini #1'));
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'stop' })), false);
});

test('r10 live: a barge-in while GPT-Live is still SPEAKING a finished answer does not make the next question\'s tool calls stale; an open response still does', async () => {
  const { runVoiceSession } = await import('../src/voice/session.js');
  const { EventEmitter } = await import('node:events');
  const run = () => {
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send() {}, close() {} });
    const results = [];
    let emit;
    const deps = { runTool: async () => ({ ok: true, content: 'x' }), makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} }, audit: () => {}, toolDefs: [], sid: 's', createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }) };
    runVoiceSession(ws, deps, { provider: 'openai', apiKey: 'k', mergeMs: 20, create: (_o, e) => { emit = e; return { sendAudio() {}, sendText() {}, interrupt() {}, sendToolResult: (id, _n, _o2, opts) => results.push([id, opts?.stale ?? false]), close() {} }; } });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'start' })), false);
    return { emit: (e) => emit(e), results, stop: () => ws.emit('message', Buffer.from(JSON.stringify({ type: 'stop' })), false) };
  };
  // q1's backend response completed, the live model is still talking when q3 comes
  const a = run();
  a.emit({ t: 'ready', model: 'gpt-live-1' });
  a.emit({ t: 'response_started' });
  a.emit({ t: 'tool_call', id: 'q1', name: 'knowledge_read', args: {} });
  await tick(10);
  a.emit({ t: 'turn_done' });
  a.emit({ t: 'transcript', role: 'assistant', delta: 'Seit dem 24.10. lehnt notify ', final: false });
  a.emit({ t: 'transcript', role: 'user', delta: 'Wofür geben wir das Geld aus', final: false });
  a.emit({ t: 'transcript', role: 'user', text: 'Wofür geben wir das Geld aus', final: true });
  a.emit({ t: 'response_started' });
  a.emit({ t: 'tool_call', id: 'q3', name: 'ledger_spend', args: {} });
  await tick(30);
  assert.deepEqual(a.results, [['q1', false], ['q3', false]]);
  a.stop();
  // the old backend response is still open: its next call belongs to the old question
  const b = run();
  b.emit({ t: 'ready', model: 'gpt-live-1' });
  b.emit({ t: 'response_started' });
  b.emit({ t: 'transcript', role: 'assistant', delta: 'Moment', final: false });
  b.emit({ t: 'transcript', role: 'user', text: 'Neue Frage?', final: true });
  b.emit({ t: 'tool_call', id: 'old', name: 'read_file', args: {} });
  await tick(30);
  assert.deepEqual(b.results, [['old', true]]);
  b.stop();
});

test('openai: the early facts never go out as a separate message during a delegation; they ride along with the next tool output', async (t) => {
  const v = await vendor(t);
  const a = createOpenAI({ apiKey: 'k', instructions: 'x', tools: TOOL_DEFS, url: v.url, watchdogMs: () => 5000 }, () => {});
  await tick(100);
  a.addContext('### ledger_spend\nGPU: 700,00 €');
  await tick(20);
  assert.equal(v.received.filter((m) => m.item?.type === 'message').length, 0);
  v.send({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'ledger_spend', arguments: '{}' } } });
  v.send({ type: 'response.event', event: { type: 'response.completed' } });
  await tick();
  a.sendToolResult('c1', 'ledger_spend', '{"count":2}');
  await tick(20);
  const out = v.received.find((m) => m.item?.type === 'function_call_output');
  assert.match(out.item.output, /^\{"count":2\}\n\n=== DESK-FAKTEN zur aktuellen Frage[\s\S]*GPU: 700,00 €/);
  a.close();
});

test('a voice session with deps.prewarm warms the bridge ledger cache once at start (round 10: cold ledger read cost ~3 s of the first answer)', async () => {
  const { runVoiceSession } = await import('../src/voice/session.js');
  const { EventEmitter } = await import('node:events');
  const ran = [];
  for (const prewarm of [true, undefined]) {
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send() {}, close() {} });
    const deps = { runTool: async (name, args) => { ran.push([prewarm, name, args.groupBy]); return { ok: true, content: '' }; }, makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} }, audit: () => {}, toolDefs: [], sid: 's', createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }), prewarm };
    runVoiceSession(ws, deps, { provider: 'openai', apiKey: 'k', create: () => ({ sendAudio() {}, sendText() {}, interrupt() {}, sendToolResult() {}, close() {} }) });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'start' })), false);
    await tick(10);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stop' })), false);
  }
  assert.deepEqual(ran, [[true, 'ledger_spend', 'category']]);
});
