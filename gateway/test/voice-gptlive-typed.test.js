// Fix 28 Oct (live: a GPT-Live answer shown twice - "…bekommen.Okay." and then a "Gesprochen" copy of the same answer): in a
// typed turn the delegation backend answers in text AND the live model speaks it (after a filler). The browser sees ONE
// assistant message per turn. Scripted OpenAI event sequences, a fake Live socket, synthetic text only.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_VOICE_WATCHDOG_MS: '60000' });
const { createOpenAI, startTypedTurn, translate } = await import('../src/voice/openai.js');
const { runVoiceSession } = await import('../src/voice/session.js');

const backend = (event) => ({ type: 'response.event', delegation_id: 'd1', event });
const spoken = (delta) => ({ type: 'session.output_transcript.delta', delta });
const ANSWER = 'Das hatte zwei Gründe: Der Abruf scheiterte, und das Zeitfenster war schon vorbei.';
const SPOKEN = ['Das hatte ', 'zwei Gründe. ', 'Der Abruf scheiterte, ', 'und das Zeitfenster ', 'war schon vorbei.'];
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A fake Live socket: answers each `response.create` with the next scripted batch of server events. */
async function fakeLive(t, script) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const received = [];
  wss.on('connection', (sock) => sock.on('message', (d) => {
    const m = JSON.parse(d.toString());
    received.push(m);
    const send = (o) => sock.send(JSON.stringify(o));
    if (m.type === 'session.start') send({ type: 'session.started', session: { model: 'gpt-live-1' } });
    if (m.type === 'response.create') for (const ev of script.shift() ?? []) send(ev);
  }));
  t.after(() => wss.close());
  return { url: `ws://127.0.0.1:${wss.address().port}`, received };
}

/** The real session + the real OpenAI adapter against the fake socket; returns the browser's messages. */
function browserSession(t, url) {
  const ws = new EventEmitter();
  Object.assign(ws, { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], send: (d) => { if (typeof d === 'string') ws.sent.push(JSON.parse(d)); }, close: () => { ws.readyState = 3; } });
  const deps = {
    sid: 's', toolDefs: [{ name: 'job_status', description: 'x', parameters: { type: 'object', properties: {} } }], audit: () => {},
    runTool: async () => ({ ok: true, summary: 's', content: 'Status: synthetisch' }), makeCtx: (page) => ({ page }),
    limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
  };
  runVoiceSession(ws, deps, { provider: 'openai', apiKey: 'k', create: (o, e) => createOpenAI({ ...o, url }, e) });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  t.after(() => msg({ type: 'stop' }));
  msg({ type: 'start' });
  return { msg, sent: ws.sent };
}

/** The assistant messages as the browser builds them (voiceController: deltas append, a final closes the bubble). */
function assistantBubbles(sent) {
  const bubbles = [];
  let open = null;
  for (const m of sent) {
    if (m.type !== 'transcript') continue;
    if (m.role === 'user') { open = null; continue; }
    if (!open) bubbles.push((open = { text: '' }));
    if (m.delta !== undefined) open.text += m.delta; else if (m.text) open.text = m.text;
    if (m.final) open = null;
  }
  return bubbles.map((b) => b.text);
}

test('the live sequence: filler, a tool round, the backend text, then the spoken copy -> one assistant message', async (t) => {
  const live = await fakeLive(t, [
    [spoken('Okay.'), backend({ type: 'response.created' }), backend({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'job_status', arguments: '{}' } }), backend({ type: 'response.completed' })],
    [backend({ type: 'response.created' }), backend({ type: 'response.output_text.done', text: ANSWER }), backend({ type: 'response.completed' }), ...SPOKEN.map(spoken)],
  ]);
  const b = browserSession(t, live.url);
  await tick(150);
  b.msg({ type: 'text', text: 'Warum ging das schief?' });
  await tick(300);
  assert.ok(live.received.some((m) => m.type === 'response.item.create' && m.item.type === 'function_call_output'), 'the tool round ran');
  assert.deepEqual(assistantBubbles(b.sent), [ANSWER]);
  assert.ok(!b.sent.some((m) => m.type === 'transcript' && m.role === 'assistant' && /Okay/.test(m.delta ?? m.text ?? '')), 'no glued filler');
});

test('the backend finishes without text: the spoken transcript is the one message (the held filler included)', async (t) => {
  const live = await fakeLive(t, [
    [spoken('Okay. '), backend({ type: 'response.created' }), backend({ type: 'response.completed' }), ...SPOKEN.map(spoken), { type: 'input_audio_buffer.speech_started' }],
  ]);
  const b = browserSession(t, live.url);
  await tick(150);
  b.msg({ type: 'text', text: 'Warum ging das schief?' });
  await tick(300);
  assert.deepEqual(assistantBubbles(b.sent), [`Okay. ${SPOKEN.join('')}`]);
});

test('translate: several backend texts in one typed turn join into one message; speech after it is not shown', () => {
  const state = {};
  startTypedTurn(state);
  assert.deepEqual(translate(spoken('Okay.'), state), []);
  translate(backend({ type: 'response.created' }), state);
  translate(backend({ type: 'response.output_text.done', text: 'Erst das.' }), state);
  const call = translate(backend({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c', name: 'job_status', arguments: '{}' } }), state);
  assert.equal(call[0].t, 'tool_call');
  assert.deepEqual(translate(backend({ type: 'response.completed' }), state), [{ t: 'turn_done' }], 'a response with a tool call is not the end');
  translate(backend({ type: 'response.created' }), state);
  translate(backend({ type: 'response.output_text.done', text: 'Dann das.' }), state);
  assert.deepEqual(translate(backend({ type: 'response.completed' }), state), [{ t: 'transcript', role: 'assistant', text: 'Erst das. Dann das.', final: true }, { t: 'turn_done' }]);
  assert.deepEqual(translate(spoken('Erst das. '), state), []);
  // the next spoken question: the live model's transcript is shown again as before (spoken turns are unchanged)
  translate({ type: 'session.input_transcript.delta', delta: 'Und?' }, state);
  assert.deepEqual(translate(spoken('Gut.'), state), [{ t: 'transcript', role: 'assistant', delta: 'Gut.', final: false }]);
});

test('spoken turns are unchanged: transcript deltas pass at once, backend text is ignored', () => {
  const state = {};
  assert.deepEqual(translate(spoken('Hallo'), state), [{ t: 'transcript', role: 'assistant', delta: 'Hallo', final: false }]);
  assert.deepEqual(translate(backend({ type: 'response.output_text.done', text: 'Hallo' }), state), []);
  assert.deepEqual(translate(backend({ type: 'response.completed' }), state), [{ t: 'turn_done' }]);
});
