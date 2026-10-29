import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGateway } from './helpers.js';

// Sessions live under the real home (so /home/flori/CLAUDE.md loads as in every session) in a throwaway folder.
const sessionsDir = path.join(os.homedir(), `.desk-sessions-test-${process.pid}`);
process.env.DESK_SESSIONS_DIR = sessionsDir;
process.env.DESK_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-'));
const { startBridge } = await import('../src/bridge.js');
const { createClaude } = await import('../src/claude.js');

let gw;
let bridge;

before(async () => {
  gw = await fakeGateway();
  bridge = startBridge({ url: gw.url, token: 'test-token-not-secret', host: 'testhost' });
  await gw.connected;
});

after(async () => {
  bridge.close();
  await gw.close();
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(process.env.DESK_AUDIT_DIR, { recursive: true, force: true });
});

test('hello announces host, caps and claude capacity; bearer header is sent', () => {
  assert.equal(gw.hello.host, 'testhost');
  assert.ok(gw.hello.caps.includes('ctx.core') && gw.hello.caps.includes('claude.start'));
  assert.deepEqual(gw.hello.claude, { running: 0, max: 3 });
  assert.equal(gw.headers.authorization, 'Bearer test-token-not-secret');
});

test('METHOD_PARAMS lists exactly the methods the bridges serve (LeChonk + Sandy)', async () => {
  const { METHOD_PARAMS } = await import('../src/params.js');
  const { buildMethods } = await import('../src/bridge.js');
  assert.deepEqual(Object.keys(buildMethods({}, 'lechonk')).sort(), [...gw.hello.caps].sort());
  const union = new Set([...Object.keys(buildMethods({}, 'lechonk')), ...Object.keys(buildMethods({}, 'sandy'))]);
  assert.deepEqual(Object.keys(METHOD_PARAMS).sort(), [...union].sort());
});

test('ctx.core returns AGENTS.md', async () => {
  const r = await gw.call('ctx.core', { name: 'AGENTS', maxChars: 500 });
  assert.equal(r.name, 'AGENTS');
  assert.equal(r.text.length, 500);
});

test('ctx.search finds text in docs and refuses an empty query', async () => {
  const r = await gw.call('ctx.search', { query: 'Limit awareness', scope: 'docs' });
  assert.ok(r.hits.length > 0);
  assert.ok(r.hits.every((h) => h.path.startsWith('/') && Number.isInteger(h.line) && typeof h.text === 'string'));
  await assert.rejects(gw.call('ctx.search', { query: '  ' }), /query required/);
});

test('ctx.read refuses the deny list over the wire', async () => {
  await assert.rejects(gw.call('ctx.read', { path: '/home/flori/.ssh/id_ed25519' }), /not allowed or not found/);
});

test('jobs.list returns newest jobs with canonical paths', async () => {
  const r = await gw.call('jobs.list', { limit: 5 });
  assert.equal(r.jobs.length, 5);
  assert.ok(r.jobs.every((j) => j.path.startsWith('/home/flori/jobs/') && j.modified));
  const mine = await gw.call('jobs.get', { name: 'explainer-live-agent-page-20261024' });
  assert.equal(mine.name, 'explainer-live-agent-page-20261024');
  assert.ok(mine.state.length > 0);
});

test('board.threads goes through the relay', async () => {
  const r = await gw.call('board.threads');
  assert.match(r.text, /^#\d+ /m);
});

test('chats.search finds Claude Code history', async () => {
  const r = await gw.call('chats.search', { query: 'Agent Desk', limit: 5 });
  assert.ok(r.hits.length > 0 && r.hits.length <= 5);
  assert.ok(r.hits[0].text.toLowerCase().includes('agent desk'));
  const recent = await gw.call('chats.recent', { limit: 3 });
  assert.equal(recent.sessions.length, 3);
});

test('audit.append writes a 0600 jsonl line', async () => {
  await gw.call('audit.append', { actor: 'florian', action: 'test', detail: 'key sk-abcdefghijklmnop1234' });
  const file = path.join(process.env.DESK_AUDIT_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, 'utf8'), /"action":"test".*\[REDACTED\]/);
});

test('unknown methods and bad frames do not crash the bridge', async () => {
  await assert.rejects(gw.call('nope.nothing'), /unknown method/);
  gw.ws.send('not json');
  gw.ws.send(JSON.stringify({ t: 'req' }));
  gw.ws.send(JSON.stringify([1, 2]));
  assert.deepEqual(await gw.call('claude.list'), { sessions: [] });
});

