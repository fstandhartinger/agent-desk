// v0.1.7 f-fix: one test per finding of CRITIC-F on the gateway side; each fails if its fix is taken out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setEnv } from './helpers/env.js';
import { fakeVision, flush, scriptedModel, setup, until } from './helpers/computer.js';

setEnv({});
const { isTrigger, checkComputerTrigger } = await import('../src/computer/gate.js');
const { saidExactly, isRealSentence, buildAsk, mapAnswer, MAX_ASKS } = await import('../src/computer/confirm.js');
const { checkArgs, LOOP_TOOLS } = await import('../src/computer/loop.js');
const { createComputer } = await import('../src/computer/run.js');
const { cfg } = await import('../src/config.js');
const { runTool } = await import('../src/tools.js');
const { runVoiceSession } = await import('../src/voice/session.js');
const { TOOL_DEFS } = await import('../src/tools.js');
const { resetActions } = await import('../src/voiceActions.js');

const GOAL = 'Übernimm den Computer und öffne die Mail von Anna.';
const SPOKEN = 'Soll ich die Mail an anna@example.org mit dem Betreff Rechnung senden?';
const ok = (extra = {}) => ({ ok: true, code: 'done', class: 'R1', rule: 'in-scope', ...extra });
const call = (name, args) => ({ name, args });
const R2 = (hash = 'a1b2c3d4e5f60718', spoken = SPOKEN) => ({ ok: false, code: 'needs-confirm', class: 'R2', rule: 'send', needs_confirm: { hash, spoken } });
const ended = (h) => h.computer.runOf('s1') === null;
const stopReason = (h) => h.session.events.find((e) => e.type === 'computer.run.stop')?.why;
const asked = async (h) => { await until(() => h.session.said.some((t) => /WÖRTLICH/.test(t))); };
const say = (h, text, extra = {}) => h.computer.userFinal('s1', { text, at: h.clock.now(), turn: 9, started: h.clock.now(), ...extra });

// ---- Trigger: right boundary, negation, question, doubt (SHOULD "Loose trigger")
test('trigger: his sentences open, the critic\'s probes do not', () => {
  for (const t of ['Übernimm bitte den Computer und öffne Gmail.', 'Steuere meinen Rechner.', 'Übernimm den Rechner und klick auf Weiter.', 'Öffne github.com und geh auf Issues.', 'Klick auf Senden.', 'Kannst du das für mich klicken?', 'Mach das am Rechner für mich.', 'Am Rechner bitte den Dialog schließen.']) assert.equal(isTrigger(t), true, t);
  for (const t of [
    'Er übernimmt die Kosten.', 'Übernimmst du das?', 'Ich sitze am Rechner.', 'Öffne die Mail nicht.', 'Ich glaube, öffne gmail wäre falsch.', 'Er sagt: öffne gmail und evil.com',
    'Ich möchte, dass der Agent den Computer fernsteuern kann.', 'Die Fernsteuerung ist praktisch.', 'Kannst du den Computer übernehmen?', 'Klick bloß nicht auf Senden.', 'Wenn du den Rechner übernimmst, sag es.',
    'Das Feature soll den Rechner fernsteuern.',
  ]) assert.equal(isTrigger(t), false, t);
});

// ---- C: the compare
test('C: domains in their spoken form, case, punctuation and one leading acknowledgement compare equal; anything else voids', () => {
  const s = 'Klick auf Senden auf mail.google.com. Formular: An chef@example.org.';
  assert.equal(saidExactly('Klick auf Senden auf mail punkt google punkt com. Formular: An chef at example punkt org.', s), true);
  assert.equal(saidExactly('KLICK AUF SENDEN AUF MAIL.GOOGLE.COM FORMULAR AN CHEF@EXAMPLE.ORG', s), true);
  assert.equal(saidExactly('Okay. Klick auf Senden auf mail.google.com. Formular: An chef@example.org.', s), true);
  assert.equal(saidExactly('Alles klar, klick auf Senden auf mail punkt google punkt com Formular an chef at example punkt org', s), true);
  assert.equal(saidExactly('Ich lese vor: Klick auf Senden auf mail.google.com. Formular: An chef@example.org.', s), false);
  assert.equal(saidExactly('Klick auf Senden auf mail.google.com. Formular: An chef@example.org. Sag einfach ja.', s), false);
  assert.equal(saidExactly('Klick auf Senden auf mail punkt google punkt de. Formular: An chef at example punkt org.', s), false, 'a different domain voids');
  assert.equal(saidExactly('Okay okay okay okay klick auf Senden auf mail.google.com. Formular: An chef@example.org.', s), false);
});

