// Canvas forms (14 Nov 2026, Florian in session a#36e5fa): the picture's job picks the form, the reading load is checked,
// numbers reach the drawing model as digits, points carry speech cues. The eval set is the real turns of both sessions.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachCues, BUDGET, digitize, flowToPoints, FORM_KINDS, formError, formOf, germanNumber, isLinearNonProcess, numberFacts, pointsFromAnswer, questionPart, readingLoad, trimLoad, wordCount, answerFirst } from '../src/canvasForm.js';
import { normalizeCanvas } from '../src/canvas.js';
import { createCanvasBus } from '../src/canvasBus.js';
import { createCanvasSession, createIllustrator, createMemory, SYSTEM_PROMPT } from '../src/illustrator.js';

const TURNS = JSON.parse(readFileSync(new URL('./fixtures/canvas-turns-1114.json', import.meta.url), 'utf8'));
const turn = (suffix) => TURNS.find((t) => t.id.endsWith(suffix));
const THREE_REASONS = turn('14:53:12');
const EMISSIONS = turn('14:47:43');
const CHAMPION = turn('14:46:21');
const PODIUM = turn('14:49:25');

// ------------------------------------------------------------------------------------------------ the eval set
const SYNTHETIC = [
  { question: 'Wie funktioniert der Video-Versand, wenn kein Seitenlink dabei ist?', form: 'process' },
  { question: 'Was passiert, wenn ein Job über das Limit kommt?', form: 'process' },
  { question: 'Wie haben sich die Ausgaben seit Oktober entwickelt?', form: 'trend' },
  { question: 'Vergleich Grok und Gemini bei der Latenz', form: 'comparison' },
  { question: 'Wie ist das Gateway aufgebaut?', form: 'architecture' },
  { question: 'Wie wird das Preisgeld aufgeteilt?', form: 'distribution' },
  { question: 'Wie viel haben wir diesen Monat für GPUs ausgegeben?', form: 'number' },
  { question: 'Welche Vorteile hat das neue Abstammungssystem?', form: 'points' },
  { question: 'Warum dauert die Prüfung sechs Stunden?', form: 'points' },
  { question: 'Fass mir die Kernpunkte zusammen', form: 'points' },
  { question: 'Was sind die Termine bis zum Launch?', form: 'timeline' },
  { question: 'Erklär mir das', answer: 'Es gibt drei Gründe. Erstens Kosten, zweitens Tempo, drittens Ruhe.', form: 'points', strong: true },
  { question: 'Wie verteilt sich das?', answer: 'Der Champion bekommt 70 Prozent, der Zweite 20 Prozent und der Dritte 10 Prozent.', form: 'distribution', strong: true },
  { question: 'Wie läuft das ab?', answer: 'Erst prüft der Guard den Link. Wenn er fehlt, blockiert notify, sonst geht die Karte raus.', form: 'process' },
];

describe('form choice: the real turns of 14 Nov and a synthetic set', () => {
  for (const t of TURNS) {
    it(`${t.id}: ${t.form ?? 'no form'}${t.strong ? ' (strong)' : ''}, never a process when none is explained`, () => {
      const f = formOf(t);
      if (t.form !== 'any') assert.equal(f.form, t.form, `${t.question.slice(0, 80)} -> ${JSON.stringify(f)}`);
      if (t.strong) assert.equal(f.strong, true);
      if (t.notFlow && f.form !== 'process') assert.ok(!FORM_KINDS[f.form ?? 'points'].includes('flow') || f.form === 'architecture');
    });
  }
  for (const t of SYNTHETIC) {
    it(`"${t.question}"${t.answer ? ' + answer' : ''} -> ${t.form}`, () => {
      const f = formOf(t);
      assert.equal(f.form, t.form, JSON.stringify(f));
      if (t.strong) assert.equal(f.strong, true);
    });
  }
  it('the three-reasons turn and the emission split are strong (the answer shows the form)', () => {
    assert.deepEqual(formOf(THREE_REASONS), { form: 'points', strong: true, why: 'answer enumerates points' });
    assert.equal(formOf(EMISSIONS).form, 'distribution');
    assert.equal(formOf(EMISSIONS).strong, true);
    assert.equal(formOf(PODIUM).strong, true, '70 / 10 / 5 in Florian\'s own words');
  });
  it('reasons are drawn from the answer; data questions start at once', () => {
    assert.equal(answerFirst('Wieso wollen wir das so tun?'), true);
    assert.equal(answerFirst('Was ist genau der Vorteil?'), true);
    assert.equal(answerFirst(CHAMPION.question), false);
    assert.equal(answerFirst('Wie funktioniert der Video-Versand?'), false);
    assert.equal(answerFirst('Erkläre mir die Abstammungsregel'), false, 'no form words: early as before');
  });
  it('a long spoken turn is judged by its asking sentences and its end', () => {
    const q = questionPart(THREE_REASONS.question);
    assert.match(q, /Überlegung dahinter/);
    assert.equal(questionPart('Kurz?'), 'Kurz?');
  });
});

