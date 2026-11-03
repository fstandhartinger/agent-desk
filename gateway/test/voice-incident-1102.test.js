// Incident 2 Nov 13:21Z, session inbound-people-20261102-n5bj31qg3v (GPT-Live): the barge-in into the greeting made the tool call of the NEW
// question stale, the stale output went out without response.create, and nothing ever recovered it. Exact log sequence, fake adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runVoiceSession } from '../src/voice/session.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function harness(t, { provider = 'openai', runTool, noAnswerMs = 40 } = {}) {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], close() { this.readyState = 3; } });
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  const results = [], recovered = [], audits = [], traced = [], audio = [];
  let emit;
  const adapter = {
    sendAudio: (b) => audio.push(b.length), sendText() {}, interrupt() {}, close() {},
    sendToolResult: (id, name, output, opts) => results.push({ id, name, output, stale: opts?.stale ?? false }),
    recover: (text) => recovered.push(text),
  };
  const deps = {
    sid: 's', toolDefs: [], audit: (e) => audits.push(e), makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
    runTool: runTool ?? (async () => ({ ok: true, summary: 's', content: 'Wissen zu TNG' })),
    openTrace: () => ({ event: (type, data) => traced.push({ type, ...data }), close() {} }),
  };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', mergeMs: 5, noAnswerMs: () => noAnswerMs, create: (_o, e) => { emit = e; return adapter; } });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  msg({ type: 'start' });
  t.after(() => msg({ type: 'stop' }));
  return { ws, msg, results, recovered, audits, traced, audio, emit: (e) => emit(e), bin: (b) => ws.emit('message', b, true) };
}

test('the logged sequence: barge-in into the greeting, then the new question\'s tool call -> delivered with a response, never stale', async (t) => {
  const h = harness(t, { noAnswerMs: 5000 });
  await sleep(1);
  h.emit({ t: 'ready', model: 'gpt-live-1' });
  h.emit({ t: 'response_started', id: 'greeting' });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Hallo Florian, wie kann ich ', final: false });
  h.emit({ t: 'transcript', role: 'user', delta: 'Was steht in der neuesten Mail von TNG', final: false }); // 13:21:45 voice.barge_in
  h.emit({ t: 'tool_call', id: 'call_tng', name: 'knowledge_read', args: { topic: 'TNG' }, responseId: 'greeting' }); // 13:21:51
  await sleep(10);
  assert.ok(h.audits.some((a) => a.action === 'voice.barge_in'));
  assert.ok(!h.audits.some((a) => a.action === 'voice.tool.stale'), 'the call of the current question must not be declared stale');
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].stale, false, 'the result must ask for a response');
});

const ask = (h, text = 'Was steht in der neuesten Mail von TNG') => h.emit({ t: 'transcript', role: 'user', delta: text, final: false });

test('a call from a response that started after the barge-in is current, whatever its arguments say', async (t) => {
  const h = harness(t, { noAnswerMs: 5000 });
  await sleep(1);
  h.emit({ t: 'ready', model: 'm' });
  h.emit({ t: 'transcript', role: 'user', text: 'Erste Frage zu Kosten', final: true });
  h.emit({ t: 'response_started', id: 'r1' });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Moment', final: false });
  ask(h);
  h.emit({ t: 'response_started', id: 'r2' });
  h.emit({ t: 'tool_call', id: 'c', name: 'read_file', args: { path: 'Kosten.md' }, responseId: 'r2' });
  await sleep(10);
  assert.equal(h.results[0].stale, false);
});