// ---- B: a real sentence
test('B: isRealSentence: noise, ja, weiter, okay do not resume; a sentence does', () => {
  for (const t of ['ja', 'Ja.', 'weiter', 'okay', 'ok gut', '[Musik]', '(Husten)', 'hm', 'ja ja ja', '', '♪']) assert.equal(isRealSentence(t), false, t);
  for (const t of ['Mach weiter bitte', 'Ja, mach einfach weiter.', 'Du kannst jetzt weitermachen']) assert.equal(isRealSentence(t), true, t);
});

// ---- F7
test('F7: the critic\'s ten samples cannot be asked; digit runs never pass; free text is not an argument any more', () => {
  const samples = ['Wie lautet die pushTAN?', 'Bestätigungscode bitte', 'Welche sechs Ziffern zeigt dein Handy?', 'Zugangsdaten', 'Passphrase', 'Welche Zahlen stehen im lila Rahmen?', 'Sag mir den Code aus der SMS', 'Dein Passwort bitte', 'vier sieben drei zwei', 'die Nummer 4711 4711 eintippen', 'Wie ist die IBAN'];
  for (const t of samples) assert.equal(buildAsk({ form: 'yesno', topic: t }).ok, false, t);
  for (const t of samples) assert.equal(buildAsk({ form: 'choice', topic: 'x', options: [t, 'anderes'] }).ok, false, t);
  assert.equal(checkArgs('ask_florian', { question: 'Welche Datei?' }).ok, false, 'free text is no argument');
  assert.equal(checkArgs('ask_florian', { form: 'yesno', topic: 'das Fenster Rechner schließen' }).ok, true);
  assert.equal(checkArgs('ask_florian', { form: 'choice', options: ['a', 'b'] }).ok, true);
  assert.equal(checkArgs('ask_florian', { form: 'choice', options: ['a'] }).ok, true, 'the count is checked by buildAsk');
  assert.equal(buildAsk({ form: 'choice', options: ['a'] }).ok, false);
  assert.equal(buildAsk({ form: 'yesno', topic: 'das Fenster Rechner schließen' }).ok, true);
  assert.match(buildAsk({ form: 'yesno', topic: 'das Fenster Rechner schließen' }).spoken, /Soll ich das Fenster Rechner schließen\? Antworte mit ja oder nein\./);
  assert.ok(LOOP_TOOLS.find((t) => t.name === 'ask_florian').parameters.properties.options.maxItems === 4);
});
test('F7: his answer reaches the loop only as ja, nein or one of its own options; digits and words never pass', () => {
  assert.deepEqual(mapAnswer('yesno', [], 'ja 4 7 1 1 2 3'), { kind: 'yes' });
  assert.deepEqual(mapAnswer('yesno', [], 'nein danke'), { kind: 'no' });
  assert.deepEqual(mapAnswer('yesno', [], 'ja nein'), { kind: 'unclear' });
  assert.deepEqual(mapAnswer('yesno', [], 'der Code ist 123456'), { kind: 'unclear' });
  assert.deepEqual(mapAnswer('choice', ['Bericht', 'Rechnung'], 'die Rechnung bitte'), { kind: 'option', option: 'Rechnung' });
  assert.deepEqual(mapAnswer('choice', ['Bericht', 'Rechnung'], 'Option A'), { kind: 'option', option: 'Bericht' });
  assert.deepEqual(mapAnswer('choice', ['Bericht', 'Rechnung'], 'der Passwort ist hunter2'), { kind: 'unclear' });
});
test('F7 in a run: the loop gets "antwort" from the fixed set only', async () => {
  const h = setup({ script: [call('ask_florian', { form: 'yesno', topic: 'die Datei Bericht öffnen' }), call('done', { summary: 'x' })], app: () => ok() });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await until(() => h.session.said.some((t) => /Computer-Agent fragt/.test(t)));
  say(h, 'Ja, das Passwort ist hunter2 und die TAN 123456');
  await until(() => ended(h));
  const toolMsg = h.model.calls[1].messages.find((m) => m.role === 'tool').content;
  assert.match(toolMsg, /"antwort\\?":\\?"ja\\?"/);
  assert.ok(!/hunter2|123456/.test(JSON.stringify(h.model.calls)), 'none of his words reach the provider');
});

