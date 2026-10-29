// Critic round 5, slice r6-misc: P2-2 (write intent / proposal turns), P2-3 (failed tools, caption claims), P2-5 (card title),
// P2-7 (pseudo paths). All data synthetic.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_TIMEOUT_MS: '400', DESK_CANVAS_DEBOUNCE_MS: '30' });
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator, unsupportedClaim } = await import('../src/illustrator.js');
const { wantsWriteAction } = await import('../src/canvas.js');
const { createProseGuard } = await import('../src/proseGuard.js');
const { runTool, pseudoPathRefusal } = await import('../src/tools.js');

const flow = JSON.stringify({ v: 2, id: 'ablauf', kind: 'flow', title: 'Ablauf', caption: 'Kurz.', sources: [], nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
let bus; let calls; let events;
const complete = async (call) => { calls.push(call); return { message: { content: flow, tool_calls: [] }, costUsd: 0 }; };
const run = async () => ({ ok: true, content: '{"ok":true}', summary: 's' });
beforeEach(() => { bus = createCanvasBus(); calls = []; events = []; bus.subscribe((e) => events.push(e)); });
const session = (extra = {}) => createCanvasSession({ bus, illustrator: createIllustrator({ bus, hub: {}, complete, run, audit: () => {} }), by: 'text', emit: () => {}, ctx: {}, debounceMs: () => 30, researchMs: () => 5000, ...extra });
const EXPLAIN = 'Der Agent bekommt den Auftrag erst nach Florians Klick. Dann arbeitet er ihn ab und meldet sich zurück.';

describe('P2-2 write intent', () => {
  it('detects "antworte/schreib/sag ... auf/per/via <channel>", English forms and "Bescheid geben"', () => {
    for (const t of [
      'Antworte Anna auf Discord bitte mit "Passt".',
      'Schreib Anna auf Discord: Wir sind fertig',
      'Sag Anna auf Discord Bescheid',
      'Antworte Ben per Mail',
      'Schreib ihr via Telegram, dass es klappt',
      'Reply to Anna on Discord',
      'Answer Ben via mail please',
      'Write to Ben on Slack that we are done',
      'Gib Ben kurz Bescheid',
      'Sag Ben Bescheid, dass es fertig ist',
    ]) assert.equal(wantsWriteAction(t), true, t);
  });
  it('does not flag questions or plain explanations', () => {
    for (const t of ['Wie schreibe ich auf Discord einen Kanal an?', 'Erkläre mir, wie Antworten per Mail funktionieren', 'Was sagt das Board zu Discord?', 'Schreib mir auf, was gestern passiert ist', 'Explain how the reply works on Discord']) assert.equal(wantsWriteAction(t), false, t);
  });
  it('a turn that called handoff_propose / claude_task is never auto-drawn, even when the call failed or the ask looked harmless', async () => {
    for (const name of ['handoff_propose', 'claude_task']) {
      const s = session();
      s.startTurn();
      s.toolStarted(name);
      s.noteTool({ name, args: {}, ok: false, content: 'ERROR' });
      assert.equal(s.autoTurn({ userText: 'Wie läuft das ab, wenn der Agent das macht?', answerText: EXPLAIN }), 'write-intent', name);
      await s.idle();
      s.close();
    }
    assert.equal(calls.length, 0);
    assert.equal(events.length, 0);
  });
  it('an early drawing that started before the proposal tool ran is dropped', async () => {
    const slow = createIllustrator({ bus, hub: {}, complete: async (c) => { await new Promise((r) => setTimeout(r, 150)); return complete(c); }, run, audit: () => {} });
    const s = session({ illustrator: slow });
    s.startTurn();
    s.userTurn('Wie funktioniert der Mailversand im Desk genau, Schritt für Schritt?');
    s.toolStarted('handoff_propose');
    await s.idle();
    assert.ok(events.some((e) => e.phase === 'pending'), 'the early drawing had started');
    assert.equal(events.at(-1).phase, 'dropped', 'and was dropped');
    s.close();
  });
});

describe('P2-3 failed tools and caption claims', () => {
  it('no automatic drawing when every data tool of the turn failed', async () => {
    const s = session();
    s.startTurn();
    s.toolStarted('discord_read');
    s.noteTool({ name: 'discord_read', args: {}, ok: false, content: 'ERROR: home-IP Chrome busy' });
    assert.equal(s.autoTurn({ userText: 'Wie sieht der Discord-Verlauf mit Anna aus?', answerText: 'Den Verlauf konnte ich nicht holen, weil der Browser gerade belegt ist. Versuch es gleich noch einmal.' }), 'tools-failed');
    await s.idle();
    assert.equal(calls.length, 0);
    s.close();
  });
  it('one successful data tool keeps the automatic drawing possible', () => {
    const s = session();
    s.startTurn();
    s.noteTool({ name: 'discord_read', args: {}, ok: false, content: 'ERROR' });
    s.noteTool({ name: 'board_read', args: {}, ok: true, content: 'x' });
    assert.equal(s.autoTurn({ userText: 'Wie funktioniert der Ablauf im Board genau?', answerText: EXPLAIN }), 'scheduled');
    s.close();
  });
  it('unsupportedClaim: a rule / allowlist word or a number the facts lack', () => {
    const facts = 'Der Desk liest Webseiten per web_read. Fünf Versuche gab es 12 mal.';
    assert.match(unsupportedClaim({ title: 'SSRF-Schutz', caption: 'Erlaubt sind nur example.com und httpbingo.org.' }, facts), /rule claim/);
    assert.match(unsupportedClaim({ title: 'x', caption: 'Es gab 77 Versuche.' }, facts), /number 77/);
    assert.equal(unsupportedClaim({ title: 'Ablauf', caption: 'Der Desk liest 12 Webseiten per web_read.' }, facts), null);
    assert.equal(unsupportedClaim({ title: 'Ablauf', caption: 'Erlaubt ist nur web_read.' }, `${facts} erlaubt`), null);
    assert.equal(unsupportedClaim({ title: 'Ablauf', caption: 'Stand 28.10.2026.' }, facts), null);
  });
  it('an automatic canvas loses an invented rule caption (title and nodes stay)', async () => {
    const spec = JSON.stringify({ v: 2, id: 'ssrf', kind: 'flow', title: 'Web-Zugriff', caption: 'Erlaubt sind nur example.com und httpbingo.org.', sources: [], nodes: [{ id: 'a', label: 'Frage' }, { id: 'b', label: 'web_read' }, { id: 'c', label: 'Antwort' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
    const ill = createIllustrator({ bus, hub: {}, complete: async () => ({ message: { content: spec, tool_calls: [] }, costUsd: 0 }), run, audit: () => {} });
    await ill.draw({ request: 'Wie läuft der Web-Zugriff ab?', by: 'auto', provider: 'x', publish: (p) => bus.publish(p), memory: undefined });
    const ready = events.find((e) => e.phase === 'ready');
    assert.ok(ready, 'drawn');
    assert.ok(!/erlaubt/i.test(ready.spec.caption ?? ''), `caption: ${ready.spec.caption}`);
    assert.equal(ready.spec.title, 'Web-Zugriff');
  });
});

describe('P2-5 card title', () => {
  it('the tool result carries the exact title and the first task line with the instruction', async () => {
    const turn = { audit: () => {}, sid: 's1', turnProposals: new Map() };
    const a = await runTool('claude_task', { prompt: 'Teste die Nachricht\nzweite Zeile', title: 'Testnachricht prüfen' }, turn);
    assert.match(a.content, /Titel der Karte \(exakt\): "Testnachricht prüfen"/);
    assert.match(a.content, /Erste Zeile des Auftrags: Teste die Nachricht/);
    assert.match(a.content, /Beschreibe die Karte nur mit diesem Titel/);
    const b = await runTool('handoff_propose', { title: 'Mail an Beispiel', task: 'Antwort schicken' }, turn);
    assert.match(b.content, /Titel der Karte \(exakt\): "Mail an Beispiel"/);
    assert.match(b.content, /Erste Zeile des Auftrags: Antwort schicken/);
  });
  it('the guard removes a card sentence that quotes another title and keeps the right one', () => {
    const guard = createProseGuard({ given: () => '', proposalTitles: () => ['Testnachricht prüfen'] });
    const bad = guard.check('Die Karte heißt „Übernehmen: Testauftrag“ und wartet auf deinen Klick.');
    assert.equal(bad.dropped, true);
    assert.match(bad.notes[0], /card title/);
    assert.equal(guard.check('Die Karte „Testnachricht prüfen“ wartet auf deinen Klick.').dropped, undefined);
    assert.equal(guard.check('Er sagte "irgendwas anderes" im Chat.').dropped, undefined, 'no card word: untouched');
    const none = createProseGuard({ given: () => '' });
    assert.equal(none.check('Die Karte heißt „Erfunden“.').dropped, undefined, 'no proposal in the turn: untouched');
  });
});

describe('P2-7 pseudo paths', () => {
  it('read_file of /dev/null, /proc, "null" is refused before the bridge', async () => {
    for (const path of ['/dev/null', '/dev/zero', '/proc/self/environ', '/sys/kernel', 'null', 'undefined', '']) {
      assert.equal(pseudoPathRefusal('read_file', { path })?.ok, false, path);
      const hub = { calls: 0, call: async () => { hub.calls += 1; return ''; } };
      const out = await runTool('read_file', { path }, { hub, audit: () => {} });
      assert.equal(out.ok, false, path);
      assert.equal(hub.calls, 0, path);
    }
    assert.equal(pseudoPathRefusal('read_file', { path: '/home/flori/jobs/x/STATE.md' }), null);
    assert.equal(pseudoPathRefusal('search_files', { path: '/dev/null' }), null);
  });
});
