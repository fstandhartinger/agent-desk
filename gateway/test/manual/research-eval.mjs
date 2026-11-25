// Research-agent eval against the REAL sources: a local gateway with two real bridges (Sandy here, LeChonk through an
// ssh reverse tunnel), the real research agent and the real OpenRouter model. Logs every tool call of every run.
// Usage (Sandy, Node >= 22.18):
//   OPENROUTER_API_KEY=... node test/manual/research-eval.mjs --questions q.jsonl --out runs.jsonl [--only id1,id2] [--model m]
//   q.jsonl lines: {"id","q","focus"?}
// Bridges: the Sandy bridge runs from ../bridge (this checkout); the LeChonk bridge from $LECHONK_BRIDGE_DIR
// (default ~/apps/agent-desk-bridge). Throwaway random BRIDGE_TOKEN; nothing is written to the live registry.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const questionsFile = arg('questions');
const outFile = arg('out', '/tmp/research-eval.jsonl');
const only = arg('only', '') ? new Set(arg('only').split(',')) : null;
const parallel = Number(arg('parallel', '3'));
const PORT = Number(arg('port', '18931'));
const TOKEN = crypto.randomBytes(24).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsch-eval-'));

Object.assign(process.env, {
  ARTIFACTS_URL: '', ARTIFACTS_DESK_TOKEN: '',
  DESK_ACCESS_CODE: crypto.randomBytes(16).toString('hex'),
  DESK_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  BRIDGE_TOKEN: TOKEN,
  DESK_ORIGIN: 'https://desk.eval',
  DESK_INTENT_TRIGGER: 'off',
  DESK_SESSIONS_FILE: path.join(tmp, 'sessions.json'),
  DESK_DEVICES_FILE: path.join(tmp, 'devices.json'),
  DESK_REVOKED_FILE: path.join(tmp, 'revoked.json'),
  DESK_LINK_USES_FILE: path.join(tmp, 'uses.json'),
  ...(arg('model') ? { DESK_RESEARCH_MODEL: arg('model') } : {}),
});

const { createApp } = await import('../../src/server.js');
const { runTool, TOOL_DEFS } = await import('../../src/tools.js');
const { completeChat } = await import('../../src/llm.js');
const { cfg } = await import('../../src/config.js');
const research = await import('../../src/research/agent.js');

const app = createApp();
app.server.listen(PORT, '127.0.0.1');
await new Promise((r) => app.server.once('listening', r));

const children = [];
const bridgeEnv = { ...process.env, DESK_URL: `ws://127.0.0.1:${PORT}/bridge`, BRIDGE_TOKEN: TOKEN };
for (const k of ['OPENROUTER_API_KEY', 'BRAVE_API_KEY']) delete bridgeEnv[k];
const sandy = spawn(process.execPath, [path.join(here, '../../../bridge/src/bridge.js')], { env: { ...bridgeEnv, BRIDGE_HOST: 'sandy' }, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(sandy);
sandy.stderr.on('data', (d) => fs.appendFileSync(path.join(tmp, 'sandy-bridge.log'), d));
sandy.stdout.on('data', (d) => fs.appendFileSync(path.join(tmp, 'sandy-bridge.log'), d));
const lcDir = process.env.LECHONK_BRIDGE_DIR || '~/apps/agent-desk-bridge';
const lechonk = spawn('ssh', ['-o', 'ExitOnForwardFailure=yes', '-R', `${PORT}:127.0.0.1:${PORT}`, 'lechonk',
  `cd ${lcDir} && DESK_URL=ws://127.0.0.1:${PORT}/bridge BRIDGE_TOKEN=${TOKEN} BRIDGE_HOST=lechonk BRIDGE_NO_CLAUDE=1 exec node src/bridge.js`], { stdio: ['ignore', 'pipe', 'pipe'] });
children.push(lechonk);
lechonk.stderr.on('data', (d) => fs.appendFileSync(path.join(tmp, 'lechonk-bridge.log'), d));
lechonk.stdout.on('data', (d) => fs.appendFileSync(path.join(tmp, 'lechonk-bridge.log'), d));
const cleanup = () => { for (const c of children) try { c.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

for (let i = 0; i < 60; i++) {
  const hosts = app.hub.status().map((b) => b.host);
  if (hosts.includes('sandy') && hosts.includes('lechonk')) break;
  await new Promise((r) => setTimeout(r, 500));
  if (i === 59) { console.error('bridges not connected:', hosts, 'logs in', tmp); cleanup(); process.exit(2); }
}
await new Promise((r) => setTimeout(r, 1500)); // caps
console.error(`bridges up (${app.hub.status().map((b) => b.host).join(', ')}), model ${cfg.researchModel()}, logs ${tmp}`);

const questions = fs.readFileSync(questionsFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((q) => !only || only.has(q.id));
const out = fs.createWriteStream(outFile, { flags: 'a' });

async function one(q) {
  const calls = [];
  const ctx = { hub: app.hub, artifacts: app.artifacts, sid: `eval-${q.id}`, maxChars: 2500, traces: app.traces };
  const logged = async (name, args, c) => {
    const t0 = Date.now();
    const res = await runTool(name, args, c);
    calls.push({ name, args: JSON.stringify(args).slice(0, 300), ms: Date.now() - t0, ok: res.ok !== false, chars: String(res.content ?? '').length, head: String(res.content ?? '').slice(0, 200) });
    return res;
  };
  const t0 = Date.now();
  const r = await research.runResearch({ question: q.q, focus: q.focus ?? '', ctx, model: cfg.researchModel(), subModel: cfg.researchSubModel(), finalModel: cfg.researchFinalModel(), budget: research.BUDGET },
    { runTool: logged, toolDefs: TOOL_DEFS, complete: (a) => completeChat({ ...a, zdrOnly: true }) });
  const rec = { id: q.id, q: q.q, model: cfg.researchModel(), ms: Date.now() - t0, answer: r.answer, found: r.found, sources: r.sources, unconfirmed: r.unconfirmed, confidence: r.confidence, stopped: r.stopped, rounds: r.rounds, steps: r.steps, costUsd: r.costUsd, calls, at: new Date().toISOString() };
  out.write(`${JSON.stringify(rec)}\n`);
  console.error(`${q.id} ${r.stopped} found=${r.found} ${Math.round(rec.ms / 1000)}s $${r.costUsd} :: ${r.answer.slice(0, 160).replace(/\n/g, ' ')}`);
}

const queue = [...questions];
await Promise.all(Array.from({ length: Math.max(1, parallel) }, async () => { while (queue.length) await one(queue.shift()); }));
out.end();
cleanup();
setTimeout(() => process.exit(0), 300);
