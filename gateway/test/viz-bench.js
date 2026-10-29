// Live latency/quality bench for the Live Canvas model (real OpenRouter calls, ~USD 0.01 per run).
// Usage: node test/viz-bench.js [model ...] [--reps N] [--show]
// Each snippet replays a real turn: tool start → done (content formatted by the real runTool) → answer → follow-up.
// "jobs-now" and "decisions-today" use the workshop's real data through the bridge modules when they are readable.
// Prints per-model p50/p90 latency, validity, id stability and two HARD checks on the emitted (guarded) specs:
//   newNumbers: numbers that occur nowhere in the input; stale: a finished tool still shown as running.
// Exit code 1 when a hard check fails. `raw…` counts show what the model wrote before the guard.
import { runTool } from '../src/tools.js';
import { openRouterJSON, buildMessages, buildInput, checkSpec, describeEvent, validateSpec, DEFAULT_VIZ_MODEL } from '../src/viz.js';
import { createToolLedger, numbersIn, TOOL_WORD } from '../src/vizFacts.js';

// The bridge is faked: `claude.list` answers "no sessions" so claude_task gets to `claude.start`.
const fakeCtx = (result) => ({ hub: { call: async (m) => (m === 'claude.list' ? { sessions: [] } : result) }, audit: () => {}, limits: { check: () => ({ ok: true }) } });

async function realData() {
  try {
    const jobs = await import('../../bridge/src/jobs.js');
    const ctx = await import('../../bridge/src/ctx.js');
    return { jobs: await jobs.list({ limit: 20 }), decisions: await ctx.decisionsToday({ maxChars: 4500 }) };
  } catch (e) {
    console.log(`(bridge data not readable: ${e.message}; using synthetic lists)`);
    const job = (i) => ({ name: `job-${i}-20261024`, path: `/home/flori/jobs/job-${i}`, modified: '2026-10-24T09:00:00.000Z', finalDone: i > 17, host: 'lechonk', summary: 'Round 2' });
    return {
      jobs: { jobs: Array.from({ length: 20 }, (_, i) => job(i + 1)) },
      decisions: { today: '2026-10-24', since: '2026-10-23', entriesToday: 13, shown: 12, omitted: 40, entries: [{ date: '2026-10-24', heading: '## Canvas darf nie lügen', text: '…' }] },
    };
  }
}

