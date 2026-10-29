// Round 6 pure pieces: quality gate, drawing heuristics, deterministic money visuals, fast path, tool aliases, Gemini
// transcript repair, provider health. Synthetic data only (public repo).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv();
const canvas = await import('../src/canvas.js');
const { normalizeCanvas, qualityError, wantsNoDrawing, isMetaAnswer, asksForSecrets, RefusalFilter } = canvas;
const { parseLedger, ledgerSeries, moneyBody, applyLedger, ledgerSources } = await import('../src/ledgerViz.js');
const { fastCalls, periodOf, groupByOf, keywordsOf } = await import('../src/fastPath.js');
const { enrichSpec, deriveSources } = await import('../src/illustrator.js');
const { runTool, mapArguments, toolSummary, TOOL_DEFS } = await import('../src/tools.js');
const { repairGlued, knownWords } = await import('../src/voice/transcript.js');

const src = [{ label: 'x', ref: '/x' }];
const node = (id, group) => ({ id, label: id.toUpperCase(), ...(group ? { group } : {}) });
const chain = (n, extra = {}) => ({ kind: 'flow', title: 'Ablauf', sources: src, nodes: Array.from({ length: n }, (_, i) => node(`n${i}`, extra.group)), edges: Array.from({ length: Math.max(0, n - 1) }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })), ...extra });
const gate = (spec) => normalizeCanvas(spec, { gate: true });

describe('quality gate', () => {
  it('is off by default (structural validation only) and on with {gate:true}', () => {
    assert.equal(normalizeCanvas(chain(1)).ok, true);
    assert.equal(gate(chain(1)).ok, false);
    assert.equal(gate(chain(3)).ok, true);
  });

  it('rejects placeholder titles and captions', () => {
    for (const text of ['Platzhalter', 'placeholder', 'TODO', '…', '...', 'Lorem ipsum dolor', 'Noch ein Platzhalter-Knoten']) {
      const r = gate({ ...chain(4), title: text });
      assert.equal(r.ok, false, text);
      assert.match(r.error, /title is a placeholder/);
    }
    assert.match(gate({ ...chain(4), caption: 'Hier steht TODO' }).error, /caption is a placeholder/);
    assert.equal(gate({ ...chain(4), title: 'Todo-Liste im Desk' }).ok, false, 'the word TODO anywhere is a stub');
    assert.equal(gate({ ...chain(4), title: 'Wie der Link-Check arbeitet' }).ok, true);
  });

  it('rejects a placeholder node label', () => {
    const spec = chain(4);
    spec.nodes[2].label = 'Platzhalter';
    assert.match(gate(spec).error, /nodes\[2\]\.label is a placeholder/);
  });

  it('flow / architecture: at least 3 nodes and at least 1 edge', () => {
    assert.match(gate(chain(2)).error, /only 2 node\(s\)/);
    assert.match(gate({ ...chain(4), edges: [] }).error, /no edges/);
    assert.equal(gate(chain(3)).ok, true);
    assert.equal(gate({ ...chain(3), kind: 'architecture' }).ok, true, 'architecture of 3 nodes is fine without groups');
  });

  it('architecture with 6 or more nodes needs groups', () => {
    const six = { ...chain(6), kind: 'architecture' };
    assert.match(gate(six).error, /needs "groups"/);
    const grouped = { ...six, groups: [{ id: 'g1', label: 'Gateway' }], nodes: six.nodes.map((n) => ({ ...n, group: 'g1' })) };
    assert.equal(gate(grouped).ok, true);
    assert.equal(gate({ ...chain(5), kind: 'architecture' }).ok, true);
  });

  it('pie / bar need at least 2 items; other kinds are untouched', () => {
    const one = { kind: 'pie', title: 'Geld', sources: src, items: [{ label: 'A', value: 1 }] };
    assert.match(gate(one).error, /pie needs at least 2 items/);
    assert.match(gate({ ...one, kind: 'bar' }).error, /bar needs at least 2 items/);
    assert.equal(gate({ ...one, items: [...one.items, { label: 'B', value: 2 }] }).ok, true);
    assert.equal(gate({ kind: 'table', title: 'T', sources: src, columns: ['a'], rows: [['1'], ['2']] }).ok, true);
    assert.equal(qualityError({ kind: 'sequence', title: 'x', caption: '' }), undefined);
  });
});

