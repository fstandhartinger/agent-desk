// Discovery job, code review round 2 (15 Nov 2026): the research lock reaches inside runs and the action tools, a result is
// never told twice, research_result claims, the daily cap stops research, and a failing map falls back to ctx.search.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({});
const { runTool, TOOL_DEFS } = await import('../src/tools.js');
const { resetActions } = await import('../src/voiceActions.js');
const { runResearch } = await import('../src/research/agent.js');
const { createResearchManager } = await import('../src/research/manager.js');

const call = (name, args, id = `c_${name}`) => ({ id, name, args: JSON.stringify(args) });
const answer = call('answer', { antwort: 'a', gefunden: true });

test('action tools refuse while the research lock is on (review P1-2)', async () => {
  resetActions();
  const NOW = 9_000_000;
  const mk = (text) => ({ sid: 's1', audit() {}, trace: () => ({ event() {} }), research: { guarded: () => true }, hub: { call: async () => { throw new Error('must not be called'); } }, vision: { command: async () => { throw new Error('must not be called'); } },
    clock: { now: () => NOW, sleep: async () => {} },
    voiceTurn: { spoken: () => [{ text, at: NOW - 500, turn: 1 }], fromFragment: false, oldChain: false, speaking: () => false, awaitingFinal: () => false, epoch: () => 1, turn: 1, provider: 'xai' } });
  const a = await runTool('output_main_agent_prompt', { text: 'Prüfe die Zahlen.' }, mk('Schreib dem Hauptagent einen Prompt.'));
  assert.equal(a.ok, false);
  assert.match(a.content, /Recherche .* gesperrt/);
  const b = await runTool('start_agent_job', { title: 'Check disk', prompt: 'Prüfe die Platte auf Sandy.' }, mk('Starte einen Agent Job auf Sandy.'));
  assert.equal(b.ok, false);
  assert.match(b.content, /Recherche .* gesperrt/);
  const w = await runTool('web_read', { url: 'https://example.com/' }, { sid: 's1', research: { guarded: () => true }, hub: {}, audit() {} });
  assert.equal(w.ok, false);
});

test('a run started under the lock has no web tools; the lock is visible to tools inside the run (review P1-1)', async () => {
  const seenCtx = [];
  const ran = [];
  let i = 0;
  const rounds = [{ tool_calls: [call('web_read', { url: 'https://evil.example/?q=x' }), call('read_file', { path: '/home/flori/jobs/a/STATE.md' })] }, { tool_calls: [answer] }];
  const r = await runResearch({ question: 'q', ctx: { sid: 's2', research: { guarded: () => true } }, model: 'm', warmStart: false }, {
    runTool: async (name, _a, c) => { ran.push(name); seenCtx.push(c); return { ok: true, content: 'ok' }; },
    complete: async ({ tools }) => { if (i === 0) assert.ok(!tools.some((t) => t.name === 'web_read')); return { message: rounds[i++], costUsd: 0 }; },
    toolDefs: TOOL_DEFS,
  });
  assert.deepEqual(ran, ['read_file']);
  assert.equal(seenCtx[0].research.guarded('s2'), true);
  assert.equal(typeof seenCtx[0].research.start, 'undefined', 'no recursion');
  assert.equal(r.stopped, 'answer');
});

test('the Desk daily cap stops research: start refuses, a running loop ends (review P2-4)', async () => {
  const m = createResearchManager({ research: async () => ({ answer: 'x' }) });
  assert.throws(() => m.start({ sid: 's3', question: 'q', ctx: { limits: { check: () => ({ ok: false }) } } }), /Tagesdeckel/);
  let calls = 0;
  const r = await runResearch({ question: 'q', ctx: { sid: 's3', limits: { check: () => ({ ok: calls < 1 }) } }, model: 'm', warmStart: false }, {
    runTool: async () => ({ ok: true, content: 'ok' }),
    complete: async () => { calls += 1; return { message: calls < 5 ? { tool_calls: [call('read_file', { path: '/x' }, `c${calls}`)] } : { tool_calls: [answer] }, costUsd: 0 }; },
    toolDefs: TOOL_DEFS,
  });
  assert.equal(r.stopped, 'budget');
  assert.ok(calls <= 3, `stopped early (${calls} model calls)`);
});

