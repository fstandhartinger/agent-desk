// Round 8 (critic r7 §7 items 3, 4, 6, 7, 10): subset-only rejection, live desk facts, deterministic money prose,
// GPT-Live instructions, late draws without stage focus, source normalisation. Synthetic data only.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_EARLY: '0', DESK_CANVAS_TIMEOUT_MS: '600', DESK_CANVAS_DEBOUNCE_MS: '30', DESK_CANVAS_RESEARCH_MS: '60', XAI_API_KEY: 'x', OPENAI_API_KEY: 'o', GOOGLE_API_KEY: 'g' });
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator, enrichSpec, entriesOf, offTopic, shrinks, ILLUSTRATOR_TOOLS, SYSTEM_PROMPT } = await import('../src/illustrator.js');
const { createMoneyGuard, answerList, parseLedger } = await import('../src/ledgerViz.js');
const { normalizeCanvas } = await import('../src/canvas.js');
const { dropOffTopicSources, normalizeRef } = await import('../src/sources.js');
const { fastCalls, isDeskStatusQuestion } = await import('../src/fastPath.js');
const { runTool, TOOL_DEFS } = await import('../src/tools.js');
const health = await import('../src/providerHealth.js');
const { buildInstructions } = await import('../src/voice/instructions.js');
const { buildInstructions: textInstructions } = await import('../src/prompt.js');

const table = (rows, sources = [{ label: 'Job', ref: '/home/flori/jobs/job-x' }]) => normalizeCanvas({ v: 2, id: 'voice-provider', kind: 'table', title: 'Voice-Provider', sources, columns: ['Provider', 'Modell', 'Status'], rows }).spec;
const answer = (content) => ({ message: { content, tool_calls: [] }, costUsd: 0.001 });
let bus; let audits; let calls; let script;
const complete = async (call) => { calls.push(call); return script(call, calls.length - 1); };
const run = async (name) => ({ ok: true, content: name === 'ledger_spend' ? '{}' : '{}', summary: 's' });
const illustrator = () => createIllustrator({ bus, hub: {}, complete, run, audit: (a) => audits.push(a) });
const session = (extra = {}) => createCanvasSession({ bus, illustrator: illustrator(), by: 'voice', provider: 'gemini', emit: () => {}, ctx: {}, debounceMs: () => 30, researchMs: () => 60, ...extra });
const events = () => bus.replay(0).map((e) => e.event);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => { bus = createCanvasBus(); audits = []; calls = []; script = () => answer('{}'); health.resetProviderHealthForTests(); });