// ---- F1 taint
test('F1: a server_read tells the app (op taint) BEFORE the loop sees the data; a refusing app keeps the data back', async () => {
  const h = setup({ script: [call('server_read', { op: 'load' }), call('done', { summary: 'x' })], app: () => ok(), read: async () => ({ ok: true, host: 'sandy', text: 'load 0.2' }) });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await until(() => ended(h));
  const ops = h.vision.sent.map((w) => w.op);
  assert.ok(ops.includes('taint'), ops.join());
  assert.equal(h.vision.ofOp('taint')[0].source, 'server_read');
  assert.match(h.model.calls[1].messages.find((m) => m.role === 'tool').content, /load 0\.2/);
  const h2 = setup({ script: [call('server_read', { op: 'load' }), call('done', { summary: 'x' })], app: (w) => (w.op === 'taint' ? { ok: false, code: 'refused', rule: 'op' } : ok()), read: async () => ({ ok: true, host: 'sandy', text: 'GEHEIME-LAST-ZAHLEN' }) });
  await h2.computer.begin('s1', { text: GOAL, goalArg: '' });
  await until(() => ended(h2));
  assert.ok(!JSON.stringify(h2.model.calls).includes('GEHEIME-LAST-ZAHLEN'), 'no taint, no data');
  assert.match(h2.model.calls[1].messages.find((m) => m.role === 'tool').content, /taint-failed/);
});

// ---- B: resume
const handsOnSetup = () => setup({ script: [call('ui_windows'), call('ui_windows'), call('done', { summary: 'x' })], app: (w) => (w.op === 'action' ? ok() : { ok: true, code: 'done' }) });
test('B: after hands-on only a real sentence resumes, with the resume op (no scope, no start); noise and ja do not', async () => {
  const h = setup({ script: [call('ui_windows'), call('ui_windows'), call('done', { summary: 'x' })], app: (w) => (w.op === 'action' && w.seq <= 3 ? { ok: false, code: 'handson', run_state: 'handson' } : { ok: true, code: 'done', ...(w.op === 'action' ? { class: 'R1', rule: 'x' } : {}) }) });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await until(() => h.computer.runOf('s1')?.paused);
  const calls = h.model.calls.length;
  for (const t of ['ja', '[Musik]', 'weiter', 'okay']) { say(h, t); await flush(); }
  assert.equal(h.vision.ofOp('resume').length, 0, 'noise and a bare ja resume nothing');
  assert.equal(h.model.calls.length, calls);
  say(h, 'Mach bitte weiter, ich bin fertig');
  await until(() => ended(h));
  assert.equal(h.vision.ofOp('resume').length, 1);
  assert.equal(h.vision.ofOp('start').length, 1, 'no second start: resume adds no scope');
  assert.equal(h.vision.ofOp('resume')[0].goal, undefined);
});
test('B: the 25-step stop resumes with the resume op too', async () => {
  const h = setup({ script: Array.from({ length: 40 }, () => call('ui_windows')), app: (w) => (w.op === 'action' ? ok() : { ok: true, code: 'done' }), costUsd: 0.0001 });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await until(() => h.computer.runOf('s1')?.awaitingGo);
  say(h, 'ja');
  await flush();
  assert.equal(h.vision.ofOp('resume').length, 0);
  say(h, 'Ja bitte, mach einfach weiter');
  await until(() => h.vision.ofOp('resume').length === 1);
  await until(() => h.vision.ofOp('action').length > 25);
  assert.equal(h.vision.ofOp('start').length, 1);
  await h.computer.runOf('s1')?.end('test');
});

