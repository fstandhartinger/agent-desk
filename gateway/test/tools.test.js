import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Limits } from '../src/limits.js';
import { TOOL_DEFS, runTool, resolveToolName } from '../src/tools.js';
import { syn } from './synthetic.js';

const fakeHub = (handlers) => ({ calls: [], async call(method, params) { this.calls.push([method, params]); return handlers[method](params); } });
const ctx = (hub, extra = {}) => ({ hub, page: null, audit: () => {}, limits: new Limits(), ...extra });

describe('tool definitions', () => {
  it('cover the registered tools of the spec with JSON-schema parameters', () => {
    assert.deepEqual(TOOL_DEFS.map((t) => t.name), ['artifact_context', 'artifact_resolve', 'artifact_search', 'artifact_ref_read', 'read_core_doc', 'knowledge_read', 'search_files', 'read_file', 'decisions_recent', 'list_jobs', 'job_status', 'board_threads', 'board_read', 'board_entry', 'board_search', 'chats_search', 'explainer_point', 'explainer_context', 'claude_task', 'claude_status', 'canvas_draw', 'canvas_render', 'ledger_spend', 'desk_status', 'code_outline', 'web_read', 'chat_read', 'discord_read', 'mail_search', 'mail_read', 'skills_list', 'skill_read', 'run_readonly', 'handoff_propose']);
    for (const t of TOOL_DEFS) assert.equal(t.parameters.type, 'object', t.name);
  });
});

describe('runTool', () => {
  it('maps arguments onto bridge methods and drops unknown keys', async () => {
    const hub = fakeHub({ 'ctx.search': () => [{ path: '/a', line: 'x' }] });
    const out = await runTool('search_files', { query: 'LeChonk', scope: 'jobs', sneaky: 1 }, ctx(hub));
    assert.equal(out.ok, true);
    assert.deepEqual(hub.calls[0], ['ctx.search', { query: 'LeChonk', scope: 'jobs', maxHits: undefined }]);
    assert.match(out.content, /"path": "\/a"/);
  });

  it('truncates to maxChars with a marker and keeps the summary at 200 chars', async () => {
    const hub = fakeHub({ 'ctx.core': () => 'x'.repeat(20_000) });
    const out = await runTool('read_core_doc', { name: 'AGENTS' }, ctx(hub));
    assert.ok(out.content.length <= 6000 && out.content.includes('abgeschnitten'));
    assert.ok(out.summary.length <= 200);
    const voice = await runTool('read_core_doc', { name: 'AGENTS' }, ctx(hub, { maxChars: 2500 }));
    assert.ok(voice.content.length <= 2500);
  });

  it('rejects bad arguments and unknown tools without calling the bridge', async () => {
    const hub = fakeHub({});
    for (const [name, args] of [['read_core_doc', { name: 'PASSWD' }], ['read_file', {}], ['list_jobs', { limit: 'many' }], ['nope', {}], ['job_status', 'x']]) {
      const out = await runTool(name, args, ctx(hub));
      assert.equal(out.ok, false, name);
      assert.match(out.content, /^ERROR:/);
    }
    assert.equal(hub.calls.length, 0);
  });

  it('turns bridge failures into error results', async () => {
    const hub = fakeHub({ 'jobs.get': () => { throw new Error('Die Werkstatt-Verbindung (lechonk) ist offline'); } });
    const out = await runTool('job_status', { name: 'x' }, ctx(hub));
    assert.deepEqual([out.ok, out.summary], [false, 'Die Werkstatt-Verbindung (lechonk) ist offline']);
  });

  it('scrubs secrets from results', async () => {
    const hub = fakeHub({ 'ctx.read': () => syn('token = abcd·efgh·ijkl·mnop·1234·5') });
    const out = await runTool('read_file', { path: '/home/flori/jobs/x' }, ctx(hub));
    assert.ok(!out.content.includes(syn('abcd·efgh·ijkl·mnop·1234·5')));
  });

  it('claude_task only PROPOSES: no bridge call, a claude_proposal event, the result says nothing has started', async () => {
    const hub = fakeHub({});
    const out = await runTool('claude_task', { prompt: 'Prüfe den Job' }, ctx(hub, { sid: 's1' }));
    assert.equal(out.ok, true);
    assert.equal(hub.calls.length, 0);
    assert.equal(out.event.type, 'claude_proposal');
    assert.match(out.event.id, /^c[0-9a-f]{16}$/);
    assert.deepEqual([out.event.prompt, out.event.title], ['Prüfe den Job', 'Prüfe den Job']);
    assert.match(out.content, /NICHTS gestartet/);
  });

  it('claude_task with a sessionId proposes a send and validates the id', async () => {
    const hub = fakeHub({});
    const out = await runTool('claude_task', { prompt: 'weiter', sessionId: 'd20261024-abc123' }, ctx(hub));
    assert.equal(out.ok, true);
    assert.equal(out.event.sessionId, 'd20261024-abc123');
    assert.equal((await runTool('claude_task', { prompt: 'weiter', sessionId: '../x' }, ctx(hub))).ok, false);
    assert.equal(hub.calls.length, 0);
  });

  it('claude_status summarises state, last 5 tool uses and last text', async () => {
    const events = [{ seq: 1, kind: 'status', state: 'running' }, ...Array.from({ length: 7 }, (_, i) => ({ seq: i + 2, kind: 'tool_use', name: 'Read', path: `/f${i}` })), { seq: 9, kind: 'text', text: 'fertig' }];
    const hub = fakeHub({ 'claude.get': () => ({ events }) });
    const out = await runTool('claude_status', { sessionId: 'd20261024-abc123' }, ctx(hub));
    const parsed = JSON.parse(out.content);
    assert.equal(parsed.state, 'running');
    assert.deepEqual(parsed.lastToolUses, ['Read /f2', 'Read /f3', 'Read /f4', 'Read /f5', 'Read /f6']);
    assert.equal(parsed.lastText, 'fertig');
  });

  it('explainer_point needs an open page and a known point', async () => {
    const out = await runTool('explainer_point', { pointId: 'x' }, ctx(fakeHub({})));
    assert.equal(out.ok, false);
    assert.match(out.summary, /no explainer page/);
  });
});