describe('item 3: subset => reject, different => the newest well-sourced drawing wins', () => {
  const stale = table([['xAI', 'grok-voice-3.0', 'kein Guthaben'], ['OpenAI', 'gpt-live-1', 'kein Guthaben'], ['Gemini', 'gemini-live', 'ok'], ['ElevenLabs', 'tts', 'ok']]);
  const live = table([['xAI', 'grok-voice-3.0', 'arbeitet'], ['OpenAI', 'gpt-live-1', 'arbeitet'], ['Gemini', 'gemini-live', 'arbeitet']], [{ label: 'Desk-Status', ref: '/home/flori/work/agent-desk/gateway/src/deskStatus.js' }]);

  it('entriesOf: whole table rows, node labels, item label + value', () => {
    assert.deepEqual([...entriesOf(stale)].sort()[0], 'elevenlabs tts ok');
    assert.equal(entriesOf(stale).size, 4);
    assert.deepEqual([...entriesOf({ kind: 'bar', items: [{ label: 'GPU', value: 5 }] })], ['gpu 5']);
  });

  it('a strict subset (same labels, fewer) is still rejected; different content with fewer rows is not', () => {
    const subset = table([['xAI', 'grok-voice-3.0', 'kein Guthaben'], ['Gemini', 'gemini-live', 'ok']]);
    assert.equal(shrinks(stale, subset), true);
    assert.equal(shrinks(stale, live), false, 'critic r7: the correct 3-row table must replace the stale 4-row one');
    assert.equal(shrinks(stale, stale), false);
  });

  it('different but UNSOURCED content with fewer entries does not displace a sourced drawing', () => {
    const unsourced = normalizeCanvas({ v: 2, id: 'voice-provider', kind: 'table', title: 'Voice-Provider', columns: ['A', 'B'], rows: [['Foo', 'bar'], ['Baz', 'qux']] }).spec;
    assert.equal(shrinks(stale, unsourced), true);
  });

  it('the agent\'s canvas_render of a differing table replaces the early one (kept is no longer true)', () => {
    bus.publish({ phase: 'ready', id: 'voice-provider', kind: 'table', title: stale.title, spec: stale, by: 'auto' });
    const s = session();
    s.startTurn();
    s.noteTurn({ role: 'user', text: 'Zeig mir als Tabelle die Voice-Provider des Agent Desk mit Modell und Status.' });
    const out = s.render({ ...live, id: 'voice-provider' });
    assert.equal(out.kept, undefined);
    assert.equal(bus.latest().find((e) => e.id === 'voice-provider').spec.rows.length, 3);
    assert.equal(bus.latest().find((e) => e.id === 'voice-provider').spec.rows[0][2], 'arbeitet');
  });

  it('a plain shrink of the same content is still kept (no regression of the r7 rule)', () => {
    bus.publish({ phase: 'ready', id: 'voice-provider', kind: 'table', title: stale.title, spec: stale, by: 'auto' });
    const s = session();
    s.startTurn();
    s.noteTurn({ role: 'user', text: 'Zeig die Voice-Provider als Tabelle.' });
    const out = s.render({ ...stale, rows: stale.rows.slice(0, 2), id: 'voice-provider' });
    assert.equal(out.kept, true);
    assert.equal(bus.latest().find((e) => e.id === 'voice-provider').spec.rows.length, 4);
  });
});

describe('item 3: live desk facts for status questions', () => {
  it('desk_status reports providerHealth and the bridges, not job notes', async () => {
    health.markOk('openai');
    health.markFailure('xai', 'Kein Guthaben');
    const hub = { status: () => [{ host: 'sandy', connected: true, since: '2026-10-24T10:00:00Z', claude: { running: 1, max: 3 } }] };
    const out = await runTool('desk_status', {}, { hub, audit() {} });
    assert.equal(out.ok, true, out.content);
    const facts = JSON.parse(out.content);
    const by = Object.fromEntries(facts.voiceProviders.map((p) => [p.provider.split(' ')[0], p]));
    assert.match(by.xAI.state, /gestört: Kein Guthaben/);
    assert.equal(by.OpenAI.state, 'arbeitet');
    assert.match(by.Google.state, /noch nicht geprüft/);
    assert.equal(by.OpenAI.model, 'gpt-live-1');
    assert.deepEqual(facts.bridges.map((b) => b.host), ['sandy']);
    assert.ok(!JSON.stringify(facts).match(/sk-|key/i), 'no secret material');
  });

  it('the status question of the critic triggers desk_status in the fast path; other questions do not', () => {
    for (const q of ['Zeig mir als Tabelle die Voice-Provider des Agent Desk mit Modell und Status.', 'Welche Modelle nutzt der Desk?', 'Hat xAI noch Guthaben?', 'Ist die Bridge verbunden?']) {
      assert.equal(isDeskStatusQuestion(q), true, q);
      assert.deepEqual(fastCalls(q, {}).map((c) => c.name), ['desk_status'], q);
    }
    assert.equal(isDeskStatusQuestion('Wohin geht das Geld?'), false);
    assert.deepEqual(fastCalls('Wohin geht das Geld im Oktober?', {}).map((c) => c.name), ['ledger_spend']);
  });

  it('the illustrator and the agents have the tool and are told to prefer it', () => {
    assert.ok(ILLUSTRATOR_TOOLS.includes('desk_status'));
    assert.ok(TOOL_DEFS.some((t) => t.name === 'desk_status'));
    assert.match(SYSTEM_PROMPT, /desk_status FIRST/);
    assert.match(textInstructions(null), /desk_status/);
    assert.match(buildInstructions(null), /desk_status/);
  });

  it('the early illustrator runs desk_status first, so its first model round sees the live state', async () => {
    const ran = [];
    const ill = createIllustrator({ bus, hub: {}, complete: async (call) => { calls.push(call); return answer(JSON.stringify({ v: 2, id: 'vp', kind: 'table', title: 'Voice-Provider', sources: [], columns: ['Provider', 'Status'], rows: [['xAI', 'arbeitet'], ['OpenAI', 'arbeitet']] })); }, run: async (name, args) => { ran.push(name); return { ok: true, content: '{"voiceProviders":[]}', summary: 's' }; }, audit() {} });
    await ill.draw({ id: 'vp', request: 'Zeig die Voice-Provider als Tabelle mit Status', question: 'Zeig die Voice-Provider als Tabelle mit Status', early: true, by: 'auto', publish: (p) => bus.publish({ by: 'auto', ...p }), memory: undefined });
    assert.deepEqual(ran, ['desk_status']);
  });
});