test('a call of the overtaken response that demonstrably fits the previous question stays stale; one that fits the new question does not', async (t) => {
  for (const [id, args, stale] of [['old', { query: 'Kosten Oktober' }, true], ['new', { query: 'TNG' }, false]]) {
    const h = harness(t, { noAnswerMs: 5000 });
    await sleep(1);
    h.emit({ t: 'ready', model: 'm' });
    h.emit({ t: 'transcript', role: 'user', text: 'Wie hoch sind die Kosten im Oktober?', final: true });
    await sleep(10);
    h.emit({ t: 'response_started', id: 'r1' });
    h.emit({ t: 'transcript', role: 'assistant', delta: 'Moment', final: false });
    ask(h);
    h.emit({ t: 'tool_call', id, name: 'search_files', args, responseId: 'r1' });
    await sleep(10);
    assert.equal(h.results[0].stale, stale, id);
  }
});

test('silence after a question: the watchdog recovers, says so in the trace, gives up after two tries with a visible notice', async (t) => {
  const h = harness(t, { noAnswerMs: 20 });
  await sleep(1);
  h.emit({ t: 'ready', model: 'm' });
  ask(h);
  await sleep(90);
  assert.equal(h.recovered.length, 2);
  assert.match(h.recovered[0], /Was steht in der neuesten Mail von TNG/);
  assert.match(h.recovered[0], /mail_search/);
  assert.deepEqual(h.traced.filter((e) => e.type === 'watchdog.no_answer').map((e) => [e.reason, e.n]), [['silent', 1], ['silent', 2]]);
  assert.ok(h.traced.some((e) => e.type === 'turn.unanswered'));
  assert.ok(h.ws.sent.some((m) => m.type === 'notice' && m.code === 'no-answer'));
});

test('a spoken promise with no tool following is recovered: the logged sentence, cut off', async (t) => {
  const h = harness(t, { noAnswerMs: 20 });
  await sleep(1);
  h.emit({ t: 'ready', model: 'm' });
  ask(h, 'Hallo, wieso kommt keine Antwort');
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Ich habe deine Frage jetzt verstanden. Ich schaue sofort, was in der neuesten Mail von TNG', final: false });
  await sleep(35);
  assert.equal(h.recovered.length, 1);
  assert.deepEqual(h.traced.find((e) => e.type === 'watchdog.no_answer').reason, 'promise');
});

test('a real answer, a running tool and plain acknowledgements do not fire the watchdog', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = harness(t, { noAnswerMs: 15, runTool: async () => { await gate; return { ok: true, content: 'x' }; } });
  await sleep(1);
  a.emit({ t: 'ready', model: 'm' });
  ask(a);
  a.emit({ t: 'tool_call', id: 'c', name: 'mail_search', args: { query: 'TNG' } });
  await sleep(50);
  assert.equal(a.recovered.length, 0, 'the tool still runs');
  release();
  await sleep(1);
  a.emit({ t: 'transcript', role: 'assistant', delta: 'Die neueste Mail von TNG kam von Benjamin Merkel am zweiten November.', final: false });
  await sleep(40);
  assert.equal(a.recovered.length, 0, 'answered');

  const b = harness(t, { noAnswerMs: 15 });
  await sleep(1);
  b.emit({ t: 'ready', model: 'm' });
  b.emit({ t: 'transcript', role: 'user', text: 'Danke.', final: true });
  await sleep(40);
  assert.equal(b.recovered.length, 0);
});

test('after a barge-in into the greeting a direct answer in word deltas settles the question: no recovery, no false notice (critic M2)', async (t) => {
  const h = harness(t, { noAnswerMs: 15 });
  await sleep(1);
  h.emit({ t: 'ready', model: 'm' });
  h.emit({ t: 'response_started', id: 'greeting' });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Hallo Florian. ', final: false });
  ask(h, 'Wie spät ist es eigentlich');
  h.emit({ t: 'turn_done', id: 'greeting' });
  for (const w of ['Es ', 'ist ', 'halb ', 'drei ', 'am ', 'Nachmittag, ', 'also ', 'noch ', 'genug ', 'Zeit ', 'für ', 'den ', 'Rest ', 'von ', 'heute.']) h.emit({ t: 'transcript', role: 'assistant', delta: w, final: false });
  await sleep(50);
  assert.equal(h.recovered.length, 0);
  assert.ok(!h.ws.sent.some((m) => m.type === 'notice'));
});

