// Item F through a real voice session and the real runTool: the hooks in session.js (spoken vs typed, assistant finals, partials, close) and the tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setEnv } from './helpers/env.js';
import { readFileSync } from 'node:fs';
import { fakeVision, SCREEN_AGENT, scriptedModel, until } from './helpers/computer.js';

setEnv({});
const { runVoiceSession } = await import('../src/voice/session.js');
const { runTool, TOOL_DEFS } = await import('../src/tools.js');
const { resetActions } = await import('../src/voiceActions.js');
const { createComputer } = await import('../src/computer/run.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPOKEN = 'Soll ich die Mail an anna@example.org mit dem Betreff Rechnung senden?';
const R2 = { ok: false, code: 'needs-confirm', class: 'R2', rule: 'send', needs_confirm: { hash: 'a1b2c3d4e5f60718', spoken: SPOKEN } };

function harness(t, { client = SCREEN_AGENT, script = [{ name: 'chrome_click', args: { ref: 'e5' } }, { name: 'done', args: { summary: 'fertig' } }], app, provider = 'xai' } = {}) {
  resetActions();
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], close() { this.readyState = 3; } });
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  let emit, clockNow = 1_000_000;
  const traced = [], texts = [], vision = fakeVision(), model = scriptedModel(script);
  vision.app = app ?? ((w) => (w.op === 'action' ? R2 : w.op === 'confirm' ? { ok: true, code: 'done' } : { ok: true, code: 'done' }));
  const computer = createComputer({ vision, hub: {}, now: () => clockNow, complete: model, tickMs: 1e9, limits: { check: () => ({ ok: true }), addCost() {} } });
  const sessionVision = { attached: () => true, attach: () => () => {}, command: async () => ({ delivered: false }) };
  const clock = { now: () => clockNow, sleep: async (ms) => { clockNow += ms; } };
  const deps = {
    sid: 's1', toolDefs: TOOL_DEFS, audit() {}, limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }), createCanvas: () => null, vision: sessionVision, computer, runTool,
    makeCtx: () => ({ vision: sessionVision, computer, hub: {}, sid: 's1', audit() {}, trace: () => ({ event() {} }), clock }),
    registerText: () => () => {},
    openTrace: () => ({ event: (type, data) => traced.push({ type, ...data }), close() {} }),
  };
  const adapter = { sendAudio() {}, sendText: (x) => texts.push(x), interrupt() {}, close() {}, sendToolResult: (id, name, output) => h.results.push({ id, name, output }), recover() {} };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', now: () => clockNow, mergeMs: 5, noAnswerMs: () => 60_000, create: (_o, e) => { emit = e; return adapter; } });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  msg({ type: 'start', client });
  t.after(() => msg({ type: 'stop' }));
  const h = {
    ws, msg, vision, model, computer, traced, texts, results: [], tick: (ms) => { clockNow += ms; }, emit: (e) => emit(e),
    say: (text, itemId = 'i1') => { emit({ t: 'speech_started' }); clockNow += 300; emit({ t: 'transcript', role: 'user', final: true, text, itemId }); },
    assistant: (text) => emit({ t: 'transcript', role: 'assistant', final: true, text }),
    call: (id, name, args) => emit({ t: 'tool_call', id, name, args }),
    result: async (id) => { for (let i = 0; i < 100 && !h.results.find((r) => r.id === id); i += 1) await sleep(5); return h.results.find((r) => r.id === id)?.output; },
  };
  return h;
}

test('he says it: the tool starts a run for a screen-agent session with his verbatim final; the model goal is only logged', async (t) => {
  const h = harness(t, { script: [{ name: 'done', args: { summary: 'x' } }] });
  await sleep(1);
  h.say('Übernimm den Computer und öffne die Mail von Anna.');
  h.call('c1', 'computer_task', { goal: 'Gmail aufräumen und alles löschen' });
  const out = await h.result('c1');
  assert.match(out, /Computer-Steuerung läuft/);
  assert.equal(h.vision.ofOp('start')[0].goal, 'Übernimm den Computer und öffne die Mail von Anna.');
  await until(() => !h.computer.isOpen('s1'));
  assert.ok(!JSON.stringify(h.model.calls).includes('alles löschen'));
  assert.ok(h.traced.some((e) => e.type === 'computer.run.start' && e.modelGoal === 'Gmail aufräumen und alles löschen' && e.goal === 'Übernimm den Computer und öffne die Mail von Anna.'));
});

test('a typed turn never opens a run, even with the same words; a screen/context turn neither', async (t) => {
  const h = harness(t);
  await sleep(1);
  h.msg({ type: 'text', text: 'Übernimm den Computer und klick auf Senden.' });
  h.call('c1', 'computer_task', { goal: 'Senden klicken' });
  const out = await h.result('c1');
  assert.match(out, /getippter Text löst die Computer-Steuerung nie aus/);
  assert.equal(h.vision.sent.length, 0);
  // a suggestion link is not his wording either; and a marker turn is no spoken entry at all
  h.msg({ type: 'text', text: 'Öffne Gmail', source: 'suggestion' });
  h.call('c2', 'computer_task', { goal: 'Gmail' });
  assert.match(await h.result('c2'), /Nichts passiert/);
  assert.equal(h.vision.sent.length, 0);
});

