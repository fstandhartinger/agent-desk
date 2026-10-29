import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Synthetic transcripts in the three agents' on-disk layouts (Claude Code, Codex, OpenCode) under a throwaway home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-chats-'));
process.env.BRIDGE_HOME = home;
const chats = await import('../src/chats.js');

const write = (rel, text) => {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const jl = (...objs) => `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`;
const FAKE_KEY = `sk-${'a1B2c3D4e5'.repeat(3)}`;

before(() => {
  write('.claude/projects/-home-flori-jobs-demo-job-20261001/aaaa-1111.jsonl', jl(
    { type: 'queue-operation', content: 'zebrafinch noise that must not be a hit' },
    { type: 'user', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'Please check the zebrafinch widget' } },
    { type: 'assistant', timestamp: '2026-10-01T10:00:05Z', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'hidden' },
      { type: 'text', text: `Looking at the widget. key ${FAKE_KEY}` },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls -la /tmp/widgets' } },
    ] } },
    { type: 'user', timestamp: '2026-10-01T10:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', content: `${'x'.repeat(900)} END` }] } },
  ));
  write('.claude/history.jsonl', jl({ display: 'zebrafinch prompt history line', timestamp: 1790000000000, project: '/home/flori/jobs/demo-job-20261001', sessionId: 'aaaa-1111' }));
  write('.codex/sessions/2026/10/02/rollout-2026-10-02T09-00-00-bbbb-2222.jsonl', jl(
    { timestamp: '2026-10-02T09:00:00Z', type: 'session_meta', payload: { cwd: '/home/flori/jobs/codex-demo-20261002', base_instructions: { text: 'zebrafinch boilerplate in a prompt' } } },
    { timestamp: '2026-10-02T09:00:01Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'skills: zebrafinch-skill' }] } },
    { timestamp: '2026-10-02T09:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate the zebrafinch regression' }] } },
    { timestamp: '2026-10-02T09:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'rg zebrafinch src' } },
    { timestamp: '2026-10-02T09:00:04Z', type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'src/a.js: zebrafinch' } },
    { timestamp: '2026-10-02T09:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found it.' }] } },
  ));
  write('.codex/archived_sessions/rollout-2026-09-01T09-00-00-cccc-3333.jsonl', jl(
    { timestamp: '2026-09-01T09:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'archived zebrafinch question' }] } },
  ));
  write('.codex/history.jsonl', jl({ session_id: 'bbbb-2222', ts: 1790000100, text: 'zebrafinch in codex history' }));
  const st = '.local/share/opencode/storage';
  write(`${st}/session/ses_oc1.json`, JSON.stringify({ id: 'ses_oc1', title: 'zebrafinch session' }));
  write(`${st}/message/ses_oc1/msg_1.json`, JSON.stringify({ id: 'msg_1', role: 'user', time: { created: 1790000200000 }, summary: { title: 'zebrafinch opencode request' } }));
  write(`${st}/message/ses_oc1/msg_2.json`, JSON.stringify({ id: 'msg_2', role: 'assistant', time: { created: 1790000300000 } }));
  write(`${st}/part/msg_2/prt_1.json`, JSON.stringify({ type: 'text', text: 'opencode answer about zebrafinch' }));
  write(`${st}/part/msg_2/prt_2.json`, JSON.stringify({ type: 'tool', tool: 'bash', state: { input: { command: 'ls' }, output: 'file-a' } }));
  write('.local/state/opencode/prompt-history.jsonl', jl({ input: 'zebrafinch in opencode prompt history' }));
});

const byAgent = (r, a) => r.hits.filter((h) => h.agent === a);

test('chats.search covers claude, codex and opencode, with opaque refs and no raw paths', async () => {
  const r = await chats.search({ query: 'zebrafinch', limit: 30 });
  for (const a of ['claude', 'codex', 'opencode']) assert.ok(byAgent(r, a).length > 0, `${a} missing`);
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes(home) && !blob.includes('.jsonl') && !blob.includes('rollout-'), 'a raw path leaked');
  for (const h of r.hits.filter((x) => x.source === 'session')) assert.match(h.ref, /^c[0-9a-f]{20}$/);
  assert.ok(r.hits.filter((x) => x.source === 'prompt-history').every((h) => h.ref === null));
});

