// Source registry, REAX docs tool, not-found guard, delivery without the 90 s stall (job agent-desk-research-upgrade-20261125).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTopic, matchTopics, mustCheck, reaxDocs, registryHint, terms } from '../src/research/sources.js';
import { runResearch } from '../src/research/agent.js';
import { createResearchManager, progressNote } from '../src/research/manager.js';
import { TOOL_DEFS } from '../src/tools.js';

const REG = {
  v: 1, built: '2026-11-25T21:00Z', rule: 'Sag nie "keine Quelle gefunden", bevor die Quellen des passenden Themas gelesen wurden.',
  topics: [
    { key: 'reax-training-rules', title: 'SN92 Trainings-Wettbewerb: Regeln, Podium, Holder', keywords: ['podium', 'holder', 'entwickler', 'regel', 'champion'], playbook: 'Regelfrage: reax_docs zuerst.',
      sources: [{ label: 'Live-Regeln', kind: 'live', ref: '/home/flori/desk-knowledge/sources/live/training-rules.md', how: 'read_file' }, { label: 'MCP', kind: 'mcp', ref: 'reax_docs: training_get_rules', how: 'live' }, { label: 'Status', kind: 'file', ref: '/home/flori/jobs/topic-status/topics/round2.md', how: 'read_file' }] },
    { key: 'gpu-tee-providers', title: 'GPUs und TEE', keywords: ['gpu', 'tee', 'lium'], playbook: 'AGENTS.md', sources: [{ label: 'AGENTS', kind: 'file', ref: '/home/flori/AGENTS.md', how: 'read_core_doc' }] },
  ],
};