// ------------------------------------------------------------------------------------------------ numbers
describe('numbers the drawing model gets', () => {
  it('German number words become digits', () => {
    assert.equal(germanNumber('tausend'), 1000);
    assert.equal(germanNumber('fünfundsiebzig'), 75);
    assert.equal(germanNumber('zweihundertfünfzig'), 250);
    assert.equal(germanNumber('zweitausendsiebenundzwanzig'), 2027);
    assert.equal(germanNumber('ein'), null);
    assert.equal(germanNumber('und'), null);
    assert.equal(digitize('tausend Alpha, siebzehn an den Zweiten; wir achten darauf'), '1000 Alpha, 17 an den Zweiten; wir achten darauf');
  });
  it('the emission answer: 30 %, then 75 / 17 / 8 adding up to 100 %', () => {
    const facts = numberFacts(EMISSIONS.answer);
    assert.match(facts, /30 Prozent der Miner-Emissionen/);
    assert.match(facts, /75 Prozent an den Champion, 17 an den zuletzt Entthronten, 8 an den davor\. \[Desk gerechnet: Summe 100 %\]/);
  });
  it('Florian\'s podium: 70 / 10 / 5 and the remainder the desk computed', () => {
    assert.match(numberFacts(PODIUM.question), /70 Prozent .*10 Prozent .*5 Prozent.*Rest bis 100 %: 15 %/);
  });
  it('the champion answer: 1000 Alpha, equal split, 10 % weight', () => {
    const facts = numberFacts(CHAMPION.answer);
    assert.match(facts, /1000 Alpha insgesamt, gleich geteilt/);
    assert.match(facts, /10 Prozent Gewichtsanteil/);
  });
  it('no numbers, no block', () => assert.equal(numberFacts('Das ist gut so.'), ''));
});

// ------------------------------------------------------------------------------------------------ reading load
const spec = (s) => { const r = normalizeCanvas({ v: 2, title: 'Warum gleich teilen?', sources: [{ label: 'Gespräch', ref: 'Gespräch' }], ...s }); assert.ok(r.ok, r.error); return r.spec; };

describe('reading load is checked, not hoped for', () => {
  it('a slide-like points list passes', () => {
    const s = spec({ kind: 'points', points: [{ label: 'Prüfbarkeit', note: 'ein Eintrag, ein Start' }, { label: 'Feste Belohnung' }, { label: 'Vorfahren unbezahlt' }] });
    assert.equal(readingLoad(s), undefined);
    assert.ok(wordCount(s) <= BUDGET.total);
  });
  it('a sentence as a label is sent back with its word count', () => {
    const s = spec({ kind: 'points', points: [{ label: 'Ein Eintrag hat genau einen Start' }, { label: 'Feste Belohnung' }] });
    assert.match(readingLoad(s), /points\[0\]\.label has 6 words.*budget is 4/);
  });
  it('a long caption and a picture over 45 words are sent back', () => {
    assert.match(readingLoad(spec({ kind: 'points', caption: 'Dies ist eine sehr lange Bildunterschrift mit viel zu vielen Wörtern für eine Folie im Gespräch heute', points: [{ label: 'A' }, { label: 'B' }] })), /caption has 17 words/);
    const many = spec({ kind: 'bar', items: Array.from({ length: 6 }, (_, i) => ({ label: `Posten Nummer ${i} lang`, value: i + 1 })), caption: 'Die Ausgaben verteilen sich auf sechs Posten mit sehr unterschiedlichen Beträgen in diesem Monat' });
    assert.match(readingLoad({ ...many, title: 'Wie sich die Ausgaben dieses Monats genau verteilen' }), /words, the budget is 45/);
  });
  it('trimLoad brings any spec within budget (fallback without a model round)', () => {
    const s = spec({ kind: 'points', caption: 'Dies ist eine sehr lange Bildunterschrift mit viel zu vielen Wörtern für eine Folie im Gespräch heute', points: [{ label: 'Ein Eintrag hat genau einen Start', note: 'damit bleibt die Abstammung sauber und automatisch prüfbar für alle' }, { label: 'Feste Belohnung' }] });
    const t = trimLoad(s);
    assert.equal(readingLoad(t), undefined);
    assert.equal(t.points[0].label, 'Ein Eintrag hat genau');
  });
  it('the system prompt states the budget and the form rules', () => {
    assert.match(SYSTEM_PROMPT, /LOW READING LOAD IS A HARD RULE/);
    assert.match(SYSTEM_PROMPT, /Reasons, arguments and explanations are NEVER a flow/);
    assert.match(SYSTEM_PROMPT, /"layout":"stacked"/);
  });
});