test('recovery carries the facts already found, and a knowledge_read for a mail question is pointed at mail_search', async (t) => {
  const h = harness(t, { noAnswerMs: 20 });
  await sleep(1);
  h.emit({ t: 'ready', model: 'm' });
  ask(h);
  h.emit({ t: 'tool_call', id: 'c', name: 'knowledge_read', args: { topic: 'TNG' } });
  await sleep(5);
  assert.match(h.results[0].output, /mail_search/);
  await sleep(30);
  assert.match(h.recovered[0], /Wissen zu TNG/);
});

test('mute: no frame reaches the vendor, no barge-in, no remark, no recovery of a half sentence; unmute changes nothing else', async (t) => {
  const h = harness(t, { noAnswerMs: 15 });
  await sleep(1);
  h.emit({ t: 'ready', model: 'm' });
  h.bin(Buffer.alloc(480));
  assert.equal(h.audio.length, 1);
  ask(h, 'Was steht in der');
  h.msg({ type: 'mute', muted: true, source: 'dock' });
  h.bin(Buffer.alloc(480));
  assert.equal(h.audio.length, 1, 'a frame still in flight is dropped');
  await sleep(40);
  assert.equal(h.recovered.length, 0);
  h.msg({ type: 'mute', muted: false });
  await sleep(40);
  assert.equal(h.recovered.length, 0, 'unmute triggers no reply');
  h.bin(Buffer.alloc(480));
  assert.equal(h.audio.length, 2, 'same session goes on');
  assert.deepEqual(h.traced.filter((e) => e.type.startsWith('mic.')).map((e) => e.type), ['mic.mute', 'mic.unmute']);
  assert.deepEqual(h.ws.sent.filter((m) => m.type === 'mute').map((m) => m.muted), [true, false]);
  assert.ok(!h.audits.some((a) => a.action === 'voice.barge_in'));
});

test('GPT-Live keeps speaking the old answer after the barge-in: that text settles nothing, the question still gets its recovery', async (t) => {
  const h = harness(t, { noAnswerMs: 15 });
  await sleep(1);
  h.emit({ t: 'ready', model: 'm' });
  h.emit({ t: 'response_started', id: 'old' });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Hallo Florian, schön dass du da bist. ', final: false });
  ask(h);
  await sleep(5);
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Heute gibt es einiges Neues zu berichten, wie zum Beispiel Sonnenschein und gutes Wetter in Passau. ', final: false });
  await sleep(60);
  assert.ok(h.recovered.length >= 1);
});

test('fix-desk M3: a started drawing answers "zeichne das"; a question that needs words is still recovered', async (t) => {
  const draw = async () => ({ ok: true, summary: 's', content: JSON.stringify({ ok: true, id: 'x', status: 'zeichne' }) });
  const a = harness(t, { noAnswerMs: 20, runTool: draw });
  await sleep(1);
  a.emit({ t: 'ready', model: 'm' });
  ask(a, 'Zeichne mir den Ablauf der Freigabe auf');
  a.emit({ t: 'tool_call', id: 'c', name: 'canvas_draw', args: { kind: 'flow', text: 'x' } });
  await sleep(60);
  assert.equal(a.recovered.length, 0, 'the drawing is the answer');
  assert.ok(a.traced.some((e) => e.type === 'watchdog.settled' && e.reason === 'drawing'));
  const b = harness(t, { noAnswerMs: 20, runTool: draw });
  await sleep(1);
  b.emit({ t: 'ready', model: 'm' });
  ask(b, 'Erkläre mir bitte die Freigabe von Reax 1.3');
  b.emit({ t: 'tool_call', id: 'c', name: 'canvas_draw', args: { kind: 'flow', text: 'x' } });
  await sleep(60);
  assert.ok(b.recovered.length >= 1, 'words were asked for');
});