describe('tool results', () => {
  it('shows a text body unescaped below a compact header, so paging hints come first and survive truncation', async () => {
    const hub = fakeHub({ 'ctx.read': () => ({ path: '/p', offset: 0, lines: 2, totalLines: 900, nextOffset: 2, text: `a\nb${'z'.repeat(8000)}` }) });
    const out = await runTool('read_file', { path: '/p' }, ctx(hub));
    assert.match(out.content, /^\{"path":"\/p","offset":0,"lines":2,"totalLines":900,"nextOffset":2\}\n---\na\nb/);
    assert.ok(out.content.length <= 6000);
  });

  it('decisions_recent sizes its answer for the caller (voice 2500 chars)', async () => {
    const hub = fakeHub({ 'ctx.decisionsToday': () => ({ entries: [] }) });
    await runTool('decisions_recent', { days: 1 }, ctx(hub));
    await runTool('decisions_recent', {}, ctx(hub, { maxChars: 2500 }));
    assert.deepEqual(hub.calls, [['ctx.decisionsToday', { days: 1, maxChars: 4500 }], ['ctx.decisionsToday', { days: undefined, maxChars: 1875 }]]);
  });

  it('describes read_file offset/limit as lines', () => {
    const { offset, limit } = TOOL_DEFS.find((t) => t.name === 'read_file').parameters.properties;
    assert.match(offset.description, /LINE/);
    assert.match(limit.description, /LINES/);
    assert.ok(!/character/i.test(`${offset.description} ${limit.description}`.replace('Never a character position', '')));
  });
});

 it('recovers unique tool spelling misses up to distance three and keeps unknown tools unknown', async () => {
   for (const typo of ['decisions_recen', 'decision_recent', 'decisions_recxxx']) assert.equal(resolveToolName(typo), 'decisions_recent');
   assert.equal(resolveToolName('nope'), 'nope');
   const hub = fakeHub({ 'jobs.list': () => ({ total: 0, open: 0, jobs: [] }) });
   assert.equal((await runTool('list_job', {}, ctx(hub))).ok, true);
   assert.equal(hub.calls[0][0], 'jobs.list');
 });