// A counterparty-grouped ledger result (synthetic names and values)
const header = { count: 4, groupBy: 'counterparty', entryCount: 4, truncated: false, totals: [], totalsEurApprox: [{ key: 'AlphaCloud — pro forma PF/1', sumEur: 700, count: 2 }, { key: 'AlphaCloud — pro forma PF/2', sumEur: 100.5, count: 1 }, { key: 'GammaPayout', sumEur: 500, count: 1 }, { key: 'ZetaTel', sumEur: 20.25, count: 1 }], fxNote: 'USD→EUR 0,9 (Näherung)', source: { kind: 'board', ref: 'Board #22 (TAX-Zeilen)' } };
const LEDGER = `${JSON.stringify(header)}\n---\n2026-10-01 | 700 EUR | AlphaCloud | Miete | GPU\n2026-10-02 | 100.5 EUR | AlphaCloud | Miete | GPU`;
const BAD = 'AlphaCloud liegt bei 1.234,50 € – Moment, das stimmt nicht, mein erster Satz war falsch. Entschuldige. fakecorp221: 221 € – Moment, auch das stimmt nicht. **6.000 €** (Unbekannt?). Ich merke, ich vermische gerade die Zahlen.';

describe('item 4: deterministic ledger prose', () => {
  it('answerList: label -> EUR (ca.), count; one payee per name; the total; folded like the chart', () => {
    const list = answerList(header);
    assert.deepEqual(list.lines, ['AlphaCloud: 800,50 € (ca.), 3 Einträge', 'GammaPayout: 500,00 € (ca.), 1 Eintrag', 'ZetaTel: 20,25 € (ca.), 1 Eintrag', 'Summe: 1.320,75 € (ca.), 5 Einträge']);
    const many = answerList({ groupBy: 'counterparty', totalsEurApprox: Array.from({ length: 15 }, (_, i) => ({ key: `Firma${i}`, sumEur: 100 - i, count: 1 })) });
    assert.equal(many.rows.length, 12);
    assert.equal(many.rows.at(-1).key, 'Sonstige');
    assert.equal(many.total, 15 * 100 - 105);
  });

  it('the ledger_spend result the text model sees ends with the list and the instruction "liste genau diese Werte"', async () => {
    const entries = [{ date: '2026-10-01', amount: 700, currency: 'EUR', eurApprox: 700, counterparty: 'AlphaCloud', purpose: 'Miete', category: 'GPU', kg: true }, { date: '2026-10-02', amount: 500, currency: 'EUR', eurApprox: 500, counterparty: 'GammaPayout', purpose: 'Auszahlung', category: 'Auszahlungen', kg: false }];
    const hub = { call: async () => ({ entries, count: 2, groupBy: 'counterparty', totals: [], totalsEurApprox: [{ key: 'AlphaCloud', sumEur: 700, count: 1 }, { key: 'GammaPayout', sumEur: 500, count: 1 }], source: { kind: 'board', ref: 'Board #22' } }) };
    const out = await runTool('ledger_spend', { groupBy: 'counterparty' }, { hub, audit() {}, maxChars: 2500 });
    assert.match(out.content, /liste genau diese Werte/);
    assert.match(out.content, /AlphaCloud: 700,00 € \(ca\.\), 1 Eintrag\nGammaPayout: 500,00 € \(ca\.\), 1 Eintrag\nSumme: 1\.200,00 € \(ca\.\), 2 Einträge$/);
    assert.ok(parseLedger(out.content), 'the header is still parseable');
    assert.ok(out.content.length <= 2500);
  });

  it('the critic\'s bad answer is flagged and replaced by the deterministic list; no marker or invented figure survives', () => {
    const guard = createMoneyGuard(LEDGER);
    const checked = guard.check(BAD);
    assert.equal(checked.ok, false);
    const fixed = guard.fix(BAD);
    assert.doesNotMatch(fixed, /Moment|stimmt nicht|vermische|Entschuldige|falsch|6\.000|fakecorp|1\.234,50/i);
    assert.match(fixed, /- AlphaCloud: 800,50 € \(ca\.\), 3 Einträge/);
    assert.match(fixed, /- Summe: 1\.320,75 € \(ca\.\)/);
    assert.equal(guard.check(fixed).ok, true, 'the replacement passes its own check');
  });

  it('a clean answer that only uses the ledger\'s values is left alone (also rounded ones)', () => {
    const guard = createMoneyGuard(LEDGER);
    const good = 'Am meisten geht an AlphaCloud: 800,50 € (ca.). Danach GammaPayout mit rund 500 €. Insgesamt 1.320,75 €.';
    assert.equal(guard.check(good).ok, true);
    assert.equal(guard.fix(good), good);
  });

  it('each marker alone flags the answer; a number that is not in the result flags it; non-money sentences survive the fix', () => {
    const guard = createMoneyGuard(LEDGER);
    for (const text of ['Moment, ich prüfe das.', 'Das stimmt nicht ganz.', 'Ich vermische die Werte.', 'Mein erster Satz war falsch.', 'Entschuldige, GammaPayout ist 500 €.', 'GammaPayout: 999 €.']) assert.equal(guard.check(text).ok, false, text);
    const fixed = guard.fix('Hier die Übersicht. ZetaTel: 77 €. Das ist die Lage.');
    assert.match(fixed, /^Hier die Übersicht\. Das ist die Lage\.\n\nLaut Ledger:/);
  });

  it('no usable aggregation -> no guard (the answer is not touched)', () => {
    assert.equal(createMoneyGuard('{"foo":1}\n---\nx'), null);
  });
});

