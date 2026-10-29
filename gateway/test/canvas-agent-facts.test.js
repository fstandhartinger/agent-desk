// Critic round 1, P1-1: the automatic illustrator drew "kein Treffer" / "fehlt ein Werkzeug" next to correct answers because it
// never saw the main agent's read-tool results. Now: the early / automatic run waits (bounded) for the agent's reads, gets their
// results as "Fakten vom Desk-Agenten", and a drawing that claims missing data is repaired or dropped. Synthetic data only.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_TIMEOUT_MS: '600', DESK_CANVAS_DEBOUNCE_MS: '30', DESK_CANVAS_RESEARCH_MS: '60' });
const { createCanvasBus } = await import('../src/canvasBus.js');
const { SYSTEM_PROMPT, claimsMissing, createCanvasSession, createIllustrator, createMemory, needsAgentFacts } = await import('../src/illustrator.js');

// The critic's repro questions (out/f3-*.json), verbatim apart from the synthetic ids.
const REPROS = [
  'Lies bitte den Board-Eintrag #31300 und sag mir in einem Satz, worum es geht und wer ihn geschrieben hat.',
  'Lies bitte die Webseite https://en.wikipedia.org/wiki/Server-side_request_forgery und fasse den ersten Absatz in zwei Sätzen zusammen.',
  'Zeig mir bitte die Liste meiner letzten Discord-DMs (discord_read ohne Kanal).',
  'Wie viel Plattenplatz ist auf Sandy frei? Nutze run_readonly disk.',
  "Such bitte nur in den Codex-Chats (agent codex) nach 'quota-pace' und lies einen Treffer mit chat_read an. Was war die Aufgabe?",
  'Such bitte in Florians Gmail nach Mails von GitHub aus den letzten Tagen und nenn mir die drei neuesten Betreffzeilen.',
  'Lies bitte die Mail account gmail uid 12345 (mail_read) und sag mir genau: welche Datei, welcher Commit, welcher Secret-Typ wurde gemeldet, und wann.',
  "Such bitte in den Claude-Code-Chats nach 'squash-publish' und lies den besten Treffer kurz an (chat_read): worum ging es in dem Chat?",
  'Lies bitte den Skill prompt-finder und sag mir, welche Verzeichnisse er für OpenCode durchsucht.',
];
// What the illustrator drew live for them (critic out/canvases.json): every one must be caught by the guard.
const FALSE_CAPTIONS = [
  'Board-Eintrag #31300: kein Treffer', 'Einen Eintrag #31300 gibt es nicht; die Suche liefert nur einen anderen Eintrag.',
  'Diesem Desk fehlt ein Werkzeug zum Abrufen von Webseiten, daher gibt es keine Quelle.', 'Discord-DMs: Liste nicht abrufbar',
  'Die disk-Abfrage lieferte keine Werte.', 'Kein Treffer zu „quota-pace“ in den Codex-Chats.', 'Gmail-Suche nach GitHub-Mails: kein Suchlauf',
  'Die Gmail-Mail konnte nicht gelesen werden.', 'Das Tool wurde in diesem Gespräch nicht aufgerufen – Ergebnisse fehlen noch.',
];

