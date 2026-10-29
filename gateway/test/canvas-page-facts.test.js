// Critic round 2, P1-2: voice auto-canvases for a clicked element claimed the facts were missing ("nennt aber weder Grenze noch
// Höhe", "stand nicht in den Fakten") next to a correct spoken answer. Now the clicked point (+ its scene narration + the most
// relevant background section) is the FIRST fact source of a drawing about the page, the guard catches any negation about the
// facts / sources, and nothing handed to the voice model (onFacts) carries such a claim. Repro shape: page
// jevbench-v160-method, element "penalty"; all page text here is synthetic.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_TIMEOUT_MS: '800', DESK_CANVAS_DEBOUNCE_MS: '30', DESK_CANVAS_RESEARCH_MS: '60' });
const { createCanvasBus } = await import('../src/canvasBus.js');
const { claimsMissing, createCanvasSession, createIllustrator, createMemory, isPageQuestion, withoutMissingClaims } = await import('../src/illustrator.js');
const { pageFacts } = await import('../src/pack.js');

const QUESTION = 'Ab welcher Grenze gibt es bei diesem Element genau einen Abzug, und wie hoch ist er?';
const PACK = {
  scenes: [
    { id: 'intro', title: 'Worum es geht', start: 0, end: 20, text: 'Die Methode vergleicht öffentliche und versiegelte Aufgaben.', points: [] },
    { id: 'scoring', title: 'Bewertung', start: 20, end: 55, text: 'Liegt die Lücke zwischen öffentlichem und versiegeltem Ergebnis über dem Feld-Median plus 8 Punkten, kostet jeder Punkt darüber einen Punkt Abzug.', points: ['penalty'] },
  ],
  elements: { penalty: { scene: 'scoring', title: 'Abzug für Überanpassung' } },
  deepdive: [
    { heading: 'Einleitung', text: 'Allgemeines zur Testreihe.' },
    { heading: 'Abzug bei großer Lücke', text: 'Der Abzug beginnt oberhalb von Median-Gap + 8 Punkten; je überschüssigem Punkt wird 1 Punkt abgezogen.' },
  ],
};
const page = () => {
  const p = {
    slug: 'jevbench-v160-method-demo', title: 'JevBench Methode (Demo)', t: 30, sceneId: 'scoring', pointId: 'penalty',
    point: { title: 'Abzug für Überanpassung', short: 'Strafe, wenn das öffentliche Ergebnis deutlich besser ist als das versiegelte.', more: 'Grenze: Feld-Median der Lücke + 8 Punkte; je Punkt darüber −1.' },
    context: '', transcriptNear: 'kostet jeder Punkt darüber einen Punkt Abzug',
  };
  Object.defineProperty(p, 'pack', { value: PACK, enumerable: false });
  return p;
};
// what the providers drew live (critic r2 out/canvases.json), verbatim
const FALSE_TEXTS = [
  'Public-vs-Sealed-Gap: eine Schwelle nennt §3 nicht', 'AGENTS.md §3 … nennt aber weder Grenze noch Höhe', '… die Grenzhöhe stand nicht in den Fakten',
  'Die genauen Werte stehen so nicht in der Quelle', 'Zur Höhe gibt es keine Angabe', 'Aus der Seite geht die Grenze nicht hervor',
];
const GOOD = { v: 2, id: 'x', kind: 'flow', title: 'Abzug für Überanpassung', caption: 'Strafe greift erst oberhalb Median-Gap + 8; ein überschüssiger Punkt = −1.', sources: [{ label: 'Erklärseite', ref: 'Gespräch' }], nodes: [{ id: 'a', label: 'Lücke messen' }, { id: 'b', label: 'über Median + 8?', shape: 'diamond' }, { id: 'c', label: '−1 je Punkt' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'ja' }] };
const answer = (spec) => ({ message: { content: JSON.stringify(spec), tool_calls: [] }, costUsd: 0.001 });

let bus; let calls; let audits; let runs; let script;
const complete = async (call) => { calls.push({ ...call, messages: structuredClone(call.messages) }); return script(call, calls.length - 1); };
const run = async (name, args) => { runs.push({ name, args }); return { ok: true, content: '{"found":true,"topic":"x"}\n---\nIrgendein Wissen. Eine Schwelle nennt die Notiz nicht.', summary: 's' }; };
const make = () => createIllustrator({ bus, hub: {}, complete, run, audit: (a) => audits.push(a) });
const ready = () => bus.replay(0).map((e) => e.event).filter((e) => e.phase === 'ready');
const userText = (call) => call.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');

beforeEach(() => { bus = createCanvasBus(); calls = []; audits = []; runs = []; script = () => answer(GOOD); });