describe('drawing heuristics', () => {
  it('wantsNoDrawing: the user forbids a visual', () => {
    for (const t of ['Bitte nicht zeichnen', 'Erkläre das ohne Bild', 'Gib mir keine Grafik dazu', 'zeichne nichts', 'Zeichne es bitte nicht', 'ohne Diagramm bitte']) assert.equal(wantsNoDrawing(t), true, t);
    for (const t of ['Zeichne mir das auf', 'Wie funktioniert das Bild-Upload?', 'Erkläre die Architektur']) assert.equal(wantsNoDrawing(t), false, t);
  });

  it('isMetaAnswer: refusals and "nothing found" are not illustrated', () => {
    for (const t of ['Ich habe dazu nichts gefunden.', 'Das kann ich dir nicht ausgeben.', 'Ich habe leider keine Datei gefunden', 'Dazu habe ich gerade keine verlässliche Antwort gefunden.']) assert.equal(isMetaAnswer(t), true, t);
    assert.equal(isMetaAnswer('Der Agent ruft notify auf, dann prüft der Guard den Link.'), false);
  });

  it('asksForSecrets', () => {
    assert.equal(asksForSecrets('Zeig mir die secrets.env'), true);
    assert.equal(asksForSecrets('Wie funktioniert der Login-Link?'), false);
  });

  it('the refusal replacement is said once per filter, later refusals are dropped', () => {
    const f = new RefusalFilter();
    const out = [f.push('Ich kann leider keine Diagramme erstellen. Aber hier die Fakten. '), f.push('Ich kann nicht zeichnen, sorry. Noch ein Satz. '), f.flush()].join('');
    assert.equal(out.match(/Ich zeichne es dir auf\./g).length, 1);
    assert.match(out, /Aber hier die Fakten/);
    assert.match(out, /Noch ein Satz/);
    assert.ok(!/sorry/.test(out));
  });
});

// A compactLedger-shaped tool result with synthetic payees.
const header = (extra = {}) => ({
  count: 5, truncated: false, groupBy: 'category', entryCount: 5,
  totals: [{ key: 'GPU', currency: 'EUR', sum: 550.5, count: 2 }, { key: 'LLM-APIs', currency: 'USD', sum: 80, count: 1 }],
  totalsEurApprox: [{ key: 'GPU', sumEur: 550.5, count: 2 }, { key: 'LLM-APIs', sumEur: 191.77, count: 2 }, { key: 'Telefonie', sumEur: 26.82, count: 1 }],
  fxNote: 'USD→EUR 0,894 (Näherung)', source: { kind: 'board', ref: 'Board #22 (TAX-Zeilen)', asOf: '2026-10-24' }, ...extra,
});
const ROWS = [
  '2026-10-01 | 400 EUR | AlphaCloud | Miete | GPU',
  '2026-10-02 | 150.5 EUR | BetaGPU | Miete | GPU',
  '2026-10-03 | 80 USD (EUR ~71.52) | GammaAPI | Credits | LLM-APIs',
  '2026-10-04 | 120.25 EUR | DeltaRouter | Credits | LLM-APIs | KG',
  '2026-10-05 | 30 USD (EUR ~26.82) | EpsilonTel | Anrufe | Telefonie',
];
const ledgerText = (h = header(), rows = ROWS) => `${JSON.stringify(h)}\n---\n${rows.join('\n')}`;

