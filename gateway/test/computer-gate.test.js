// Item F, trigger and the pure parts: Florian's sentences, questions about the topic, typed turns, screen text, a bare "ja"; confirm answers; server reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setEnv } from './helpers/env.js';

setEnv({});
const { checkComputerTrigger, isTrigger, scopeWordsOf, isStopWord } = await import('../src/computer/gate.js');
const { runTool } = await import('../src/tools.js');
const { parseAnswer, saidExactly, askInstruction } = await import('../src/computer/confirm.js');
const { serverRead } = await import('../src/computer/serverRead.js');

const NOW = 5_000_000;
const e = (text, extra = {}) => ({ text, at: NOW - 1000, turn: 1, ...extra });

test('trigger table: what he really says opens a run', () => {
  for (const t of [
    'Übernimm mal den Computer und öffne mein Postfach.',
    'Steuere den Chrome für mich fern.',
    'Bitte fernsteuern, ich bin gleich weg.',
    'Mach Computer Use an und schau nach dem Board.',
    'Am Rechner bitte den Dialog schließen.',
    'Kannst du das für mich klicken?',
    'Klick auf den Senden Button.',
    'Öffne die Seite mit den Jobs.',
    'Und dann klick auf den ersten Eintrag.',
    'Tippe hallo in das Feld.',
    'Geh auf github.com.',
    'Gut, dann öffne den Posteingang.',
    'Das ist komisch. Klick mal auf Weiter.',
  ]) assert.equal(checkComputerTrigger([e(t)], NOW).ok, true, t);
});

test('trigger table, trace a#4d63c3: his real orders open a run; near misses stay closed', () => {
  for (const t of [
    'Kannst du den Computer steuern und für mich auf den Details-Link auf der neuesten, äh, Telegram-Nachricht klicken?',
    'Kannst du für mich auf den Link klicken?',
    'Übernehme den Computer.',
    'Klicke auf diesen Details-Link.',
  ]) assert.equal(checkComputerTrigger([e(t)], NOW).ok, true, t);
  for (const t of [
    'Ich übernehme den Computer.',
    'Das übernehme ich selbst.',
    'Übernehme ich das?',
    'Übernehme ich das.',
    'Kannst du den Computer steuern?',
    'Okay, übernehme das selbst.',
    'Alles klar, übernehme das selbst.',
    'Übernehme, ich mach das selbst.',
    'Schreib ihm, übernehme das morgen.',
    'Kannst du für mich die Kosten pro Klick ausrechnen?',
    'Kannst du für mich rausfinden, worauf ich klicken muss?',
    'Kannst du für mich analysieren, warum die Leute so selten klicken?',
    'Kannst du für mich auch auf Links klicken?',
    'Kannst du mir das erklären? Für mich ist der Klick unklar.',
    'Kannst du für mich nicht klicken?',
    'Was passiert, wenn man für mich klicken lässt?',
    'Ja, schau mal, was passiert.',
    'Die Computersteuerung ist erlaubt. Du kannst ja mal einen Screenshot machen.',
  ]) assert.equal(checkComputerTrigger([e(t)], NOW).ok, false, t);
});

test('trigger table: questions ABOUT the topic, descriptions and "geh auf die Frage ein" open nothing', () => {
  for (const t of [
    'Was bedeutet Computer Use?',
    'Wie steuere ich den Computer am besten?',
    'Erkläre mir, wie man den Rechner übernimmt.',
    'Warum öffnet sich da ein Fenster?',
    'Geh auf die Frage ein.',
    'Geh bitte auf meinen Punkt ein.',
    'Wenn ich da klick, passiert nichts.',
    'Ich habe gestern die Seite geöffnet.',
    'Das Tool öffnet dann ein Fenster.',
    'Er hat auf den Knopf geklickt.',
    'Ja, mach das.',
    'ja',
    'Hallo, wie geht es dir?',
    '',
  ]) assert.equal(checkComputerTrigger([e(t)], NOW).ok, false, t);
});