const RULES = { version: 'v2.10', effective_from_utc: '2026-11-24T13:30:00Z', source_url: 'https://reax.co/competitions/rules/', sections: [
  { id: '2.9', title: 'Holder', text: '**Holder:** entries belong to one holder if they have the same coldkey, or if they share the Hugging Face account.' },
  { id: '6.6', title: 'Podium', text: '- **One podium place per holder:** a holder holds only the first of its places in this order: champion, last dethroned champion, the one before, place 2, place 3. For places 2 and 3 the next eligible entry moves up.' },
  { id: '5.2', title: 'Preview', text: 'every PASS entry gets one automatic preview' },
] };
const fakeFetch = (value) => async (url, init) => {
  assert.equal(url, 'https://mcp.reax.co/mcp');
  const body = JSON.parse(init.body);
  return { ok: true, text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: value, called: body.params.name } })}\n` };
};

describe('source registry', () => {
  it('matches the podium/developer question to the rules topic first', () => {
    const hits = matchTopics(REG, 'Wenn alle Top drei Modelle vom gleichen Entwickler sind, bekommt er alle drei Podiumsplätze?');
    assert.equal(hits[0].topic.key, 'reax-training-rules');
  });
  it('builds a prompt hint with the sources and the rule; nothing for an unrelated question', () => {
    const hint = registryHint(REG, 'Podium Regel');
    assert.match(hint, /training-rules\.md/);
    assert.match(hint, /keine Quelle gefunden/);
    assert.equal(registryHint(REG, 'Wie wird das Wetter morgen?'), '');
  });
  it('mustCheck names live/mcp/file sources of the best topic', () => {
    const refs = mustCheck(REG, 'Podium Holder').map((s) => s.kind);
    assert.deepEqual(refs, ['live', 'mcp', 'file']);
    assert.match(formatTopic(REG.topics[0]), /Vorgehen: Regelfrage/);
  });
  it('German question words add the English rule words', () => {
    const t = terms('Bekommt der gleiche Entwickler alle Podiumsplätze?');
    for (const w of ['holder', 'podium', 'place']) assert.ok(t.includes(w), w);
  });
});

describe('reax_docs', () => {
  it('returns the matching clauses with their numbers, version and source', async () => {
    const out = await reaxDocs({ method: 'training_get_rules', query: 'podium place holder developer' }, { fetchImpl: fakeFetch(RULES), max: 4000 });
    assert.match(out, /v2\.10/);
    assert.match(out, /\[6\.6\]/);
    assert.match(out, /One podium place per holder/);
    assert.ok(out.indexOf('[6.6]') < (out.indexOf('[5.2]') === -1 ? Infinity : out.indexOf('[5.2]')));
  });
  it('without query: the clause index', async () => {
    const out = await reaxDocs({ method: 'training_get_rules' }, { fetchImpl: fakeFetch({ ...RULES, version: 'v2.11' }) });
    assert.match(out, /2\.9: Holder/);
  });
  it('refuses methods outside the read-only list (no signed or "my" calls)', async () => {
    await assert.rejects(reaxDocs({ method: 'training_submit_dispute' }, { fetchImpl: fakeFetch({}) }), /unbekannte Methode/);
    await assert.rejects(reaxDocs({ method: 'account_get_identity' }, { fetchImpl: fakeFetch({}) }), /unbekannte Methode/);
  });
});

const call = (name, args, id = `c${Math.random().toString(36).slice(2, 8)}`) => ({ id, name, args: JSON.stringify(args) });
function scripted(steps) {
  const seen = [];
  let i = 0;
  return { seen, complete: async (req) => { seen.push(req); const s = steps[Math.min(i++, steps.length - 1)]; const m = typeof s === 'function' ? s(req.messages) : s; return { message: { content: m.content ?? '', tool_calls: m.tool_calls ?? [] }, costUsd: 0.001 }; } };
}

describe('research with the registry', () => {
  it('puts the registry hint into the first prompt and refuses "nichts gefunden" once while the rules were not read', async () => {
    const used = [];
    const runTool = async (name, args) => { used.push(name); return { ok: true, content: name === 'reax_docs' ? '[6.6] One podium place per holder' : '0 Treffer' }; };
    const { complete, seen } = scripted([
      { tool_calls: [call('search', { query: 'podium entwickler' })] },
      { tool_calls: [call('answer', { antwort: 'Dazu habe ich nichts gefunden.', gefunden: false })] },
      { tool_calls: [call('reax_docs', { method: 'training_get_rules', query: 'podium place holder' })] },
      { tool_calls: [call('answer', { antwort: 'Nein. Laut Regel 6.6 hält ein Holder nur einen Podiumsplatz.', gefunden: true, quellen: [{ label: 'Regel 6.6', ref: 'mcp training_get_rules 6.6' }] })] },
    ]);
    const r = await runResearch({ question: 'Bekommt der gleiche Entwickler alle drei Podiumsplätze?', ctx: { sid: 's' }, model: 'm', warmStart: false }, { runTool, complete, toolDefs: TOOL_DEFS, registry: async () => REG });
    assert.match(seen[0].messages[1].content, /Wissenslandkarte/);
    assert.match(seen[0].messages[1].content, /training-rules\.md/);
    const refusal = seen[2].messages.find((m) => m.role === 'tool' && /Noch nicht/.test(m.content));
    assert.ok(refusal, 'not-found refused');
    assert.match(refusal.content, /training-rules\.md|reax_docs/);
    assert.equal(r.found, true);
    assert.match(r.answer, /6\.6/);
    assert.ok(used.includes('reax_docs'));
  });
  it('accepts "nichts gefunden" when the registry sources were read', async () => {
    const runTool = async () => ({ ok: true, content: 'nichts' });
    const { complete } = scripted([
      { tool_calls: [call('reax_docs', { method: 'training_get_rules', query: 'x' }), call('read_file', { path: '/home/flori/desk-knowledge/sources/live/training-rules.md' }), call('read_file', { path: '/home/flori/jobs/topic-status/topics/round2.md' })] },
      { tool_calls: [call('answer', { antwort: 'Dazu habe ich nichts gefunden.', gefunden: false })] },
    ]);
    const r = await runResearch({ question: 'Podium Holder Sonderfall?', ctx: { sid: 's' }, model: 'm', warmStart: false }, { runTool, complete, toolDefs: TOOL_DEFS, registry: async () => REG });
    assert.equal(r.found, false);
    assert.equal(r.stopped, 'answer');
  });
  it('the research tool list offers reax_docs, source_map and grep_path', async () => {
    const { researchToolDefs } = await import('../src/research/agent.js');
    const names = researchToolDefs(TOOL_DEFS, {}).map((t) => t.name);
    for (const n of ['reax_docs', 'source_map', 'grep_path']) assert.ok(names.includes(n), n);
  });
});

describe('research manager: no silent stalls', () => {
  const quickBudget = { rounds: 2, ms: 1000, usd: 1, parallel: 2, subChunks: 1, subParallel: 1 };
  it('a run that hangs ends with a fallback answer and an ALERT log line after budget + hard extra', async () => {
    const logs = [];
    let t = 0;
    const m = createResearchManager({ runTool: async () => ({}), toolDefs: [], complete: async () => ({}), model: 'm', now: () => t, budget: { ...quickBudget, ms: 10 }, hardExtraMs: 10, log: (l) => logs.push(l),
      research: () => new Promise(() => {}) }); // never settles
    const run = m.start({ sid: 's', question: 'q' });
    const res = await run.promise;
    assert.equal(res.stopped, 'overrun');
    assert.match(res.answer, /Zeitlimit/);
    assert.ok(logs.some((l) => /ALERT research/.test(l)));
  });
  it('a detached slow run gets a spoken progress note when the session is idle', async () => {
    const said = [];
    let resolve;
    const m = createResearchManager({ runTool: async () => ({}), toolDefs: [], complete: async () => ({}), model: 'm', budget: { ...quickBudget, ms: 120_000 },
      research: ({ onStep }) => { onStep({ phase: 'done', id: 'x', name: 'reax_docs', label: 'REAX-Regeln live: podium' }); return new Promise((r) => { resolve = r; }); } });
    m.attach('s', { say: (t) => { said.push(t); return true; }, idle: () => true });
    const run = m.start({ sid: 's', question: 'Podium?' });
    run.detach();
    assert.ok(run.progressTimers?.length >= 1);
    // fire the first progress timer now instead of waiting 20 s
    for (const tm of run.progressTimers) clearTimeout(tm);
    const note = progressNote(run, 21_000);
    assert.match(note, /läuft noch \(21 s/);
    assert.match(note, /REAX-Regeln live/);
    resolve({ answer: 'Nein.', found: true, sources: [], unconfirmed: [], confidence: 'hoch', classes: [], rounds: 1, steps: 1, ms: 5, costUsd: 0, model: 'm', stopped: 'answer' });
    await run.promise;
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(said.some((s) => /ist fertig/.test(s)), 'result delivered at once when idle');
  });
});