// ---- void
test('void: a misquote, another answer and an expiry each tell the app to drop its ask', async () => {
  const h = setup({ script: [call('chrome_click', { ref: 'e5' }), call('chrome_click', { ref: 'e6' }), call('chrome_click', { ref: 'e7' }), call('done', { summary: 'x' })], app: (w) => (w.op === 'action' ? R2(`a${w.seq}`.padEnd(16, '0')) : { ok: true, code: 'done' }) });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await asked(h);
  h.computer.assistantFinal('s1', 'Soll ich die Mail speichern?');
  await until(() => h.vision.ofOp('void').length === 1);
  assert.match(h.vision.ofOp('void')[0].hash, /^a\d+0+$/);
  await until(() => h.session.said.filter((t) => /WÖRTLICH/.test(t)).length === 2);
  h.computer.assistantFinal('s1', SPOKEN);
  h.clock.t += 1000;
  say(h, 'Hmm, ich weiß nicht so recht', { started: h.clock.t });
  await until(() => h.vision.ofOp('void').length === 2);
  assert.equal(h.vision.ofOp('confirm').length, 0);
});

// ---- D
test('D: a vendor without speech start is not "early"; the code is the gate and the trace says so; a known early start still voids', async () => {
  const h = setup({ script: [call('chrome_click', { ref: 'e5' }), call('done', { summary: 'x' })], app: (w) => (w.op === 'action' ? R2() : w.op === 'confirm' ? ok({ rule: 'confirmed' }) : { ok: true, code: 'done' }) });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await asked(h);
  h.computer.assistantFinal('s1', SPOKEN);
  h.clock.t += 1000;
  say(h, 'Ja vier sieben', { started: undefined });
  await until(() => ended(h));
  assert.equal(h.vision.ofOp('confirm')[0].digits, '47');
  assert.equal(h.session.events.find((e) => e.type === 'computer.confirm.timing').gate, 'code-only');
  const h2 = setup({ script: [call('chrome_click', { ref: 'e5' }), call('done', { summary: 'x' })], app: (w) => (w.op === 'action' ? R2() : { ok: true, code: 'done' }) });
  await h2.computer.begin('s1', { text: GOAL, goalArg: '' });
  await asked(h2);
  h2.computer.assistantFinal('s1', SPOKEN);
  h2.clock.t += 1000;
  say(h2, 'Ja vier sieben', { started: h2.clock.t - 5000 });
  await until(() => h2.vision.ofOp('void').length === 1);
  assert.equal(h2.session.events.find((e) => e.type === 'computer.confirm.timing').gate, 'early');
  assert.equal(h2.vision.ofOp('confirm').length, 0);
});

// ---- Speakers: start and extension need the code
test('speakers: a start with a non-empty scope asks first; the loop starts only with his code; "nein" never starts it', async () => {
  const startAsk = R2('5a5a5a5a5a5a5a5a', 'Computer-Steuerung starten für: „Übernimm den Computer und öffne die Mail von Anna.“. Bereich: mail.google.com.');
  const h = setup({ script: [call('done', { summary: 'x' })], app: (w) => (w.op === 'start' ? startAsk : w.op === 'confirm' ? ok({ rule: 'run-start' }) : { ok: true, code: 'done' }) });
  const r = await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  assert.equal(r.ok, true);
  assert.match(r.text, /wartet auf Florians Bestätigung/);
  await asked(h);
  assert.equal(h.model.calls.length, 0, 'no loop before the code');
  h.computer.assistantFinal('s1', startAsk.needs_confirm.spoken);
  h.clock.t += 1000;
  say(h, 'Ja drei neun');
  await until(() => ended(h));
  assert.equal(h.vision.ofOp('confirm')[0].digits, '39');
  assert.ok(h.model.calls.length >= 1);
  const h2 = setup({ script: [call('done', { summary: 'x' })], app: (w) => (w.op === 'start' ? startAsk : { ok: true, code: 'done' }) });
  await h2.computer.begin('s1', { text: GOAL, goalArg: '' });
  await asked(h2);
  h2.computer.assistantFinal('s1', startAsk.needs_confirm.spoken);
  h2.clock.t += 1000;
  say(h2, 'Nein');
  await until(() => ended(h2));
  assert.equal(h2.model.calls.length, 0);
  assert.equal(stopReason(h2), 'nein');
  assert.equal(h2.vision.ofOp('stop').length, 1);
});
test('speakers: an extension needs the code; the goal changes only after it, and the new goal stays in every later model turn', async () => {
  const extAsk = R2('7b7b7b7b7b7b7b7b', 'Auftrag erweitern um: „öffne auch github.com“.');
  const h = setup({ script: [call('ui_windows'), call('ui_windows'), call('done', { summary: 'x' })], app: (w) => (w.op === 'start' && w.extend ? extAsk : w.op === 'confirm' ? ok({ rule: 'run-extend' }) : w.op === 'action' ? ok() : { ok: true, code: 'done' }) });
  h.model.calls.length = 0;
  const gate = new Promise((res) => { h.release = res; });
  const app = h.vision.app;
  h.vision.app = async (w) => { if (w.op === 'action' && w.seq > 3) await gate; return app(w); };
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await until(() => h.model.calls.length >= 1);
  say(h, 'Und öffne auch github.com', { turn: 11 });
  await asked(h);
  assert.equal(h.computer.runOf('s1').goalText, GOAL, 'not before the code');
  h.computer.assistantFinal('s1', extAsk.needs_confirm.spoken);
  h.clock.t += 1000;
  say(h, 'Ja eins zwei', { turn: 12 });
  await until(() => h.computer.runOf('s1')?.goalText.includes('github.com'));
  h.release();
  await until(() => ended(h));
  const last = h.model.calls.at(-1).messages;
  assert.ok(last.find((m) => m.role === 'user').content.includes('github.com'), 'the extended goal is part of the first message of later turns');
});

