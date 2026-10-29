// Round 6: the early illustrator (starts with the user's question, in parallel with the agent), its fast path, the
// quality gate in the illustrator, deterministic money charts and automatic sources. Synthetic data only.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_TIMEOUT_MS: '600', DESK_CANVAS_DEBOUNCE_MS: '30', DESK_CANVAS_RESEARCH_MS: '60' });
const { createCanvasBus: createBus } = await import('../src/canvasBus.js');
// what live listeners saw (round 10: failed / dropped placeholders leave the replay ring, so the ring alone no longer tells)
const createCanvasBus = () => { const b = createBus(); b.seen = []; b.subscribe((e) => b.seen.push(e)); return b; };
const { createCanvasSession, createIllustrator, createMemory } = await import('../src/illustrator.js');

const LEDGER = `${JSON.stringify({
  count: 3, groupBy: 'category', entryCount: 3, truncated: false,
  totals: [], totalsEurApprox: [{ key: 'GPU', sumEur: 550.5, count: 2 }, { key: 'Telefonie', sumEur: 26.82, count: 1 }],
  fxNote: 'USD→EUR 0,894 (Näherung)', source: { kind: 'board', ref: 'Board #22 (TAX-Zeilen)', asOf: '2026-10-24' },
})}\n---\n2026-10-01 | 400 EUR | AlphaCloud | Miete | GPU\n2026-10-02 | 150.5 EUR | BetaGPU | Miete | GPU\n2026-10-05 | 30 USD (EUR ~26.82) | EpsilonTel | Anrufe | Telefonie`;
const flow = (extra = {}) => JSON.stringify({ v: 2, id: 'x', kind: 'flow', title: 'Ablauf des Links', caption: 'Drei Schritte.', sources: [], nodes: [{ id: 'a', label: 'Agent' }, { id: 'b', label: 'Guard', shape: 'diamond' }, { id: 'c', label: 'Telegram' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'mit Link' }], ...extra });
const answer = (content) => ({ message: { content, tool_calls: [] }, costUsd: 0.001 });
const toolCall = (name, args, id = 'c1') => ({ message: { content: '', tool_calls: [{ id, name, args: JSON.stringify(args) }] }, costUsd: 0.001 });

