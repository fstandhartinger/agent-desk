import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// a#41d6d2 (14 Nov 2026): board.handoff must survive an archived handoff thread, fall back to an active thread, and say
// "not-posted:" whenever agent-board refused before it wrote anything. agent-board is a stub script that logs its argv.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-handoff-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true })); // the fixtures are temporary
const board = await import('../src/board.js');

const ARCHIVED = "agent-board: Thread #31 is archived; post to an active thread instead.";

/** One fresh stub + BRIDGE_HOME per test. Behaviour switches are files in `dir`: archived, stuck, unarchive-refused, fallback-refused, crash. */
function setup(name, switches = []) {
  const dir = fs.mkdtempSync(path.join(root, `${name}-`));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  for (const s of switches) fs.writeFileSync(path.join(dir, s), '1');
  const log = path.join(dir, 'board.log');
  const bin = path.join(dir, 'agent-board');
  fs.writeFileSync(bin, `#!/bin/bash
D="${dir}"
printf '%s\\n' "$(node -e 'console.log(JSON.stringify({args: process.argv.slice(1), name: process.env.AGENT_BOARD_NAME}))' -- "$@")" >> "${log}"
sub="$3"
case "$sub" in
  post)
    thread="$8"
    if [ -f "$D/crash" ]; then echo "Traceback (most recent call last):" >&2; echo "sqlite3.OperationalError: database is locked" >&2; exit 1; fi
    if [ "$thread" = "15" ]; then
      if [ -f "$D/fallback-refused" ]; then echo "agent-board: Thread #15 is archived; post to an active thread instead." >&2; exit 2; fi
      echo "Posted entry #5151 to thread #15 Ops & security."; exit 0
    fi
    if [ -f "$D/archived" ]; then echo "${ARCHIVED}" >&2; exit 2; fi
    echo "Posted entry #4242 to thread #31 Agent Desk handoffs."
    ;;
  unarchive)
    if [ -f "$D/unarchive-refused" ]; then echo "agent-board: unarchive is not allowed for agent-desk." >&2; exit 2; fi
    [ -f "$D/stuck" ] || rm -f "$D/archived"
    echo "Thread #31 unarchived."
    ;;
  *) echo "agent-board: unexpected $sub" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
  process.env.BRIDGE_HOME = home;
  process.env.BRIDGE_BOARD_BIN = bin;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const used = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.cache', 'agent-desk', 'handoff-count.json'), 'utf8')).n; } catch { return 0; } };
  return { calls, used, dir };
}
const subs = (calls) => calls().map((c) => c.args[2]);
const job = { title: 'Regeln ändern', task: 'Bitte Regel 2 anpassen.', why: 'Florian hat es entschieden' };

test('archived handoff thread: unarchive by the id from the refusal, retry once, success', async () => {
  const s = setup('reopen', ['archived']);
  const r = await board.handoff(job);
  assert.deepEqual(r, { id: 4242, thread: 'Agent Desk handoffs', reopened: true });
  assert.deepEqual(subs(s.calls), ['post', 'unarchive', 'post']);
  const [, unarchive] = s.calls();
  assert.deepEqual(unarchive.args, ['--as', 'agent-desk', 'unarchive', '31']);
  assert.equal(unarchive.name, 'agent-desk');
  assert.equal(s.used(), 1, 'one daily slot, committed after the post');
});

test('unarchive refused: fallback post into thread 15 with a first line that says why', async () => {
  const s = setup('fallback', ['archived', 'unarchive-refused']);
  const r = await board.handoff(job);
  assert.equal(r.fallback, true);
  assert.equal(r.id, 5151);
  assert.equal(r.threadId, 15);
  assert.equal(r.thread, 'Ops & security');
  assert.equal(r.intendedThread, 'Agent Desk handoffs');
  assert.equal(r.intendedThreadId, 31);
  assert.deepEqual(subs(s.calls), ['post', 'unarchive', 'post']);
  const last = s.calls().at(-1).args;
  assert.deepEqual(last.slice(0, 7), ['--as', 'agent-desk', 'post', '--kind', 'handoff', '--to', '@cos-deputy-opus']);
  assert.equal(last[7], '15', 'the fallback thread is addressed by id, not by a fuzzy title');
  const first = last[8].split('\n')[0];
  assert.match(first, /^Fallback: das Thema „Agent Desk handoffs“ \(#31\) war archiviert/);
  assert.match(last[8], /Auftrag von Florian \(Agent Desk, bestätigt\)/);
  assert.match(last[8], /Warum: Florian hat es entschieden$/);
  assert.equal(s.used(), 1);
});

test('still archived after the unarchive (retry refused again): fallback as well, no second unarchive', async () => {
  const s = setup('stuck', ['archived', 'stuck']);
  const r = await board.handoff(job);
  assert.equal(r.fallback, true);
  assert.deepEqual(subs(s.calls), ['post', 'unarchive', 'post', 'post']);
  assert.equal(s.used(), 1);
});

test('both threads refuse: error starts with not-posted:, names both reasons, no daily slot is used', async () => {
  const s = setup('both', ['archived', 'stuck', 'fallback-refused']);
  await assert.rejects(board.handoff(job), (err) => {
    assert.match(err.message, /^not-posted: /);
    assert.match(err.message, /archived/);
    assert.match(err.message, /Ausweichthema 15 ebenfalls abgelehnt/);
    return true;
  });
  assert.equal(s.used(), 0);
});

test('an unclear failure (crash, exit 1) is NOT marked not-posted and triggers neither unarchive nor fallback', async () => {
  const s = setup('crash', ['crash']);
  await assert.rejects(board.handoff(job), (err) => {
    assert.ok(!err.message.startsWith('not-posted:'), err.message);
    assert.match(err.message, /^board failed:/);
    return true;
  });
  assert.deepEqual(subs(s.calls), ['post'], 'a second post could duplicate the entry');
  assert.equal(s.used(), 0);
});

test('validation and the daily limit are refused with the not-posted: prefix (before any board call)', async () => {
  const s = setup('validation');
  for (const [args, re] of [[{ title: '', task: 'y' }, /title required/], [{ title: 'x', task: '' }, /task required/], [{ title: 'x', task: 'y', why: 'w'.repeat(1001) }, /why too long/]]) {
    await assert.rejects(board.handoff(args), (err) => err.message.startsWith('not-posted: ') && re.test(err.message) && err.notPosted === true);
  }
  assert.equal(s.calls().length, 0);
  fs.mkdirSync(path.join(process.env.BRIDGE_HOME, '.cache', 'agent-desk'), { recursive: true });
  fs.writeFileSync(path.join(process.env.BRIDGE_HOME, '.cache', 'agent-desk', 'handoff-count.json'), JSON.stringify({ day: new Date().toISOString().slice(0, 10), n: 10 }));
  await assert.rejects(board.handoff(job), /^Error: not-posted: handoff limit reached \(10 per day\)/);
  assert.equal(s.calls().length, 0);
});

test('refusedBeforeWrite: refusals yes; timeouts, signals, crashes and unknown failures no', () => {
  const r = board.refusedBeforeWrite;
  assert.equal(r({ code: 2 }, ARCHIVED), true);
  assert.equal(r({ code: 2 }, "agent-board: No thread matches 'Agent Desk handoffs'."), true);
  assert.equal(r({ code: 1 }, 'agent-board: Thread #31 is archived; post to an active thread instead.'), true, 'the archived text alone proves it');
  assert.equal(r({ code: 'ENOENT' }, ''), true, 'binary missing: it never ran');
  assert.equal(r({ code: 2 }, 'usage: agent-board post ...'), false, 'exit 2 without the agent-board: marker is not assumed');
  assert.equal(r({ code: 1 }, 'Traceback (most recent call last):\n  File x\nValueError: thread not found'), false);
  assert.equal(r({ code: null, killed: true, signal: 'SIGTERM' }, ''), false, 'our timeout: the post may have gone through');
  assert.equal(r({ code: 143, signal: 'SIGTERM' }, ARCHIVED), false);
  assert.equal(r({ code: 3 }, ''), false);
});

test('the normal path stays as before: one post, result without extras', async () => {
  const s = setup('plain');
  const r = await board.handoff(job);
  assert.deepEqual(r, { id: 4242, thread: 'Agent Desk handoffs' });
  assert.deepEqual(subs(s.calls), ['post']);
  assert.equal(s.used(), 1);
});
