// Live evaluation 16 Nov 2026 (job agent-desk-context-discovery-20261115, board #63616): Grok said a holding line and then nothing (q37,
// a#542918); Gemini answered late. Fixes: a digit inside a name keeps a holding line a holding line; a slow call that keeps finished results
// of the same question waiting in the batch is cut; Gemini recovers after 7 s, its answer guard checks after 1.5 s, fact answers come first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isPromiseOnly } from '../src/voice/noAnswer.js';
import { runVoiceSession, GUARD_MS, NO_ANSWER_SHIFT_MS, SIBLING_WAIT_MS } from '../src/voice/session.js';
import { buildInstructions } from '../src/voice/instructions.js';
import { ToolBatch } from '../src/voice/adapter.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a digit inside a name does not turn a holding line into an answer', () => {
  assert.equal(isPromiseOnly('Ich schaue in die Runde-2-Dateien.'), true); // a#542918, the exact line
  assert.equal(isPromiseOnly('Ich schaue in die Runde-2-Vorbereitung.'), true); // a#19bf39
  assert.equal(isPromiseOnly('Ich lese a#13554b.'), true);
  assert.equal(isPromiseOnly('Ich prüfe gpt-6.'), true);
});

test('a standalone number still makes it an answer', () => {
  assert.equal(isPromiseOnly('Ich lese 500 Dollar.'), false);
  assert.equal(isPromiseOnly('Ich sehe 2,5 Stunden.'), false);
  assert.equal(isPromiseOnly('Ich schaue nach 48 Stunden.'), false);
  assert.equal(isPromiseOnly('Ich zeichne kein Diagramm, weil es nichts zeigt.'), false); // unchanged rules
});

function harness(t, { provider = 'xai', runTool, siblingWaitMs = 40, noAnswerMs = 5000 } = {}) {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], close() { this.readyState = 3; } });
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  const traced = [], recovered = [], released = [];
  let emit;
  // like xai.js: outputs wait in a ToolBatch until every call of the response has its result
  const batch = new ToolBatch((rs) => released.push(...rs));
  const adapter = {
    sendAudio() {}, sendText() {}, interrupt() {}, close() {},
    sendToolResult: (id, name, output, opts) => batch.result({ id, name, output, stale: opts?.stale }),
    held: () => batch.results.length,
    recover: (text) => recovered.push(text),
  };
  const deps = {
    sid: 's', toolDefs: [], audit() {}, makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
    runTool,
    openTrace: () => ({ event: (type, data) => traced.push({ type, ...data }), close() {} }),
  };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', mergeMs: 5, noAnswerMs: () => noAnswerMs, siblingWaitMs, toolTimeoutMs: 400, create: (_o, e) => { emit = e; return adapter; } });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  msg({ type: 'start' });
  t.after(() => msg({ type: 'stop' }));
  return { traced, recovered, released, batch, emit: (e) => emit(e) };
}

/** q37 as it happened: holding line, two calls in one response, the first back at once, the second hanging. */
async function q37(h) {
  await sleep(1);
  h.emit({ t: 'ready', model: 'grok-voice-3.0' });
  h.emit({ t: 'transcript', role: 'user', text: 'Welchen Anteil des Kostendeckels bekommt jede Bewertungsbox im Runde-2-Runner?', final: true });
  await sleep(15);
  h.emit({ t: 'response_started', id: 'r1' });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Ich schaue in die Runde-2-Dateien.', final: false });
  h.emit({ t: 'transcript', role: 'assistant', text: 'Ich schaue in die Runde-2-Dateien.', final: true });
  h.batch.call(); h.batch.call(); // the adapter counts the calls of the response
  h.emit({ t: 'tool_call', id: 'k', name: 'knowledge_read', args: { topic: 'generalist-runde-2' }, responseId: 'r1' });
  h.emit({ t: 'tool_call', id: 's', name: 'search_files', args: { query: 'Kostendeckel Bewertungsbox' }, responseId: 'r1' });
  h.batch.responseDone();
}