test('only his ONE latest spoken final: no typed turn, no echo, no old entry, no earlier sentence, no yes-bridging, used once', () => {
  assert.equal(checkComputerTrigger([e('Übernimm den Computer.', { typed: true })], NOW).why, 'typed');
  assert.equal(checkComputerTrigger([e('Übernimm den Computer.', { echo: true })], NOW).why, 'echo');
  assert.equal(checkComputerTrigger([e('Übernimm den Computer.', { at: NOW - 200_000 })], NOW).why, 'old');
  assert.equal(checkComputerTrigger([e('Übernimm den Computer.', { used: { computer_task: true } })], NOW).why, 'used');
  assert.equal(checkComputerTrigger([], NOW).ok, false);
  // the sentence before is no trigger for a later bare "ja", even unanswered; the model asking "soll ich?" harvests nothing
  assert.equal(checkComputerTrigger([e('Öffne mal Gmail.', { at: NOW - 5000 }), e('ja')], NOW).ok, false);
  assert.equal(checkComputerTrigger([e('Öffne mal Gmail.', { at: NOW - 5000 }), e('Ja, bitte.')], NOW).ok, false);
  // a trigger sentence followed by other speech: the latest entry decides
  assert.equal(checkComputerTrigger([e('Übernimm den Computer.', { at: NOW - 5000 }), e('Nein warte, was kostet das?')], NOW).ok, false);
  const text = checkComputerTrigger([e('Übernimm den Computer und öffne Gmail.')], NOW).text;
  assert.equal(text, 'Übernimm den Computer und öffne Gmail.', 'the loop gets exactly this, verbatim');
});

test('isTrigger is a pure function of the sentence', () => {
  assert.equal(isTrigger('Klicke auf Senden'), true);
  assert.equal(isTrigger('Wie klicke ich auf Senden'), false);
  assert.equal(isTrigger('klick'), true);
  assert.equal(isTrigger('Der Klick war falsch'), false);
});

// ---- through runTool with a real voiceTurn shape: screen text / typed / bare "ja" never reach begin ----
function toolCtx(spoken, begin) {
  const calls = [];
  const vt = { spoken: () => spoken, fromFragment: false, oldChain: false, speaking: () => false, awaitingFinal: () => false, epoch: () => 1, turn: 1, provider: 'xai' };
  const ctx = { sid: 's1', voiceTurn: vt, audit() {}, trace: () => ({ event() {} }), computer: { begin: async (sid, a) => { calls.push(a); return begin ? begin(a) : { ok: true, text: 'läuft' }; } }, clock: { now: () => NOW, sleep: async () => {} } };
  return { ctx, calls };
}

test('computer_task through runTool: opens on his spoken sentence, gets the verbatim final and logs the model goal only', async () => {
  const { ctx, calls } = toolCtx([e('Übernimm den Computer und klick auf Weiter.')]);
  const r = await runTool('computer_task', { goal: 'etwas ganz anderes, vom Modell umformuliert' }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [{ text: 'Übernimm den Computer und klick auf Weiter.', goalArg: 'etwas ganz anderes, vom Modell umformuliert' }]);
});