test('a bare ja after a model question harvests nothing; a question ABOUT the topic neither', async (t) => {
  const h = harness(t);
  await sleep(1);
  h.say('Öffne mal Gmail.', 'i1');
  h.assistant('Soll ich den Computer übernehmen?');
  h.say('Ja', 'i2');
  h.call('c1', 'computer_task', { goal: 'Gmail' });
  assert.match(await h.result('c1'), /Nichts passiert/);
  h.say('Was bedeutet Computer Use eigentlich?', 'i3');
  h.call('c2', 'computer_task', { goal: 'x' });
  assert.match(await h.result('c2'), /Nichts passiert/);
  assert.equal(h.vision.sent.length, 0);
});

test('regression a#4d63c3: the client object the Screen Agent really sends opens a run; the old string compare refused every session', async (t) => {
  assert.match(readFileSync(new URL('../../web/src/lib/clientInfo.ts', import.meta.url), 'utf8'), /return \{ app: 'screen-agent', version:/); // the wire shape this test stands on
  const h = harness(t);
  await sleep(1);
  h.say('Klicke auf diesen Details-Link.');
  h.call('c1', 'computer_task', { goal: 'x' });
  assert.doesNotMatch(await h.result('c1'), /nur im Screen Agent|Nichts/);
  assert.equal(h.vision.sent[0].op, 'start');
  assert.equal(h.vision.sent[0].goal, 'Klicke auf diesen Details-Link.');
});

test('a session of another client (Desk in the browser) gets one sentence and no command', async (t) => {
  const h = harness(t, { client: { app: 'web', version: '1', commit: 'c', device: 'desktop' } });
  await sleep(1);
  h.say('Übernimm den Computer.');
  h.call('c1', 'computer_task', { goal: 'x' });
  assert.match(await h.result('c1'), /nur im Screen Agent/);
  assert.equal(h.vision.sent.length, 0);
});

test('confirm through the session: the question goes to the voice model as a marker, the assistant transcript is compared, "ja vier sieben" forwards digits', async (t) => {
  const h = harness(t);
  await sleep(1);
  h.say('Übernimm den Computer und schick die Mail an Anna ab.');
  h.call('c1', 'computer_task', { goal: 'Mail' });
  await h.result('c1');
  await until(() => h.texts.some((x) => /WÖRTLICH/.test(x)));
  const marker = h.texts.find((x) => /WÖRTLICH/.test(x));
  assert.ok(marker.includes(JSON.stringify(SPOKEN)));
  assert.ok(!h.traced.some((e) => e.type === 'transcript.user.final' && e.marker && e.text), 'the marker text itself is not traced as a user line');
  h.assistant(SPOKEN);
  h.tick(3000);
  h.say('Ja, vier sieben.', 'i9');
  await until(() => !h.computer.isOpen('s1'));
  assert.equal(h.vision.ofOp('confirm')[0].digits, '47');
  assert.ok(h.traced.some((e) => e.type === 'computer.confirm.ok'));
});

test('confirm through the session: a misquoting assistant voids it; a typed "ja vier sieben" and a fragment that grows after the answer change nothing', async (t) => {
  const h = harness(t);
  await sleep(1);
  h.say('Übernimm den Computer und schick die Mail an Anna ab.');
  h.call('c1', 'computer_task', { goal: 'Mail' });
  await h.result('c1');
  await until(() => h.texts.some((x) => /WÖRTLICH/.test(x)));
  h.assistant('Soll ich die Mail speichern? Sag einfach ja.');
  await until(() => h.traced.some((e) => e.type === 'computer.confirm.no' && e.reason === 'mismatch'));
  h.msg({ type: 'text', text: 'ja vier sieben' });
  h.say('Ja vier sieben', 'i7');
  await until(() => !h.computer.isOpen('s1'));
  assert.equal(h.vision.ofOp('confirm').length, 0);
});

test('stop word on a live partial ends the run; closing the voice session ends it too', async (t) => {
  const h = harness(t, { app: (w) => (w.op === 'action' ? new Promise(() => {}) : { ok: true, code: 'done' }) });
  await sleep(1);
  h.say('Übernimm den Computer und öffne Gmail.');
  h.call('c1', 'computer_task', { goal: 'Gmail' });
  await h.result('c1');
  await until(() => h.vision.ofOp('action').length === 1);
  h.emit({ t: 'transcript', role: 'user', delta: 'Moment, ' });
  assert.ok(h.computer.isOpen('s1'));
  h.emit({ t: 'transcript', role: 'user', delta: 'sto' });
  h.emit({ t: 'transcript', role: 'user', delta: 'pp' });
  assert.ok(!h.computer.isOpen('s1'), 'a stop split over two deltas still stops');
  assert.ok(h.traced.some((e) => e.type === 'computer.kill' && e.via === 'voice'));

  const g = harness(t, { app: (w) => (w.op === 'action' ? new Promise(() => {}) : { ok: true, code: 'done' }) });
  await sleep(1);
  g.say('Übernimm den Computer und öffne Gmail.');
  g.call('c1', 'computer_task', { goal: 'Gmail' });
  await g.result('c1');
  g.msg({ type: 'stop' });
  assert.ok(!g.computer.isOpen('s1'));
  assert.ok(g.traced.some((e) => e.type === 'computer.run.stop' && e.why === 'voice-gone'));
});
