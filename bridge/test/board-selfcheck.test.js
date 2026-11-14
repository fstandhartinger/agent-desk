import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { boardFailures, connectionState, findThread, parseThreadLine } from '../ops/handoff-selfcheck.mjs';

// a#41d6d2 (14 Nov 2026): the daily handoff selfcheck, run as the real script against fake agent-board / systemctl / journalctl binaries.
const exec = promisify(execFile);
const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'ops', 'handoff-selfcheck.mjs');
const NOW = '2026-11-14T13:00:00Z';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true })); // the fixtures are temporary

const LINES = {
  active: '#31 Agent Desk handoffs [untagged] · 6 entries · 2026-11-03T01:25:10Z · latest #41693 note by codex:cos-deputy-opus · topic:desk-handoffs',
  archivedUnpinned: '#31 Agent Desk handoffs [untagged] · 6 entries · 2026-11-03T01:25:10Z · latest #41693 note by codex:cos-deputy-opus · archived',
  unpinned: '#31 Agent Desk handoffs [untagged] · 6 entries · 2026-11-03T01:25:10Z · latest #41693 note by codex:cos-deputy-opus',
  other: '#15 Ops & security [ops, security] · 5888 entries · 2026-11-14T13:15:23Z · latest #60891 note by claude:x · topic:telegram-reply-pickup',
  oldArchived: '#19 Revamp + SEO: PDFMint / DocMint / MailMint [mint, seo] · 54 entries · 2026-10-16T08:18:22Z · latest #19844 note by hermes · archived',
};
const CONNECTED = '2026-11-12T08:00:00.000Z bridge connected to https://desk.test (12 secret values, 3 window hashes guarded)';

/** A sandbox: fake binaries + files. `opts`: thread line(s), journal text, bridge state, refusals. */
function sandbox(name, { thread = LINES.active, journal = CONNECTED, active = 'active', refuse = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(root, `${name}-`));
  const w = (f, text, mode) => fs.writeFileSync(path.join(dir, f), text, mode ? { mode } : undefined);
  w('threads.txt', [LINES.other, thread, LINES.oldArchived].filter(Boolean).join('\n') + '\n');
  w('journal.txt', `${journal}\n`);
  w('active.txt', active);
  for (const r of refuse) w(`refuse-${r}`, '1');
  w('agent-board', `#!/bin/bash
D="${dir}"
a="$*"; printf '%s\\n' "\${a//\$'\\n'/ | }" >> "$D/board.log"
if [ "$1" = "--as" ]; then shift 2; fi
case "$1" in
  threads) cat "$D/threads.txt" ;;
  unarchive) [ -f "$D/refuse-unarchive" ] && { echo "agent-board: unarchive is not allowed" >&2; exit 2; }; sed -i "/^#$2 /s/ · archived\\$//" "$D/threads.txt" ;;
  topic) [ -f "$D/refuse-topic" ] && { echo "agent-board: topic is not allowed" >&2; exit 2; }; sed -i "/^#$2 /{/ · topic:/!s/\\$/ · topic:$3/}" "$D/threads.txt" ;;
  post) [ -f "$D/refuse-post" ] && { echo "agent-board: post refused" >&2; exit 2; }; echo "Posted entry #9001 to thread #15 Ops & security." ;;
  *) echo "agent-board: unexpected $1" >&2; exit 2 ;;
esac
`, 0o755);
  w('systemctl', `#!/bin/bash\ns=$(cat "${dir}/active.txt"); echo "$s"; [ "$s" = active ]\n`, 0o755);
  w('journalctl', `#!/bin/bash\ncat "${dir}/journal.txt"\n`, 0o755);
  const env = (extra = {}) => ({
    PATH: process.env.PATH, HOME: dir,
    SELFCHECK_BOARD_BIN: path.join(dir, 'agent-board'), SELFCHECK_SYSTEMCTL: path.join(dir, 'systemctl'), SELFCHECK_JOURNALCTL: path.join(dir, 'journalctl'),
    SELFCHECK_STATE_DIR: path.join(dir, 'state'), SELFCHECK_NOW: NOW, ...extra,
  });
  const run = async (args = [], extra = {}) => {
    try { const r = await exec('node', [script, ...args], { env: env(extra) }); return { code: 0, out: r.stdout.trim() }; }
    catch (e) { return { code: e.code, out: String(e.stdout ?? '').trim() }; }
  };
  const log = () => (fs.existsSync(path.join(dir, 'board.log')) ? fs.readFileSync(path.join(dir, 'board.log'), 'utf8').trim().split('\n') : []);
  const mutations = () => log().filter((l) => /^--as agent-desk-selfcheck (unarchive|topic|post) /.test(l));
  const reads = () => log().filter((l) => /^threads( |$)/.test(l));
  const posts = () => log().filter((l) => / post /.test(` ${l} `));
  return { run, log, mutations, reads, posts, dir, file: (f) => path.join(dir, f), threads: () => fs.readFileSync(path.join(dir, 'threads.txt'), 'utf8') };
}