test('chats.search skips queue noise, developer boilerplate and redacts snippets', async () => {
  const r = await chats.search({ query: 'zebrafinch', agent: 'claude' });
  assert.ok(r.hits.every((h) => h.role !== 'queue-operation'));
  const codex = await chats.search({ query: 'zebrafinch', agent: 'codex' });
  assert.ok(codex.hits.every((h) => !/boilerplate|skills:/.test(h.text)), JSON.stringify(codex.hits));
  assert.ok(codex.hits.some((h) => h.project === 'codex-demo-20261002'));
  const leaky = await chats.search({ query: 'Looking at the widget', agent: 'claude' });
  assert.ok(leaky.hits.length && leaky.hits.every((h) => !h.text.includes(FAKE_KEY.slice(4, 20))));
});

test('chats.search agent filter, OR terms and argument checks', async () => {
  const oc = await chats.search({ query: 'zebrafinch', agent: 'opencode' });
  assert.ok(oc.hits.length > 0 && oc.hits.every((h) => h.agent === 'opencode'));
  const either = await chats.search({ query: 'archived OR nonexistentterm', agent: 'codex' });
  assert.ok(either.hits.some((h) => /archived/.test(h.text)));
  await assert.rejects(chats.search({ query: 'a' }), /too short/);
  await assert.rejects(chats.search({ query: 'zebrafinch', agent: 'cursor' }), /agent must be/);
});

test('chats.read renders Claude turns: text, tool names + short args, truncated results, no thinking', async () => {
  const hit = (await chats.search({ query: 'zebrafinch widget', agent: 'claude' })).hits.find((h) => h.ref);
  const r = await chats.read({ ref: hit.ref, limit: 50 });
  const roles = r.turns.map((t) => t.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'tool_result']);
  assert.ok(r.turns.every((t) => !t.text.includes('hidden')));
  assert.match(r.turns[2].text, /^Bash .*ls -la/);
  assert.ok(r.turns[3].text.length < 400 && r.turns[3].text.includes('chars]'));
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY.slice(4, 20)));
  assert.equal(r.total, 4);
});

test('chats.read pages by turns and renders codex and opencode', async () => {
  const cx = (await chats.search({ query: 'zebrafinch regression', agent: 'codex' })).hits.find((h) => h.ref);
  const p1 = await chats.read({ ref: cx.ref, offset: 0, limit: 2 });
  assert.equal(p1.turns.length, 2);
  assert.equal(p1.nextOffset, 2);
  const p2 = await chats.read({ ref: cx.ref, offset: 2, limit: 10 });
  assert.deepEqual(p2.turns.map((t) => t.role), ['tool_result', 'assistant']);
  assert.equal(p2.nextOffset, null);
  const oc = (await chats.search({ query: 'zebrafinch session', agent: 'opencode' })).hits.find((h) => h.ref);
  const r = await chats.read({ ref: oc.ref });
  assert.deepEqual(r.turns.map((t) => t.role), ['user', 'assistant', 'tool', 'tool_result']);
});

test('chats.read refuses made-up refs and refs whose file left the chat roots', async () => {
  await assert.rejects(chats.read({ ref: 'c' + '0'.repeat(20) }), /unknown or expired/);
  await assert.rejects(chats.read({ ref: '/etc/passwd' }), /unknown or expired/);
  await assert.rejects(chats.read({}), /unknown or expired/);
  // a ref made for a denied file (cookies database next to a session) must not render
  const evil = write('.claude/projects/p/cookies.sqlite', 'x');
  const ref = chats.makeRef('claude', evil);
  await assert.rejects(chats.read({ ref }), /not available/);
  const outside = write('elsewhere/s.jsonl', jl({ type: 'user', message: { content: 'secret' } }));
  await assert.rejects(chats.read({ ref: chats.makeRef('claude', outside) }), /not available/);
  const hist = path.join(home, '.claude/history.jsonl');
  await assert.rejects(chats.read({ ref: chats.makeRef('claude', hist) }), /not available/);
});