const { jobs, decisions } = await realData();
const open = jobs.jobs.filter((j) => !j.finalDone);
const names = (list, n) => list.slice(0, n).map((j) => j.name).join(', ');
const heads = decisions.entries.slice(0, 3).map((e) => e.heading.replace(/^#+\s*/, '')).join('; ');

// tool(name, args, result) → the real chat event pair (start, done) with runTool's content.
const tool = (name, args, result) => ({ name, args, result });

const SNIPPETS = [
  {
    name: 'jobs-now',
    user: 'Welche Jobs laufen gerade?',
    tools: [tool('list_jobs', {}, jobs)],
    answer: `In der Liste stehen ${jobs.jobs.length} Jobs, ${open.length} davon sind noch offen, zum Beispiel ${names(open, 3)}.`,
    follow: 'Und welcher davon ist der neueste?',
    followTools: [],
  },
  {
    name: 'decisions-today',
    user: 'Was hat Florian heute entschieden?',
    tools: [tool('decisions_recent', {}, decisions)],
    answer: `Heute gibt es ${decisions.entriesToday} Entscheidungen. Die neuesten: ${heads}.`,
    follow: 'Welche davon betrifft die Agent Desk?',
    followTools: [],
  },
  {
    name: 'voice-misheard-job',
    user: 'Wie ist der Stand von Rags to Next Steps?',
    tools: [tool('job_status', { name: 'Rags to Next Steps' }, new Error('bad job name')), tool('list_jobs', { filter: 'reax2' }, { jobs: [{ name: 'reax2-next-steps-20261024', path: '/home/flori/jobs/reax2-next-steps-20261024', modified: '2026-10-24T09:40:00.000Z', finalDone: false, host: 'lechonk', summary: 'Next steps' }] })],
    answer: 'Den Namen kannte ich nicht, gemeint ist wohl reax2-next-steps-20261024. Der Job ist noch offen und läuft auf LeChonk.',
    follow: 'Woran hängt er?',
    followTools: [tool('read_file', { path: 'jobs/reax2-next-steps-20261024/STATE.md' }, { path: '/home/flori/jobs/reax2-next-steps-20261024/STATE.md', offset: 0, lines: 64, size: 3100, truncated: false, totalLines: 64, text: '# STATE\nwartet auf GPU-Pod' })],
  },
  {
    name: 'board-risk',
    user: 'Gibt es auf dem Board etwas Dringendes?',
    tools: [tool('board_threads', {}, { text: '#27 Florian asks\n#22 System1\n#15 Ops & security\n#11 JevBench releases', truncated: false }), tool('board_read', { thread: '15', limit: 5 }, { text: '#25718 [2026-10-24 10:58] gpu-reaper: Pod lium-7f2 läuft 9 h ohne Reservierung, ~14 USD', entries: 1, truncated: false })],
    answer: 'Ja: im Thread #15 meldet gpu-reaper, dass der Lium-Pod lium-7f2 seit 9 Stunden ohne Reservierung läuft (ca. 14 USD).',
    follow: 'Wem gehört der Pod?',
    followTools: [tool('search_files', { query: 'lium-7f2', scope: 'jobs' }, { query: 'lium-7f2', hits: [{ path: '/home/flori/jobs/jevbench-q4-sweep/STATE.md', line: 12, text: 'Pod lium-7f2 gestartet 00:12' }] })],
  },
  {
    name: 'claude-task',
    user: 'Starte bitte eine Claude-Session, die im agent-desk Repo die Login-Rate-Limits testet.',
    tools: [tool('claude_task', { prompt: 'Login-Rate-Limits testen', model: 'sonnet' }, { sid: 'd20261024-a3f9c1' })],
    claude: [
      { kind: 'tool_use', name: 'Read', path: 'gateway/src/auth.js' },
      { kind: 'todo', items: [{ content: 'auth.js lesen', status: 'completed' }, { content: 'Test schreiben', status: 'in_progress' }, { content: 'node --test ausführen', status: 'pending' }] },
    ],
    answer: 'Ich habe die Session d20261024-a3f9c1 gestartet; sie liest gerade auth.js und schreibt dann einen Test.',
    follow: 'Ist der Test schon grün?',
    followTools: [],
  },
];

const args = process.argv.slice(2);
const reps = Number(args[args.indexOf('--reps') + 1]) || 2;
const show = args.includes('--show');
const models = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--reps');
if (!models.length) models.push(DEFAULT_VIZ_MODEL);

// Standalone numbers of the spec that are not in the input.
const newNumbers = (spec, input) => {
  const known = numbersIn(JSON.stringify(input), true);
  const own = [spec.title, spec.caption, ...spec.nodes.flatMap((n) => [n.label, n.value]), ...spec.edges.map((e) => e.label), ...(spec.steps ?? []).map((s) => s.label)];
  return [...new Set(own.flatMap((s) => [...numbersIn(s)]))].filter((n) => !known.has(n));
};
// A finished tool shown as running: a node naming the tool, or a caption narrating a running query, after all calls ended.
const staleState = (spec, calls) => {
  if (calls.some((c) => c.status === 'start')) return [];
  const names = calls.flatMap((c) => [c.name, TOOL_WORD[c.name]].filter(Boolean).map((w) => w.toLowerCase()));
  const bad = spec.nodes.filter((n) => names.some((w) => `${n.id} ${n.label}`.toLowerCase().includes(w)) && /läuft|running|lädt|wartet/i.test(`${n.label} ${n.value ?? ''}`)).map((n) => n.id);
  if (/(abfrage|suche|tool)\w*[^.]{0,40}(läuft|noch)/i.test(spec.caption ?? '')) bad.push('caption');
  return bad;
};

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function feed(ledger, list) {
  for (const [i, t] of list.entries()) {
    const id = `${t.name}-${i}-${Math.random().toString(36).slice(2, 6)}`;
    ledger.note({ type: 'tool', id, name: t.name, args: t.args, status: 'start' });
    const r = t.result instanceof Error
      ? { ok: false, summary: t.result.message, content: `ERROR: ${t.result.message}` }
      : await runTool(t.name, t.args, fakeCtx(t.result));
    ledger.note({ type: 'tool', id, name: t.name, args: t.args, status: r.ok ? 'done' : 'error', summary: r.summary, content: r.content, ms: 4 });
  }
}

async function call(model, prev, req, ledger) {
  const t0 = performance.now();
  try {
    const { json, costUsd } = await openRouterJSON({ model, messages: buildMessages({ ...req, prev }) });
    const input = buildInput(req);
    const raw = validateSpec(json, prev);
    const { spec, fixes } = checkSpec(json, { prev, calls: ledger.calls(), input, answered: req.turns.at(-1).role === 'assistant' && !req.events.length });
    return {
      ms: performance.now() - t0, spec, costUsd, fixes,
      rawNew: raw ? newNumbers(raw, input) : [], rawStale: raw ? staleState(raw, ledger.calls()) : [],
      invented: spec ? newNumbers(spec, input) : [], stale: spec ? staleState(spec, ledger.calls()) : [],
    };
  } catch (e) {
    return { ms: performance.now() - t0, spec: null, error: e.message, costUsd: 0, fixes: [], rawNew: [], rawStale: [], invented: [], stale: [] };
  }
}

let hardFail = false;
for (const model of models) {
  const lat = [];
  let valid = 0, total = 0, kept = 0, keptOf = 0, cost = 0, fixed = 0;
  const made = [], stale = [], rawMade = [], rawStale = [];
  const record = (tag, r) => {
    lat.push(r.ms); total++; cost += r.costUsd;
    if (r.fixes.length) fixed++;
    if (r.invented.length) made.push(`${tag}: ${r.invented.join(',')}`);
    if (r.stale.length) stale.push(`${tag}: ${r.stale.join(',')}`);
    if (r.rawNew.length) rawMade.push(`${tag}: ${r.rawNew.join(',')}`);
    if (r.rawStale.length) rawStale.push(`${tag}: ${r.rawStale.join(',')}`);
    if (!r.spec) console.log(`  ${tag}: invalid ${r.error ?? ''}`);
    else valid++;
  };
  for (let r = 0; r < reps; r++) {
    for (const sn of SNIPPETS) {
      const ledger = createToolLedger();
      await feed(ledger, sn.tools);
      const events = (sn.claude ?? []).map(describeEvent).filter(Boolean);
      const turns = [{ role: 'user', text: sn.user }, { role: 'assistant', text: sn.answer }];
      const a = await call(model, null, { turns, events, tools: ledger.entries() }, ledger);
      record(sn.name, a);
      if (!a.spec) continue;
      await feed(ledger, sn.followTools);
      const b = await call(model, a.spec, { turns: [...turns, { role: 'user', text: sn.follow }], events, tools: ledger.entries() }, ledger);
      record(`${sn.name}/follow`, b);
      if (b.spec) {
        const before = new Set(a.spec.nodes.map((n) => n.id));
        keptOf += before.size;
        kept += b.spec.nodes.filter((n) => before.has(n.id)).length;
      }
      if (show && r === 0) console.log(`--- ${model} · ${sn.name}\n${JSON.stringify(a.spec)}\n  fixes: ${a.fixes.join(' ') || '-'}\n  follow-up → ${JSON.stringify(b.spec)}\n  fixes: ${b.fixes.join(' ') || '-'}`);
    }
  }
  console.log(`${model}: n=${total} p50=${Math.round(pct(lat, 0.5))}ms p90=${Math.round(pct(lat, 0.9))}ms valid=${valid}/${total} idsKept=${keptOf ? Math.round((100 * kept) / keptOf) : 0}% cost=$${cost.toFixed(4)} guardFixed=${fixed}/${total}`);
  console.log(`  HARD newNumbers=[${made.join(' | ')}] stale=[${stale.join(' | ')}]`);
  console.log(`  raw model (before guard): newNumbers=[${rawMade.join(' | ')}] stale=[${rawStale.join(' | ')}]`);
  if (made.length || stale.length || valid < total) hardFail = true;
}
process.exitCode = hardFail ? 1 : 0;