let bus; let audits; let calls; let runs; let script;
const complete = async (call) => { calls.push({ ...call, messages: structuredClone(call.messages) }); return script(call, calls.length - 1); };
const run = async (name, args) => {
  runs.push([name, args]);
  if (name === 'ledger_spend') return { ok: true, content: LEDGER, summary: 's' };
  if (name === 'code_outline') return { ok: true, content: '{"root":"x","files":3}\n---\ngateway/src/server.js (180 Z.)', summary: 's' };
  if (name === 'knowledge_read') return { ok: true, content: '{"found":true,"topic":"jevbench","path":"/home/flori/desk-knowledge/topics/jevbench.md"}\n---\nJevBench misst Modelle.', summary: 's' };
  return { ok: true, content: '{}', summary: 's' };
};
const illustrator = () => createIllustrator({ bus, hub: {}, complete, run, audit: (a) => audits.push(a) });
const events = () => bus.seen;
const ring = () => bus.replay(0).map((e) => e.event);
const phases = () => events().map((e) => `${e.phase}:${e.id}${e.by ? `:${e.by}` : ''}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const session = (extra = {}) => {
  const out = [];
  const s = createCanvasSession({ bus, illustrator: illustrator(), by: 'voice', provider: 'gemini', emit: (e) => out.push(e), ctx: {}, debounceMs: () => 30, researchMs: () => 60, ...extra });
  s.out = out;
  return s;
};
const ask = (s, text) => { s.startTurn(); s.noteTurn({ role: 'user', text }); return s.userTurn(text); };

beforeEach(() => { bus = createCanvasBus(); audits = []; calls = []; runs = []; script = () => answer(flow()); });

describe('early illustrator', () => {
  it('an explanatory question publishes pending AT ONCE (before any model answer) and draws the question', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    script = async () => { await gate; return answer(flow()); };
    const s = session();
    assert.equal(ask(s, 'Wie funktioniert die Video-Sendeblockierung?'), 'early');
    assert.deepEqual(phases(), ['pending:wie-funktioniert-die-video-sendeblockier:auto']);
    assert.equal(s.out.length, 1, 'mirrored to the session stream');
    release();
    await s.idle();
    assert.deepEqual(phases(), ['pending:wie-funktioniert-die-video-sendeblockier:auto', 'ready:wie-funktioniert-die-video-sendeblockier:auto']);
    assert.match(calls[0].messages[1].content, /Anfrage: Wie funktioniert die Video-Sendeblockierung\?/);
    assert.match(audits.find((a) => a.action === 'canvas.draw').detail, / early/);
  });

  it('not for chit-chat, secrets, a forbidden drawing, or when the daily cost cap is reached', () => {
    const s = session();
    assert.equal(ask(s, 'Danke!'), 'not-explanatory');
    assert.equal(ask(s, 'Läuft der Job gerade noch?'), 'not-explanatory');
    assert.equal(ask(s, 'Wie komme ich an die secrets.env?'), 'secret');
    assert.equal(ask(s, 'Erkläre mir bitte den Ablauf, aber ohne Bild'), 'forbidden');
    assert.equal(ask(s, 'Erkläre bitte nicht zeichnen den Ablauf'), 'forbidden');
    const capped = session({ ctx: { sid: 's', limits: { check: () => ({ ok: false }) } } });
    assert.equal(ask(capped, 'Wie funktioniert das genau?'), 'limit');
    assert.equal(events().length, 0);
    assert.equal(calls.length, 0);
  });

  it('only once per turn; a new turn starts fresh', async () => {
    const s = session();
    assert.equal(ask(s, 'Wie funktioniert das?'), 'early');
    assert.equal(s.userTurn('Wie funktioniert das?'), 'skipped');
    await s.idle();
    assert.equal(ask(s, 'Wie funktioniert das andere?'), 'early');
    await s.idle();
  });

  it('after the early canvas, the auto trigger of the turn does not draw a second one, and the agent\'s canvas_draw (same kind or none) REFINES the same id', async () => {
    const s = session();
    ask(s, 'Wie funktioniert die Video-Sendeblockierung?');
    await s.idle();
    const first = events().find((e) => e.phase === 'ready');
    assert.equal(s.autoTurn({ answerText: 'Der Agent ruft notify auf und notify prüft den Link ganz genau.' }), 'skipped');
    const r = s.draw({ request: 'Detaillierter, mit dem Override', kind: 'flow', id: 'vom-agenten' });
    assert.equal(r.id, first.id, 'no second canvas');
    await s.idle();
    assert.deepEqual(events().filter((e) => e.phase === 'ready').map((e) => e.id), [first.id, first.id]);
    assert.match(calls.at(-1).messages[1].content, /Update dieser Zeichnung/);
    assert.notEqual(s.draw({ request: 'Eine Zeitleiste dazu', kind: 'timeline', id: 'zeit' }).id, first.id, 'a clearly different kind is its own canvas');
    await s.idle();
  });

  it('a canvas_draw that arrives while the early run is still drawing is deferred and refines afterwards (one canvas)', async () => {
    let n = 0;
    script = async () => { n += 1; await wait(40); return answer(flow({ title: `Fassung ${n}` })); };
    const s = session();
    ask(s, 'Wie funktioniert die Video-Sendeblockierung?');
    const id = events()[0].id;
    const r = s.draw({ request: 'Mit allen Details aus der Recherche', id: 'anders' });
    assert.deepEqual(r, { ok: true, id, status: 'zeichne' });
    assert.equal(events().length, 1, 'no second pending while the early one is running');
    await s.idle();
    const ready = events().filter((e) => e.phase === 'ready');
    assert.deepEqual(ready.map((e) => [e.id, e.spec.title]), [[id, 'Fassung 1'], [id, 'Fassung 2']]);
    assert.match(calls[1].messages[1].content, /Anfrage: Mit allen Details aus der Recherche/);
    assert.match(calls[1].messages[1].content, /Update dieser Zeichnung/);
  });

  it('canvas_render of the same kind replaces a still-drawing early canvas (same id) and cancels it', async () => {
    script = (c) => new Promise((resolve, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)));
    const s = session();
    ask(s, 'Wie funktioniert die Video-Sendeblockierung?');
    const id = events()[0].id;
    const r = s.render({ kind: 'flow', title: 'Fertige Skizze', id: 'eigene-id', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
    assert.equal(r.id, id);
    await s.idle();
    assert.deepEqual(phases().map((p) => p.split(':').slice(0, 2).join(':')), [`pending:${id}`, `ready:${id}`]);
    assert.equal(events().at(-1).spec.title, 'Fertige Skizze');
  });

  it('a forbidden drawing blocks the agent\'s own canvas tools for that turn too', () => {
    const s = session();
    ask(s, 'Erkläre den Ablauf ohne Grafik');
    assert.throws(() => s.draw({ request: 'x' }), /keine Zeichnung/);
    assert.throws(() => s.render({ kind: 'flow', title: 'x' }), /keine Zeichnung/);
    assert.equal(s.autoTurn({ userText: 'Erkläre den Ablauf ohne Grafik', answerText: 'Erst A, dann B, dann C. So läuft das.' }), 'forbidden');
  });

  it('a failing early run of a NEW id leaves no failed placeholder: "dropped" live, nothing in the replay ring (r10, critic r9 F6)', async () => {
    script = () => answer('kein json');
    const s = session();
    ask(s, 'Wie funktioniert das genau?');
    await s.idle();
    assert.deepEqual(events().map((e) => e.phase), ['pending', 'dropped']);
    assert.deepEqual(ring(), []);
  });
});

describe('triggers: research timer and provider turn-done', () => {
  it('research longer than researchMs (2+ tools) in a turn without a canvas starts the illustrator once, even if the question did not look explanatory', async () => {
    const u = session();
    u.startTurn();
    u.noteTurn({ role: 'user', text: 'Hmm, was steckt da dahinter genau' });
    assert.equal(u.userTurn('Hmm, was steckt da dahinter genau'), 'not-explanatory');
    u.toolStarted();
    u.toolStarted();
    assert.equal(events().length, 0, 'not before researchMs');
    await wait(120);
    assert.deepEqual(events().map((e) => e.phase).slice(0, 2), ['pending', 'ready']);
    const draws = events().filter((e) => e.phase === 'pending').length;
    u.toolStarted();
    await u.idle();
    await wait(100);
    assert.equal(events().filter((e) => e.phase === 'pending').length, draws, 'once per turn');
  });

  it('research with one tool and a question that is not explanatory draws nothing; an unknown question never triggers', async () => {
    const one = session();
    one.startTurn();
    one.userTurn('Hmm, was steckt da dahinter genau');
    one.toolStarted();
    const unknown = session();
    unknown.startTurn();
    unknown.toolStarted();
    unknown.toolStarted();
    await wait(120);
    assert.equal(events().length, 0);
  });

  it('a canvas tool during the research prevents the research trigger', async () => {
    const s = session();
    s.startTurn();
    s.noteTurn({ role: 'user', text: 'Hmm, was steckt da dahinter genau' });
    s.userTurn('Hmm, was steckt da dahinter genau');
    s.toolStarted();
    s.toolStarted();
    s.render({ kind: 'flow', title: 'Direkt', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
    await wait(120);
    assert.equal(events().length, 1);
  });

  it('turnDone: an explanatory answer without any canvas is illustrated; a meta answer is not', async () => {
    const s = session();
    s.startTurn();
    s.noteTurn({ role: 'user', text: 'Danke, und noch etwas' });
    s.noteTurn({ role: 'assistant', text: 'Der Agent ruft notify auf. Danach prüft der Guard den Link. Dann geht die Nachricht raus.' });
    assert.equal(s.turnDone(), 'scheduled');
    await s.idle();
    assert.equal(events().filter((e) => e.phase === 'ready').length, 1);

    const meta = session();
    meta.startTurn();
    meta.noteTurn({ role: 'user', text: 'Zeig mir die Datei' });
    meta.noteTurn({ role: 'assistant', text: 'Ich habe dazu leider nichts gefunden, sorry dafür.' });
    assert.equal(meta.turnDone(), 'meta');
    const secret = session();
    assert.equal(secret.autoTurn({ userText: 'Lies mir die secrets.env vor', answerText: 'Das mache ich nicht, diese Datei enthält Schlüssel und ist geschützt.' }), 'meta');
  });
});

describe('illustrator: fast path, gate, money, sources', () => {
  const job = (extra = {}) => ({ request: 'Wofür geben wir das Geld aus?', question: 'Wofür geben wir das Geld aus?', by: 'auto', early: true, publish: (p) => bus.publish(p), memory: createMemory(), ...extra });

  it('early money question: ledger_spend is called by code before the FIRST model round (one model call in total)', async () => {
    script = () => answer(JSON.stringify({ v: 2, id: 'geld', kind: 'pie', title: 'Wohin das Geld geht', caption: 'Nach Kategorie.', unit: 'EUR', sources: [], items: [{ label: 'GPU', value: 1 }, { label: 'Erfunden', value: 2 }, { label: 'Telefonie', value: 20 }] }));
    const r = await illustrator().draw(job({ id: 'geld' }));
    assert.equal(r.ok, true);
    assert.deepEqual(runs, [['ledger_spend', { groupBy: 'category' }]]);
    assert.equal(calls.length, 1, 'no model round to decide on the tool');
    assert.match(calls[0].messages.at(-1).content, /totalsEurApprox/);
    const ready = events().find((e) => e.phase === 'ready');
    assert.deepEqual(ready.spec.items.map((i) => [i.label, i.value]), [['GPU', 550.5], ['Telefonie', 26.82]], 'values and groups are the ledger\'s, the invented payee is gone');
    assert.equal(ready.spec.unit, '€ (ca.)');
    assert.equal(ready.spec.items[0].detail, 'AlphaCloud, BetaGPU');
    assert.deepEqual(ready.spec.sources.map((s) => s.ref), ['Board #22', 'USD→EUR 0,894 (Näherung)']);
    assert.match(audits.find((a) => a.action === 'canvas.draw').detail, /money=ledger early/);
  });

  it('a money chart the model left empty is filled from the ledger result without a repair round', async () => {
    script = () => answer(JSON.stringify({ v: 2, id: 'geld', kind: 'pie', title: 'Wohin das Geld geht', caption: 'Nach Kategorie.', sources: [] }));
    const r = await illustrator().draw(job({ id: 'geld' }));
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1, 'no repair round');
    assert.deepEqual(events().find((e) => e.phase === 'ready').spec.items.map((i) => i.value), [550.5, 26.82]);
  });

  it('any other explanatory question: knowledge and a file search are read before the first model round', async () => {
    await illustrator().draw(job({ id: 'sperre', request: 'Wie funktioniert die Video-Sendeblockierung?', question: 'Wie funktioniert die Video-Sendeblockierung?' }));
    assert.deepEqual(runs.map((r) => r[0]), ['knowledge_read', 'search_files']);
    assert.equal(calls.length, 1);
    assert.deepEqual(events().find((e) => e.phase === 'ready').spec.sources.map((s) => s.ref), ['~/desk-knowledge/topics/jevbench.md']);
  });

  it('the same board ref is listed once ("Board #22" next to "Board #22 (TAX-Zeilen)")', async () => {
    script = () => answer(JSON.stringify({ v: 2, id: 'geld', kind: 'pie', title: 'Wohin das Geld geht', caption: 'x', sources: [{ label: 'Board', ref: 'Board #22' }], items: [{ label: 'GPU', value: 550.5 }, { label: 'Telefonie', value: 26.82 }] }));
    const memory = createMemory();
    memory.noteTurn({ role: 'user', text: 'Board #22 Ledger' });
    await illustrator().draw(job({ id: 'geld', memory }));
    assert.deepEqual(events().find((e) => e.phase === 'ready').spec.sources.map((s) => s.ref), ['Board #22', 'USD→EUR 0,894 (Näherung)']);
  });

  it('a non-early job (the agent\'s own canvas_draw) has no fast path', async () => {
    await illustrator().draw(job({ id: 'geld2', early: false }));
    assert.equal(runs.length, 0);
  });

  it('architecture of the desk: code_outline of the real directories is read first', async () => {
    await illustrator().draw(job({ id: 'arch', request: 'Erkläre die Architektur vom Agent Desk Gateway', question: 'Erkläre die Architektur vom Agent Desk Gateway' }));
    assert.deepEqual(runs, [['code_outline', { path: '/home/flori/work/agent-desk/gateway/src' }], ['desk_status', {}]]);
    assert.equal(calls.length, 1);
  });

  it('r8 C3: the illustrator gets the desk\'s real model facts and a drawing with an invented model is rejected, then repaired', async () => {
    const bad = flow({ nodes: [{ id: 'a', label: 'Agent' }, { id: 'b', label: 'Text-Modell', detail: 'Claude über Abos' }, { id: 'c', label: 'Telegram' }] });
    script = (c, i) => answer(i === 0 ? bad : flow());
    const r = await illustrator().draw(job({ id: 'arch2', request: 'Erkläre die Architektur vom Agent Desk Gateway', question: 'Erkläre die Architektur vom Agent Desk Gateway' }));
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0].messages[0].content, /Desk-Fakten[\s\S]*Text-Agent \(Chat\): deepseek\/deepseek-v4\.1-flash/);
    assert.match(calls[0].messages[0].content, /gateway\/src/);
    assert.match(calls[1].messages.at(-1).content, /names a model that is not in the desk facts.*claude/is);
  });

  it('a model named in the desk facts passes (DeepSeek as text model)', async () => {
    script = () => answer(flow({ nodes: [{ id: 'a', label: 'Agent' }, { id: 'b', label: 'Text-Modell', detail: 'deepseek-v4.1-flash' }, { id: 'c', label: 'Telegram' }] }));
    const r = await illustrator().draw(job({ id: 'arch3', early: false }));
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
  });

  it('a placeholder answer is rejected by the gate; the repair round carries the reason and the facts hint; a good answer follows', async () => {
    script = (c, i) => answer(i === 0 ? flow({ title: 'Platzhalter', nodes: [{ id: 'a', label: 'Browser' }], edges: [] }) : flow());
    const r = await illustrator().draw(job({ id: 'gw', early: false }));
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[1].messages.at(-1).content, /title is a placeholder.*no placeholders/s);
    assert.equal(events().find((e) => e.phase === 'ready').spec.title, 'Ablauf des Links');
  });

  it('round budget used up: the final answer is requested without tools and "from the gathered facts"', async () => {
    let n = 0;
    script = (c) => (c.tools ? toolCall('read_file', { path: `/home/flori/a${(n += 1)}.md` }, `c${n}`) : answer(flow()));
    await illustrator().draw(job({ id: 'loop', early: false }));
    assert.equal(calls.at(-1).tools, undefined);
    assert.match(calls.at(-1).messages.at(-1).content, /ausschließlich aus den gesammelten Fakten/);
  });

  it('two stubs in a row for a NEW id leave nothing behind; for an EXISTING id the old drawing stays (shown again, no error)', async () => {
    script = () => answer(flow({ title: 'TODO', nodes: [{ id: 'a', label: 'A' }], edges: [] }));
    await illustrator().draw(job({ id: 'neu', early: false }));
    assert.deepEqual(events().map((e) => e.phase), ['dropped'], 'an automatic (by:"auto") drawing leaves no failed placeholder (r10)');
    assert.deepEqual(ring(), [], 'the error is live only, a reload never shows it (r10)');

    bus = createCanvasBus();
    const good = JSON.parse(flow({ id: 'alt' }));
    bus.publish({ phase: 'ready', id: 'alt', kind: 'flow', title: good.title, spec: good, by: 'text' });
    await illustrator().draw(job({ id: 'alt', early: false }));
    assert.deepEqual(events().map((e) => e.phase), ['ready', 'ready'], 'no error event for an existing id');
    assert.deepEqual(events()[1].spec, good, 'the previous spec, unchanged');
  });

  it('sources come from the agent\'s tools of the turn when the illustrator itself used none', async () => {
    const memory = createMemory();
    memory.noteTool({ name: 'knowledge_read', args: { topic: 'JevBench' }, ok: true, content: '{"found":true,"topic":"jevbench"}\n---\ntext' });
    memory.noteTool({ name: 'read_file', args: { path: '/home/flori/AGENTS.md' }, ok: true, content: 'x' });
    await illustrator().draw(job({ id: 'quellen', early: false, memory }));
    assert.deepEqual(events().find((e) => e.phase === 'ready').spec.sources.map((s) => s.ref), ['~/desk-knowledge/topics/jevbench.md', '/home/flori/AGENTS.md']);
  });

  it('canvas_render by the agent also gets sources and the ledger numbers of its turn', () => {
    const s = session();
    s.noteTool({ name: 'ledger_spend', args: {}, ok: true, content: LEDGER });
    s.startTurn();
    s.noteTurn({ role: 'user', text: 'Wo geht das Geld hin?' });
    s.userTurn('Wo geht das Geld hin?'); // early starts (async); the agent renders at once
    s.render({ kind: 'pie', title: 'Geld nach Kategorie', unit: 'EUR', items: [{ label: 'GPU', value: 5120.5 }, { label: 'Telefonie', value: 20 }] });
    const spec = events().at(-1).spec;
    assert.deepEqual(spec.items.map((i) => i.value), [550.5, 26.82]);
    assert.equal(spec.unit, '€ (ca.)');
    assert.ok(spec.sources.some((x) => x.ref === 'Board #22'));
    s.cancelAll();
  });

  it('canvas_render with a stub is an error for the model (the gate)', () => {
    const s = session();
    assert.throws(() => s.render({ kind: 'flow', title: 'Platzhalter', nodes: [{ id: 'a', label: 'A' }], edges: [] }), /placeholder|only 1 node/);
    assert.throws(() => s.render({ kind: 'pie', title: 'Geld', items: [{ label: 'A', value: 1 }] }), /at least 2 items/);
    assert.equal(events().length, 0);
  });
});
