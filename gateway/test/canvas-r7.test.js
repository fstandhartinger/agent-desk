// Round 7 (critic r6 §7): correct FINAL visuals and clean prose. Synthetic data only.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_TIMEOUT_MS: '600', DESK_CANVAS_DEBOUNCE_MS: '30', DESK_CANVAS_RESEARCH_MS: '60' });
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator, enrichSpec, infoCount, kindsFor } = await import('../src/illustrator.js');
const canvas = await import('../src/canvas.js');
const { applyLedger, ledgerBreakdown, moneyBody, parseLedger } = await import('../src/ledgerViz.js');
const { normalizeRef, normalizeSources } = await import('../src/sources.js');
const { TOOL_DEFS, resolveToolName, runTool } = await import('../src/tools.js');
const { buildInstructions } = await import('../src/prompt.js');
const { buildInstructions: voiceInstructions } = await import('../src/voice/instructions.js');
const { fastCalls } = await import('../src/fastPath.js');

const ENTRIES = [
  { category: 'GPU', counterparty: 'AlphaCloud', eurApprox: 700 }, { category: 'GPU', counterparty: 'BetaGPU', eurApprox: 200 },
  { category: 'Auszahlungen', counterparty: 'GammaPayout', eurApprox: 500 }, { category: 'LLM-APIs', counterparty: 'DeltaRouter', eurApprox: 100 },
  { category: 'LLM-APIs', counterparty: 'EpsilonAPI', eurApprox: 50 }, { category: 'Telefonie', counterparty: 'ZetaTel', eurApprox: 20 },
];
const header = (groupBy, totals, extra = {}) => ({
  count: 6, groupBy, entryCount: 6, truncated: false, totals: [], totalsEurApprox: totals.map(([key, sumEur]) => ({ key, sumEur, count: 1 })),
  fxNote: 'USD→EUR 0,9 (Näherung)', source: { kind: 'board', ref: 'Board #22 (TAX-Zeilen)', asOf: '2026-10-24' }, ...ledgerBreakdown(ENTRIES), ...extra,
});
// counterparty-grouped result whose rows were cut after 2 entries (the real ledger is much longer than the size cap)
const CP = `${JSON.stringify(header('counterparty', [['AlphaCloud', 700], ['GammaPayout', 500], ['BetaGPU', 200], ['DeltaRouter', 100], ['EpsilonAPI', 50], ['ZetaTel', 20]]))}\n---\n2026-10-01 | 700 EUR | AlphaCloud | Miete | GPU\n2026-10-02 | 500 EUR | GammaPayout | Auszahlung | Auszahlungen`;
const CAT = `${JSON.stringify(header('category', [['GPU', 900], ['Auszahlungen', 500], ['LLM-APIs', 150], ['Telefonie', 20]]))}\n---\n2026-10-01 | 700 EUR | AlphaCloud | Miete | GPU`;
const sum = (items) => Math.round(items.reduce((s, i) => s + i.value, 0) * 100) / 100;
const flowSpec = (n, id = 'ablauf') => ({ v: 2, id, kind: 'flow', title: 'Ablauf', caption: 'Schritte.', sources: [{ label: 'Gespräch', ref: 'Gespräch' }], nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Schritt ${i + 1}` })), edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })) });
const answer = (content) => ({ message: { content, tool_calls: [] }, costUsd: 0.001 });

let bus; let audits; let calls; let script;
const complete = async (call) => { calls.push({ ...call, messages: structuredClone(call.messages) }); return script(call, calls.length - 1); };
const run = async (name) => ({ ok: true, content: name === 'ledger_spend' ? CAT : '{}', summary: 's' });
const illustrator = () => createIllustrator({ bus, hub: {}, complete, run, audit: (a) => audits.push(a) });
const session = (extra = {}) => createCanvasSession({ bus, illustrator: illustrator(), by: 'voice', provider: 'gemini', emit: () => {}, ctx: {}, debounceMs: () => 30, researchMs: () => 60, ...extra });
const ask = (s, text) => { s.startTurn(); s.noteTurn({ role: 'user', text }); return s.userTurn(text); };
const events = () => bus.replay(0).map((e) => e.event);
const readyOf = (id) => bus.latest().find((e) => e.id === id)?.spec;
const tool = (content, args = {}) => ({ name: 'ledger_spend', args, ok: true, content });

beforeEach(() => { bus = createCanvasBus(); audits = []; calls = []; script = () => answer(JSON.stringify(flowSpec(4))); });

describe('item 2: money charts cover ALL groups, the title follows the grouping', () => {
  it('a category pie with 2 items on a COUNTERPARTY ledger is rebuilt with every category; the sum is the total', () => {
    const pie = { v: 2, id: 'geld', kind: 'pie', title: 'Ausgaben nach Kategorien', unit: 'EUR', items: [{ label: 'GPU', value: 900 }, { label: 'LLM-APIs', value: 150 }], sources: [] };
    const { spec, rebuilt } = enrichSpec(pie, { tools: [tool(CP)], moneyHint: true });
    assert.equal(rebuilt, true);
    assert.deepEqual(spec.items.map((i) => i.label), ['GPU', 'Auszahlungen', 'LLM-APIs', 'Telefonie']);
    assert.equal(sum(spec.items), 1570);
    assert.match(spec.items[0].detail, /AlphaCloud, BetaGPU/);
  });

  it('a bar that misses the biggest category gets it back (category ledger)', () => {
    const bar = { v: 2, id: 'g', kind: 'bar', title: 'Geld nach Kategorien', unit: 'EUR', items: [{ label: 'Auszahlungen', value: 500 }, { label: 'LLM-APIs', value: 150 }, { label: 'Telefonie', value: 20 }], sources: [] };
    const { spec } = enrichSpec(bar, { tools: [tool(CAT)], moneyHint: true });
    assert.ok(spec.items.some((i) => i.label === 'GPU' && i.value === 900));
    assert.equal(sum(spec.items), 1570);
  });

  it('the title follows the grouping: "Kategorien" on counterparty data becomes "Gegenparteien" (and back)', () => {
    const noBreakdown = `${JSON.stringify({ ...header('counterparty', [['AlphaCloud', 700], ['GammaPayout', 500]]), breakdown: undefined, breakdownComplete: undefined })}\n---\n2026-10-01 | 700 EUR | AlphaCloud | Miete | GPU`;
    const pie = { v: 2, id: 'g', kind: 'pie', title: 'Ausgaben nach Kategorien', unit: 'EUR', items: [{ label: 'AlphaCloud', value: 700 }, { label: 'GammaPayout', value: 500 }], sources: [] };
    const out = enrichSpec(pie, { tools: [tool(noBreakdown)], moneyHint: true }).spec;
    assert.equal(out.title, 'Ausgaben nach Gegenparteien');
    assert.deepEqual(out.items.map((i) => i.label), ['AlphaCloud', 'GammaPayout']);
    // the title names the grouping and the result can carry it: the chart follows the title
    const cp = enrichSpec({ ...pie, title: 'Geld nach Gegenpartei', items: [{ label: 'GPU', value: 1 }, { label: 'LLM-APIs', value: 2 }] }, { tools: [tool(CAT)], moneyHint: true }).spec;
    assert.deepEqual(cp.items.map((i) => i.label).slice(0, 2), ['AlphaCloud', 'GammaPayout']);
    // ... and when it cannot (no breakdown, rows cut), the title follows the data
    const catOnly = `${JSON.stringify({ ...header('category', [['GPU', 900], ['Telefonie', 20]]), breakdown: undefined, breakdownComplete: undefined })}\n---\n2026-10-01 | 700 EUR | AlphaCloud | Miete | GPU`;
    const back = enrichSpec({ ...pie, title: 'Geld nach Gegenpartei', items: [{ label: 'GPU', value: 1 }, { label: 'Telefonie', value: 2 }] }, { tools: [tool(catOnly)], moneyHint: true }).spec;
    assert.equal(back.title, 'Geld nach Kategorie');
    assert.deepEqual(back.items.map((i) => i.label), ['GPU', 'Telefonie']);
  });

  it('a sankey "nach Kategorie und Gegenpartei" on a counterparty ledger has the category level', () => {
    const sankey = { v: 2, id: 's', kind: 'sankey', title: 'Geldfluss nach Kategorie und Gegenpartei', unit: 'EUR', nodes: [{ id: 'a', label: 'Gesamt' }, { id: 'b', label: 'AlphaCloud' }], links: [{ from: 'a', to: 'b', value: 700 }], sources: [] };
    const { spec } = enrichSpec(sankey, { tools: [tool(CP)], moneyHint: true });
    const labels = spec.nodes.map((n) => n.label);
    assert.ok(labels.includes('GPU') && labels.includes('Auszahlungen'), 'category level');
    assert.ok(labels.includes('AlphaCloud') && labels.includes('BetaGPU'), 'counterparty level');
    const out = (id) => spec.links.filter((l) => l.from === id).reduce((s, l) => s + l.value, 0);
    assert.equal(out('gesamt'), 1570);
    assert.equal(out(spec.nodes.find((n) => n.label === 'GPU').id), 900);
  });

  it('a payee drill-down on a category ledger (title without a grouping word) still keeps only the known payees', () => {
    const bar = { v: 2, id: 'g', kind: 'bar', title: 'LLM-Zahlungen', unit: 'EUR', items: [{ label: 'DeltaRouter', value: 100 }, { label: 'EpsilonAPI', value: 50 }, { label: 'Erfunden GmbH', value: 9 }], sources: [] };
    const { spec, rebuilt } = enrichSpec(bar, { tools: [tool(CAT)], moneyHint: true });
    assert.equal(rebuilt, false);
    assert.deepEqual(spec.items.map((i) => i.label), ['DeltaRouter', 'EpsilonAPI']);
  });

  it('item 12: caption claims about currencies / entry counts that contradict the rebuilt chart are removed', () => {
    const bar = { v: 2, id: 'g', kind: 'bar', title: 'Geld nach Kategorien', caption: 'EUR und USD getrennt dargestellt, nicht addiert. Basis: 54 Einträge. Größter Posten ist GPU.', unit: 'EUR', items: [{ label: 'GPU', value: 900 }, { label: 'Telefonie', value: 20 }], sources: [] };
    const { spec } = enrichSpec(bar, { tools: [tool(CAT)], moneyHint: true });
    assert.equal(spec.caption, 'Größter Posten ist GPU.');
    const all = enrichSpec({ ...bar, caption: 'Alles in USD, 54 Einträge.' }, { tools: [tool(CAT)], moneyHint: true }).spec;
    assert.match(all.caption, /^Summe 1\.570,00 € \(ca\.\), 4 Kategorien\.$/);
    const right = enrichSpec({ ...bar, caption: 'Basis: 6 Einträge.' }, { tools: [tool(CAT)], moneyHint: true }).spec;
    assert.equal(right.caption, 'Basis: 6 Einträge.');
  });

  it('the breakdown header of ledger_spend is built from ALL entries, whatever rows fit', async () => {
    const entries = Array.from({ length: 120 }, (_, i) => ({ date: '2026-10-01', amount: 1, currency: 'EUR', eurApprox: 1 + i / 100, counterparty: i % 2 ? 'OddCo' : 'EvenCo', purpose: `Zeile ${i}`, category: i % 3 ? 'GPU' : 'Telefonie', kg: false }));
    const hub = { call: async () => ({ entries, totals: [], totalsEurApprox: [{ key: 'GPU', sumEur: 1, count: 1 }], source: { kind: 'board', ref: 'Board #22' } }) };
    const out = await runTool('ledger_spend', { groupBy: 'category' }, { hub, audit() {}, maxChars: 2500 });
    const head = JSON.parse(out.content.split('\n---\n')[0]);
    assert.equal(head.breakdownComplete, true);
    assert.deepEqual(head.breakdown.map((c) => c.category).sort(), ['GPU', 'Telefonie']);
    const total = head.breakdown.reduce((s, c) => s + c.sumEur, 0);
    assert.ok(Math.abs(total - entries.reduce((s, e) => s + e.eurApprox, 0)) < 0.05);
    assert.equal(parseLedger(out.content).triples.length, 4, 'the viz layer regroups from it although the rows are cut');
  });
});

describe('item 2: a refinement never shows less than what is on the canvas', () => {
  const blocks = { kind: 'flow', title: 'Ablauf' };
  it('the illustrator keeps the 7-node flow when its update has 4 nodes; logs canvas.refine.rejected and clears pending', async () => {
    bus.publish({ phase: 'ready', id: 'ablauf', kind: 'flow', title: 'Ablauf', spec: flowSpec(7), by: 'auto' });
    script = () => answer(JSON.stringify(flowSpec(4)));
    const r = await illustrator().draw({ id: 'ablauf', request: 'Ablauf noch mal', by: 'voice', publish: (p) => bus.publish(p), memory: { snapshot: () => ({ turns: [], facts: '' }), toolsUsed: () => [], lastUser: () => 'Wie läuft das?' } });
    assert.equal(r.kept, true);
    assert.equal(readyOf('ablauf').nodes.length, 7);
    assert.equal(events().at(-1).phase, 'ready');
    assert.equal(audits.filter((a) => a.action === 'canvas.refine.rejected').length, 1);
  });

  it('...unless Florian asked to simplify', async () => {
    bus.publish({ phase: 'ready', id: 'ablauf', kind: 'flow', title: 'Ablauf', spec: flowSpec(7), by: 'auto' });
    const r = await illustrator().draw({ id: 'ablauf', request: 'Mach den Ablauf bitte einfacher', by: 'voice', publish: (p) => bus.publish(p), memory: { snapshot: () => ({ turns: [], facts: '' }), toolsUsed: () => [], lastUser: () => '' } });
    assert.equal(r.kept, undefined);
    assert.equal(readyOf('ablauf').nodes.length, 4);
  });

  it('canvas_render with fewer nodes on a ready id is answered with the existing canvas (shown, kept) and audited', () => {
    bus.publish({ phase: 'ready', id: 'ablauf', kind: 'flow', title: 'Ablauf', spec: flowSpec(7), by: 'auto' });
    const s = session();
    ask(s, 'Danke dir');
    const r = s.render({ ...blocks, id: 'ablauf', nodes: flowSpec(4).nodes, edges: flowSpec(4).edges });
    assert.equal(r.kept, true);
    assert.equal(readyOf('ablauf').nodes.length, 7);
    ask(s, 'Bitte vereinfache den Ablauf');
    s.render({ ...blocks, id: 'ablauf', nodes: flowSpec(4).nodes, edges: flowSpec(4).edges });
    assert.equal(readyOf('ablauf').nodes.length, 4);
  });

  it('a deterministic money rebuild may have fewer groups (another period) and is not rejected', () => {
    const s = session();
    s.noteTool(tool(CAT));
    bus.publish({ phase: 'ready', id: 'geld', kind: 'pie', title: 'Geld', spec: { v: 2, id: 'geld', kind: 'pie', title: 'Geld', items: Array.from({ length: 6 }, (_, i) => ({ label: `K${i}`, value: i + 1 })) }, by: 'auto' });
    ask(s, 'Wofür geben wir das Geld aus?');
    const r = s.render({ kind: 'pie', id: 'geld', title: 'Geld nach Kategorien', unit: 'EUR', items: [{ label: 'GPU', value: 900 }, { label: 'Telefonie', value: 20 }] });
    assert.equal(r.kept, undefined);
    assert.equal(readyOf('geld').items.length, 4);
  });

  it('infoCount counts nodes / items / rows / events / messages / points', () => {
    assert.equal(infoCount(flowSpec(5)), 5);
    assert.equal(infoCount({ kind: 'table', rows: [[1], [2]] }), 2);
    assert.equal(infoCount({ kind: 'line', series: [{ points: [1, 2, 3] }] }), 3);
    assert.equal(infoCount(undefined), 0);
  });
});

describe('item 3: quality gate for tables and sankeys', () => {
  const table = (columns, rows) => ({ kind: 'table', title: 'Voice-Provider', caption: 'Übersicht.', sources: [{ label: 'x', ref: 'Gespräch' }], columns, rows });
  const gate = (spec) => canvas.normalizeCanvas(spec, { gate: true });
  it('rejects the garbage table of critic r6 (rows "vexp: gemini" and "x | y")', () => {
    const r = gate(table(['Provider', 'Modell', 'Status'], [['vexp: gemini', '', ''], ['x', 'y', '']]));
    assert.equal(r.ok, false);
    assert.match(r.error, /table/);
  });
  it('rejects < 2 rows, mostly empty tables, placeholder cells, a row with only its first cell', () => {
    assert.match(gate(table(['A', 'B'], [['eins', 'zwei']])).error, /at least 2/);
    assert.match(gate(table(['A', 'B'], [['eins', ''], ['zwei', ''], ['drei', '']])).error, /mostly empty|only its first cell/);
    assert.match(gate(table(['A', 'B'], [['x', 'y'], ['x', 'y']])).error, /mostly empty or placeholder/);
    assert.match(gate(table(['A', 'B', 'C'], [['eins', 'zwei', 'drei'], ['vier', '', '']])).error, /only its first cell/);
  });
  it('accepts a real table (numbers of one digit are real cells)', () => {
    assert.equal(gate(table(['Provider', 'Anzahl'], [['Grok', '3'], ['Gemini', '5']])).ok, true);
  });
  it('a sankey that promises two levels but has one is rejected; a real two-level one passes', () => {
    const flat = { kind: 'sankey', title: 'Geld nach Kategorie und Gegenpartei', sources: [{ label: 'x', ref: 'Gespräch' }], nodes: [{ id: 'g', label: 'Gesamt' }, { id: 'a', label: 'GPU' }, { id: 'b', label: 'LLM' }], links: [{ from: 'g', to: 'a', value: 5 }, { from: 'g', to: 'b', value: 3 }] };
    assert.match(gate(flat).error, /two levels/);
    const deep = { ...flat, nodes: [...flat.nodes, { id: 'c', label: 'AlphaCloud' }], links: [...flat.links, { from: 'a', to: 'c', value: 5 }] };
    assert.equal(gate(deep).ok, true);
    assert.match(gate({ ...flat, title: 'Geld', links: [flat.links[0]] }).error, /at least 2 flows/);
  });
});

describe('item 4: a render that does not answer the question gets its own id and does not cancel the early run', () => {
  it('Gemini: an old video-block flow rendered on the architecture question\'s id goes to its own canvas; the early run finishes', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    script = async () => { await gate; return answer(JSON.stringify({ ...flowSpec(5), kind: 'architecture', title: 'Architektur Gateway', groups: [{ id: 'g', label: 'Gateway' }], nodes: flowSpec(5).nodes.map((n) => ({ ...n, group: 'g' })) })); };
    const s = session();
    assert.equal(ask(s, 'Erkläre mir die Architektur vom Agent Desk Gateway.'), 'early');
    const earlyId = events()[0].id;
    const r = s.render({ kind: 'flow', title: 'Videoübertragung blockiert', id: earlyId, nodes: flowSpec(4).nodes, edges: flowSpec(4).edges });
    assert.notEqual(r.id, earlyId);
    assert.equal(readyOf(earlyId), undefined, 'nothing wrong under the question\'s id');
    release();
    await s.idle();
    assert.equal(readyOf(earlyId).kind, 'architecture');
    assert.equal(readyOf(r.id).kind, 'flow');
  });

  it('kindsFor: architecture -> architecture, money -> pie/bar/sankey, process -> flow/sequence, explicit words win', async () => {
    const { kindsFor, fitsQuestion } = await import('../src/illustrator.js');
    assert.deepEqual(kindsFor('Erkläre mir die Architektur vom Desk'), ['architecture']);
    assert.ok(kindsFor('Wofür geben wir das Geld aus?').includes('pie'));
    assert.ok(kindsFor('Wie funktioniert der Versand? Zeig den Ablauf').includes('flow'));
    assert.deepEqual(kindsFor('Zeig mir als Tabelle die Provider'), ['table']);
    assert.equal(kindsFor('Wer war das?'), null);
    assert.equal(fitsQuestion('flow', 'Erkläre mir die Architektur'), false);
    assert.equal(fitsQuestion('architecture', 'Erkläre mir die Architektur'), true);
    assert.equal(fitsQuestion('pie', 'Ganz andere Frage'), true);
  });
});

describe('item 5: the early trigger covers Florian\'s real phrasing', () => {
  const TAX = 'Ich habe eine Frage über unsere Steuerrücklagen und über die Notwendigkeit, ständig erhaltene Honoraremissionen überweisen zu müssen und dann in Euro umwandeln zu müssen.';
  it('Florian\'s exact tax sentence starts the early illustrator at once (pending published synchronously)', () => {
    const s = session();
    assert.equal(ask(s, TAX), 'early');
    assert.equal(events()[0].phase, 'pending');
    assert.equal(events()[0].by, 'auto');
  });
  it('the words and any longer question / request count; chit-chat and short status questions do not', () => {
    for (const t of ['Frage zu den Tranchen', 'Was ist mit der Steuer?', 'Rücklage?', 'Wie läuft das mit der Umwandlung', 'Was passiert wenn der Job abbricht', 'Kannst du mir kurz sagen, ob der Job schon fertig ist und was als Nächstes ansteht, damit ich planen kann?']) assert.equal(canvas.isExplanatory(t, ''), true, t);
    for (const t of ['Danke!', 'Läuft der Job gerade noch?', 'Ok alles klar, dann machen wir das so und ich melde mich später wieder bei dir, bis dann und tschüss', 'Prima, das passt so für mich, vielen Dank für die schnelle Hilfe heute Morgen und bis später']) assert.equal(canvas.isExplanatory(t, ''), false, t);
  });
  it('the fast path treats the tax sentence as a knowledge question, not a ledger query', () => {
    assert.deepEqual(fastCalls(TAX).map((c) => c.name), ['knowledge_read', 'search_files']);
    assert.equal(fastCalls('Wofür geben wir das Geld aus?')[0].name, 'ledger_spend');
  });
});

describe('item 6: explicit ids', () => {
  it('the user names an existing canvas id: the early run uses it (update of that canvas)', async () => {
    bus.publish({ phase: 'ready', id: 'wofuer-geben-wir-das-geld-aus', kind: 'pie', title: 'Geld', spec: { v: 2, id: 'wofuer-geben-wir-das-geld-aus', kind: 'pie', title: 'Geld', items: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] }, by: 'auto' });
    const s = session();
    assert.equal(ask(s, 'Aktualisiere die bestehende Canvas mit id "wofuer-geben-wir-das-geld-aus" und zeig nur den Oktober'), 'early');
    const pending = events().find((e) => e.phase === 'pending');
    assert.equal(pending.id, 'wofuer-geben-wir-das-geld-aus');
    assert.match(calls.length ? '' : 'x', /x/);
    await s.idle();
    assert.match(calls[0].messages[1].content, /Update dieser Zeichnung/);
  });

  it('"aktualisiere / ändere die Canvas" without an id points at the newest canvas; chit-chat does not', () => {
    bus.publish({ phase: 'ready', id: 'aelter', kind: 'flow', title: 'a', spec: flowSpec(3, 'aelter'), by: 'text' });
    bus.publish({ phase: 'ready', id: 'neuester-ablauf', kind: 'flow', title: 'b', spec: flowSpec(3, 'neuester-ablauf'), by: 'text' });
    const s = session();
    assert.equal(ask(s, 'Ändere die Zeichnung bitte so, dass Telegram dabei ist'), 'early');
    assert.equal(events().find((e) => e.phase === 'pending' && e.by === 'auto').id, 'neuester-ablauf');
  });

  it('the agent\'s explicit id of an existing canvas wins over the early id; an unknown id still refines the early canvas', async () => {
    bus.publish({ phase: 'ready', id: 'vorhanden', kind: 'flow', title: 'v', spec: flowSpec(3, 'vorhanden'), by: 'text' });
    script = () => new Promise(() => {});
    const s = session();
    ask(s, 'Wie funktioniert der Versand?');
    const earlyId = events().find((e) => e.phase === 'pending').id;
    const a = s.render({ kind: 'flow', title: 'Versand', id: 'vorhanden', nodes: flowSpec(5).nodes, edges: flowSpec(5).edges });
    assert.equal(a.id, 'vorhanden');
    const b = s.render({ kind: 'flow', title: 'Versand', id: 'frei-erfunden', nodes: flowSpec(5).nodes, edges: flowSpec(5).edges });
    assert.equal(b.id, earlyId);
    s.cancelAll();
  });
});

describe('item 7: prose', () => {
  it('both prompts carry the verbatim-numbers rule and name the breakdown', () => {
    for (const text of [buildInstructions(null), voiceInstructions(null)]) {
      assert.match(text, /Zahlen und Kategorien nur wörtlich aus dem Werkzeugergebnis/);
      assert.match(text, /keine Selbstkorrektur-Floskeln \("Moment, ich prüfe"\)/);
      assert.match(text, /"breakdown"/);
    }
  });
  it('CJK glyphs are removed from German text only', () => {
    assert.equal(canvas.stripCjk('ohne弛 Payload'), 'ohne Payload');
    assert.equal(canvas.isGermanText('Wie funktioniert das?'), true);
    assert.equal(canvas.isGermanText('这是什么 wie'), false);
    assert.equal(canvas.isGermanText('What is this'), false);
  });
});

describe('item 8: wantsNoDrawing only for explicit negations of the user\'s own request', () => {
  it('the critic\'s test sentence ("… rufe keine Werkzeuge auf: Ich kann leider keine Diagramme …") is not a drawing ban', () => {
    assert.equal(canvas.wantsNoDrawing('Test der Antwortformatierung: Antworte bitte wörtlich nur mit diesem Satz und rufe keine Werkzeuge auf: Ich kann leider keine Diagramme direkt auf der Canvas für dich erstellen. Zeig mir trotzdem, wie der Login-Link-Ablauf funktioniert.'), false);
    assert.equal(canvas.wantsNoDrawing('Sag „keine Grafik“ und erkläre den Ablauf'), false);
    assert.equal(canvas.wantsNoDrawing('Erkläre ohne Werkzeuge ein Bild'), false);
  });
  it('real negations still count', () => {
    for (const t of ['nicht zeichnen', 'ohne Bild bitte', 'ohne Grafik', 'ohne Diagramm', 'keine Grafik', 'Zeichne bitte nichts', 'Erkläre das, aber keine Skizze dazu']) assert.equal(canvas.wantsNoDrawing(t), true, t);
  });
});

describe('item 11: sources are a path, URL, board ref, DECISIONS key with file, or "Gespräch"', () => {
  const board = (thread, entry) => ({ name: 'board_read', args: { thread }, ok: true, content: `{"entries":2}\n---\n#${entry} [x] hallo\n#${entry + 1} [x] zwei` });
  it('repairs the refs of critic r6 and drops invented ones', () => {
    assert.equal(normalizeRef('Ledger-Aggregation'), null);
    assert.equal(normalizeRef('ledger_spend, Stand 24.10.'), null);
    assert.equal(normalizeRef('src (Code)'), null);
    assert.equal(normalizeRef('AGENTS'), '/home/flori/AGENTS.md');
    assert.equal(normalizeRef('AGENTS.md §6'), '/home/flori/AGENTS.md');
    assert.equal(normalizeRef('Thread #11'), 'Board #11');
    assert.equal(normalizeRef('Board #22, 54 Einträge, Stand 24.10. 17:02 UTC'), 'Board #22');
    assert.equal(normalizeRef('Board #22 (TAX-Zeilen)'), 'Board #22', 'the parenthesis is a comment');
    assert.equal(normalizeRef('Board #22 (ledger_spend, asOf 2026-10-24)'), 'Board #22');
    assert.equal(normalizeRef('Board #22 · Eintrag 25697'), 'Board #22 · Eintrag 25697');
    assert.equal(normalizeRef('DECISIONS.md'), '/home/flori/DECISIONS.md');
    assert.equal(normalizeRef('DECISIONS: bridge-allowlist'), '/home/flori/DECISIONS.md · bridge-allowlist');
    assert.equal(normalizeRef('~/desk-knowledge/topics/x.md'), '~/desk-knowledge/topics/x.md');
    assert.equal(normalizeRef('https://example.com/a'), 'https://example.com/a');
    assert.equal(normalizeRef('gespräch'), 'Gespräch');
    assert.equal(normalizeRef('gateway/src/canvas.js'), '/home/flori/work/agent-desk/gateway/src/canvas.js');
    assert.equal(normalizeRef('beispiel-job-x'), null);
    assert.equal(normalizeRef('beispiel-job-x', [{ name: 'job_status', args: { name: 'beispiel-job-x' }, ok: true }]), '/home/flori/jobs/beispiel-job-x');
  });
  it('an entry id is mapped to its thread through the board_read results of the turn', () => {
    const tools = [board("7", 41234)];
    assert.equal(normalizeRef('Board #41234', tools), 'Board #7 · Eintrag 41234');
    assert.equal(normalizeRef('Thread #41234', tools), 'Board #7 · Eintrag 41234');
    assert.equal(normalizeRef('Board #41234'), 'Board · Eintrag 41234', 'unknown thread: the entry stays an entry, no made-up thread');
  });
  it('enrichSpec applies it: junk sources fall back to the tools of the turn, or to "Gespräch" (unsourced)', () => {
    const spec = { v: 2, id: 'x', kind: 'flow', title: 'x', sources: [{ label: 'Aggregation', ref: 'Ledger-Aggregation' }, { label: 'AGENTS', ref: 'AGENTS' }] };
    assert.deepEqual(enrichSpec(spec, { tools: [] }).spec.sources, [{ label: 'AGENTS.md', ref: '/home/flori/AGENTS.md' }]);
    const bad = { ...spec, sources: [{ label: 'a', ref: 'Ledger-Aggregation' }] };
    const none = enrichSpec(bad, { tools: [] }).spec;
    assert.deepEqual(none.sources, [{ label: 'Gespräch', ref: 'Gespräch' }]);
    assert.equal(none.unsourced, true);
    const withTool = enrichSpec(bad, { tools: [{ name: 'read_file', args: { path: '/home/flori/jobs/j/STATE.md' }, ok: true, content: '' }] }).spec;
    assert.deepEqual(withTool.sources.map((s) => s.ref), ['/home/flori/jobs/j/STATE.md']);
  });
  it('normalizeSources keeps the desk\'s own FX note', () => {
    const list = [{ label: 'Wechselkurs (ca.)', ref: 'USD→EUR 0,9 (Näherung)' }, { label: 'x', ref: 'Quatsch' }];
    assert.deepEqual(normalizeSources(list), [list[0]]);
  });
});

