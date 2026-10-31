// The text agent and the bridge are two programs written by two hands; round 1 shipped with "characters" on one side
// and "lines" on the other, and 130 unit tests stayed green. These tests pin the contract itself:
// (1) every argument a tool forwards is a parameter of the bridge method, with the same JSON type;
// (2) the real bridge handlers, called through runTool, behave as the tool descriptions promise.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-home-'));
process.env.BRIDGE_HOME = home;
process.env.DESK_SESSIONS_DIR = path.join(home, 'desk-sessions');
const { TOOL_DEFS, BRIDGE_TOOLS, runTool } = await import('../src/tools.js');
const { Limits } = await import('../src/limits.js');
const { METHOD_PARAMS } = await import('../../bridge/src/params.js');
const ctxMod = await import('../../bridge/src/ctx.js');
const jobsMod = await import('../../bridge/src/jobs.js');
const chatsMod = await import('../../bridge/src/chats.js');
const knowledgeMod = await import('../../bridge/src/knowledge.js');

// chats_search/chat_read/discord_read call the bridge through own handlers (fan-out, host refs, two methods); the
// 'whatever runTool sends' test below still checks their params against METHOD_PARAMS.
const GATEWAY_ONLY = new Set(['screen_context', 'artifact_context', 'artifact_resolve', 'artifact_search', 'artifact_ref_read', 'desk_status', 'explainer_point', 'explainer_context', 'claude_task', 'claude_status', 'canvas_render', 'canvas_draw', 'web_read', 'handoff_propose', 'chats_search', 'chat_read', 'discord_read']);
const today = new Date().toISOString().slice(0, 10);
const sample = (spec) => spec.enum?.[0] ?? ({ string: 'x', integer: 3, boolean: true }[spec.type]);
const typeOf = (value) => (Number.isInteger(value) ? 'integer' : typeof value);

const REAL = {
  'ctx.core': ctxMod.core,
  'ctx.search': ctxMod.search,
  'ctx.read': ctxMod.read,
  'ctx.decisionsToday': ctxMod.decisionsToday,
  'jobs.list': jobsMod.list,
  'jobs.get': jobsMod.get,
  'chats.search': chatsMod.search,
  'ctx.knowledge': knowledgeMod.knowledge,
};

before(() => {
  fs.mkdirSync(path.join(home, 'jobs', 'ask-investigate-demo-20261024'), { recursive: true });
  fs.writeFileSync(path.join(home, 'jobs', 'ask-investigate-demo-20261024', 'STATE.md'), '# STATE\nLäuft: Untersuchung\n');
  fs.writeFileSync(path.join(home, 'jobs', 'ask-investigate-demo-20261024', 'notes.md'), Array.from({ length: 100 }, (_, i) => `zeile ${i}`).join('\n'));
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'Regeln: LeChonk ist die zweite Werkstatt\n');
  fs.mkdirSync(path.join(home, 'desk-knowledge', 'topics'), { recursive: true });
  fs.writeFileSync(path.join(home, 'desk-knowledge', 'INDEX.md'), '# Florians Themen\n## Steuer\n');
  fs.writeFileSync(path.join(home, 'desk-knowledge', 'topics', 'owner-emissions-tax.md'), '# Owner emissions and tax\n<!-- keywords: steuer, tax, rücklage, tranche -->\n- 250-alpha tranches, 3 per day\n');
  fs.writeFileSync(path.join(home, 'DECISIONS.md'), `<!-- c -->\n## ${today} 09:00Z — Heutige Entscheidung\n- Florian hat X freigegeben.\nresolved-keys: x\n\n## 2020-01-01 10:00Z — Uralt\n- alt\n`);
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

/** Hub that records the params and runs the REAL bridge handler where there is one. */
function recordingHub() {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params ?? {}]);
      if (REAL[method]) return REAL[method](params);
      if (method === 'claude.list') return { sessions: [] };
      if (method === 'claude.start') return { sid: 'd20261024-abc123' };
      return { ok: true, text: '' };
    },
  };
}
const ctxFor = (hub) => ({ hub, page: null, audit: () => {}, limits: new Limits() });

