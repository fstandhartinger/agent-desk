#!/usr/bin/env node
// Offline evaluation of the research agent (job agent-desk-context-discovery-20261115): runs questions of a private test set
// through gateway/src/research with an in-process hub that calls the LeChonk bridge methods directly (same redaction as the
// bridge), so research models can be compared before a deploy. The test set is private (Florian's own numbers): it lives
// outside the repo, e.g. ~/desk-knowledge/eval/questions.jsonl. Needs OPENROUTER_API_KEY in the environment (never logged).
//
// node gateway/eval/research-eval.mjs --questions <file.jsonl> --models a,b [--ids q01,q12] [--out results.jsonl] [--parallel 3]
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildMethods } from '../../bridge/src/bridge.js';
import { redactDeepAsync } from '../../bridge/src/redact.js';
import { TOOL_DEFS, runTool } from '../src/tools.js';
import { completeChat } from '../src/llm.js';
import { runResearch } from '../src/research/agent.js';
import { Limits } from '../src/limits.js';

const run = promisify(execFile);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const questionsFile = arg('questions');
const models = String(arg('models', 'google/gemini-3.8-flash')).split(',').map((m) => m.trim()).filter(Boolean);
const ids = arg('ids') ? new Set(arg('ids').split(',')) : null;
const out = arg('out', '/tmp/research-eval.jsonl');
const parallel = Number(arg('parallel', '3'));
if (!questionsFile || !process.env.OPENROUTER_API_KEY) { console.error('usage: OPENROUTER_API_KEY=… node research-eval.mjs --questions <file> --models a,b'); process.exit(2); }

const NO_CLAUDE = { start() {}, send() {}, stop() {}, list() { return { sessions: [] }; }, get() { return {}; }, restore() {}, shutdown() {}, running: () => 0, max: 0 };
const methods = buildMethods(NO_CLAUDE, 'lechonk');
// Sandy-only reads the questions may need, through the existing read-only relay from LeChonk
methods['board.entry'] ??= async ({ id }) => {
  if (!/^\d{1,7}$/.test(String(id))) throw new Error('bad entry id');
  const { stdout } = await run(`${process.env.HOME}/bin/sandy-read`, ['board-sql', `select e.id, e.thread_id, e.author, e.kind, e.created_at, e.body from entries e where e.id = ${Number(id)}`], { timeout: 20_000, maxBuffer: 4 << 20 });
  return { text: stdout.slice(0, 20_000) };
};
// Eval guard: the job that builds this test set holds the questions and answers (briefs, prompt, worker chats). Hidden
// from every search, map line and read, so the agent cannot find the answer key. HIDE = substrings of paths / projects.
const HIDE = String(process.env.EVAL_HIDE ?? 'agent-desk-context-discovery-20261115,desk-knowledge/eval').split(',').filter(Boolean);
const hidden = (v) => HIDE.some((h) => JSON.stringify(v ?? '').includes(h));
function scrub(method, params, result) {
  if (/^ctx\.read$|^chats\.read$/.test(method) && hidden(params)) throw new Error('path not allowed or not found');
  if (result && Array.isArray(result.hits)) return { ...result, hits: result.hits.filter((h) => !hidden(h)) };
  if (result && Array.isArray(result.lines)) return { ...result, lines: result.lines.filter((l) => !hidden(l)) };
  if (result && Array.isArray(result.jobs)) return { ...result, jobs: result.jobs.filter((j) => !hidden(j.name)) };
  return result;
}
const hub = {
  pick: () => 'lechonk',
  hostsFor: () => ['lechonk'],
  async call(method, params = {}) {
    const fn = methods[method];
    if (!fn) throw new Error(`unknown method ${method}`);
    if (method === 'jobs.get' && hidden(params)) throw new Error('no such job');
    return redactDeepAsync(scrub(method, params, await fn(params)));
  },
};

const questions = fs.readFileSync(questionsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((q) => !ids || ids.has(q.id));
const jobs = models.flatMap((model) => questions.map((q) => ({ model, q })));
console.log(`${jobs.length} runs (${questions.length} questions x ${models.length} models), parallel ${parallel}`);
const sink = fs.createWriteStream(out, { flags: 'a' });
let next = 0;
let cost = 0;
async function worker() {
  while (next < jobs.length) {
    const { model, q } = jobs[next++];
    const ctx = { hub, sid: `eval-${q.id}`, limits: new Limits(), audit: () => {}, page: null };
    const t0 = Date.now();
    const [id, reasoning] = model.split('@'); // "google/gemini-3.8-flash@minimal" = that model with reasoning effort minimal
    const r = await runResearch({ question: q.question, ctx, model: id, subModel: id, ...(reasoning ? { reasoning } : {}) }, { runTool, complete: (a) => completeChat({ ...a, zdrOnly: true }), toolDefs: TOOL_DEFS });
    cost += r.costUsd;
    const row = { at: new Date().toISOString(), id: q.id, category: q.category, hops: q.hops, model, question: q.question, gold: q.answer, accept: q.accept, answer: r.answer, found: r.found, confidence: r.confidence, sources: r.sources, unconfirmed: r.unconfirmed, ms: Date.now() - t0, steps: r.steps, rounds: r.rounds, costUsd: r.costUsd, stopped: r.stopped, touched: r.touched, timing: r.timing };
    sink.write(`${JSON.stringify(row)}\n`);
    console.log(`${q.id} ${model.split('/').pop()} ${r.stopped} ${Math.round(row.ms / 1000)}s ${r.steps} steps $${r.costUsd} | ${r.answer.slice(0, 110).replace(/\n/g, ' ')}`);
  }
}
await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
sink.end();
console.log(`done: total USD ${cost.toFixed(3)} -> ${out}`);
process.exit(0);