test('q37: a hanging search_files no longer holds back the finished knowledge_read; both go out and the model is asked', async (t) => {
  const runTool = (name) => (name === 'search_files' ? new Promise(() => {}) : Promise.resolve({ ok: true, summary: 's', content: 'Jede Box bekommt 45 Prozent.' }));
  const h = harness(t, { runTool });
  await q37(h);
  await sleep(10);
  assert.equal(h.released.length, 0, 'held while the sibling runs');
  await sleep(80);
  const cut = h.traced.find((e) => e.type === 'tool.cut_slow');
  assert.ok(cut, 'the slow call was cut');
  assert.equal(cut.name, 'search_files');
  assert.deepEqual(h.released.map((r) => r.id).sort(), ['k', 's']);
  assert.match(h.released.find((r) => r.id === 's').output, /Abgebrochen: search_files/);
  assert.match(h.released.find((r) => r.id === 'k').output, /45 Prozent/);
});

test('a sibling that finishes in time is never cut', async (t) => {
  const runTool = (name) => (name === 'search_files' ? sleep(15).then(() => ({ ok: true, summary: 's', content: 'Treffer' })) : Promise.resolve({ ok: true, summary: 's', content: 'Wissen' }));
  const h = harness(t, { runTool, siblingWaitMs: 200 });
  await q37(h);
  await sleep(60);
  assert.equal(h.traced.filter((e) => e.type === 'tool.cut_slow').length, 0);
  assert.deepEqual(h.released.map((r) => r.output), ['Wissen', 'Treffer']);
});

test('nothing is cut once the question has an answer with content', async (t) => {
  const runTool = (name) => (name === 'search_files' ? new Promise(() => {}) : Promise.resolve({ ok: true, summary: 's', content: 'Wissen' }));
  const h = harness(t, { runTool });
  await sleep(1);
  h.emit({ t: 'ready', model: 'grok-voice-3.0' });
  h.emit({ t: 'transcript', role: 'user', text: 'Welchen Anteil bekommt jede Bewertungsbox?', final: true });
  await sleep(15);
  h.emit({ t: 'response_started', id: 'r1' });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Jede Bewertungsbox bekommt 45 Prozent des Kostendeckels, laut Wissensnotiz.', final: false });
  h.batch.call(); h.batch.call();
  h.emit({ t: 'tool_call', id: 'k', name: 'knowledge_read', args: { topic: 'x' }, responseId: 'r1' });
  h.emit({ t: 'tool_call', id: 's', name: 'search_files', args: { query: 'y' }, responseId: 'r1' });
  h.batch.responseDone();
  await sleep(100);
  assert.equal(h.traced.filter((e) => e.type === 'tool.cut_slow').length, 0);
});

test('research and action tools are never cut by the sibling rule', async (t) => {
  const runTool = (name) => (name === 'research' ? new Promise(() => {}) : Promise.resolve({ ok: true, summary: 's', content: 'Wissen' }));
  const h = harness(t, { runTool });
  await sleep(1);
  h.emit({ t: 'ready', model: 'grok-voice-3.0' });
  h.emit({ t: 'transcript', role: 'user', text: 'Wie viel hat der Vortest gekostet?', final: true });
  await sleep(15);
  h.emit({ t: 'response_started', id: 'r1' });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Ich schaue nach.', final: false });
  h.batch.call(); h.batch.call();
  h.emit({ t: 'tool_call', id: 'k', name: 'knowledge_read', args: { topic: 'x' }, responseId: 'r1' });
  h.emit({ t: 'tool_call', id: 'r', name: 'research', args: { question: 'Vortest Kosten' }, responseId: 'r1' });
  h.batch.responseDone();
  await sleep(100);
  assert.equal(h.traced.filter((e) => e.type === 'tool.cut_slow').length, 0);
});

test('Gemini: recovery after 7 s (answers start 2.5-4.8 s after the last result), guard after 1.5 s; OpenAI keeps its extra time', () => {
  assert.equal(10_000 + NO_ANSWER_SHIFT_MS.gemini, 7000);
  assert.equal(10_000 + NO_ANSWER_SHIFT_MS.openai, 12_000);
  assert.equal(NO_ANSWER_SHIFT_MS.xai ?? 0, 0);
  assert.equal(GUARD_MS, 1500);
  assert.equal(SIBLING_WAIT_MS, 5000);
});

test('Gemini gets the fact-first rule, the others do not', () => {
  const rule = /Bei einer Faktenfrage steht die Antwort .* im ERSTEN Satz/;
  assert.match(buildInstructions(null, new Date(), { provider: 'gemini' }), rule);
  assert.doesNotMatch(buildInstructions(null, new Date(), { provider: 'xai' }), rule);
  assert.doesNotMatch(buildInstructions(null, new Date(), { provider: 'openai' }), rule);
});