const flow = (extra = {}) => JSON.stringify({ v: 2, id: 'x', kind: 'flow', title: 'Plattenplatz auf Sandy', caption: 'Laut Statusbefehl sind 120 GB frei.', sources: [{ label: 'run_readonly disk', ref: 'Gespräch' }], nodes: [{ id: 'a', label: 'Sandy' }, { id: 'b', label: 'Platte /' }, { id: 'c', label: '120 GB frei' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], ...extra });
const answer = (content) => ({ message: { content, tool_calls: [] }, costUsd: 0.001 });
const DISK = 'Filesystem Size Used Avail\n/dev/sda1 500G 380G 120G';

let bus; let calls; let audits; let script;
const complete = async (call) => { calls.push({ ...call, at: Date.now(), messages: structuredClone(call.messages) }); return script(call, calls.length - 1); };
const run = async () => ({ ok: true, content: '{}', summary: 's' });
const make = () => createIllustrator({ bus, hub: {}, complete, run, audit: (a) => audits.push(a) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = () => bus.replay(0).map((e) => e.event).filter((e) => e.phase === 'ready');
const userTexts = (call) => call.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');

beforeEach(() => { bus = createCanvasBus(); calls = []; audits = []; script = () => answer(flow()); });

describe('P1-1: questions answered by the agent\'s read tools', () => {
  it('every critic repro question is recognised; ordinary explanations are not', () => {
    for (const q of REPROS) assert.ok(needsAgentFacts(q), q);
    for (const q of ['Wie funktioniert die Video-Sendeblockierung?', 'Erklär mir die Architektur vom Gateway', 'Wofür geben wir das Geld aus?']) assert.ok(!needsAgentFacts(q), q);
  });

  it('the guard catches every false "no data / no tool" caption the critic saw, and passes normal drawings', () => {
    for (const caption of FALSE_CAPTIONS) assert.ok(claimsMissing({ title: 'T', caption }), caption);
    assert.equal(claimsMissing(JSON.parse(flow())), null);
    assert.equal(claimsMissing({ title: 'Ablauf des Links', caption: 'Ohne Seitenlink blockiert die Link-Prüfung.', nodes: [{ id: 'a', label: 'Guard' }] }), null);
  });

  it('the prompt forbids drawing claims about missing data or tools', () => {
    assert.match(SYSTEM_PROMPT, /NEVER draw a claim that data or a tool is missing/);
    assert.match(SYSTEM_PROMPT, /draw only what the conversation shows/);
    assert.ok(!/say so in the caption/.test(SYSTEM_PROMPT));
  });
});

describe('P1-1: the early run waits for the agent\'s result and draws from it', () => {
  it('scripted: the agent\'s run_readonly result arrives after 80 ms → the first model round already sees it', async () => {
    const memory = createMemory();
    const q = REPROS[3];
    memory.noteTurn({ role: 'user', text: q });
    const t0 = Date.now();
    const drawing = make().draw({ id: 'platz', request: q, question: q, early: true, by: 'auto', publish: (e) => bus.publish(e), memory });
    memory.agentToolStarted();
    setTimeout(() => memory.noteTool({ name: 'run_readonly', args: { command: 'disk' }, ok: true, content: DISK }), 80);
    const r = await drawing;
    assert.equal(r.ok, true);
    assert.ok(calls[0].at - t0 >= 70, 'no model round before the agent\'s result');
    assert.match(userTexts(calls[0]), /Fakten vom Desk-Agenten[\s\S]*run_readonly[\s\S]*120G/);
    assert.equal(ready()[0].spec.caption, 'Laut Statusbefehl sind 120 GB frei.');
  });

  it('through a canvas session (text chat order): userTurn → toolStarted → noteTool; the drawing carries the agent\'s fact', async () => {
    const s = createCanvasSession({ bus, illustrator: make(), by: 'text', emit: () => {}, ctx: {}, debounceMs: () => 30, researchMs: () => 60 });
    const q = 'Erklär mir bitte, wie viel Plattenplatz auf Sandy frei ist und wie sich das aufteilt (run_readonly disk).';
    s.startTurn();
    s.noteTurn({ role: 'user', text: q });
    const decided = s.userTurn(q);
    s.toolStarted();
    await wait(40);
    s.noteTool({ name: 'run_readonly', args: { command: 'disk' }, ok: true, content: DISK });
    s.noteTurn({ role: 'assistant', text: 'Auf Sandy sind 120 GB frei.' });
    s.autoTurn({ userText: q, answerText: 'Auf Sandy sind 120 GB frei.' });
    await s.idle();
    assert.ok(calls.length >= 1, `drawn (${decided})`);
    assert.match(calls.map(userTexts).join('\n'), /120G/);
  });

  it('bounded: with no agent result the run still draws after the wait budget (half the canvas timeout)', async () => {
    const memory = createMemory();
    const q = REPROS[0];
    const t0 = Date.now();
    memory.agentToolStarted(); // never reports back
    const r = await make().draw({ id: 'eintrag', request: q, question: q, early: true, by: 'auto', publish: (e) => bus.publish(e), memory });
    assert.equal(r.ok, true);
    assert.ok(calls[0].at - t0 >= 250 && calls[0].at - t0 < 600, `waited ${calls[0].at - t0} ms`);
  });

  it('an ordinary early question does not wait at all', async () => {
    const memory = createMemory();
    memory.agentToolStarted();
    const t0 = Date.now();
    await make().draw({ id: 'video', request: 'Wie funktioniert die Video-Sendeblockierung?', question: 'Wie funktioniert die Video-Sendeblockierung?', early: true, by: 'auto', publish: (e) => bus.publish(e), memory });
    assert.ok(calls[0].at - t0 < 100);
  });
});

describe('P1-1: a "no data" drawing is repaired or dropped', () => {
  it('first answer "kein Treffer" → repair round with the agent facts → the corrected drawing is shown', async () => {
    const memory = createMemory();
    const q = REPROS[0];
    memory.noteTurn({ role: 'user', text: q });
    memory.noteTool({ name: 'board_entry', args: { id: 31300 }, ok: true, content: '{"id":31300,"by":"beispiel-job","title":"Synthetischer Eintrag"}' });
    script = (_c, i) => answer(i === 0
      ? flow({ title: 'Board-Eintrag #31300: kein Treffer', caption: 'Einen Eintrag #31300 gibt es nicht.' })
      : flow({ title: 'Board-Eintrag #31300', caption: 'Geschrieben von beispiel-job.' }));
    await make().draw({ id: 'eintrag', request: q, question: q, early: true, by: 'auto', publish: (e) => bus.publish(e), memory });
    assert.equal(calls.length, 2);
    assert.match(userTexts(calls[1]), /data or a tool is missing/);
    assert.deepEqual(ready().map((e) => e.spec.title), ['Board-Eintrag #31300']);
  });

  it('twice "nicht abrufbar" → nothing is published (the automatic placeholder goes away)', async () => {
    script = () => answer(flow({ title: 'Discord-DMs: Liste nicht abrufbar', caption: 'Ohne Ergebnis gibt es keine Liste.' }));
    const memory = createMemory();
    const r = await make().draw({ id: 'dms', request: REPROS[2], question: REPROS[2], early: true, by: 'auto', publish: (e) => bus.publish(e), memory });
    assert.equal(r.ok, false);
    assert.deepEqual(ready(), []);
  });

  it('the agent\'s own explicit canvas_draw is not judged by this guard', async () => {
    script = () => answer(flow({ title: 'Suche ohne Treffer', caption: 'Kein Treffer in den Job-Dateien.' }));
    const r = await make().draw({ id: 'suche', request: 'Zeichne: die Suche ergab keinen Treffer', by: 'text', publish: (e) => bus.publish(e), memory: createMemory() });
    assert.equal(r.ok, true);
  });
});
