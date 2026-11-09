// Voice session, unrestricted default: (1) a name on his screen that sounds like what the recogniser wrote reaches the model with its first tool result of that
// sentence, (2) his speech start asks for a fresh picture, (3) computer_task starts after 0.7 s of silence instead of 2.5 s (trace a#ba7990). Fictional names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setEnv } from './helpers/env.js';
import { fakeVision, SCREEN_AGENT, scriptedModel, until } from './helpers/computer.js';

setEnv({});
delete process.env.DESK_COMPUTER_GUARDS;
const { runVoiceSession } = await import('../src/voice/session.js');
const { runTool, TOOL_DEFS } = await import('../src/tools.js');
const { resetActions, SETTLE_MS } = await import('../src/voiceActions.js');
const { createComputer } = await import('../src/computer/run.js');
const { QUICK_SETTLE_MS } = await import('../src/computer/tool.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(t, { names = [], fakeTool = null, script = [{ name: 'done', args: { summary: 'x' } }] } = {}) {
  resetActions();
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], close() { this.readyState = 3; } });
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  let emit, clockNow = 1_000_000;
  const traced = [], vision = fakeVision(), model = scriptedModel(script);
  vision.app = (w) => (w.op === 'action' ? { ok: true, code: 'done', result: { text: 'frame: screen 1280x720', jpeg: 'AAAA' } } : { ok: true, code: 'done' });
  const computer = createComputer({ vision, hub: {}, now: () => clockNow, complete: model, tickMs: 1e9, limits: { check: () => ({ ok: true }), addCost() {} }, statePath: '' });
  const refreshed = [];
  const sessionVision = { attached: () => true, attach: () => () => {}, command: async () => ({ delivered: false }), names: () => names, refresh: (sid) => { refreshed.push(sid); return true; } };
  const clock = { now: () => clockNow, sleep: async (ms) => { clockNow += ms; } };
  const h = { results: [], refreshed, traced, vision, computer, now: () => clockNow };
  const deps = {
    sid: 's1', toolDefs: TOOL_DEFS, audit() {}, limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }), createCanvas: () => null, vision: sessionVision, computer, runTool: fakeTool ?? runTool,
    makeCtx: () => ({ vision: sessionVision, computer, hub: {}, sid: 's1', audit() {}, trace: () => ({ event() {} }), clock }),
    registerText: () => () => {},
    openTrace: () => ({ event: (type, data) => traced.push({ type, ...data }), close() {} }),
  };
  const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, close() {}, sendToolResult: (id, name, output) => h.results.push({ id, name, output }), recover() {} };
  runVoiceSession(ws, deps, { provider: 'xai', apiKey: 'k', now: () => clockNow, mergeMs: 5, noAnswerMs: () => 60_000, create: (_o, e) => { emit = e; return adapter; } });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  msg({ type: 'start', client: { ...SCREEN_AGENT, version: '0.1.14' } });
  t.after(() => msg({ type: 'stop' }));
  Object.assign(h, {
    emit: (e) => emit(e),
    say: (text, itemId = 'i1') => { emit({ t: 'speech_started' }); clockNow += 300; emit({ t: 'transcript', role: 'user', final: true, text, itemId }); },
    call: (id, name, args) => emit({ t: 'tool_call', id, name, args }),
    result: async (id) => { for (let i = 0; i < 200 && !h.results.find((r) => r.id === id); i += 1) await sleep(5); return h.results.find((r) => r.id === id)?.output; },
    tick: (ms) => { clockNow += ms; },
  });
  return h;
}
const NAMES = ['Oppel AI', 'Nordgatan', 'Outwing', 'Telegram Web'];
const plainTool = async () => ({ ok: true, content: 'Im Wissen steht dazu nichts Besonderes.', summary: 'gelesen' });