// ---- trace
test('trace (session): the app\'s R2 text and his answers to an ask are in the durable trace as lengths only', async (t) => {
  resetActions();
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], close() { this.readyState = 3; } });
  ws.send = (d) => ws.sent.push(d);
  let emit, clockNow = 1_000_000;
  const traced = [], vision = fakeVision(), model = scriptedModel([call('chrome_click', { ref: 'e5' }), call('done', { summary: 'fertig' })]);
  vision.app = (w) => (w.op === 'action' ? R2() : { ok: true, code: 'done' });
  const computer = createComputer({ vision, hub: {}, now: () => clockNow, complete: model, tickMs: 1e9, limits: { check: () => ({ ok: true }), addCost() {} }, statePath: '' });
  const sessionVision = { attached: () => true, attach: () => () => {}, command: async () => ({ delivered: false }) };
  const deps = { sid: 's1', toolDefs: TOOL_DEFS, audit() {}, limits: { check: () => ({ ok: true }), addCost() {} }, createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }), createCanvas: () => null, vision: sessionVision, computer, runTool,
    makeCtx: () => ({ vision: sessionVision, computer, hub: {}, sid: 's1', audit() {}, trace: () => ({ event() {} }), clock: { now: () => clockNow, sleep: async (ms) => { clockNow += ms; } } }), registerText: () => () => {}, openTrace: () => ({ event: (type, data) => traced.push({ type, ...data }), close() {} }) };
  const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, close() {}, sendToolResult() {}, recover() {} };
  runVoiceSession(ws, deps, { provider: 'xai', apiKey: 'k', now: () => clockNow, mergeMs: 5, noAnswerMs: () => 60_000, create: (_o, e) => { emit = e; return adapter; } });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  msg({ type: 'start', client: 'screen-agent' });
  t.after(() => msg({ type: 'stop' }));
  await new Promise((r) => setTimeout(r, 1));
  emit({ t: 'speech_started' }); clockNow += 300;
  emit({ t: 'transcript', role: 'user', final: true, text: 'Übernimm den Computer und schick die Mail an Anna ab.', itemId: 'i1' });
  emit({ t: 'tool_call', id: 'c1', name: 'computer_task', args: { goal: 'Mail' } });
  await until(() => computer.runOf('s1')?.pending?.state === 'saying');
  emit({ t: 'transcript', role: 'assistant', final: true, text: SPOKEN });
  clockNow += 2000;
  emit({ t: 'transcript', role: 'user', final: true, text: 'Ja vier sieben', itemId: 'i2' });
  await until(() => !computer.isOpen('s1'));
  const lines = traced.filter((e) => /^transcript\.(assistant|user)\.final$/.test(e.type));
  const all = JSON.stringify(traced);
  assert.ok(!all.includes('anna@example.org'), 'the spoken R2 text (recipient) is not in the trace');
  assert.ok(!/vier sieben/i.test(JSON.stringify(lines.filter((e) => e.computer))), 'his code answer is not in the trace');
  assert.ok(lines.some((e) => e.computer && e.chars === SPOKEN.length), 'length only');
  assert.ok(lines.some((e) => e.type === 'transcript.user.final' && e.text?.startsWith('Übernimm')), 'his first sentence is traced as before');
});

