// Round 12 (critic r11 §7 item 5): Gemini's transcript carries no tool markup, a question shows at most one filler sentence,
// and the early illustrator's facts reach Gemini at once (not only with its next tool result). Fake sockets, no network.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { setEnv } from './helpers/env.js';

setEnv({});
const { TOOL_DEFS, runTool } = await import('../src/tools.js');
const { runVoiceSession } = await import('../src/voice/session.js');
const { createGemini, FACTS_HINT, FACTS_LEAD } = await import('../src/voice/gemini.js');
const { limitFillers, stripToolMarkup, TranscriptMarkupFilter } = await import('../src/voice/transcript.js');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function harness(t, provider = 'gemini') {
  const ws = new EventEmitter();
  Object.assign(ws, { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], send: (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d), close: () => { ws.readyState = 3; } });
  let emit;
  const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, close() {}, sendToolResult() {} };
  const deps = { sid: 's', toolDefs: TOOL_DEFS, audit: () => {}, runTool, makeCtx: (page) => ({ page, hub: {}, audit: () => {} }), limits: { check: () => ({ ok: true }), addCost() {} }, createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }) };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', create: (_o, e) => ((emit = e), adapter) });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  t.after(() => msg({ type: 'stop' }));
  msg({ type: 'start' });
  const said = (e) => emit({ t: 'transcript', role: 'assistant', delta: e, final: false });
  return {
    emit: (e) => emit(e), said,
    shown: () => ws.sent.filter((m) => m.type === 'transcript' && m.role === 'assistant'),
    finals: () => ws.sent.filter((m) => m.type === 'transcript' && m.role === 'assistant' && m.final).map((m) => m.text),
  };
}

describe('r12 item 5: no tool markup in transcripts', () => {
  it('critic repro: "zm-thinker:call_tool_use_thinker_agent{}" split over deltas never reaches the browser', (t) => {
    const h = harness(t);
    for (const d of ['zm-thin', 'ker:call_tool', '_use_thinker_agent{', '}Laut der ', 'Notiz gilt das ', 'wöchentlich.']) h.said(d);
    h.emit({ t: 'turn_done' });
    const all = h.shown().map((m) => m.delta ?? m.text).join('|');
    assert.doesNotMatch(all, /call_|thinker|zm-/);
    assert.equal(h.finals().at(-1), 'Laut der Notiz gilt das wöchentlich.');
  });

  it('other providers too; ordinary words with ":" or "_" stay', (t) => {
    const h = harness(t, 'xai');
    for (const d of ['Status: ', 'ok, die Datei ', 'build_video.sh ', 'prüft das.']) h.said(d);
    h.emit({ t: 'turn_done' });
    assert.equal(h.finals().at(-1), 'Status: ok, die Datei build_video.sh prüft das.');
    assert.equal(stripToolMarkup('a default_api.knowledge_read(topic="x") b <ctrl42>c'), 'a b c');
    const f = new TranscriptMarkupFilter();
    assert.equal(f.push('Hallo ') + f.push('Welt') + f.flush(), 'Hallo Welt');
  });
});