test('bridge reconnects after the gateway drops the socket', async () => {
  const before = gw.hello;
  gw.hello = null;
  gw.connected = new Promise((resolve) => { const t = setInterval(() => { if (gw.hello) { clearInterval(t); resolve(); } }, 50); });
  gw.ws.terminate();
  await gw.connected;
  assert.notEqual(gw.hello, null);
  assert.deepEqual(gw.hello.caps, before.caps);
});

const skipReal = process.env.SKIP_REAL_CLAUDE === '1' ? 'SKIP_REAL_CLAUDE set' : false;

test('real Claude session: start, stream, resume with send, restore after restart', { skip: skipReal, timeout: 600_000 }, async () => {
  const { sid } = await gw.call('claude.start', { title: 'smoke', prompt: 'Antworte nur mit OK.', model: 'sonnet', effort: 'medium', page: { slug: 'demo', title: 'Demo', t: 12 }, chatContext: [{ role: 'user', content: 'Hallo' }] });
  assert.match(sid, /^d\d{8}-[0-9a-f]{6}$/);
  const topic = `claude:${sid}`;
  const firstResult = await gw.waitEvent((f) => f.topic === topic && f.data.kind === 'result');
  await gw.waitEvent((f) => f.topic === topic && f.data.kind === 'status' && f.data.state === 'idle');
  const kinds1 = [...new Set(gw.events.filter((f) => f.topic === topic).map((f) => f.data.kind))];
  console.log(`turn 1 event kinds: ${kinds1.join(', ')}; first result seq ${firstResult.data.seq}`);
  assert.ok(kinds1.includes('status') && kinds1.includes('user') && kinds1.includes('text_delta') && kinds1.includes('text'));

  const dir = path.join(sessionsDir, sid);
  const prompt = fs.readFileSync(path.join(dir, 'PROMPT.md'), 'utf8');
  assert.match(prompt, /Asked by: Florian, via the Agent Desk page/);
  assert.match(prompt, /explainer: Demo \(demo\) at t=12s/);
  assert.match(prompt, /Florian: Hallo/);
  const csid = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).claudeSessionId;
  assert.ok(csid);

  const seqBefore = gw.events.filter((f) => f.topic === topic).length;
  await gw.call('claude.send', { sid, text: "Und jetzt mit 'OK 2'." });
  const secondResult = await gw.waitEvent((f) => f.topic === topic && f.data.kind === 'result' && f.data.seq > firstResult.data.seq);
  await gw.waitEvent((f) => f.topic === topic && f.data.kind === 'status' && f.data.state === 'idle' && f.data.seq > secondResult.data.seq);
  const second = gw.events.filter((f) => f.topic === topic).slice(seqBefore).map((f) => f.data);
  console.log(`turn 2 event kinds: ${[...new Set(second.map((e) => e.kind))].join(', ')}`);
  assert.match(second.find((e) => e.kind === 'text').text, /OK 2/);
  const init2 = JSON.parse(fs.readFileSync(path.join(dir, 'turn-2.out'), 'utf8').split('\n')[0]);
  assert.equal(init2.session_id, csid, 'second turn resumed the same Claude session');

  const replay = await gw.call('claude.get', { sid, sinceSeq: firstResult.data.seq });
  assert.ok(replay.events.length > 0 && replay.events.every((e) => e.seq > firstResult.data.seq));
  assert.equal(replay.state, 'idle');
  assert.match(replay.lastText, /OK 2/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n')[0])).slice(0, 2), ['seq', 'ts']);

  const restored = createClaude({ emit: () => {} });
  restored.restore();
  const entry = restored.list().sessions.find((s) => s.sid === sid);
  assert.equal(entry.state, 'idle');
  assert.equal(restored.get({ sid }).lastSeq, replay.lastSeq);
});

test('real Claude session: stop kills the whole process group', { skip: skipReal, timeout: 600_000 }, async () => {
  const { sid } = await gw.call('claude.start', { title: 'stop test', prompt: 'Run the shell command `sleep 100` with the Bash tool, then say DONE.', model: 'sonnet', effort: 'low' });
  const topic = `claude:${sid}`;
  await gw.waitEvent((f) => f.topic === topic && f.data.kind === 'tool_use' && f.data.name === 'Bash' && /sleep/.test(f.data.command ?? ''));
  const pid = JSON.parse(fs.readFileSync(path.join(sessionsDir, sid, 'meta.json'), 'utf8')).pid;
  assert.ok(pid > 1);
  await gw.call('claude.stop', { sid });
  await gw.waitEvent((f) => f.topic === topic && f.data.kind === 'status' && f.data.state === 'stopped', 60_000);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