// ---- redact before the provider, quiet hook
test('provider: app results are redacted before they reach the loop model', async () => {
  const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789';
  const h = setup({ script: [call('chrome_read', { tab: 'AB12CD34' }), call('done', { summary: 'x' })], app: (w) => (w.op === 'action' ? ok({ result: { text: `Seite mit Schlüssel ${KEY} und Rest` } }) : { ok: true, code: 'done' }) });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await until(() => ended(h));
  const tool = h.model.calls[1].messages.find((m) => m.role === 'tool').content;
  assert.ok(!tool.includes(KEY) && !tool.includes('0123456789abcdef0123'), tool);
  assert.match(tool, /Seite mit Schlüssel/);
});

// ---- web_read in the guard window
test('web_read is closed during a run and for 5 minutes after, like the two action tools', async () => {
  const ctx = { computer: { guarded: () => true }, sid: 's1', audit() {}, hub: {}, trace: () => ({ event() {} }) };
  const r = await runTool('web_read', { url: 'https://example.org/' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.content, /gesperrt/);
  const open = await runTool('web_read', { url: 'http://127.0.0.1/' }, { ...ctx, computer: { guarded: () => false } });
  assert.doesNotMatch(open.content ?? '', /gesperrt/, 'outside the window the normal path (here: a private address refusal) answers');
});

// ---- caps
test('caps: NaN, text and negative values fall back to the default; the daily counter survives a restart', async () => {
  for (const bad of ['abc', 'NaN', '-3', '']) {
    process.env.DESK_COMPUTER_RUN_USD = bad; process.env.DESK_COMPUTER_DAY_USD = bad;
    assert.equal(cfg.computerRunUsd(), 1.5, bad);
    assert.equal(cfg.computerDayUsd(), 5, bad);
  }
  process.env.DESK_COMPUTER_RUN_USD = '0.25'; assert.equal(cfg.computerRunUsd(), 0.25);
  delete process.env.DESK_COMPUTER_RUN_USD; delete process.env.DESK_COMPUTER_DAY_USD;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cday-')), 'day.json');
  const clock = { t: Date.UTC(2026, 10, 3, 12) };
  const mk = () => {
    const vision = fakeVision(); vision.app = () => ok();
    const c = createComputer({ vision, hub: {}, now: () => clock.t, complete: scriptedModel([call('ui_windows'), call('done', { summary: 'x' })], { costUsd: 2.4 }), tickMs: 1e9, limits: { check: () => ({ ok: true }), addCost() {} }, statePath: file });
    const session = { client: 'screen-agent', say: () => true, trace() {}, activity() {} };
    c.attach('s1', session);
    return c;
  };
  process.env.DESK_COMPUTER_RUN_USD = '9';
  const a = mk();
  assert.equal((await a.begin('s1', { text: GOAL, goalArg: '' })).ok, true);
  await until(() => a.runOf('s1') === null);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).usd >= 4.7);
  const b = mk(); // "gateway restart": a new manager reads the file
  const again = await b.begin('s1', { text: GOAL, goalArg: '' });
  assert.equal(again.ok, true, 'still below USD 5 after one run');
  await until(() => b.runOf('s1') === null);
  const c = mk();
  const third = await c.begin('s1', { text: GOAL, goalArg: '' });
  assert.equal(third.ok, false, 'the day is used up after the restart');
  assert.match(third.text, /Tageslimit/);
  delete process.env.DESK_COMPUTER_RUN_USD;
});

test('asks cap is 8', () => assert.equal(MAX_ASKS, 8));
test('checkComputerTrigger carries the new filters (the latest spoken final only)', () => {
  const e = (text) => ({ text, at: 1_000_000 });
  assert.equal(checkComputerTrigger([e('Er übernimmt die Kosten.')], 1_000_100).ok, false);
  assert.equal(checkComputerTrigger([e('Übernimm den Computer.')], 1_000_100).ok, true);
});