describe('r12 item 5: at most one filler sentence per question', () => {
  it('critic repro (Gemini tax t1): three announcements -> only the first is shown, the answer stays', (t) => {
    const h = harness(t);
    h.emit({ t: 'transcript', role: 'user', text: 'Wie läuft das mit der Rücklage?', final: true });
    for (const filler of ['Ich schaue mir die Details an.', 'Ich analysiere gerade die Auswirkungen.', 'Ich prüfe jetzt die Regeln.', 'Ich verfolge gerade die Logik der Untertitel.']) {
      for (const w of filler.split(/(?<= )/)) h.said(w);
      h.emit({ t: 'turn_done' });
    }
    for (const w of 'Laut der Notiz gehen 40 Prozent in die Rücklage.'.split(/(?<= )/)) h.said(w);
    h.emit({ t: 'turn_done' });
    assert.deepEqual(h.finals(), ['Ich schaue mir die Details an.', 'Laut der Notiz gehen 40 Prozent in die Rücklage.']);
    assert.doesNotMatch(h.shown().map((m) => m.delta ?? m.text).join(''), /analysiere|prüfe jetzt|verfolge/);
  });

  it('the next question gets its own filler again; a filler inside an answer turn is cut from the final text', (t) => {
    const h = harness(t);
    h.emit({ t: 'transcript', role: 'user', text: 'Erste Frage?', final: true });
    h.said('Ich schaue kurz nach. '); h.said('Ich prüfe das noch. '); h.said('Es sind 3.');
    h.emit({ t: 'turn_done' });
    h.emit({ t: 'speech_started' });
    h.emit({ t: 'transcript', role: 'user', text: 'Zweite Frage?', final: true });
    h.said('Ich schaue nach. '); h.said('Es sind 4.');
    h.emit({ t: 'turn_done' });
    assert.deepEqual(h.finals(), ['Ich schaue kurz nach. Es sind 3.', 'Ich schaue nach. Es sind 4.']);
    assert.deepEqual(limitFillers('Moment. Laut Datei 5.', 0), { text: 'Laut Datei 5.', fillers: 0 });
    // live r12: content that starts like an announcement stays
    assert.equal(limitFillers('Ich sehe, dass Videos ohne Seitenlink … vom System abgelehnt werden.', 0).text, 'Ich sehe, dass Videos ohne Seitenlink … vom System abgelehnt werden.');
    assert.equal(limitFillers('Ich habe gesehen, wie die Sperre greift.', 0).text, 'Ich habe gesehen, wie die Sperre greift.');
  });
});