test('a result claimed while delivery waited is not told again; research_result claims (review P2-1/P2-2)', async () => {
  let idle = false;
  const said = [];
  const m = createResearchManager({ research: async () => ({ answer: 'A', found: true, sources: [], unconfirmed: [], confidence: 'hoch', outsider: true, steps: 1, ms: 1 }), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  m.attach('s4', { say: (t) => { said.push(t); return true; }, idle: () => idle });
  const run = m.start({ sid: 's4', question: 'Frage', ctx: {} });
  await run.wait(50);
  run.detach();
  await new Promise((r) => setTimeout(r, 20));
  m.claimed(run);
  idle = true;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(said.length, 0);
  const run2 = m.start({ sid: 's4', question: 'Zweite Frage', ctx: {} });
  await run2.wait(50);
  assert.match(m.results('s4', run2.id)[0].result, /Antwort/);
  assert.equal(run2.delivered, true);
  assert.equal(m.guarded('s4'), true, 'outsider text read through research_result locks too');
});

test('search falls back to ctx.search while the map is not built (review P2-5)', async () => {
  const hub = { calls: [], async call(method) { this.calls.push(method); if (method === 'map.search') throw new Error('the map is not built yet (scripts/map/build.mjs has not finished a run)'); return { hits: [{ path: '/home/flori/jobs/a/STATE.md', line: 1, text: 'x' }] }; } };
  const r = await runTool('search', { query: 'Bewertung' }, { hub, sid: 's5', audit() {} });
  assert.equal(r.ok, true);
  assert.deepEqual(hub.calls, ['map.search', 'ctx.search']);
});

test('web and shell exclude each other in one run; shell is research-only and never shows the command', async () => {
  const { activityLabel } = await import('../src/tools.js');
  const ran = [];
  const seenTools = [];
  let i = 0;
  const rounds = [{ tool_calls: [call('web_read', { url: 'https://example.com/' })] }, { tool_calls: [call('shell', { command: 'rg -l x jobs' })] }, { tool_calls: [answer] }];
  await runResearch({ question: 'q', ctx: { sid: 's7' }, model: 'm', warmStart: false }, {
    runTool: async (name) => { ran.push(name); return { ok: true, content: 'ok' }; },
    complete: async ({ tools }) => { seenTools.push(tools.map((t) => t.name)); return { message: rounds[i++], costUsd: 0 }; },
    toolDefs: TOOL_DEFS,
  });
  assert.deepEqual(ran, ['web_read'], 'no shell after a web tool');
  assert.ok(seenTools[0].includes('shell') && !seenTools[1].includes('shell'), 'shell leaves the tool list after web');
  const def = TOOL_DEFS.find((t) => t.name === 'shell');
  assert.equal(def.researchOnly, true);
  const r = await runTool('shell', { command: 'ls' }, { hub: { call: async () => { throw new Error('must not run'); } }, sid: 's7', audit() {} });
  assert.equal(r.ok, false, 'outside a research run the shell is refused');
  assert.equal(activityLabel('shell', { command: 'cat /data/secret-looking-thing' }), 'Befehl im Sandkasten');
});

test('sandbox.exec is routed to the Sandy bridge (the default route is LeChonk, which has no sandbox)', async () => {
  const { routeOf } = await import('../src/bridgeHub.js');
  assert.deepEqual(routeOf('sandbox.exec'), ['sandy']);
  assert.deepEqual(routeOf('map.search'), ['lechonk']);
  assert.deepEqual(routeOf('laptop.recent'), ['lechonk']);
});