describe('item 6: GPT-Live researches instead of asking back', () => {
  it('only the OpenAI instructions carry the never-ask-back rule; the others stay as they were', () => {
    const openai = buildInstructions(null, undefined, { provider: 'openai' });
    assert.match(openai, /NIE eine Rückfrage, bevor du nachgeschaut hast/);
    assert.match(openai, /knowledge_read, search_files oder \(bei Geld\) ledger_spend/);
    assert.doesNotMatch(buildInstructions(null, undefined, { provider: 'xai' }), /NIE eine Rückfrage/);
    assert.doesNotMatch(buildInstructions(null), /NIE eine Rückfrage/);
  });

  it('the early illustrator hands its fast-path facts to the voice session (onFacts) once they are read', async () => {
    const got = [];
    script = () => answer(JSON.stringify({ v: 2, id: 'x', kind: 'flow', title: 'Ablauf', sources: [], nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }));
    const ill = createIllustrator({ bus, hub: {}, complete, run: async (name) => ({ ok: true, content: name === 'knowledge_read' ? '{"found":true,"topic":"jevbench"}\n---\nJevBench misst Modelle.' : '{}', summary: 's' }), audit() {} });
    await ill.draw({ id: 'x', request: 'Wie funktioniert JevBench?', question: 'Wie funktioniert JevBench?', early: true, by: 'auto', publish: (p) => bus.publish({ by: 'auto', ...p }), onFacts: (t) => got.push(t) });
    assert.equal(got.length, 1);
    assert.match(got[0], /### knowledge_read[\s\S]*JevBench misst Modelle/);
  });
});

describe('item 7: late draws do not take the stage', () => {
  it('offTopic: an architecture during a money question (and the reverse) - by kind or title; same-topic and unknown are fine', () => {
    assert.equal(offTopic('architecture', 'Architektur des Gateway', 'Wohin geht das Geld im Oktober?'), true);
    assert.equal(offTopic('pie', 'Ausgaben nach Kategorie', 'Erklär mir die Architektur vom Gateway'), true);
    assert.equal(offTopic('flow', 'Ablauf des Video-Versands', 'Wohin geht das Geld?'), false);
    assert.equal(offTopic('architecture', 'Aufbau', 'Erklär mir die Architektur'), false);
    assert.equal(offTopic('table', 'Voice-Provider', 'Wie viele Kosten hatten wir?'), false);
    assert.equal(offTopic('architecture', 'Aufbau', ''), false);
  });

  it('canvas_render of the previous topic during the next question: published with focus:false, the same-topic one without the flag', () => {
    const s = session();
    s.startTurn();
    s.noteTurn({ role: 'user', text: 'Wohin geht das Geld im Oktober?' });
    s.userTurn('Wohin geht das Geld im Oktober?');
    const arch = { kind: 'architecture', title: 'Architektur vom Gateway', id: 'gateway-arch', groups: [{ id: 'g', label: 'Gateway' }], nodes: ['a', 'b', 'c'].map((x) => ({ id: x, label: x.toUpperCase(), group: 'g' })), edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], sources: [{ label: 'Code', ref: '/home/flori/work/agent-desk/gateway/src' }] };
    s.render(arch);
    const late = events().find((e) => e.id === 'gateway-arch' && e.phase === 'ready');
    assert.equal(late.focus, false);
    s.render({ kind: 'bar', title: 'Ausgaben nach Kategorie', id: 'ausgaben', items: [{ label: 'GPU', value: 5 }, { label: 'LLM', value: 3 }], sources: [{ label: 'Board', ref: 'Board #22' }] });
    const own = events().find((e) => e.id === 'ausgaben' && e.phase === 'ready');
    assert.equal('focus' in own, false);
  });

  it('a drawing that finishes after the NEXT user turn started is published with focus:false (pending and ready)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    script = async () => { await gate; return answer(JSON.stringify({ v: 2, id: 'ablauf', kind: 'flow', title: 'Ablauf', sources: [], nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] })); };
    const s = session();
    s.startTurn();
    s.noteTurn({ role: 'user', text: 'Erkläre den Ablauf.' });
    s.draw({ request: 'Zeichne den Ablauf', kind: 'flow', id: 'ablauf' });
    s.startTurn(); // the user already asks the next question
    s.noteTurn({ role: 'user', text: 'Und wohin geht das Geld?' });
    release();
    await s.idle();
    const mine = events().filter((e) => e.id === 'ablauf');
    assert.deepEqual(mine.map((e) => e.phase), ['pending', 'ready']);
    assert.equal(mine[0].focus, undefined, 'the pending marker came in time');
    assert.equal(mine[1].focus, false);
  });

  it('a draw of the CURRENT turn keeps following (no flag)', async () => {
    script = () => answer(JSON.stringify({ v: 2, id: 'ablauf', kind: 'flow', title: 'Ablauf', sources: [], nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }));
    const s = session();
    s.startTurn();
    s.noteTurn({ role: 'user', text: 'Erkläre den Ablauf.' });
    s.draw({ request: 'Zeichne den Ablauf', kind: 'flow', id: 'ablauf' });
    await s.idle();
    assert.ok(events().filter((e) => e.id === 'ablauf').every((e) => !('focus' in e)));
  });
});