test('parsing: the thread line of `agent-board threads --archived` (archived flag, pinned topic, title)', () => {
  assert.deepEqual(parseThreadLine(LINES.active), { id: '31', title: 'Agent Desk handoffs', archived: false, topic: 'desk-handoffs' });
  assert.deepEqual(parseThreadLine(LINES.archivedUnpinned), { id: '31', title: 'Agent Desk handoffs', archived: true, topic: null });
  assert.deepEqual(parseThreadLine(LINES.oldArchived), { id: '19', title: 'Revamp + SEO: PDFMint / DocMint / MailMint', archived: true, topic: null });
  assert.equal(parseThreadLine('not a thread line'), null);
  assert.equal(findThread([LINES.other, LINES.active].join('\n'), 'Agent Desk handoffs').id, '31');
  assert.equal(findThread(LINES.other, 'Agent Desk handoffs'), null);
});

test('journal parsing: newest connection state, reconnect grace, only "board failed" counts as a failure', () => {
  const now = Date.parse(NOW);
  const j = (...lines) => lines.join('\n');
  assert.equal(connectionState(j(CONNECTED), now).ok, true);
  assert.equal(connectionState(j(CONNECTED, '2026-11-12T09:00:00.000Z bridge disconnected, retry in 900 ms'), now).ok, false, 'dropped two days ago, never came back');
  assert.equal(connectionState(j(CONNECTED, '2026-11-14T12:58:30.000Z bridge disconnected, retry in 900 ms'), now).ok, true, 'a reconnect in progress');
  assert.equal(connectionState('nothing relevant', now), null);
  const f = boardFailures(j(
    '2026-11-14T10:00:00.000Z bridge handoff: FALLBACK post into thread 15 (entry #5151); the handoff thread #31 was archived',
    '2026-11-14T10:05:00.000Z bridge handoff: thread #31 was archived, reopened it and posted',
    '2026-11-14T11:00:00.000Z bridge handoff failed (nothing posted): not-posted: board failed: agent-board: Thread #31 is archived',
  ));
  assert.equal(f.length, 1, 'a fallback or healed reopen is no failure');
  assert.equal(Date.parse('2026-11-14T11:00:00.000Z'), f[0].at);
});

