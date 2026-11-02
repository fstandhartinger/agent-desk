// Trace a#7f54a5 t5-t7: "Nein, wir nehmen ... weil wir" came as three growing finals, each a turn with a response. Replay of the exact vendor frames
// through the xAI adapter's translate and the voice session; plus the marker turn and the harmless "Item not found" of the screen context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setEnv } from './helpers/env.js';

setEnv({});
const { runVoiceSession } = await import('../src/voice/session.js');
const { translate } = await import('../src/voice/xai.js');
const { localDiagnosis } = await import('../src/trace.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T5 = 'Nein, wir nehmen dieses Protokoll jetzt auf, weil wir';
const T6 = 'Nein, wir nehmen dieses Protokoll jetzt auf, weil wir eine Fehlerbehebung vornehmen müssen, damit all diese';
const T7 = 'Nein, wir nehmen dieses Protokoll jetzt auf, weil wir eine Fehlerbehebung vornehmen müssen, damit all diese Dinge besser funktionieren in Zukunft.';

function harness(t, { provider = 'xai', noAnswerMs = 5000, canvas } = {}) {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], close() { this.readyState = 3; } });
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  const results = [], traced = [], texts = [], interrupts = [], recovered = [], noted = [], registered = [];
  let emit;
  const state = {};
  const adapter = {
    sendAudio() {}, sendText: (x) => texts.push(x), interrupt: () => interrupts.push(1), close() {},
    sendToolResult: (id, name, output, opts) => results.push({ id, name, output, stale: opts?.stale ?? false }),
    recover: (x) => recovered.push(x),
  };
  const deps = {
    sid: 's', toolDefs: [], audit() {}, makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn: (x) => noted.push(['viz', x]), noteEvent() {}, close() {} }),
    createCanvas: () => canvas ?? null,
    runTool: async () => ({ ok: true, summary: 's', content: 'Ergebnis' }),
    registerText: (fn) => { registered.push(fn); return () => {}; },
    openTrace: () => ({ event: (type, data) => traced.push({ type, ...data }), close() {} }),
  };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', mergeMs: 5, noAnswerMs: () => noAnswerMs, create: (_o, e) => { emit = e; return adapter; } });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  msg({ type: 'start' });
  t.after(() => msg({ type: 'stop' }));
  // vendor frame -> normalised events -> session
  const vendor = (frame) => translate(frame, state).forEach((e) => emit(e));
  return { ws, msg, results, traced, texts, interrupts, recovered, noted, registered, emit: (e) => emit(e), vendor };
}
const final = (item_id, transcript) => ({ type: 'conversation.item.input_audio_transcription.updated', item_id, transcript });
const users = (h) => h.ws.sent.filter((m) => m.type === 'transcript' && m.role === 'user');

for (const [name, ids] of [['a new item per fragment (prefix growth)', ['i5', 'i6', 'i7']], ['one item growing', ['i5', 'i5', 'i5']]]) {
  test(`replay t5-t7, ${name}: one turn, the browser message replaced, the shorter answers cut, one watchdog on the whole sentence`, async (t) => {
    const h = harness(t);
    await sleep(1);
    h.vendor({ type: 'session.updated' });
    h.vendor(final(ids[0], T5));
    await sleep(20); // mergeMs passed: the fragment is committed
    h.vendor({ type: 'response.created', response: { id: 'r5' } });
    h.vendor({ type: 'input_audio_buffer.speech_started' });
    h.vendor(final(ids[1], T6));
    await sleep(20);
    h.vendor({ type: 'response.created', response: { id: 'r6' } });
    h.vendor({ type: 'response.function_call_arguments.done', call_id: 'c6', name: 'knowledge_read', arguments: '{"topic":"Protokoll"}', response_id: 'r5' });
    h.vendor(final(ids[2], T7));
    await sleep(30);
    const starts = h.traced.filter((e) => e.type === 'turn.user.start');
    assert.equal(starts.length, 1, 'no new turn.user.start for a grown fragment');
    const grown = h.traced.filter((e) => e.type === 'turn.user.grown');
    assert.deepEqual(grown.map((e) => [e.turn, e.text]), [[starts[0].turn, T5], [starts[0].turn, T6]], 'superseded fragments are named');
    assert.deepEqual(grown.map((e) => e.into), [T6, T7]);
    const finals = h.traced.filter((e) => e.type === 'transcript.user.final');
    assert(finals.every((e) => e.turn === starts[0].turn)); assert.equal(finals.at(-1).text, T7);
    const sent = users(h);
    assert.deepEqual(sent.map((m) => !!m.replace), [false, true, true], 'the browser replaces the message');
    assert.equal(sent.at(-1).text, T7);
    assert(h.interrupts.length >= 1, 'the response of the shorter fragment is a normal barge-in');
    const stale = h.traced.filter((e) => e.type === 'tool.stale');
    assert.equal(stale.length, 1); assert.equal(stale[0].reason, 'fragment superseded');
    assert.equal(h.results[0].stale, true, 'the fragment answer\'s tool call is stale');
    assert.equal(h.traced.filter((e) => e.type === 'turn.unanswered').length, 0);
    // the diagnosis raises no flag for the superseded fragments
    assert.equal(localDiagnosis(h.traced.map((e) => ({ type: e.type, turn: e.turn, data: e }))), 'Keine Auffälligkeiten im Verlauf.');
  });
}