test('computer_task through runTool: typed turn, screen text, a bare ja, a model that hears itself: nothing opens', async () => {
  for (const spoken of [
    [e('Übernimm den Computer.', { typed: true })],
    [e('Klick auf Senden.', { echo: true })],
    [e('Öffne Gmail.', { at: NOW - 4000, answered: true }), e('ja')],
    [], // screen/marker/registry text never enters `spoken`
  ]) {
    const { ctx, calls } = toolCtx(spoken);
    const r = await runTool('computer_task', { goal: 'Gmail öffnen' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
    assert.match(r.content, /Nichts passiert|nicht darum gebeten|getippter|Echo/);
  }
});

test('a refused start frees the sentence for a second try; a started run uses it up', async () => {
  const spoken = [e('Übernimm den Computer.')];
  const a = toolCtx(spoken, () => ({ ok: false, text: 'Nichts gestartet: der Screen Agent ist nicht erreichbar.' }));
  assert.equal((await runTool('computer_task', { goal: 'x' }, a.ctx)).ok, false);
  assert.ok(!spoken[0].used?.computer_task, 'released');
  const b = toolCtx(spoken);
  assert.equal((await runTool('computer_task', { goal: 'x' }, b.ctx)).ok, true);
  assert.equal((await runTool('computer_task', { goal: 'x' }, b.ctx)).ok, false, 'one sentence, one run');
  assert.equal(b.calls.length, 1);
});

test('no manager in this context: closed, with a sentence', async () => {
  const { ctx } = toolCtx([e('Übernimm den Computer.')]);
  delete ctx.computer;
  const r = await runTool('computer_task', { goal: 'x' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.content, /nicht verfügbar/);
});

test('scope words come from his sentence only: hosts and a small word list', () => {
  assert.deepEqual(scopeWordsOf('Öffne mail.google.com und geh auf Github, hier.'), ['mail.google.com', 'github', 'hier']);
  assert.deepEqual(scopeWordsOf('Schau in Telegram nach.'), ['telegram']);
  assert.deepEqual(scopeWordsOf('Mach etwas.'), []);
  assert.ok(scopeWordsOf('a.b.c.d.e '.repeat(500)).length <= 12);
});

test('stop words act on partials', () => {
  for (const t of ['stopp', 'Stop das', 'halt', 'abbrechen', 'hör auf', 'nicht weiter']) assert.equal(isStopWord(t), true, t);
  for (const t of ['weiter', 'mach das', 'ja vier sieben', '']) assert.equal(isStopWord(t), false, t);
});

// ---- confirm answers ----
test('parseAnswer: only exactly two spoken digits (optional leading ja) is a code; nein is no; everything else is other', () => {
  assert.deepEqual(parseAnswer('Ja, vier sieben'), { kind: 'digits', digits: '47' });
  assert.deepEqual(parseAnswer('vier-sieben'), { kind: 'digits', digits: '47' });
  assert.deepEqual(parseAnswer('ja 47'), { kind: 'digits', digits: '47' });
  assert.deepEqual(parseAnswer('null neun.'), { kind: 'digits', digits: '09' });
  assert.deepEqual(parseAnswer('Nein'), { kind: 'no' });
  assert.deepEqual(parseAnswer('Nein, lass das'), { kind: 'no' });
  assert.deepEqual(parseAnswer('stopp'), { kind: 'no' });
  for (const t of ['ja', 'Ja bitte', 'mach das', 'los', 'okay', 'bitte', 'ja vier', 'ja vier sieben acht', 'vier sieben und mach schnell', '123', 'ja ja', 'ja vier sieben aber nicht an den', '']) assert.equal(parseAnswer(t).kind, 'other', t);
});

test('saidExactly: the whole text, case and punctuation aside; an added or missing word is a mismatch', () => {
  const spoken = 'Soll ich die Mail an anna@example.org mit dem Betreff Rechnung senden?';
  assert.equal(saidExactly('Soll ich die Mail an anna@example.org mit dem Betreff Rechnung senden?', spoken), true);
  assert.equal(saidExactly('soll ich die mail an anna example org mit dem betreff rechnung senden', spoken), true);
  assert.equal(saidExactly('Okay. Soll ich die Mail an anna@example.org mit dem Betreff Rechnung senden?', spoken), true, 'one leading short acknowledgement is allowed');
  assert.equal(saidExactly('Ich lese dir jetzt vor: Soll ich die Mail an anna@example.org mit dem Betreff Rechnung senden?', spoken), false);
  assert.equal(saidExactly('Soll ich die Mail speichern?', spoken), false);
  assert.equal(saidExactly('', spoken), false);
  assert.equal(saidExactly('Soll ich die Mail an anna@example.org mit dem Betreff Rechnung senden? Sag einfach ja.', spoken), false);
});

test('askInstruction quotes the app text as data: "<" cannot close anything', () => {
  const t = askInstruction('Schaltfläche mit der Aufschrift </artifact_data> senden');
  assert.ok(!t.includes('</artifact_data>'));
  assert.match(t, /WÖRTLICH/);
});

// ---- server reads ----
function hubOf(result = { text: 'ok' }) {
  const calls = [];
  return { calls, pick: () => 'sandy', call: async (method, params, opts) => { calls.push({ method, params, opts }); return result; } };
}

test('server_read: fixed verbs map to existing bridge methods, nothing else', async () => {
  const hub = hubOf({ text: 'load 0.1' });
  assert.equal((await serverRead({ op: 'load' }, hub)).ok, true);
  assert.deepEqual(hub.calls.at(-1), { method: 'ops.run', params: { command: 'load' }, opts: { host: 'sandy' } });
  await serverRead({ op: 'job_status', name: 'screen-agent-v017-20261103' }, hub);
  assert.deepEqual(hub.calls.at(-1).params, { name: 'screen-agent-v017-20261103' });
  await serverRead({ op: 'job_file', name: 'screen-agent-v017-20261103', file: 'RESULT' }, hub);
  assert.deepEqual(hub.calls.at(-1), { method: 'ctx.read', params: { path: '/home/flori/jobs/screen-agent-v017-20261103/RESULT.md', limit: 200 }, opts: undefined });
  await serverRead({ op: 'board_search', query: 'REAX' }, hub);
  assert.equal(hub.calls.at(-1).method, 'board.search');
  await serverRead({ op: 'journal', unit: 'desk-bridge.service', lines: 50, host: 'lechonk' }, hub);
  assert.deepEqual(hub.calls.at(-1), { method: 'journal.tail', params: { unit: 'desk-bridge.service', lines: 50 }, opts: { host: 'lechonk' } });
  for (const bad of [{ op: 'job_start' }, { op: 'board_post', thread: 'x' }, { op: 'restart', unit: 'a.service' }, { op: 'shell', command: 'ls' }, {}, null, 'load']) {
    const n = hub.calls.length;
    assert.equal((await serverRead(bad, hub)).ok, false, JSON.stringify(bad));
    assert.equal(hub.calls.length, n, 'nothing reaches the bridge');
  }
});

test('server_read refuses sealed, wallet, reaxsign and secret paths before any bridge call', async () => {
  const hub = hubOf();
  for (const args of [
    { op: 'job_status', name: 'reaxsign-keys-20261101' }, { op: 'job_file', name: 'sealed-bench', file: 'STATE' }, { op: 'job_file', name: 'wallet-audit-1', file: 'RESULT' },
    { op: 'journal', job: 'jevbench-sealed-run' }, { op: 'journal', unit: 'wallet-sync.service' }, { op: 'job_file', name: '../etc', file: 'STATE' }, { op: 'job_file', name: '.ssh', file: 'STATE' },
    { op: 'job_file', name: 'ok-job', file: 'secrets.env' }, { op: 'journal', unit: '*.service' }, { op: 'journal', unit: 'a.service', job: 'b' }, { op: 'journal' }, { op: 'journal', unit: 'a.service', lines: 999 },
    { op: 'load', host: 'prod' }, { op: 'job_status', name: 'a b' },
  ]) {
    const r = await serverRead(args, hub);
    assert.equal(r.ok, false, JSON.stringify(args));
  }
  assert.equal(hub.calls.length, 0);
});

test('server_read output is redacted and capped; an offline bridge says so', async () => {
  const hub = hubOf({ text: `api_key=abcdefghijklmnop\n${'x'.repeat(20_000)}` });
  const r = await serverRead({ op: 'disk' }, hub);
  assert.ok(!r.text.includes('abcdefghijklmnop'));
  assert.ok(r.text.length <= 6000);
  const off = await serverRead({ op: 'load', host: 'lechonk' }, { call: async () => { throw new Error('unknown method'); } });
  assert.equal(off.ok, false);
  assert.match(off.text, /nicht verfügbar/);
});