test('healthy: one OK line, exit 0, no board writes', async () => {
  const s = sandbox('ok');
  const r = await s.run();
  assert.equal(r.code, 0);
  assert.match(r.out, /^agent-desk handoff-selfcheck OK: thread=#31 active topic=desk-handoffs bridge=active desk=connected since 2026-11-12T08:00Z board_failed_24h=0$/);
  assert.deepEqual(s.mutations(), []);
  assert.deepEqual(s.reads(), ['threads --archived'], 'the read has no --as (works through the LeChonk relay too)');
  assert.ok(!fs.existsSync(s.file('state/handoff-selfcheck.json')));
});

test('archived and unpinned: healed (unarchive + topic as agent-desk-selfcheck), logged not posted, exit 0', async () => {
  const s = sandbox('heal', { thread: LINES.archivedUnpinned });
  const r = await s.run();
  assert.equal(r.code, 0);
  assert.match(r.out, /HEALED: thread=#31 active topic=desk-handoffs .*\| healed: unarchived #31, pinned #31 as topic desk-handoffs$/);
  assert.deepEqual(s.mutations(), ['--as agent-desk-selfcheck unarchive 31', '--as agent-desk-selfcheck topic 31 desk-handoffs']);
  assert.match(s.threads(), /#31 Agent Desk handoffs .*· topic:desk-handoffs$/m);
  assert.doesNotMatch(s.threads().split('\n').find((l) => l.startsWith('#31')), /archived/);
  assert.deepEqual(s.posts(), [], 'healed problems are not posted');
});

test('active but not pinned: only the topic is set', async () => {
  const s = sandbox('pin', { thread: LINES.unpinned });
  const r = await s.run();
  assert.equal(r.code, 0);
  assert.deepEqual(s.mutations(), ['--as agent-desk-selfcheck topic 31 desk-handoffs']);
  assert.match(r.out, /HEALED/);
});

test('--dry-run changes and posts nothing, names what it would do, exits 1 while something is wrong', async () => {
  const s = sandbox('dry', { thread: LINES.archivedUnpinned, active: 'inactive' });
  const r = await s.run(['--dry-run']);
  assert.equal(r.code, 1);
  assert.match(r.out, /PROBLEM \(dry-run\)/);
  assert.match(r.out, /would run: agent-board unarchive 31; agent-board topic 31 desk-handoffs/);
  assert.match(r.out, /would post one finding to thread 15 for @cos-deputy-opus/);
  assert.deepEqual(s.mutations(), []);
  assert.ok(!fs.existsSync(s.file('state/handoff-selfcheck.json')), 'a dry run never writes the state file');
  const clean = await sandbox('dry-ok').run(['--dry-run']);
  assert.equal(clean.code, 0);
  assert.match(clean.out, /OK \(dry-run\)/);
});

test('a problem it cannot heal: ONE finding to thread 15 for @cos-deputy-opus as agent-desk-selfcheck, then at most once per 24 h', async () => {
  const s = sandbox('post', { active: 'failed' });
  const r1 = await s.run();
  assert.equal(r1.code, 1);
  assert.match(r1.out, /PROBLEM: .*bridge=failed .*problems: agent-desk-bridge\.service is failed.*\| finding posted to thread 15$/);
  assert.equal(s.posts().length, 1);
  const post = s.posts()[0];
  assert.match(post, /^--as agent-desk-selfcheck post --kind finding --to @cos-deputy-opus 15 Agent Desk handoff selfcheck:/);
  assert.match(post, /agent-desk-bridge\.service is failed/);
  assert.equal(JSON.parse(fs.readFileSync(s.file('state/handoff-selfcheck.json'), 'utf8')).lastPostAt, '2026-11-14T13:00:00.000Z');
  const r2 = await s.run([], { SELFCHECK_NOW: '2026-11-15T06:30:00Z' }); // 17.5 h later
  assert.equal(r2.code, 1);
  assert.match(r2.out, /suppressed \(a finding went out 2026-11-14T13:00:00\.000Z\)$/);
  assert.equal(s.posts().length, 1, 'no second finding inside 24 h');
  const r3 = await s.run([], { SELFCHECK_NOW: '2026-11-15T13:00:01Z' });
  assert.match(r3.out, /finding posted/);
  assert.equal(s.posts().length, 2, 'after 24 h the next finding may go out');
});

test('unarchive refused: the problem is reported, and a failed post is NOT recorded as sent', async () => {
  const s = sandbox('refused', { thread: LINES.archivedUnpinned, refuse: ['unarchive', 'post'] });
  const r = await s.run();
  assert.equal(r.code, 1);
  assert.match(r.out, /problems: unarchive #31 failed: agent-board: unarchive is not allowed/);
  assert.match(r.out, /finding NOT posted \(agent-board: post refused\)$/);
  assert.ok(!fs.existsSync(s.file('state/handoff-selfcheck.json')), 'the next run tries again');
  assert.deepEqual(s.mutations().filter((m) => / topic /.test(m)), [], 'no pinning of a thread that is still archived');
});

test('journal: a "board failed" in the last 24 h is a problem, an older one is not; a lost desk connection is a problem, a fresh reconnect is not', async () => {
  const failed = '2026-11-14T11:00:00.000Z bridge handoff failed (nothing posted): not-posted: board failed: agent-board: Thread #31 is archived; post to an active thread instead.';
  const a = await sandbox('f24', { journal: `${CONNECTED}\n${failed}` }).run();
  assert.equal(a.code, 1);
  assert.match(a.out, /board_failed_24h=1.*problems: 1 handoff post\(s\) failed in the last 24 h; last \(2026-11-14T11:00Z\): handoff failed \(nothing posted\)/);
  const old = await sandbox('f48', { journal: `${CONNECTED}\n${failed.replace('2026-11-14T11', '2026-11-12T11')}` }).run();
  assert.equal(old.code, 0);
  assert.match(old.out, /board_failed_24h=0/);
  const lost = await sandbox('lost', { journal: `${CONNECTED}\n2026-11-14T09:00:00.000Z bridge disconnected, retry in 900 ms` }).run();
  assert.equal(lost.code, 1);
  assert.match(lost.out, /lost its connection to the desk at 2026-11-14T09:00Z/);
  const redeploy = await sandbox('redeploy', { journal: `${CONNECTED}\n2026-11-14T12:58:00.000Z bridge disconnected, retry in 900 ms` }).run();
  assert.equal(redeploy.code, 0);
  assert.match(redeploy.out, /desk=reconnecting/);
  const never = await sandbox('never', { journal: '-- No entries --' }).run();
  assert.equal(never.code, 1);
  assert.match(never.out, /no connection to the desk/);
});

test('thread missing (not created yet) is not a failure; the line says so', async () => {
  const s = sandbox('missing', { thread: '' });
  const r = await s.run();
  assert.equal(r.code, 0);
  assert.match(r.out, /OK: thread not created yet/);
  assert.deepEqual(s.mutations(), []);
});

test('the check itself broke (no board binary): a PROBLEM line, never a crash without a line', async () => {
  const s = sandbox('nobin');
  const r = await s.run([], { SELFCHECK_BOARD_BIN: path.join(s.dir, 'does-not-exist') });
  assert.equal(r.code, 1);
  assert.match(r.out, /PROBLEM: .*problems: agent-board threads failed/);
});
