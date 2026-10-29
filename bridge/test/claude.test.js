import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A stand-in for the claude CLI: same stream-json shape, controllable duration, no tokens spent.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-claude-'));
const fake = path.join(tmp, 'fake-claude.sh');
fs.writeFileSync(fake, `#!/bin/bash
echo '{"type":"system","subtype":"init","session_id":"fake-sess"}'
sleep "\${FAKE_SLEEP:-1}"
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from fake"}]},"session_id":"fake-sess"}'
echo '{"type":"result","subtype":"success","is_error":false,"duration_ms":5,"num_turns":1,"total_cost_usd":0.01,"session_id":"fake-sess"}'
`, { mode: 0o755 });
process.env.CLAUDE_BIN = fake;
process.env.DESK_SESSIONS_DIR = path.join(tmp, 'sessions');
const { createClaude, MAX_RUNNING } = await import('../src/claude.js');

const until = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
};
const managers = [];
const make = (emit = () => {}) => { const c = createClaude({ emit }); managers.push(c); return c; };

after(() => {
  for (const c of managers) c.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a turn streams events, ends idle and a queued send runs afterwards', async () => {
  const live = [];
  const claude = make((topic, data) => live.push({ topic, data }));
  const { sid } = await claude.start({ title: 't', prompt: 'say hi' });
  assert.equal(claude.running(), 1);
  const queued = await claude.send({ sid, text: 'second' });
  assert.equal(queued.queued, true);
  await until(() => claude.get({ sid }).events.filter((e) => e.kind === 'result').length === 2 && claude.get({ sid }).state === 'idle');
  const events = claude.get({ sid }).events;
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'seq is gapless and increasing');
  assert.ok(live.some((l) => l.topic === `claude:${sid}` && l.data.kind === 'text'));
  assert.ok(live.some((l) => l.topic === 'claude:list' && l.data.state === 'running'));
  assert.equal(claude.get({ sid }).turns, 2);
});

test('at most three sessions run at once', async () => {
  const claude = make();
  process.env.FAKE_SLEEP = '60';
  const sids = [];
  for (let i = 0; i < MAX_RUNNING; i++) sids.push((await claude.start({ prompt: `p${i}` })).sid);
  await assert.rejects(claude.start({ prompt: 'one too many' }), /max 3/);
  for (const sid of sids) claude.stop({ sid });
  await until(() => claude.running() === 0, 20_000);
  assert.ok(sids.every((sid) => claude.get({ sid }).state === 'stopped'));
  delete process.env.FAKE_SLEEP;
});

test('a running turn survives a bridge restart and is re-attached', async () => {
  process.env.FAKE_SLEEP = '2';
  const first = make();
  const { sid } = await first.start({ prompt: 'long' });
  await until(() => first.get({ sid }).events.some((e) => e.kind === 'status' && e.state === 'running'));
  first.shutdown(); // the old bridge process is gone; the claude child keeps running
  const second = make();
  second.restore();
  assert.equal(second.running(), 1);
  await until(() => second.get({ sid }).state === 'idle');
  const kinds = second.get({ sid }).events.map((e) => e.kind);
  assert.ok(kinds.includes('text') && kinds.includes('result'));
  assert.equal(kinds.filter((k) => k === 'result').length, 1, 'no duplicate events after re-attach');
  delete process.env.FAKE_SLEEP;
});

test('sessions that ended while the bridge was down are drained and resumable', async () => {
  process.env.FAKE_SLEEP = '0';
  const first = make();
  const { sid } = await first.start({ prompt: 'quick' });
  first.shutdown();
  await new Promise((r) => setTimeout(r, 800));
  const second = make();
  second.restore();
  await until(() => second.get({ sid }).state === 'idle');
  assert.ok(second.get({ sid }).events.some((e) => e.kind === 'result'));
  await second.send({ sid, text: 'again' });
  await until(() => second.get({ sid }).turns === 2 && second.get({ sid }).state === 'idle');
  delete process.env.FAKE_SLEEP;
});

test('send and stop reject unknown sessions; send needs text', async () => {
  const claude = make();
  await assert.rejects(claude.send({ sid: 'nope', text: 'x' }), /unknown session/);
  assert.throws(() => claude.stop({ sid: 'nope' }), /unknown session/);
  await assert.rejects(claude.start({ prompt: ' ' }), /prompt required/);
  await assert.rejects(claude.start({ prompt: 'x', model: 'haiku' }), /model must be/);
});

test('a requested stop ends as "stopped" without an error event; result.turns counts desk turns and is marked as subscription', async () => {
  const stopper = path.join(tmp, 'fake-claude-sigint.sh');
  fs.writeFileSync(stopper, `#!/bin/bash
trap 'echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"error_during_execution\\",\\"is_error\\":true,\\"duration_ms\\":3,\\"num_turns\\":7,\\"total_cost_usd\\":0.2,\\"result\\":\\"error_during_execution\\",\\"session_id\\":\\"fake-sess\\"}"; exit 130' INT
echo '{"type":"system","subtype":"init","session_id":"fake-sess"}'
while true; do sleep 0.1; done
`, { mode: 0o755 });
  process.env.CLAUDE_BIN = stopper;
  try {
    const claude = make();
    const { sid } = await claude.start({ prompt: 'long task' });
    await until(() => claude.get({ sid }).events.some((e) => e.kind === 'status' && e.state === 'running'));
    await new Promise((r) => setTimeout(r, 400));
    claude.stop({ sid });
    await until(() => claude.get({ sid }).state === 'stopped', 20_000);
    const events = claude.get({ sid }).events;
    assert.ok(!events.some((e) => e.kind === 'error'), JSON.stringify(events.filter((e) => e.kind === 'error')));
    const result = events.find((e) => e.kind === 'result');
    assert.deepEqual([result.turns, result.agentSteps, result.subscription, result.costUsd], [1, 7, true, 0.2]);
  } finally {
    process.env.CLAUDE_BIN = fake;
  }
});

test('turns in result events follow the desk turn number, not the agent step count', async () => {
  const claude = make();
  const { sid } = await claude.start({ prompt: 'one' });
  await until(() => claude.get({ sid }).state === 'idle', 20_000);
  await claude.send({ sid, text: 'two' });
  await until(() => claude.get({ sid }).events.filter((e) => e.kind === 'result').length === 2 && claude.get({ sid }).state === 'idle', 20_000);
  assert.deepEqual(claude.get({ sid }).events.filter((e) => e.kind === 'result').map((e) => e.turns), [1, 2]);
});

test('PROMPT.md carries the page title and the recent chat transcript (D14)', async () => {
  const claude = make();
  const chat = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn-${i}` }));
  const { sid } = await claude.start({ prompt: 'mach was', page: { slug: 'demo-page', title: 'Warum Agenten Limits brauchen', t: 42 }, chatContext: chat });
  const md = fs.readFileSync(path.join(tmp, 'sessions', sid, 'PROMPT.md'), 'utf8');
  assert.match(md, /explainer: Warum Agenten Limits brauchen \(demo-page\) at t=42s/);
  assert.match(md, /## Recent chat on the desk page/);
  assert.ok(md.includes('turn-13') && md.includes('turn-2') && !md.includes('turn-1\n') && !md.includes('turn-0'), 'last 12 turns only');
  const str = await claude.start({ prompt: 'x', chatContext: 'user: hallo\nassistant: hi' });
  assert.match(fs.readFileSync(path.join(tmp, 'sessions', str.sid, 'PROMPT.md'), 'utf8'), /user: hallo\nassistant: hi/);
  await until(() => claude.running() === 0, 20_000);
});