test('"OpenAI" understood, "Oppel AI" on screen: the first tool result of that sentence carries the hint, once; a sentence heard right gets none', async (t) => {
  const h = harness(t, { names: NAMES, fakeTool: plainTool });
  await sleep(1);
  h.say('Äh, erklär mir, um was es bei OpenAI geht.');
  h.call('c1', 'knowledge_read', { topic: 'OpenAI' });
  const first = await h.result('c1');
  assert.match(first, /^Im Wissen steht dazu nichts Besonderes\.\n\[Hinweis vom Desk, nicht von Florian, Daten:/);
  assert.match(first, /steht gerade "Oppel AI"; erkannt wurde "OpenAI"/);
  assert.match(first, /sag in einem Halbsatz, dass du den Namen vom Bildschirm annimmst/, 'an assumption he can correct, not a silent substitution');
  h.call('c2', 'knowledge_read', { topic: 'Oppel AI' });
  assert.equal(await h.result('c2'), 'Im Wissen steht dazu nichts Besonderes.', 'one hint per sentence');
  const heard = h.traced.filter((e) => e.type === 'screen.heard');
  assert.equal(heard.length, 1);
  assert.ok(!JSON.stringify(heard).includes('Oppel'), 'the trace says that it happened, not what is on the screen');
  h.tick(5000);
  h.say('Und worum geht es bei Outwing?', 'i2');
  h.call('c3', 'knowledge_read', { topic: 'Outwing' });
  assert.equal(await h.result('c3'), 'Im Wissen steht dazu nichts Besonderes.');
});

test('no names on screen (or no Screen Agent): tool results are untouched', async (t) => {
  const h = harness(t, { names: [], fakeTool: plainTool });
  await sleep(1);
  h.say('Erklär mir, um was es bei OpenAI geht.');
  h.call('c1', 'knowledge_read', { topic: 'OpenAI' });
  assert.equal(await h.result('c1'), 'Im Wissen steht dazu nichts Besonderes.');
});

test('his speech start asks for a fresh picture of the screen', async (t) => {
  const h = harness(t, { names: NAMES, fakeTool: plainTool });
  await sleep(1);
  h.say('Was siehst du gerade?');
  assert.deepEqual(h.refreshed, ['s1']);
});

test('computer_task starts 0.7 s after his last sound, not 2.5 s; the run begins with a screenshot', async (t) => {
  const h = harness(t, {});
  await sleep(1);
  h.say('Klick bitte auf Senden bei der mittleren Karte.');
  const t0 = h.now();
  h.call('c1', 'computer_task', { goal: 'Im Chrome-Fenster Telegram Web bei der mittleren Karte auf Senden klicken.' });
  assert.match(await h.result('c1'), /Computer-Steuerung läuft/);
  const waited = h.now() - t0;
  assert.ok(waited >= QUICK_SETTLE_MS - 300 && waited < 1200, `waited ${waited} ms`);
  assert.ok(SETTLE_MS >= 2000, 'the other voice actions keep the long settle');
  await until(() => !h.computer.isOpen('s1'));
  assert.equal(h.vision.ofOp('action')[0].tool, 'screenshot');
  assert.match(h.vision.ofOp('start')[0].goal, /mittleren Karte auf Senden klicken\. \(Florians Worte: Klick bitte auf Senden bei der mittleren Karte\.\)/);
});

test('a cancelled tool call does not use the hint up: the next current result of the same sentence carries it', async (t) => {
  let slow;
  const tool = async (name, args) => { if (args.topic === 'slow') await new Promise((r) => { slow = r; }); return { ok: true, content: 'Ergebnis.', summary: 'x' }; };
  const h = harness(t, { names: NAMES, fakeTool: tool });
  await sleep(1);
  h.say('Erklär mir, um was es bei OpenAI geht.');
  h.call('c1', 'knowledge_read', { topic: 'slow' });
  await sleep(5);
  h.emit({ t: 'tool_cancelled', ids: ['c1'] });
  slow();
  await sleep(10);
  assert.equal(h.results.find((r) => r.id === 'c1'), undefined, 'a cancelled result is not delivered');
  assert.equal(h.traced.filter((e) => e.type === 'screen.heard').length, 0);
  h.call('c2', 'knowledge_read', { topic: 'OpenAI' });
  assert.match(await h.result('c2'), /steht gerade "Oppel AI"; erkannt wurde "OpenAI"/);
});
