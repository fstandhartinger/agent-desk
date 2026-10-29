// Round 8: Gemini's research loop is capped, the early illustrator's facts reach the voice adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runVoiceSession } from '../src/voice/session.js';

function harness(t, provider = 'gemini', { createCanvas } = {}) {
  const ws = new EventEmitter();
  ws.OPEN = 1; ws.CONNECTING = 0; ws.readyState = 1;
  ws.sent = [];
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  ws.close = () => { ws.readyState = 3; };
  const results = [];
  const ran = [];
  const context = [];
  let emit;
  let options;
  const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, sendToolResult: (...a) => results.push(a), addContext: (x) => context.push(x), close() {} };
  const deps = {
    sid: 's1', toolDefs: [], audit() {}, makeCtx: (p) => ({ page: p }),
    limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
    runTool: async (name) => { ran.push(name); return { summary: 's', content: 'ok' }; },
    createCanvas,
  };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', create: (o, e) => ((options = o), (emit = e), adapter) });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  t.after(() => msg({ type: 'stop' }));
  return { msg, results, ran, context, emit: (e) => emit(e), options: () => options };
}
const tick = () => new Promise((r) => setImmediate(r));

test('Gemini: after 3 research tools in one turn the 4th is not run and the model is told to answer in German; drawing tools do not count; a new turn resets (r10: cap 5 -> 3)', async (t) => {
  const h = harness(t);
  h.msg({ type: 'start' });
  h.emit({ t: 'ready', model: 'm' });
  h.emit({ t: 'speech_started' });
  for (let i = 1; i <= 7; i += 1) h.emit({ t: 'tool_call', id: `c${i}`, name: i === 3 ? 'canvas_draw' : 'search_files', args: {} });
  await tick();
  assert.deepEqual(h.ran, ['search_files', 'search_files', 'canvas_draw', 'search_files'], '3 research tools + 1 draw ran');
  assert.equal(h.results.length, 7);
  const capped = h.results.filter((r) => /Recherche-Limit erreicht \(3 Werkzeuge pro Frage\): keine weiteren Werkzeuge\. Antworte Florian jetzt auf Deutsch/.test(r[2]));
  assert.deepEqual(capped.map((r) => r[0]), ['c5', 'c6', 'c7']);
  h.emit({ t: 'speech_started' });
  h.emit({ t: 'tool_call', id: 'n1', name: 'search_files', args: {} });
  await tick();
  assert.equal(h.ran.length, 5);
});

test('other providers have no cap', async (t) => {
  const h = harness(t, 'xai');
  h.msg({ type: 'start' });
  for (let i = 1; i <= 8; i += 1) h.emit({ t: 'tool_call', id: `c${i}`, name: 'search_files', args: {} });
  await tick();
  assert.equal(h.ran.length, 8);
});

test('the canvas session gets an onFacts hook that feeds the adapter (GPT-Live), and the OpenAI instructions carry the research rule', async (t) => {
  let hook;
  const h = harness(t, 'openai', { createCanvas: ({ onFacts }) => { hook = onFacts; return null; } });
  h.msg({ type: 'start' });
  hook('### knowledge_read\nFakt');
  assert.deepEqual(h.context, ['### knowledge_read\nFakt']);
  assert.match(h.options().instructions, /NIE eine Rückfrage/);
});