describe('deterministic money visuals', () => {
  it('parseLedger reads header and rows, and knows whether every entry is shown', () => {
    const l = parseLedger(ledgerText());
    assert.equal(l.rows.length, 5);
    assert.deepEqual(l.rows[2], { date: '2026-10-03', counterparty: 'GammaAPI', category: 'LLM-APIs', eur: 71.52 });
    assert.equal(l.rows[3].category, 'LLM-APIs', 'the KG flag is not the category');
    assert.equal(l.complete, true);
    assert.equal(parseLedger(ledgerText(header({ entryCount: 9 }))).complete, false);
    assert.equal(parseLedger('not json'), null);
    assert.equal(parseLedger('{"foo":1}'), null);
  });

  it('series use the EUR approximation, labelled "€ (ca.)", biggest first', () => {
    const s = ledgerSeries(parseLedger(ledgerText()));
    assert.equal(s.unit, '€ (ca.)');
    assert.deepEqual(s.list.map((t) => [t.label, t.value]), [['GPU', 550.5], ['LLM-APIs', 191.77], ['Telefonie', 26.82]]);
  });

  it('pie body: values from the ledger, details are real counterparties of that category', () => {
    const body = moneyBody(parseLedger(ledgerText()), 'pie');
    assert.equal(body.unit, '€ (ca.)');
    assert.deepEqual(body.items.map((i) => [i.label, i.value]), [['GPU', 550.5], ['LLM-APIs', 191.77], ['Telefonie', 26.82]]);
    assert.equal(body.items[0].detail, 'AlphaCloud, BetaGPU');
    assert.equal(body.items[1].detail, 'DeltaRouter, GammaAPI');
  });

  it('details say "u. a." when not every entry is shown', () => {
    const body = moneyBody(parseLedger(ledgerText(header({ entryCount: 40 }))), 'bar');
    assert.match(body.items[0].detail, /^u\. a\. /);
  });

  it('single currency without EUR approximation: that currency is the unit', () => {
    const l = parseLedger(ledgerText(header({ totalsEurApprox: [], totals: [{ key: 'GPU', currency: 'USD', sum: 5, count: 1 }, { key: 'X', currency: 'USD', sum: 2, count: 1 }] })));
    assert.equal(ledgerSeries(l).unit, 'USD');
    assert.equal(ledgerSeries(parseLedger(ledgerText(header({ totalsEurApprox: [], totals: [{ key: 'a', currency: 'USD', sum: 1 }, { key: 'b', currency: 'EUR', sum: 1 }] })))), null);
  });

  it('more than 12 groups: the tail is folded into "Sonstige" with an exact sum', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ key: `K${i}`, sumEur: 100 - i, count: 1 }));
    const body = moneyBody(parseLedger(ledgerText(header({ totalsEurApprox: many }), [])), 'pie');
    assert.equal(body.items.length, 12);
    assert.deepEqual([body.items[11].label, body.items[11].value], ['Sonstige', many.slice(11).reduce((s, t) => s + t.sumEur, 0)]);
  });

  it('months become "Okt 2026" in time order', () => {
    const l = parseLedger(ledgerText(header({ groupBy: 'month', totalsEurApprox: [{ key: '2026-10', sumEur: 5 }, { key: '2026-09', sumEur: 7 }] }), []));
    assert.deepEqual(ledgerSeries(l).list.map((t) => t.label), ['Sep 2026', 'Okt 2026']);
  });

  it('sankey: Gesamt -> categories -> top counterparties; flows add up per category', () => {
    const body = moneyBody(parseLedger(ledgerText()), 'sankey');
    const out = (id) => body.links.filter((l) => l.from === id).reduce((s, l) => s + l.value, 0);
    assert.equal(Math.round(out('gesamt') * 100) / 100, 769.09);
    const gpu = body.nodes.find((n) => n.label === 'GPU').id;
    assert.equal(Math.round(out(gpu) * 100) / 100, 550.5);
    assert.ok(body.nodes.some((n) => n.label === 'AlphaCloud'));
    assert.ok(body.nodes.length <= 24 && body.links.length <= 40);
    assert.equal(body.unit, '€ (ca.)');
    const partial = moneyBody(parseLedger(ledgerText(header({ entryCount: 40 }))), 'sankey');
    assert.ok(!partial.nodes.some((n) => n.label === 'AlphaCloud'), 'no second level from partial rows');
  });

  it('applyLedger replaces model items (with invented payees) by the ledger when the labels are the ledger groups', () => {
    const spec = { kind: 'pie', title: 'Geld', unit: 'EUR', items: [{ label: 'GPU', value: 5120.5 }, { label: 'RunCloud', value: 12 }, { label: 'Telefonie', value: 20 }] };
    const r = applyLedger(spec, parseLedger(ledgerText()), { moneyHint: true, ledgerText: ledgerText() });
    assert.equal(r.rebuilt, true);
    assert.deepEqual(r.spec.items.map((i) => [i.label, i.value]), [['GPU', 550.5], ['LLM-APIs', 191.77], ['Telefonie', 26.82]]);
  });

  it('applyLedger on counterparty items: unknown payees are dropped, known ones stay', () => {
    const spec = { kind: 'bar', title: 'LLM', unit: 'EUR', items: [{ label: 'GammaAPI', value: 71.52 }, { label: 'DeltaRouter', value: 120.25 }, { label: 'Hostinger', value: 9 }] };
    const r = applyLedger(spec, parseLedger(ledgerText()), { moneyHint: true, ledgerText: ledgerText() });
    assert.equal(r.rebuilt, false);
    assert.deepEqual(r.spec.items.map((i) => i.label), ['GammaAPI', 'DeltaRouter']);
    assert.equal(r.dropped, 1);
  });

  it('applyLedger leaves non-money charts alone', () => {
    const spec = { kind: 'bar', title: 'Scores', items: [{ label: 'Modell A', value: 91 }, { label: 'Modell B', value: 84 }] };
    assert.equal(applyLedger(spec, parseLedger(ledgerText()), { moneyHint: false, ledgerText: ledgerText() }), null);
    assert.equal(applyLedger({ kind: 'flow', title: 'x' }, parseLedger(ledgerText()), { moneyHint: true }), null);
  });

  it('ledgerSources: the ledger\'s own ref and the FX note; an export path only when the source is an export', () => {
    assert.deepEqual(ledgerSources(parseLedger(ledgerText())), [{ label: 'Board #22 (Buchungen)', ref: 'Board #22' }, { label: 'Wechselkurs (ca.)', ref: 'USD→EUR 0,894 (Näherung)' }]);
    const exp = ledgerSources(parseLedger(ledgerText(header({ source: { kind: 'export', ref: '/data/export.md' }, fxNote: undefined }))));
    assert.deepEqual(exp, [{ label: 'Ledger-Export', ref: '/data/export.md' }]);
  });
});