describe('r12 item 5: Gemini answers from the early facts quickly', () => {
  it('session: a research result waits (bounded) until the early facts are in, so they ride along with it', async (t) => {
    const ws = new EventEmitter();
    Object.assign(ws, { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], send: (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d), close: () => { ws.readyState = 3; } });
    let emit; let onFacts;
    const order = [];
    const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, close() {}, newTurn() {}, factsDelivered: () => false, addContext: () => { order.push('facts'); return 'held'; }, sendToolResult: (id) => order.push(`result ${id}`) };
    const canvas = { noteTurn() {}, startTurn() {}, userTurn: () => 'early', autoTurn() {}, turnDone() {}, toolStarted() {}, noteTool() {}, close() {} };
    const deps = { sid: 's', toolDefs: TOOL_DEFS, audit: () => {}, runTool: async () => ({ ok: true, content: 'x' }), makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} }, createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }), createCanvas: (o) => { onFacts = o.onFacts; return canvas; } };
    runVoiceSession(ws, deps, { provider: 'gemini', apiKey: 'k', create: (_o, e) => ((emit = e), adapter) });
    const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
    t.after(() => msg({ type: 'stop' }));
    msg({ type: 'start' });
    emit({ t: 'transcript', role: 'user', text: 'Wie läuft die Sperre?', final: true });
    emit({ t: 'tool_call', id: 'c1', name: 'search_files', args: { query: 'x' } });
    await tick(120);
    assert.deepEqual(order, [], 'the result waits for the facts');
    onFacts('### knowledge_read\nDie Sperre greift bei exit 75.', { strong: true, final: false });
    await tick(10);
    assert.deepEqual(order, ['facts', 'result c1']);
  });

  async function vendor(t) {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.on('listening', r));
    const received = [];
    let sock = null;
    wss.on('connection', (ws) => { sock = ws; ws.on('message', (d) => received.push(JSON.parse(d.toString()))); });
    t.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
    return { url: `ws://127.0.0.1:${wss.address().port}`, received, send: (obj) => sock.send(JSON.stringify(obj)) };
  }

  it('the facts ride along with the first tool result with the "answer from them" hint, never as a separate input; later facts of the same question are ignored', async (t) => {
    const v = await vendor(t);
    const a = createGemini({ apiKey: 'k', instructions: 'x', tools: TOOL_DEFS, url: v.url, watchdogMs: () => 5000 }, () => {});
    await tick(100);
    assert.equal(a.addContext('Frage: Wie läuft die Sperre?\n\n### knowledge_read\nDie Sperre greift bei exit 75.'), 'held');
    await tick();
    assert.equal(v.received.filter((m) => m.realtimeInput?.text).length, 0, 'no separate input (live r12: it made Gemini say "keine Information")');
    assert.equal(a.factsDelivered(), false);
    a.sendToolResult('g1', 'search_files', 'r');
    await tick();
    const response = v.received.find((m) => m.toolResponse).toolResponse.functionResponses[0].response;
    assert.match(response.result, /^r\n\n=== DESK-FAKTEN zur aktuellen Frage \(schon gelesen\) ===\n/);
    assert.ok(response.result.includes(FACTS_HINT));
    assert.match(response.result, /exit 75/);
    assert.equal(a.factsDelivered(), true);
    assert.equal(a.addContext('### more'), 'late');
    a.newTurn();
    assert.equal(a.factsDelivered(), false);
    a.close();
  });

  it('exact facts (topic by its slug, ledger) go out at once as desk input; the interruption they cause is not Florian speaking', async (t) => {
    const v = await vendor(t);
    const events = [];
    const a = createGemini({ apiKey: 'k', instructions: 'x', tools: TOOL_DEFS, url: v.url, watchdogMs: () => 5000 }, (e) => events.push(e));
    await tick(100);
    assert.equal(a.addContext('### ledger_spend\nGPU 700', { exact: true }), 'sent');
    assert.equal(a.addContext('### more', { exact: true }), 'late');
    await tick();
    const texts = v.received.filter((m) => m.realtimeInput?.text).map((m) => m.realtimeInput.text);
    assert.equal(texts.length, 1);
    assert.ok(texts[0].startsWith(FACTS_LEAD));
    v.send({ serverContent: { interrupted: true } });
    await tick();
    assert.equal(events.filter((e) => e.t === 'speech_started').length, 0);
    v.send({ voiceActivity: { type: 'ACTIVITY_START' } });
    await tick();
    assert.equal(events.filter((e) => e.t === 'speech_started').length, 1, 'real speech still counts');
    // with a tool call open, even exact facts ride along with its result
    a.newTurn();
    v.send({ toolCall: { functionCalls: [{ id: 'g1', name: 'knowledge_read', args: {} }] } });
    await tick();
    assert.equal(a.addContext('### ledger_spend\nGPU 800', { exact: true }), 'held');
    a.close();
  });

  it('session: after the facts went out, Gemini gets one more research tool, then the cap answers "antworte jetzt"', async (t) => {
    const ws = new EventEmitter();
    Object.assign(ws, { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], send: (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d), close: () => { ws.readyState = 3; } });
    let emit;
    let delivered = false;
    const results = [];
    const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, close() {}, newTurn() {}, factsDelivered: () => delivered, sendToolResult: (id, _n, out) => { results.push([id, out]); delivered = true; } };
    const deps = { sid: 's', toolDefs: TOOL_DEFS, audit: () => {}, runTool: async () => ({ ok: true, content: 'x' }), makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} }, createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }) };
    runVoiceSession(ws, deps, { provider: 'gemini', apiKey: 'k', create: (_o, e) => ((emit = e), adapter) });
    const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
    t.after(() => msg({ type: 'stop' }));
    msg({ type: 'start' });
    emit({ t: 'transcript', role: 'user', text: 'Wie läuft die Sperre?', final: true });
    for (const id of ['c1', 'c2', 'c3']) { emit({ t: 'tool_call', id, name: 'search_files', args: { query: 'x' } }); await tick(10); }
    assert.deepEqual(results.map(([id]) => id), ['c1', 'c2', 'c3']);
    assert.equal(results[0][1], 'x');
    assert.equal(results[1][1], 'x', 'one more research tool after the facts');
    assert.match(results[2][1], /Recherche-Limit erreicht/);
  });
});
