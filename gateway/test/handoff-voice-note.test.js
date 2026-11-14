// a#41d6d2 (14 Nov 2026): in a voice session a failed handoff-card click reaches the live model as a passive note (no reply asked) and the trace.
// The model proposes with the REAL handoff_propose tool; the click goes through the REAL handleHandoff. All data synthetic.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { DESK_ORIGIN, setEnv } from './helpers/env.js';

setEnv();
const { runVoiceSession } = await import('../src/voice/session.js');
const { runTool } = await import('../src/tools.js');
const { handleHandoff } = await import('../src/handoff.js');
const { TEXT } = await import('../src/messages.js');

const tick = () => new Promise((r) => setImmediate(r));
const reply = () => { const r = { status: 0, body: null, writeHead(s) { r.status = s; }, end(d) { r.body = JSON.parse(d); } }; return r; };
const click = async (id, hub, sid = 'sv') => { const res = reply(); await handleHandoff(Object.assign(Readable.from([Buffer.from(JSON.stringify({ id }))]), { method: 'POST', headers: { origin: DESK_ORIGIN } }), res, { sid, ip: 'x', hub, audit() {} }); return res; };

function voice({ provider = 'xai', briefingAdapter = true } = {}) {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], close() { this.readyState = 3; } });
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  const briefed = [], texts = [], events = [], results = [];
  let emit, attach;
  const adapter = { sendAudio() {}, sendText: (t) => texts.push(t), interrupt() {}, close() {}, sendToolResult: (...a) => results.push(a), ...(briefingAdapter ? { setBriefing: (x) => (briefed.push(x), 'sent') } : {}) };
  const trace = { event: (type, d) => events.push({ type, ...d }), close() {} };
  const hub = { pick: () => 'sandy', call: async () => { throw new Error(TEXT.bridgeOffline('sandy')); } };
  const deps = {
    sid: 'sv', toolDefs: [], audit() {}, limits: { check: () => ({ ok: true }), addCost() {} }, createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
    makeCtx: () => ({ sid: 'sv', hub, trace: () => trace }),
    runTool, openTrace: () => trace,
    briefing: { attach: (sid, h) => { attach = h; return () => {}; } },
  };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', create: (o, e) => { emit = e; return adapter; } });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  return { msg, emit: (e) => emit(e), briefed, texts, events, results, hub, setBriefing: (text) => attach.setContext(text), stop: () => msg({ type: 'stop' }) };
}

test('a failed click: the live model gets ONE passive note (briefing channel, no sendText = no reply), the trace has click + failed + note', async () => {
  const v = voice();
  v.msg({ type: 'start' });
  v.emit({ t: 'ready', model: 'm' });
  await tick();
  v.setBriefing('[Überblick vom Desk] fake briefing text'); // the start briefing is on the channel already
  assert.equal(v.briefed.length, 1);
  v.emit({ t: 'tool_call', id: 'c1', name: 'handoff_propose', args: { title: 'Regel ändern', task: 'Bitte Regel 2 anpassen (synthetisch).' } });
  await new Promise((r) => setTimeout(r, 30));
  const proposed = v.results.at(-1)?.[2] ?? '';
  const id = /Vorschlag (h[0-9a-f]{16}) angezeigt/.exec(proposed)?.[1];
  assert.ok(id, `the tool proposed a card: ${proposed.slice(0, 120)}`);
  const res = await click(id, v.hub);
  assert.equal(res.status, 502);
  assert.equal(res.body.retry, true);
  assert.equal(v.briefed.length, 2, 'one more passive channel write');
  assert.match(v.briefed[1], /^Hinweis des Desks: Florians Klick auf die Übergabe-Karte ist fehlgeschlagen: Die Werkstatt auf Sandy ist gerade nicht verbunden – in ein paar Minuten noch einmal klicken\./);
  assert.match(v.briefed[1], /\[Überblick vom Desk\] fake briefing text$/, 'the briefing is carried along (xAI replaces its briefing item)');
  assert.deepEqual(v.texts, [], 'no typed turn: the model is not asked to answer');
  const names = v.events.map((e) => e.type).filter((t) => /^handoff\./.test(t));
  assert.deepEqual(names, ['handoff.click', 'handoff.failed', 'handoff.note']);
  assert.equal(v.events.find((e) => e.type === 'handoff.note').how, 'sent');
  // a later briefing update (late device part) keeps the note
  v.setBriefing('[Überblick vom Desk] updated');
  assert.match(v.briefed[2], /^Hinweis des Desks: Florians Klick/);
  assert.match(v.briefed[2], /updated$/);
  v.stop();
});

test('notes stay bounded (3 newest) and an adapter without a briefing channel is reported, not crashed on', async () => {
  const v = voice();
  v.msg({ type: 'start' });
  v.emit({ t: 'ready', model: 'm' });
  await tick();
  for (let i = 0; i < 5; i += 1) {
    v.emit({ t: 'tool_call', id: `c${i}`, name: 'handoff_propose', args: { title: `Auftrag ${i}`, task: 'Synthetisch.' } });
    await new Promise((r) => setTimeout(r, 15));
    await click(/Vorschlag (h[0-9a-f]{16}) angezeigt/.exec(v.results.at(-1)?.[2] ?? '')?.[1], v.hub);
  }
  assert.equal(v.briefed.length, 5);
  assert.equal(v.briefed.at(-1).split('Hinweis des Desks:').length - 1, 3);
  v.stop();
  const w = voice({ briefingAdapter: false });
  w.msg({ type: 'start' });
  w.emit({ t: 'ready', model: 'm' });
  await tick();
  w.emit({ t: 'tool_call', id: 'c1', name: 'handoff_propose', args: { title: 'Regel', task: 'Synthetisch.' } });
  await new Promise((r) => setTimeout(r, 20));
  const res = await click(/Vorschlag (h[0-9a-f]{16}) angezeigt/.exec(w.results.at(-1)?.[2] ?? '')?.[1], w.hub);
  assert.equal(res.status, 502);
  assert.equal(w.events.find((e) => e.type === 'handoff.note').how, 'unsupported');
  w.stop();
});