describe('item 14: tool hallucinations', () => {
  const ctx = (extra = {}) => ({ audit() {}, hub: { call: async () => ({ text: 'x' }) }, ...extra });
  it('canvas_render {} becomes a canvas_draw of the user question', async () => {
    const drawn = [];
    const canvasSession = { question: () => 'Wie läuft der Versand?', draw: (a) => (drawn.push(a), { ok: true, id: 'wie-laeuft', status: 'zeichne' }), render: () => { throw new Error('must not render'); } };
    const r = await runTool('canvas_render', {}, ctx({ canvas: canvasSession }));
    assert.equal(r.ok, true, r.content);
    assert.deepEqual(drawn, [{ request: 'Wie läuft der Versand?' }]);
    const r2 = await runTool('canvas_render', { id: 'meine-id' }, ctx({ canvas: canvasSession }));
    assert.deepEqual(drawn[1], { request: 'Wie läuft der Versand?', id: 'meine-id' });
    assert.equal(r2.ok, true);
  });
  it('canvas_render {} without a question is still the old validation error', async () => {
    const r = await runTool('canvas_render', {}, ctx({ canvas: { question: () => '' } }));
    assert.equal(r.ok, false);
    assert.match(r.content, /kind|missing/);
  });
  it('unknown keys like "__unused" are an error that lists the valid arguments', async () => {
    const r = await runTool('read_file', { __unused: 'x' }, ctx());
    assert.equal(r.ok, false);
    assert.match(r.content, /unknown argument\(s\): __unused\. read_file takes: path, offset\?, limit\?/);
    const r2 = await runTool('read_file', { pfad_x: 'x' }, ctx());
    assert.match(r2.content, /missing argument: path \(unknown argument\(s\): pfad_x\)\. read_file takes: path/);
  });
  it('"*_placeholder" tools map to the real tool of the same intent, else are rejected with the list', async () => {
    assert.equal(resolveToolName('search_chunk_placeholder'), 'search_files');
    assert.equal(resolveToolName('read_placeholder'), 'read_file');
    assert.equal(resolveToolName('ledger_placeholder'), 'ledger_spend');
    assert.equal(resolveToolName('claude_task_placeholder'), 'claude_status', 'never mapped onto a tool with side effects');
    assert.equal(resolveToolName('weird_placeholder'), 'weird_placeholder');
    const hub = { calls: [], call: async (m, p) => (hub.calls.push([m, p]), { text: 'treffer' }) };
    const ok = await runTool('search_chunk_placeholder', { query: "thema" }, ctx({ hub }));
    assert.equal(ok.ok, true);
    assert.equal(hub.calls[0][0], 'ctx.search');
    const no = await runTool('weird_placeholder', {}, ctx());
    assert.equal(no.ok, false);
    assert.match(no.content, /unknown tool: weird_placeholder\. Valid tools: .*search_files\(query/);
    assert.ok(TOOL_DEFS.length > 0);
  });
});

describe('found live on the local stack', () => {
  it('a thousands dot inside a caption is no sentence end ("4.321" stays "4.321")', () => {
    const bar = { v: 2, id: 'g', kind: 'bar', title: 'Geld nach Kategorien', caption: 'Basis: 99 Einträge. Größter Posten GPU mit 4.321 EUR.', unit: 'EUR', items: [{ label: 'GPU', value: 900 }, { label: 'Telefonie', value: 20 }], sources: [] };
    assert.equal(enrichSpec(bar, { tools: [tool(CAT)], moneyHint: true }).spec.caption, 'Größter Posten GPU mit 4.321 EUR.');
  });

  it('the tax sentence is a process question, not a money one: the agent\'s flow refines the early canvas (no second canvas)', () => {
    const TAX = 'Ich habe eine Frage über unsere Steuerrücklagen und die Notwendigkeit, erhaltene Honoraremissionen in Euro umwandeln zu müssen.';
    assert.equal(kindsFor(TAX), null);
    const s = session();
    script = () => new Promise(() => {});
    ask(s, TAX);
    const earlyId = events()[0].id;
    const r = s.render({ kind: 'flow', title: 'Emission bis Euro', id: 'eigene-kette', nodes: flowSpec(4).nodes, edges: flowSpec(4).edges });
    assert.equal(r.id, earlyId);
    s.cancelAll();
  });

  it('~/x and /home/flori/x are one source', () => {
    const spec = { v: 2, id: 'x', kind: 'flow', title: 'x', sources: [{ label: 'Wissen', ref: '~/desk-knowledge/topics/a.md' }, { label: 'Wissen', ref: '/home/flori/desk-knowledge/topics/a.md' }] };
    assert.deepEqual(enrichSpec(spec, { tools: [] }).spec.sources.map((s) => s.ref), ['~/desk-knowledge/topics/a.md']);
  });
});

describe('critic r3 P2-3: page-sourced canvases', () => {
  const flow = { id: 'x', kind: 'flow', title: 'Ablauf', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }], sources: [] };
  it('a drawing made from the clicked point is sourced "Seite: <title>", not unsourced', () => {
    const { spec } = enrichSpec(flow, { tools: [], page: { title: 'Demo-Erklärseite', pointId: 'p1', point: { title: 'Schritt' } } });
    assert.deepEqual(spec.sources, [{ label: 'Seite: Demo-Erklärseite', ref: 'Seite: Demo-Erklärseite' }]);
    assert.equal(spec.unsourced, undefined);
  });
  it('without a page point the drawing stays unsourced', () => {
    const { spec } = enrichSpec(flow, { tools: [], page: { title: 'Demo-Erklärseite' } });
    assert.equal(spec.unsourced, true);
  });
});