// ------------------------------------------------------------------------------------------------ form rules
const FLOW3 = { kind: 'flow', nodes: [{ id: 'a', label: 'Prüfbarkeit' }, { id: 'b', label: 'Feste Belohnung' }, { id: 'c', label: 'Vorfahren' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] };
describe('form rules', () => {
  it('a strong points answer rejects a flow (with the reason the model repairs against)', () => {
    assert.match(formError(spec(FLOW3), formOf(THREE_REASONS)), /list of points: draw kind "points"/);
    assert.equal(formError(spec({ kind: 'points', points: [{ label: 'A' }, { label: 'B' }] }), formOf(THREE_REASONS)), undefined);
  });
  it('a strong split rejects a flow and a table; bar / pie / sankey pass', () => {
    const f = formOf(EMISSIONS);
    assert.match(formError(spec(FLOW3), f), /splits a whole/);
    assert.equal(formError(spec({ kind: 'bar', layout: 'stacked', items: [{ label: 'Champion', value: 75 }, { label: 'Zweiter', value: 17 }, { label: 'Dritter', value: 8 }] }), f), undefined);
  });
  it('a pie over 4 parts is sent to a bar', () => {
    assert.match(formError(spec({ kind: 'pie', items: [1, 2, 3, 4, 5].map((v) => ({ label: `P${v}`, value: v })) }), {}), /pie with more than 4 parts/);
  });
  it('a linear flow that explains no process becomes a numbered list (same order, no extra model round)', () => {
    assert.equal(isLinearNonProcess(spec(FLOW3), formOf(THREE_REASONS)), true);
    assert.equal(isLinearNonProcess(spec(FLOW3), { form: 'process' }), false);
    const branched = spec({ ...FLOW3, nodes: [...FLOW3.nodes, { id: 'd', label: 'Nein' }], edges: [...FLOW3.edges, { from: 'b', to: 'd' }] });
    assert.equal(isLinearNonProcess(branched, {}), false, 'a real branch stays a flow');
    const p = flowToPoints({ ...spec({ ...FLOW3, edges: [{ from: 'b', to: 'c' }, { from: 'a', to: 'b' }] }), highlight: 'b' });
    assert.deepEqual(p.points.map((x) => x.label), ['Prüfbarkeit', 'Feste Belohnung', 'Vorfahren']);
    assert.equal(p.highlight, 'Feste Belohnung');
    assert.ok(normalizeCanvas(p, { gate: true }).ok);
  });
});

// ------------------------------------------------------------------------------------------------ cues
describe('points from the spoken answer and speech cues', () => {
  it('the three reasons become three short numbered points with cues', () => {
    const p = pointsFromAnswer(THREE_REASONS.answer);
    assert.deepEqual(p.points.map((x) => x.label), ['Prüfbarkeit', 'Belohnung steht vorab fest', 'Vorfahren']);
    assert.deepEqual(p.points.map((x) => x.cue), ['Erstens die Prüfbarkeit', 'Zweitens: Die Belohnung', 'drittens die Vorfahren']);
    assert.equal(pointsFromAnswer('Nur ein Satz.'), null);
  });
  it('a cue is kept only when the answer says it; sync speech when one is left', () => {
    const s = spec({ kind: 'points', points: [{ label: 'Prüfbarkeit', cue: 'Erstens die Prüfbarkeit' }, { label: 'Erfunden', cue: 'viertens etwas anderes' }] });
    const out = attachCues(s, THREE_REASONS.answer);
    assert.equal(out.points[0].cue, 'Erstens die Prüfbarkeit');
    assert.equal(out.points[1].cue, undefined);
    assert.equal(out.sync, 'speech');
    assert.equal(attachCues(s, '').sync, undefined);
  });
});

// ------------------------------------------------------------------------------------------------ the illustrator with these rules
const answer = (obj) => ({ message: { content: JSON.stringify(obj), tool_calls: [] }, costUsd: 0.001 });
const SRC = [{ label: 'Gespräch', ref: 'Gespräch' }];

describe('illustrator: form + load gates on the real turns', () => {
  let bus; let audits; let prompts;
  beforeEach(() => { bus = createCanvasBus(); audits = []; prompts = []; });
  const run = async (t, script) => {
    const memory = createMemory();
    memory.noteTurn({ role: 'user', text: t.question });
    memory.noteTurn({ role: 'assistant', text: t.answer });
    const ill = createIllustrator({ bus, hub: {}, complete: async ({ messages }) => { prompts.push(messages.map((m) => m.content).join('\n')); return answer(script.shift()); }, run: async () => ({ ok: true, content: '' }), audit: (a) => audits.push(a) });
    const r = await ill.draw({ id: 'bild', request: 'Illustriere die letzte Antwort', by: 'auto', provider: 'xai', publish: (p) => bus.publish(p), memory });
    return { r, spec: bus.latest()[0]?.spec };
  };

  it('three reasons: the form line and the numbers reach the model; a flow answer is repaired into points with cues', async () => {
    const pts = { v: 2, id: 'bild', kind: 'points', title: 'Warum gleich teilen?', sources: SRC, points: [{ label: 'Prüfbarkeit', cue: 'Erstens die Prüfbarkeit' }, { label: 'Feste Belohnung', cue: 'Zweitens: Die Belohnung' }, { label: 'Vorfahren unbezahlt', cue: 'drittens die Vorfahren' }] };
    const flow = { v: 2, id: 'bild', title: 'Warum gleich teilen?', sources: SRC, ...FLOW3, nodes: [...FLOW3.nodes, { id: 'd', label: 'Nein' }], edges: [...FLOW3.edges, { from: 'a', to: 'd' }] };
    const { spec: s } = await run(THREE_REASONS, [flow, pts]);
    assert.match(prompts[0], /Form: Kernpunkte .*die gesprochene Antwort hat genau diese Form/);
    assert.match(prompts[1], /rejected: the spoken answer is a list of points/);
    assert.equal(s.kind, 'points');
    assert.equal(s.sync, 'speech');
    assert.equal(s.points.filter((p) => p.cue).length, 3);
    assert.ok(audits.some((a) => a.action === 'canvas.form'));
  });

  it('three reasons, the model insists on a flow twice: the points list built from the answer is published', async () => {
    const flow = { v: 2, id: 'bild', title: 'Warum gleich teilen?', sources: SRC, ...FLOW3, nodes: [...FLOW3.nodes, { id: 'd', label: 'Nein' }], edges: [...FLOW3.edges, { from: 'a', to: 'd' }] };
    const { spec: s } = await run(THREE_REASONS, [flow, flow]);
    assert.equal(s.kind, 'points');
    assert.deepEqual(s.points.map((p) => p.label), ['Prüfbarkeit', 'Belohnung steht vorab fest', 'Vorfahren']);
    assert.equal(s.sync, 'speech');
  });

  it('emission split: number words reach the model as digits; a stacked bar with 75 / 17 / 8 is grounded and published', async () => {
    const bar = { v: 2, id: 'bild', kind: 'bar', layout: 'stacked', title: 'Wer bekommt die Emissionen?', unit: '%', sources: SRC, items: [{ label: 'Champion', value: 75 }, { label: 'Zuletzt entthront', value: 17 }, { label: 'Davor', value: 8 }] };
    const { spec: s } = await run(EMISSIONS, [bar]);
    assert.match(prompts[0], /Zahlen, die Florian hört[\s\S]*75 Prozent an den Champion, 17 an den zuletzt Entthronten, 8/);
    assert.equal(s.layout, 'stacked');
    assert.deepEqual(s.items.map((i) => i.value), [75, 17, 8]);
  });

  it('Florian\'s podium: the remainder 15 % the desk computed is a grounded number', async () => {
    const memory = { q: PODIUM.question };
    const bar = { v: 2, id: 'bild', kind: 'bar', layout: 'stacked', title: 'Podium-Vorschlag', unit: '%', sources: SRC, items: [{ label: 'Champion', value: 70 }, { label: 'Ehemaliger', value: 10 }, { label: 'Weiterer', value: 5 }, { label: 'Rest offen', value: 15 }] };
    const { spec: s } = await run({ question: memory.q, answer: 'Ich starte den Job.' }, [bar]);
    assert.deepEqual(s.items.map((i) => i.value), [70, 10, 5, 15]);
  });

  it('champion: a stat with an invented number loses it; the grounded ones stay', async () => {
    const stat = { v: 2, id: 'bild', kind: 'stat', title: 'Belohnung Runde 2', sources: SRC, stats: [{ value: 1000, unit: 'Alpha', label: 'gleich geteilt' }, { value: '≥ 10 %', label: 'Gewicht nötig' }, { value: 333, unit: 'Alpha', label: 'pro Eintrag' }] };
    const { spec: s } = await run(CHAMPION, [stat]);
    assert.deepEqual(s.stats.map((x) => x.value), [1000, '≥ 10 %']);
  });

  it('over the word budget: one repair, then the trimmed version', async () => {
    const long = { v: 2, id: 'bild', kind: 'points', title: 'Warum gleich teilen?', sources: SRC, points: [{ label: 'Ein Eintrag hat genau einen Start und bleibt sauber' }, { label: 'Feste Belohnung' }] };
    const { spec: s } = await run(THREE_REASONS, [long, long]);
    assert.equal(s.points[0].label, 'Ein Eintrag hat genau');
    assert.ok(audits.some((a) => a.action === 'canvas.repair' && /budget is 4/.test(a.detail)));
  });
});

// ------------------------------------------------------------------------------------------------ the session: when the picture is drawn
describe('session: reasons wait for the answer; an early drawing is reformed once', () => {
  let bus; let jobs; let drawKind;
  // the fake illustrator publishes what the early run "drew" (null = it skipped), like the real one before its run ends
  const illustrator = () => ({ draw: async (job) => { jobs.push(job); if (drawKind && job.id) job.publish({ phase: 'ready', id: job.id, kind: drawKind, title: 'Belohnung', by: 'auto', spec: { v: 2, id: job.id, kind: drawKind, title: 'Belohnung', sources: SRC } }); return { ok: true }; }, cancel() {} });
  beforeEach(() => { bus = createCanvasBus(); jobs = []; drawKind = null; });
  const session = () => createCanvasSession({ bus, illustrator: illustrator(), by: 'voice', provider: 'xai', emit: () => {}, ctx: {}, audit: () => {}, debounceMs: () => 10, researchMs: () => 5000 });

  it('"Wieso wollen wir das so tun?" draws nothing from the question; the answer starts the drawing', async () => {
    const s = session();
    s.startTurn(); s.noteTurn({ role: 'user', text: THREE_REASONS.question });
    assert.equal(s.userTurn(THREE_REASONS.question), 'answer-first');
    assert.equal(jobs.length, 0);
    s.noteTurn({ role: 'assistant', text: 'Die Logik ist dreifach.' });
    assert.equal(s.autoTurn({ answerText: 'Die Logik ist dreifach.' }), 'waiting-answer', 'a lead-in sentence is no answer yet');
    const rest = THREE_REASONS.answer.replace('Die Logik ist dreifach. ', '');
    s.noteTurn({ role: 'assistant', text: rest });
    assert.equal(s.autoTurn({ answerText: rest }), 'scheduled');
    await s.idle();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].request, 'Illustriere die letzte Antwort');
  });

  it('a data question still draws early; when the answer splits in percent and the drawing is a flow, it is redrawn once', async () => {
    const s = session();
    drawKind = 'flow';
    s.startTurn(); s.noteTurn({ role: 'user', text: CHAMPION.question });
    assert.equal(s.userTurn(CHAMPION.question), 'early');
    await s.idle();
    const id = jobs[0].id;
    s.noteTurn({ role: 'assistant', text: EMISSIONS.answer });
    assert.equal(s.autoTurn({ answerText: EMISSIONS.answer }), 'reform');
    await s.idle();
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].id, id);
    assert.equal(jobs[1].formInfo.form, 'distribution');
    assert.equal(s.autoTurn({ answerText: EMISSIONS.answer }), 'skipped', 'only once per turn');
  });

  it('an early drawing that already has the answer\'s form is not redrawn', async () => {
    const s = session();
    drawKind = 'bar';
    s.startTurn(); s.noteTurn({ role: 'user', text: CHAMPION.question });
    s.userTurn(CHAMPION.question);
    await s.idle();
    s.noteTurn({ role: 'assistant', text: EMISSIONS.answer });
    assert.equal(s.autoTurn({ answerText: EMISSIONS.answer }), 'skipped');
  });

  it('the early run found nothing to draw from the question: the spoken answer gets its own chance (once)', async () => {
    drawKind = null; // the early run skipped ("single reward figure")
    const s = session();
    s.startTurn(); s.noteTurn({ role: 'user', text: CHAMPION.question });
    assert.equal(s.userTurn(CHAMPION.question), 'early');
    await s.idle();
    s.noteTurn({ role: 'assistant', text: CHAMPION.answer });
    assert.equal(s.autoTurn({ answerText: CHAMPION.answer }), 'scheduled');
    await s.idle();
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].request, 'Illustriere die letzte Antwort');
  });
});
