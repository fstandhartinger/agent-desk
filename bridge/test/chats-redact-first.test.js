// Critic round 3, P0-1 (a): chats.* redacts the source text BEFORE cutting a snippet, drops partial tokens at the cuts and
// never shows an environment dump. Every value here is synthetic; the values live only in a throwaway home.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syn } from './synthetic.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-chats-rf-'));
process.env.BRIDGE_HOME = home;
const chats = await import('../src/chats.js');
const { ENV_HIDDEN, snippetAny, hideEnvDumps, isEnvDump } = chats;

const write = (rel, text) => {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const jl = (...objs) => `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`;
// no vendor prefix, no value list entry: only key context or the env-dump rule can catch these
const V1 = syn('Qm7Z·p2Lx·9Vb4·Nc8R·t1Wd·6Ys3·Hf5J·g0Ka');
const V2 = syn('uE4n·B8vM·2cX6·zL0k·J9hG·3fD7·sA1p·O5iU');
const pad = (n) => 'Notiz zum Lauf und zum Ergebnis. '.repeat(n);
const leaks = (s, v) => s.includes(v) || s.includes(v.slice(3, 19)) || s.includes(v.slice(10, 26));

before(() => {
  // a Codex rollout whose tool output is an `env` dump with escaped newlines (the critic-3 shape)
  write('.codex/sessions/2026/10/19/rollout-2026-10-19T22-32-48-dddd-4444.jsonl', jl(
    { timestamp: '2026-10-19T22:00:00Z', type: 'session_meta', payload: { cwd: '/home/flori/jobs/synth-envdump-20261019' } },
    { timestamp: '2026-10-19T22:00:01Z', type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: '{"cmd":"env"}' } },
    { timestamp: '2026-10-19T22:00:02Z', type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify({ output: `HOME=/home/x\nSYNTH_GOOGLE_SECRET=${V1}\nFUSION_PARENT=/home/flori/jobs/synth-launch-20261015\nSYNTH_QA_MEMBER_PASSWORD=${V2}\nPATH=/usr/bin` }) } },
    { timestamp: '2026-10-19T22:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${pad(4)}Danach lief der Build. SYNTH_DEPLOY_TOKEN=${V1} wurde gesetzt und lugubrious geprüft.` }] } },
  ));
  write('.claude/projects/-home-flori-jobs-synth-envdump/eeee-5555.jsonl', jl(
    { type: 'user', timestamp: '2026-10-20T10:00:00Z', message: { role: 'user', content: 'print the environment for lugubrious' } },
    { type: 'assistant', timestamp: '2026-10-20T10:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `SYNTH_A_KEY=${V1} SYNTH_B=1 SYNTH_C=2 ./run lugubrious` } }] } },
    { type: 'user', timestamp: '2026-10-20T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', content: `environ({'HOME': '/home/x', 'SYNTH_TOKEN': '${V2}', 'LANG': 'C'})` }] } },
    { type: 'user', timestamp: '2026-10-20T10:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', content: `declare -x SYNTH_QA_PASSWORD="${V2}"` }] } },
    { type: 'assistant', timestamp: '2026-10-20T10:00:04Z', message: { role: 'assistant', content: [{ type: 'text', text: `${'x'.repeat(1490)} SYNTH_LATE_SECRET=${V1}` }] } },
  ));
});

test('isEnvDump / hideEnvDumps: pairs, declare -x, environ reprs, UPPER JSON keys, runs of NAME=value lines', () => {
  assert.ok(isEnvDump('HOME=/x USER=me SYNTH_KEY=abc'));
  assert.ok(isEnvDump('declare -x HOME="/x"'));
  assert.ok(isEnvDump("environ({'HOME': '/x'})"));
  assert.ok(isEnvDump('print(os.environ)'));
  assert.ok(isEnvDump('{"HOME_DIR": "/x", "SYNTH_USER": "me", "SYNTH_KEY": "abc"}'));
  assert.ok(!isEnvDump('Die Pipeline hat 12 Schritte, MAX_TOKENS=4000 ist gesetzt.'));
  assert.equal(hideEnvDumps('vorher\nA_ONE=1\nB_TWO=2\nC_THREE=3\nnachher'), `vorher\n${ENV_HIDDEN}\nnachher`);
  assert.equal(hideEnvDumps('vorher\\nA_ONE=1\\nB_TWO=2\\nC_THREE=3\\nnachher'), `vorher\\n${ENV_HIDDEN}\\nnachher`);
  assert.equal(hideEnvDumps('PORT=8080\nnormaler Text'), 'PORT=8080\nnormaler Text');
});

test('snippetAny: a cut that starts mid-key never shows the bare value (redact first, then cut)', () => {
  // the hit is 100+ chars after the value: an old cut would start at "…ET=<value>" without the key name
  const text = `${pad(3)}SYNTH_GOOGLE_SECRET=${V1}\n${'y'.repeat(60)} lugubrious ${pad(2)}`;
  const s = snippetAny(text, ['lugubrious']);
  assert.ok(s.includes('lugubrious'), s);
  assert.ok(!leaks(s, V1), s);
  // a cut inside a long token drops the partial token
  const t2 = `${'Q'.repeat(30)}${V1.toLowerCase()}tail ${'z'.repeat(80)} lugubrious end`;
  const s2 = snippetAny(t2, ['lugubrious']);
  assert.ok(s2.startsWith('zzz') && s2.endsWith('lugubrious end'), s2);
});

test('chats.search: env dumps and mid-key snippets from Codex and Claude transcripts carry no value', async () => {
  for (const q of ['SYNTH_QA_MEMBER_PASSWORD', 'FUSION_PARENT', 'lugubrious', 'SYNTH_TOKEN', 'declare', 'SYNTH_LATE_SECRET']) {
    const r = await chats.search({ query: q, agent: 'all', limit: 30 });
    const blob = JSON.stringify(r);
    assert.ok(!leaks(blob, V1) && !leaks(blob, V2), `query ${q}: ${blob.slice(0, 400)}`);
  }
  const env = await chats.search({ query: 'SYNTH_QA_MEMBER_PASSWORD', agent: 'codex' });
  assert.ok(env.hits.length > 0 && env.hits.every((h) => h.text.includes(ENV_HIDDEN)), JSON.stringify(env.hits));
});

test('chats.read: turns and tool results are redacted before clipping; env dumps are hidden', async () => {
  for (const agent of ['codex', 'claude']) {
    const r = await chats.search({ query: 'lugubrious', agent });
    const ref = r.hits.find((h) => h.ref)?.ref;
    assert.ok(ref, agent);
    const page = await chats.read({ ref, limit: 100 });
    const blob = JSON.stringify(page);
    assert.ok(!leaks(blob, V1) && !leaks(blob, V2), `${agent}: ${blob.slice(0, 600)}`);
    assert.ok(blob.includes(ENV_HIDDEN), agent);
  }
});

test('chats.recent: the first user line is redacted before it is cut', async () => {
  write('.claude/projects/-home-flori-jobs-synth-recent/ffff-6666.jsonl', jl(
    { type: 'user', timestamp: '2026-10-21T10:00:00Z', message: { role: 'user', content: `${'w'.repeat(200)} SYNTH_FIRST_SECRET=${V1}` } },
  ));
  const r = await chats.recent({ limit: 10 });
  assert.ok(!leaks(JSON.stringify(r), V1));
});