describe('item 10: sources', () => {
  it('Board refs lose their parenthesis; the board is cited once', () => {
    assert.equal(normalizeRef('Board #22 (TAX-Zeilen)'), 'Board #22');
    assert.equal(normalizeRef('Board #22 (ledger_spend, asOf 2026-10-24)'), 'Board #22');
    const pie = { v: 2, id: 'g', kind: 'pie', title: 'Ausgaben nach Kategorie', unit: 'EUR', items: [{ label: 'GPU', value: 1 }, { label: 'LLM', value: 2 }], sources: [{ label: 'a', ref: 'Board #22 (TAX-Zeilen)' }, { label: 'b', ref: 'Board #22' }] };
    const out = enrichSpec(pie, { tools: [{ name: 'ledger_spend', ok: true, args: {}, content: `${JSON.stringify({ ...header, groupBy: 'category', totalsEurApprox: [{ key: 'GPU', sumEur: 1, count: 1 }, { key: 'LLM', sumEur: 2, count: 1 }] })}\n---\n` }], moneyHint: true });
    assert.deepEqual(out.spec.sources.map((s) => s.ref).filter((r) => r.startsWith('Board')), ['Board #22']);
  });

  it('a notify / video-send flow never cites the desk\'s own code; a desk architecture still does', () => {
    const code = { label: 'bridge/src (Code)', ref: '/home/flori/work/agent-desk/bridge/src' };
    const skill = { label: 'notify', ref: '/home/flori/.claude/skills/notify-telegram/SKILL.md' };
    const flow = { kind: 'flow', title: 'Wie die Notify-Nachricht mit Video-Link rausgeht', nodes: [{ label: 'build_video.sh' }, { label: 'notify' }] };
    assert.deepEqual(dropOffTopicSources([code, skill], flow), [skill]);
    const arch = { kind: 'architecture', title: 'Architektur vom Agent Desk Gateway', nodes: [{ label: 'server.js' }] };
    assert.deepEqual(dropOffTopicSources([code, skill], arch), [code, skill]);
  });

  it('enrichSpec applies it: the model looked into bridge/src for a notify flow, the drawing does not cite it', () => {
    const flow = { v: 2, id: 'n', kind: 'flow', title: 'Notify-Ablauf', caption: 'Zwei Schritte.', sources: [], nodes: [{ id: 'a', label: 'notify' }, { id: 'b', label: 'Telegram' }, { id: 'c', label: 'Guard' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] };
    const tools = [{ name: 'code_outline', ok: true, args: { path: '/home/flori/work/agent-desk/bridge/src' }, content: '{}' }, { name: 'read_core_doc', ok: true, args: { name: 'AGENTS' }, content: 'x' }];
    const { spec } = enrichSpec(flow, { tools });
    assert.ok(!spec.sources.some((s) => /agent-desk/.test(s.ref)), JSON.stringify(spec.sources));
    assert.ok(spec.sources.some((s) => /AGENTS\.md/.test(s.ref)));
  });

  it('"Gespräch" is dropped as soon as a real source is there', () => {
    const tbl = { v: 2, id: 'vp', kind: 'table', title: 'Voice-Provider', sources: [{ label: 'Gespräch', ref: 'Gespräch' }, { label: 'Board', ref: 'Board #22' }], columns: ['A', 'B'], rows: [['xAI', 'arbeitet'], ['OpenAI', 'arbeitet']] };
    assert.deepEqual(enrichSpec(tbl, { tools: [] }).spec.sources.map((s) => s.ref), ['Board #22']);
    assert.deepEqual(enrichSpec({ ...tbl, sources: [{ label: 'Gespräch', ref: 'Gespräch' }] }, { tools: [] }).spec.sources.map((s) => s.ref), ['Gespräch']);
  });

  it('desk_status is a real source (a status table is not "ohne Quelle")', async () => {
    const { deriveSources } = await import('../src/illustrator.js');
    assert.deepEqual(deriveSources([{ name: 'desk_status', ok: true, args: {}, content: '{}' }]), [{ label: 'Desk-Status (live)', ref: '/home/flori/work/agent-desk/gateway/src/deskStatus.js' }]);
    const tbl = { v: 2, id: 'vp', kind: 'table', title: 'Voice-Provider', sources: [], columns: ['A', 'B'], rows: [['xAI', 'arbeitet'], ['OpenAI', 'arbeitet']] };
    const { spec } = enrichSpec(tbl, { tools: [{ name: 'desk_status', ok: true, args: {}, content: '{}' }] });
    assert.equal(spec.unsourced, undefined);
    assert.equal(spec.sources[0].label, 'Desk-Status (live)');
  });

  it('code_outline sources are labelled with the last two path parts, not "src (Code)"', async () => {
    const { deriveSources } = await import('../src/illustrator.js');
    assert.equal(deriveSources([{ name: 'code_outline', ok: true, args: { path: '/home/flori/work/agent-desk/bridge/src' }, content: '{}' }])[0].label, 'bridge/src (Code)');
  });
});