describe('tool arguments match bridge parameters', () => {
  it('every tool is bridge-backed or gateway-only', () => {
    for (const { name } of TOOL_DEFS) assert.ok(BRIDGE_TOOLS[name] || GATEWAY_ONLY.has(name), name);
    for (const name of Object.keys(BRIDGE_TOOLS)) assert.ok(TOOL_DEFS.some((t) => t.name === name), name);
  });

  for (const [tool, [method, mapArgs]] of Object.entries(BRIDGE_TOOLS)) {
    it(`${tool} → ${method}: all parameters forwarded, same names and types, none unknown`, () => {
      const def = TOOL_DEFS.find((t) => t.name === tool);
      const args = Object.fromEntries(Object.entries(def.parameters.properties).map(([key, spec]) => [key, sample(spec)]));
      const mapped = mapArgs(args, 6000);
      const accepted = METHOD_PARAMS[method];
      assert.ok(accepted, `${method} missing in bridge/src/params.js`);
      for (const [key, value] of Object.entries(mapped)) {
        assert.ok(key in accepted, `${tool} sends "${key}" which ${method} does not accept`);
        assert.equal(typeOf(value), accepted[key], `${tool}.${key}`);
      }
      for (const key of Object.keys(def.parameters.properties)) assert.ok(key in mapped, `${tool}.${key} is declared to the model but never forwarded`);
    });
  }

  it('whatever runTool sends to the bridge for any tool (incl. claude_task / claude_status) is accepted by METHOD_PARAMS', async () => {
    const hub = recordingHub();
    const inputs = { read_core_doc: { name: 'AGENTS' }, search_files: { query: 'x' }, read_file: { path: '/x' }, decisions_recent: {}, list_jobs: {}, job_status: { name: 'x' }, board_threads: {}, board_read: { thread: '15' }, board_search: { query: 'x' }, search_chats: { query: 'xx' }, chats_search: { query: 'xx', agent: 'codex', host: 'sandy', limit: 5 }, chat_read: { ref: 'sandy~abc', offset: 2, limit: 5 }, discord_read: {}, mail_search: { query: 'x', limit: 2 }, mail_read: { account: 'a', uid: '7' }, skills_list: {}, skill_read: { name: 'x', file: 'README.md' }, run_readonly: { command: 'disk' }, knowledge_read: { topic: 'Steuer' }, claude_task: { prompt: 'Mach X', model: 'sonnet' }, claude_status: {}, ledger_spend: { groupBy: 'category', kgOnly: true }, code_outline: { path: '/x' } };
    for (const [name, args] of Object.entries(inputs)) await runTool(name, args, ctxFor(hub));
    await runTool('claude_task', { prompt: 'weiter', sessionId: 'd20261024-abc123' }, ctxFor(hub));
    await runTool('claude_status', { sessionId: 'd20261024-abc123' }, ctxFor(hub));
    for (const [method, params] of hub.calls) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        assert.ok(key in METHOD_PARAMS[method], `${method} got unknown param "${key}"`);
        assert.equal(typeOf(value), METHOD_PARAMS[method][key], `${method}.${key}`);
      }
    }
    assert.ok(hub.calls.length >= 13);
  });
});

describe('real bridge handlers behind the tools', () => {
  it('read_file offset/limit are LINES and the result says how to continue', async () => {
    const file = path.join(home, 'jobs', 'ask-investigate-demo-20261024', 'notes.md');
    assert.match(TOOL_DEFS.find((t) => t.name === 'read_file').parameters.properties.offset.description, /LINE/);
    const out = await runTool('read_file', { path: file, offset: 20, limit: 5 }, ctxFor(recordingHub()));
    assert.equal(out.ok, true, out.content);
    const [header, body] = out.content.split('\n---\n');
    assert.deepEqual(JSON.parse(header).totalLines, 100);
    assert.deepEqual(JSON.parse(header).nextOffset, 25);
    assert.equal(body, ['zeile 20', 'zeile 21', 'zeile 22', 'zeile 23', 'zeile 24'].join('\n'));
  });

  it('the old failure: a character-style offset beyond the file returns a note instead of an unexplained empty read', async () => {
    const file = path.join(home, 'jobs', 'ask-investigate-demo-20261024', 'notes.md');
    const out = await runTool('read_file', { path: file, offset: 4000, limit: 400 }, ctxFor(recordingHub()));
    assert.match(out.content, /LINES, not characters/);
  });

  it('read_core_doc DECISIONS tells the model it is newest-first, in the header', async () => {
    const out = await runTool('read_core_doc', { name: 'DECISIONS' }, ctxFor(recordingHub()));
    assert.match(out.content.split('\n---\n')[0], /newest-first/);
    assert.match(out.content, /Heutige Entscheidung/);
  });

  it('decisions_recent returns today\'s entries only, within the size cap, also with the 2500-char voice cap', async () => {
    const out = await runTool('decisions_recent', {}, ctxFor(recordingHub()));
    assert.match(out.content, /Heutige Entscheidung/);
    assert.ok(!out.content.includes('Uralt'));
    const voice = await runTool('decisions_recent', {}, { ...ctxFor(recordingHub()), maxChars: 2500 });
    assert.ok(voice.content.length <= 2500 && voice.content.includes('Heutige Entscheidung'));
  });

  it('list_jobs / job_status keep ask-… job names intact end to end (no a[REDACTED])', async () => {
    const list = await runTool('list_jobs', { activeOnly: true }, ctxFor(recordingHub()));
    assert.match(list.content, /ask-investigate-demo-20261024/);
    assert.ok(!list.content.includes('a[REDACTED]'));
    const status = await runTool('job_status', { name: 'ask-investigate-demo-20261024' }, ctxFor(recordingHub()));
    assert.match(status.content, /Untersuchung/);
  });

  it('search_files finds text in the core docs', async () => {
    const out = await runTool('search_files', { query: 'zweite Werkstatt', scope: 'docs' }, ctxFor(recordingHub()));
    assert.match(out.content, /AGENTS\.md/);
  });

  it('knowledge_read → ctx.knowledge: German topic names find the topic file; without topic the index', async () => {
    const topic = await runTool('knowledge_read', { topic: 'Steuerrücklage' }, ctxFor(recordingHub()));
    assert.equal(topic.ok, true, topic.content);
    assert.match(topic.content, /250-alpha tranches/);
    const index = await runTool('knowledge_read', {}, ctxFor(recordingHub()));
    assert.match(index.content, /Florians Themen/);
  });

  it('search_files: a multiword German query is OR of expanded terms, not one phrase (24 Oct zero-hit bug)', async () => {
    const out = await runTool('search_files', { query: 'Steuer Rücklage Tranchen Überweisung' }, ctxFor(recordingHub()));
    assert.match(out.content, /owner-emissions-tax\.md/);
  });
});