describe('enrichSpec: sources from the turn\'s tools', () => {
  const unsourced = (extra = {}) => normalizeCanvas({ kind: 'pie', title: 'Geld', items: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }], sources: [], ...extra }).spec;
  const tool = (name, args, content = '{}') => ({ name, args, ok: true, content });

  it('no sources / only Gespräch + tools ran -> the tools\' sources', () => {
    const tools = [tool('read_file', { path: '/home/flori/a.md' }), tool('board_read', { thread: '22' }), tool('code_outline', { path: '/home/flori/work/agent-desk/gateway/src' })];
    for (const spec of [unsourced(), unsourced({ sources: [{ label: 'Gespräch', ref: 'Gespräch' }] })]) {
      const { spec: out } = enrichSpec(spec, { tools });
      assert.deepEqual(out.sources.map((s) => s.ref), ['/home/flori/a.md', 'Board #22', '/home/flori/work/agent-desk/gateway/src']);
      assert.equal(out.unsourced, undefined);
    }
  });

  it('a spec with a real source keeps it; without any tool it stays unsourced', () => {
    const real = unsourced({ sources: [{ label: 'Mine', ref: '/x/y.md' }] });
    assert.deepEqual(enrichSpec(real, { tools: [tool('read_file', { path: '/z' })] }).spec.sources, [{ label: 'Mine', ref: '/x/y.md' }]);
    assert.equal(enrichSpec(unsourced(), { tools: [] }).spec.unsourced, true);
  });

  it('knowledge_read -> ~/desk-knowledge/topics/<slug>.md from the result header; an unknown topic gives no source', () => {
    const hit = tool('knowledge_read', { topic: 'Steuer' }, '{"found":true,"topic":"owner-emissions-tax","path":"/home/flori/desk-knowledge/topics/owner-emissions-tax.md"}\n---\ntext');
    assert.deepEqual(deriveSources([hit]), [{ label: 'Desk-Wissen: owner-emissions-tax', ref: '~/desk-knowledge/topics/owner-emissions-tax.md' }]);
    assert.deepEqual(deriveSources([tool('knowledge_read', { topic: 'xyz' }, '{"found":false,"topic":"xyz"}')]), []);
    assert.deepEqual(deriveSources([tool('knowledge_read', {}, '{"found":true,"topic":"INDEX"}\n---\n')]), [{ label: 'Desk-Wissen: Übersicht', ref: '~/desk-knowledge/INDEX.md' }]);
  });

  it('ledger_spend -> its source.ref; a claimed GELDBEWEGUNGEN file is removed unless the source is an export', () => {
    const ledgerTool = tool('ledger_spend', {}, ledgerText());
    const claimed = unsourced({ sources: [{ label: 'GELDBEWEGUNGEN_2026.md', ref: 'GELDBEWEGUNGEN_2026.md' }, { label: 'Gespräch', ref: 'Gespräch' }] });
    const { spec } = enrichSpec(claimed, { tools: [ledgerTool] });
    assert.ok(!spec.sources.some((s) => /GELDBEWEGUNGEN/.test(s.ref)));
    assert.ok(spec.sources.some((s) => s.ref === 'Board #22'), JSON.stringify(spec.sources));
    const exportTool = tool('ledger_spend', {}, ledgerText(header({ source: { kind: 'export', ref: '/data/GELDBEWEGUNGEN_2026.md' } })));
    const kept = enrichSpec(unsourced({ sources: [{ label: 'Export', ref: '/data/GELDBEWEGUNGEN_2026.md' }] }), { tools: [exportTool] }).spec;
    assert.ok(kept.sources.some((s) => /GELDBEWEGUNGEN/.test(s.ref)));
  });

  it('ledger_spend + a money pie: items from the ledger, unit "€ (ca.)", FX note in the sources', () => {
    const spec = unsourced({ unit: 'EUR', items: [{ label: 'GPU', value: 999 }, { label: 'Telefonie', value: 20 }] });
    const { spec: out, rebuilt } = enrichSpec(spec, { tools: [tool('ledger_spend', {}, ledgerText())], moneyHint: true });
    assert.equal(rebuilt, true);
    assert.equal(out.unit, '€ (ca.)');
    assert.equal(out.items.find((i) => i.label === 'Telefonie').value, 26.82);
    assert.ok(out.sources.some((s) => /Wechselkurs/.test(s.label)));
  });
});