describe('P1-2 guard and helpers', () => {
  it('every false caption the critic saw is caught; the correct drawing passes', () => {
    for (const t of FALSE_TEXTS) assert.ok(claimsMissing({ title: 'T', caption: t }), t);
    assert.equal(claimsMissing(GOOD), null);
    for (const t of ['Kein Abzug unterhalb der Grenze', 'Ohne Seitenlink blockiert die Link-Prüfung.', 'Sealed-Set bleibt geheim', 'Lücke ≤ Median + 8: nicht bestraft']) assert.equal(claimsMissing({ title: t }), null, t);
  });
  it('withoutMissingClaims drops only the claiming sentence', () => {
    assert.equal(withoutMissingClaims('Die Grenze ist Median + 8. Die Höhe stand nicht in den Fakten.\nZweite Zeile.'), 'Die Grenze ist Median + 8.\nZweite Zeile.');
  });
  it('pageFacts carries the point, its scene narration and the relevant background section; isPageQuestion', () => {
    const f = pageFacts(page());
    assert.match(f, /^Angeklickt: "penalty" – Abzug für Überanpassung/);
    assert.match(f, /Feld-Median der Lücke \+ 8 Punkte; je Punkt darüber −1/);
    assert.match(f, /Szene "scoring" – Bewertung .*Sprechtext: Liegt die Lücke/);
    assert.match(f, /Abschnitt "Abzug bei großer Lücke"/);
    assert.ok(!JSON.stringify(page()).includes('Abzug bei großer Lücke'), 'the pack stays non-enumerable');
    assert.ok(isPageQuestion(QUESTION, page()));
    assert.ok(isPageQuestion('Wie hoch ist der Abzug genau?', page())); // shares words with the point
    assert.ok(!isPageQuestion('Lies bitte den Board-Eintrag #31300', page()));
    assert.ok(!isPageQuestion('Was läuft gerade auf Sandy?', page()));
    assert.ok(!isPageQuestion(QUESTION, null));
  });
});

describe('P1-2 critic repro (scripted): voice early drawing for the clicked element', () => {
  it('the page facts come FIRST in the prompt, no keyword searches run, the voice model gets the page facts, the drawing is published', async () => {
    const memory = createMemory();
    memory.noteTurn({ role: 'user', text: QUESTION });
    const handed = [];
    const r = await make().draw({ id: 'abzug', request: QUESTION, question: QUESTION, early: true, by: 'auto', provider: 'openai', page: page(), onFacts: (text, meta) => handed.push({ text, meta }), publish: (e) => bus.publish(e), memory });
    assert.equal(r.ok, true, JSON.stringify(r));
    const msg = userText(calls[0]);
    const factsAt = msg.indexOf('Fakten der Erklärseite (ERSTE Quelle');
    assert.ok(factsAt > 0 && factsAt < msg.indexOf('Gespräch (letzte Turns)') && factsAt < msg.indexOf('Fakten aus Werkzeugaufrufen'), msg);
    assert.match(msg, /Grenze: Feld-Median der Lücke \+ 8 Punkte; je Punkt darüber −1/);
    assert.deepEqual(runs, [], 'no knowledge_read / search_files for "grenze gibt diesem element"');
    assert.equal(handed.length, 1);
    assert.match(handed[0].text, /Erklärseite \(angeklicktes Element, erste Quelle\)[\s\S]*Median der Lücke \+ 8/);
    assert.equal(handed[0].meta.strong, true);
    assert.equal(ready()[0].spec.caption, GOOD.caption);
  });

  it('a "nennt aber weder Grenze noch Höhe" drawing goes to repair and is never published', async () => {
    script = (_c, i) => (i === 0 ? answer({ ...GOOD, caption: 'Die Seite nennt aber weder Grenze noch Höhe' }) : answer(GOOD));
    const memory = createMemory();
    memory.noteTurn({ role: 'user', text: QUESTION });
    await make().draw({ id: 'abzug', request: QUESTION, question: QUESTION, early: true, by: 'auto', page: page(), publish: (e) => bus.publish(e), memory });
    assert.equal(calls.length, 2);
    assert.match(userText(calls[1]), /claims that data or a tool is missing/);
    assert.deepEqual(ready().map((e) => e.spec.caption), [GOOD.caption]);
  });

  it('a "stand nicht in den Fakten" drawing twice → nothing is published', async () => {
    script = () => answer({ ...GOOD, caption: '… die Grenzhöhe stand nicht in den Fakten' });
    const memory = createMemory();
    memory.noteTurn({ role: 'user', text: QUESTION });
    await make().draw({ id: 'abzug', request: QUESTION, question: QUESTION, early: true, by: 'auto', page: page(), publish: (e) => bus.publish(e), memory });
    assert.equal(ready().length, 0);
  });

  it('onFacts from the fast path never carries a "no data" sentence (non-page question)', async () => {
    const memory = createMemory();
    const q = 'Was steht im Wissen zum Thema Testreihe?';
    memory.noteTurn({ role: 'user', text: q });
    const handed = [];
    await make().draw({ id: 'wissen', request: q, question: q, early: true, by: 'auto', page: null, onFacts: (text) => handed.push(text), publish: (e) => bus.publish(e), memory });
    assert.ok(runs.length > 0, 'the fast path ran');
    assert.ok(handed.length > 0);
    for (const text of handed) { assert.match(text, /Irgendein Wissen\./); assert.doesNotMatch(text, /nennt die Notiz nicht/); }
  });

  it('a canvas session follows a new click (setPage): the next drawing gets the new point', async () => {
    const illustrator = make();
    const session = createCanvasSession({ bus, illustrator, by: 'voice', provider: 'openai', emit: () => {}, page: null });
    session.setPage(page());
    session.memory.noteTurn({ role: 'user', text: QUESTION });
    await illustrator.draw({ id: 'abzug', request: QUESTION, question: QUESTION, early: true, by: 'auto', page: page(), publish: (e) => bus.publish(e), memory: session.memory });
    assert.match(userText(calls[0]), /Angeklickt: "penalty"/);
    session.close();
  });
});
