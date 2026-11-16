// Round 2 of job agent-desk-context-discovery: the Gemini answer guard through a real voice session (timer, cancel on a tool call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setEnv } from './helpers/env.js';

setEnv({});
const { runVoiceSession } = await import('../src/voice/session.js');
const { TOOL_DEFS } = await import('../src/tools.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(t, provider = 'gemini') {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], close() { this.readyState = 3; } });
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  let emit;
  const traced = [], recovered = [];
  const deps = {
    sid: 's1', toolDefs: TOOL_DEFS, audit() {}, limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }), createCanvas: () => null, runTool: async () => '{"ok":true}',
    makeCtx: () => ({ hub: {}, sid: 's1', audit() {}, trace: () => ({ event() {} }) }),
    registerText: () => () => {},
    openTrace: () => ({ event: (type, data) => traced.push({ type, ...data }), close() {} }),
  };
  const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, close() {}, sendToolResult() {}, recover: (x) => recovered.push(x) };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', mergeMs: 5, noAnswerMs: () => 60_000, create: (_o, e) => { emit = e; return adapter; } });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  msg({ type: 'start' });
  t.after(() => msg({ type: 'stop' }));
  return {
    traced, recovered, ask: (text) => msg({ type: 'text', text }),
    answer: (text) => { emit({ t: 'transcript', role: 'assistant', final: true, text }); emit({ t: 'turn_done' }); },
    call: (id, name) => emit({ t: 'tool_call', id, name, args: { query: 'x' } }),
  };
}

test('gemini: a fact answered without a lookup and without a source is checked once', async (t) => {
  const h = harness(t);
  await sleep(5);
  h.ask('Wie lange dauerte die Bewertung in der letzten Generalist-Runde?');
  h.answer('Die Bewertung dauerte gut 10 Tage und umfasste 445 GPU-Stunden.');
  await sleep(3300);
  assert.equal(h.recovered.length, 1);
  assert.match(h.recovered[0], /ohne Nachschlagen/);
  h.answer('Das stimmt, laut der Wissensnotiz zur Generalist-Runde zwei.');
  await sleep(3300);
  assert.equal(h.recovered.length, 1); // once per question
});

test('gemini: a filler followed by a tool call is not checked; a cut answer is asked to finish', async (t) => {
  const h = harness(t);
  await sleep(5);
  h.ask('Wie hoch ist das tägliche Research-GPU-Limit vom 16. bis 18. November?');
  h.answer('Ich sehe kurz nach den Limits.');
  await sleep(500);
  h.call('c1', 'search');
  await sleep(50);
  h.answer('Das tägliche Research-GPU-Limit für die Tage vom 16.');
  await sleep(3300);
  assert.equal(h.recovered.length, 1);
  assert.match(h.recovered[0], /mitten im Satz/);
});

test('other providers are not guarded', async (t) => {
  const h = harness(t, 'xai');
  await sleep(5);
  h.ask('Wie lange dauerte die Bewertung in der letzten Generalist-Runde?');
  h.answer('Die Bewertung dauerte gut 10 Tage und umfasste 445 GPU-Stunden.');
  await sleep(3300);
  assert.equal(h.recovered.filter((x) => /Nachschlagen|mitten im Satz/.test(x)).length, 0);
});