describe('fast path', () => {
  const today = { year: 2026, month: 10, day: 24 };
  it('money questions call ledger_spend with groupBy and period from the words', () => {
    assert.deepEqual(fastCalls('Wofür geben wir das Geld aus?', { now: new Date('2026-10-24T10:00:00Z') }), [{ name: 'ledger_spend', args: { groupBy: 'category' } }]);
    assert.deepEqual(fastCalls('Zeig mir die Ausgaben pro Gegenpartei im Oktober', { now: new Date('2026-10-24T10:00:00Z') })[0].args, { groupBy: 'counterparty', from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(groupByOf('Verlauf der Kosten pro Monat'), 'month');
  });
  it('periods: month names, this/last month, today', () => {
    assert.deepEqual(periodOf('im September', today), { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(periodOf('im Dezember', today), { from: '2025-12-01', to: '2025-12-31' });
    assert.deepEqual(periodOf('im Februar 2026', today), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(periodOf('letzten Monat', { year: 2026, month: 1, day: 3 }), { from: '2025-12-01', to: '2025-12-31' });
    assert.deepEqual(periodOf('diesen Monat', today), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(periodOf('was kostet heute', today), { from: '2026-10-24', to: '2026-10-24' });
    assert.deepEqual(periodOf('alles', today), {});
  });
  it('architecture of the desk -> code_outline of the repo directories; of anything else -> knowledge_read', () => {
    assert.deepEqual(fastCalls('Erkläre mir die Architektur vom Agent Desk Gateway').map((c) => c.args.path ?? c.name), ['/home/flori/work/agent-desk/gateway/src', 'desk_status']);
    const all = fastCalls('Erkläre die Architektur vom Agent Desk');
    assert.deepEqual(all.map((c) => c.args.path ?? c.name), ['/home/flori/work/agent-desk/gateway/src', '/home/flori/work/agent-desk/bridge/src', '/home/flori/work/agent-desk/web/src', 'desk_status']);
    assert.deepEqual(fastCalls('Wie ist der Aufbau von JevBench?'), [{ name: 'knowledge_read', args: { topic: 'JevBench' } }]);
  });
  it('any other explanatory question: knowledge_read and search_files for its content words, in parallel', () => {
    assert.deepEqual(fastCalls('Wie funktioniert die Video-Sendeblockierung?'), [
      { name: 'knowledge_read', args: { topic: 'video sendeblockierung' } },
      { name: 'search_files', args: { query: 'video sendeblockierung', scope: 'all', maxHits: 8 } },
    ]);
    assert.equal(keywordsOf('Wie funktioniert das?'), '');
    assert.deepEqual(fastCalls('Wie funktioniert das?'), []);
    assert.equal(keywordsOf('Erkläre mir bitte den Tranchen-Automaten für die Honorar-Emissionen von SN92 und mehr'), 'tranchen automaten honorar emissionen');
  });
});

describe('tool hallucinations', () => {
  const ctx = (calls = []) => ({ hub: { call: async (method, params) => { calls.push([method, params]); return { text: 'x', topic: 't', found: true }; } }, audit: () => {}, maxChars: 4000 });

  it('an unknown tool is an error that lists the valid tools and their arguments', async () => {
    const r = await runTool('frobnicate_search_placeholder', { q: 'x' }, ctx());
    assert.equal(r.ok, false);
    assert.match(r.content, /unknown tool: frobnicate_search_placeholder/);
    assert.match(r.content, /Valid tools: /);
    assert.match(r.content, /read_file\(path, offset\?, limit\?\)/);
    assert.match(r.content, /knowledge_read\(topic\?\)/);
    assert.ok(r.content.length < 1500);
    assert.ok(r.summary.length <= 180);
    assert.equal(toolSummary().split('; ').length, TOOL_DEFS.length);
  });

  it('argument aliases are mapped: file_path -> path, name/slug -> topic, query -> topic', async () => {
    const calls = [];
    await runTool('read_file', { file_path: '/home/flori/a.md' }, ctx(calls));
    await runTool('knowledge_read', { name: 'sn92' }, ctx(calls));
    await runTool('knowledge_read', { slug: 'server' }, ctx(calls));
    await runTool('search_files', { topic: 'Steuer' }, ctx(calls));
    await runTool('read_core_doc', { topic: 'AGENTS' }, ctx(calls));
    await runTool('job_status', { job: 'abc' }, ctx(calls));
    assert.deepEqual(calls.map((c) => c[1]), [{ path: '/home/flori/a.md', offset: undefined, limit: undefined }, { topic: 'sn92' }, { topic: 'server' }, { query: 'Steuer', scope: undefined, maxHits: undefined }, { name: 'AGENTS', maxChars: undefined }, { name: 'abc' }]);
  });

  it('a real argument is never overwritten by an alias; /home/florian and ~ are fixed in paths', () => {
    const def = TOOL_DEFS.find((t) => t.name === 'read_file');
    assert.deepEqual(mapArguments(def, { path: '/a', file_path: '/b' }), { path: '/a', file_path: '/b' });
    assert.equal(mapArguments(def, { path: '/home/florian/x.md' }).path, '/home/flori/x.md');
    assert.equal(mapArguments(def, { file_path: '~/x.md' }).path, '/home/flori/x.md');
    assert.equal(mapArguments(def, { path: '/home/florianx/y' }).path, '/home/florianx/y');
  });
});

describe('Gemini transcript repair', () => {
  it('splits glued German compounds with a hyphen (patterns from the round-5 transcripts)', () => {
    const text = 'um rund 35 Prozent Einkommensteuer auf die zufließenden KryptoEmissionen und die laufenden GPUServerkosten. Der TranchenAutomat pausiert, der AlphaPreis ist niedrig, EuroErlöse sichern das.';
    const fixed = repairGlued(text);
    for (const w of ['Krypto-Emissionen', 'GPU-Serverkosten', 'Tranchen-Automat', 'Alpha-Preis', 'Euro-Erlöse']) assert.ok(fixed.includes(w), `${w} in ${fixed}`);
    assert.equal(fixed.replace(/-/g, ''), text.replace(/-/g, ''), 'nothing else changes: spaces stay');
  });
  it('brand names and words seen in tool results stay whole', () => {
    const text = 'OpenRouter, JevBench, GitHub, TensorX und DeepSeek; Eigenname Zetavia';
    assert.equal(repairGlued(text, knownWords('Zetavia steht im Wissen')), text);
  });
  it('spaces and existing hyphens are kept', () => {
    const t = 'Ich sehe mir das direkt an. Krypto-Emissionen und GPU-Server kosten Geld.';
    assert.equal(repairGlued(t), t);
  });
});