test('a fragment that is still collecting (no commit yet) is replaced, not glued: the question reaches the watchdog once, whole', async (t) => {
  const h = harness(t, { noAnswerMs: 15 });
  await sleep(1);
  h.vendor({ type: 'session.updated' });
  h.vendor(final('i5', T5));
  h.vendor(final('i6', T6)); // within mergeMs: still collecting
  h.vendor(final('i7', T7));
  await sleep(60);
  assert.equal(h.traced.filter((e) => e.type === 'turn.user.start').length, 1);
  assert(h.recovered.length >= 1);
  assert(h.recovered.every((x) => x.includes(`Frage: ${T7}`)), 'the recovery names the whole sentence once');
  assert(!h.recovered.some((x) => x.includes(`${T5} ${T5}`) || x.includes(`${T6} ${T6}`)));
});

test('an answer came in between: "Ja genau" after "Ja" is a new turn, not a longer fragment', async (t) => {
  const h = harness(t);
  await sleep(1);
  h.vendor({ type: 'session.updated' });
  h.vendor(final('i1', 'Ja.'));
  await sleep(5);
  h.vendor({ type: 'response.created', response: { id: 'r1' } });
  h.vendor({ type: 'response.output_audio_transcript.delta', delta: 'Gut, dann so.', response_id: 'r1' });
  h.vendor({ type: 'response.done', response: { id: 'r1' } });
  await sleep(5);
  h.vendor(final('i2', 'Ja genau.'));
  await sleep(5);
  assert.equal(h.traced.filter((e) => e.type === 'turn.user.grown').length, 0);
  assert.equal(h.traced.filter((e) => e.type === 'turn.user.start').length, 2);
  assert.deepEqual(users(h).map((m) => !!m.replace), [false, false]);
});

test('an unrelated next final is a new turn, also an equal sentence from another item', async (t) => {
  const h = harness(t);
  await sleep(1);
  h.vendor(final('i1', 'Und jetzt?')); await sleep(15);
  h.vendor(final('i2', 'Okay, warte. Was ist mit der Bank?')); await sleep(15);
  h.vendor(final('i3', 'Ja.')); await sleep(15);
  h.vendor(final('i4', 'Ja.')); await sleep(15);
  assert.equal(h.traced.filter((e) => e.type === 'turn.user.start').length, 4);
  assert.equal(h.traced.filter((e) => e.type === 'turn.user.grown').length, 0);
});

test('highlight marker: a marked context turn asks for an answer, never a user transcript to the browser; the trace flags it `marker`', async (t) => {
  const h = harness(t);
  await sleep(1);
  h.emit({ t: 'ready', model: 'm' });
  const deliver = h.registered[0];
  assert.equal(deliver('[Markierung vom Desk] <artifact_data source="screen">{"beschreibung":"Die Zahl 12.480"}</artifact_data>', { marker: true }), true);
  assert.equal(h.texts.length, 1, 'sendText: the model gets the turn and answers');
  assert.equal(users(h).length, 0, 'nothing in the browser');
  const start = h.traced.find((e) => e.type === 'turn.user.start'), fin = h.traced.find((e) => e.type === 'transcript.user.final');
  assert.equal(start.marker, true); assert.equal(fin.marker, true); assert.match(fin.text, /12\.480/);
  assert.equal(h.noted.length, 0, 'viz does not take it for a question');
  assert.equal(h.traced.some((e) => e.type === 'transcript.user.final' && e.typed), false);
  // a normal context text still arrives as before (typed)
  assert.equal(deliver('Hallo'), true);
  assert.equal(users(h).at(-1).typed, true);
});

test('"Item not found" of the screen context is benign: screen.context.gone, never screen.context.error', async (t) => {
  const h = harness(t);
  await sleep(1);
  h.vendor({ type: 'session.updated' });
  h.vendor({ type: 'error', event_id: 'screen-del-3', error: { message: 'Item not found: screen_ctx_2' } });
  h.vendor({ type: 'error', event_id: 'screen-add-3', error: { message: 'Item not found: screen_ctx_2' } });
  assert(h.traced.some((e) => e.type === 'screen.context.gone'));
  assert(!h.traced.some((e) => e.type === 'screen.context.error'));
  h.vendor({ type: 'error', event_id: 'screen-add-4', error: { message: 'Invalid item' } });
  assert(h.traced.some((e) => e.type === 'screen.context.error'), 'a real refusal is still an error');
});
