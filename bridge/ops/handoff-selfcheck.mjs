#!/usr/bin/env node
// Daily self-check of the Agent Desk handoff path (a#41d6d2, 14 Nov 2026: the handoff board thread was auto-archived after 7 quiet days and every
// click failed). Runs on Sandy from a systemd user timer (ops/agent-desk-handoff-selfcheck.{service,timer}); no dependencies.
//
//   1. the handoff thread exists, is not archived and is a pinned topic (`topic:desk-handoffs`) -> HEALS it (unarchive + topic)
//   2. agent-desk-bridge.service is active
//   3. the bridge journal (24 h) shows a live connection to the desk and no "board failed"
//
// Prints ONE status line. A problem it cannot heal becomes ONE `finding` entry in board thread 15 addressed to @cos-deputy-opus, as identity
// agent-desk-selfcheck, at most once per 24 h (state file). Healed problems are only logged. `--dry-run` changes and posts nothing.
// Exit code: 0 = ok or healed, 1 = a problem remains, 2 = the check itself broke.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
const HOME = env.HOME || os.homedir();
const CFG = {
  board: env.SELFCHECK_BOARD_BIN || path.join(HOME, 'bin', 'agent-board'),
  journalctl: env.SELFCHECK_JOURNALCTL || 'journalctl',
  systemctl: env.SELFCHECK_SYSTEMCTL || 'systemctl',
  unit: env.SELFCHECK_BRIDGE_UNIT || 'agent-desk-bridge',
  title: env.SELFCHECK_THREAD_TITLE || 'Agent Desk handoffs',
  topic: env.SELFCHECK_TOPIC || 'desk-handoffs',
  findingThread: env.SELFCHECK_FINDING_THREAD || '15', // Ops & security, by id
  addressee: env.SELFCHECK_TO || '@cos-deputy-opus',
  identity: 'agent-desk-selfcheck',
  stateFile: env.SELFCHECK_STATE_FILE || path.join(env.SELFCHECK_STATE_DIR || path.join(HOME, '.cache', 'agent-desk'), 'handoff-selfcheck.json'),
  now: () => (env.SELFCHECK_NOW ? new Date(env.SELFCHECK_NOW) : new Date()),
};
const DAY_MS = 24 * 3600_000;
const RECONNECT_GRACE_MS = 10 * 60_000; // a "disconnected, retry in …" newer than this is a normal reconnect (desk redeploy), not a problem

const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const childEnv = { ...env, AGENT_BOARD_NAME: CFG.identity, ...(uid !== null && !env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: `/run/user/${uid}` } : {}), ...(uid !== null && !env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` } : {}) };
const run = (cmd, args, { timeout = 30_000 } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: childEnv }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '').trim(), error: err?.message ?? null });
  });
});
// Writes name their identity explicitly; the read (`threads`) goes without --as so it also works through LeChonk's agent-board relay (manual dry runs there).
const board = (args, opts) => run(CFG.board, args[0] === 'threads' ? args : ['--as', CFG.identity, ...args], opts);
const oneLine = (s, n = 160) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

/** Thread lines of `agent-board threads --archived`: "#31 Agent Desk handoffs [tags] · 6 entries · … · topic:desk-handoffs · archived". */
export function parseThreadLine(line) {
  const m = /^#(\d{1,6}) (.+?)(?: \[[^\]]*\])?(?: · |$)/.exec(line);
  if (!m) return null;
  const parts = line.split(' · ').map((p) => p.trim());
  return { id: m[1], title: m[2], archived: parts.includes('archived'), topic: parts.find((p) => p.startsWith('topic:'))?.slice(6) ?? null };
}

export function findThread(text, title) {
  const all = String(text).split('\n').map(parseThreadLine).filter(Boolean);
  return all.find((t) => t.title === title) ?? null;
}

// The bridge writes "<ISO>Z bridge <message>" (bridge.js log()); its own timestamp is used, so any journalctl output mode works.
const BRIDGE_LINE = /(\d{4}-\d\d-\d\dT[\d:.]+Z) bridge (.*)$/;
const bridgeLines = (journal) => String(journal).split('\n').flatMap((l) => { const m = BRIDGE_LINE.exec(l); return m ? [{ at: Date.parse(m[1]), text: m[2] }] : []; });

/** The newest connection state in the bridge journal: {ok, connected, at} or null when it never said. */
export function connectionState(journal, nowMs) {
  let last = null;
  for (const { at, text } of bridgeLines(journal)) {
    if (text.startsWith('connected to ')) last = { connected: true, at };
    else if (text.startsWith('disconnected, retry in ')) last = { connected: false, at };
  }
  if (!last) return null;
  return { ...last, ok: last.connected || nowMs - last.at < RECONNECT_GRACE_MS };
}

/** Handoff posts that ended in failure: [{at, text}] (the bridge never writes "board failed" for a healed reopen or a fallback post). */
export function boardFailures(journal) {
  return bridgeLines(journal).filter((l) => /board failed/.test(l.text));
}

function readState() {
  try { return JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); } catch { return {}; /* first run or unreadable: nothing posted yet */ }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(CFG.stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CFG.stateFile, JSON.stringify(state), { mode: 0o600 });
}

export async function selfcheck({ dryRun = false } = {}) {
  const now = CFG.now();
  const healed = []; // problems this run fixed (logged, not posted)
  const problems = []; // what stays broken (posted once per 24 h)
  const facts = [];
  const would = []; // dry run: the commands it would have run

  // ---- 1. the handoff thread ---------------------------------------------------------------------------------------------
  const listing = await board(['threads', '--archived']);
  if (!listing.ok) {
    problems.push(`agent-board threads failed (${oneLine(listing.stderr || listing.error, 120)})`);
  } else {
    let thread = findThread(listing.stdout, CFG.title);
    if (!thread) {
      facts.push('thread not created yet (the first handoff creates it; the next run pins it)');
    } else {
      const heal = async (what, args) => {
        if (dryRun) { would.push(`agent-board ${args.join(' ')}`); return false; }
        const r = await board(args);
        if (!r.ok) { problems.push(`${what} failed: ${oneLine(r.stderr || r.error, 140)}`); return false; }
        return true;
      };
      if (thread.archived && await heal(`unarchive #${thread.id}`, ['unarchive', thread.id])) healed.push(`unarchived #${thread.id}`);
      if (thread.topic !== CFG.topic && (!thread.archived || healed.length || dryRun) && await heal(`topic #${thread.id} ${CFG.topic}`, ['topic', thread.id, CFG.topic])) healed.push(`pinned #${thread.id} as topic ${CFG.topic}`);
      if (healed.length) { // trust, but verify: read it back
        const again = await board(['threads', '--archived']);
        thread = again.ok ? findThread(again.stdout, CFG.title) : thread;
        if (!thread || thread.archived || thread.topic !== CFG.topic) problems.push(`thread #${thread?.id ?? '?'} is still ${thread?.archived ? 'archived' : 'unpinned'} after healing`);
      }
      facts.push(thread ? `thread=#${thread.id} ${thread.archived ? 'ARCHIVED' : 'active'} topic=${thread.topic ?? 'none'}` : 'thread=gone');
    }
  }

  // ---- 2. the bridge service ---------------------------------------------------------------------------------------------
  const active = await run(CFG.systemctl, ['--user', 'is-active', `${CFG.unit}.service`], { timeout: 10_000 });
  const state = active.stdout.trim() || 'unknown';
  facts.push(`bridge=${state}`);
  if (state !== 'active') problems.push(`${CFG.unit}.service is ${state}; the desk cannot reach the board or Sandy`);

  // ---- 3. the bridge journal -------------------------------------------------------------------------------------------
  const journal = await run(CFG.journalctl, ['--user', '-u', `${CFG.unit}.service`, '--since', '7 days ago', '-o', 'cat', '--no-pager'], { timeout: 30_000 });
  if (!journal.ok && !journal.stdout) {
    problems.push(`bridge journal unreadable (${oneLine(journal.stderr || journal.error, 100)})`);
  } else {
    let conn = connectionState(journal.stdout, now.getTime());
    if (!conn) { // critic S6: a connection stable for more than 7 days has no line in the window; the newest connect/disconnect line counts then
      const newest = await run(CFG.journalctl, ['--user', '-u', `${CFG.unit}.service`, '-o', 'cat', '--no-pager', '-r', '-n', '1', '-g', 'bridge (connected to|disconnected, retry in)'], { timeout: 30_000 });
      if (newest.stdout) conn = connectionState(newest.stdout, now.getTime());
    }
    if (!conn) { facts.push('desk=never-seen'); problems.push('the bridge journal of the last 7 days shows no connection to the desk'); }
    else { facts.push(`desk=${conn.connected ? 'connected' : 'reconnecting'} since ${new Date(conn.at).toISOString().slice(0, 16)}Z`); if (!conn.ok) problems.push(`the bridge lost its connection to the desk at ${new Date(conn.at).toISOString().slice(0, 16)}Z and has not come back`); }
    const recent = boardFailures(journal.stdout).filter((l) => Number.isFinite(l.at) && now.getTime() - l.at <= DAY_MS);
    facts.push(`board_failed_24h=${recent.length}`);
    if (recent.length) problems.push(`${recent.length} handoff post(s) failed in the last 24 h; last (${new Date(recent.at(-1).at).toISOString().slice(0, 16)}Z): ${oneLine(recent.at(-1).text, 200)}`);
  }

  // ---- the one status line, the healed log, the one finding --------------------------------------------------------------
  const verdict = problems.length ? 'PROBLEM' : healed.length ? 'HEALED' : would.length ? 'WOULD-HEAL' : 'OK';
  const line = `agent-desk handoff-selfcheck ${verdict}${dryRun ? ' (dry-run)' : ''}: ${facts.join(' ')}${healed.length ? ` | healed: ${healed.join(', ')}` : ''}${would.length ? ` | would run: ${would.join('; ')}` : ''}${problems.length ? ` | problems: ${problems.join('; ')}` : ''}`;
  let posted = null;
  if (problems.length) {
    const st = readState();
    const last = Date.parse(st.lastPostAt ?? '');
    if (Number.isFinite(last) && now.getTime() - last < DAY_MS) posted = `suppressed (a finding went out ${st.lastPostAt})`;
    else if (dryRun) posted = `would post one finding to thread ${CFG.findingThread} for ${CFG.addressee}`;
    else {
      const text = `Agent Desk handoff selfcheck: handoffs from the Desk to the agents are at risk.\n\n${problems.map((p) => `- ${p}`).join('\n')}\n\n${healed.length ? `Healed in this run: ${healed.join(', ')}.\n` : ''}Status: ${facts.join(' ')}\nCheck again: node ~/apps/agent-desk-bridge-sandy/ops/handoff-selfcheck.mjs --dry-run`;
      const r = await board(['post', '--kind', 'finding', '--to', CFG.addressee, CFG.findingThread, text]);
      if (r.ok) { writeState({ lastPostAt: now.toISOString(), lastStatus: verdict }); posted = `finding posted to thread ${CFG.findingThread}`; }
      else posted = `finding NOT posted (${oneLine(r.stderr || r.error, 120)})`;
    }
  }
  return { verdict, line: posted ? `${line} | ${posted}` : line, problems, healed, would, exit: problems.length || would.length ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dryRun = process.argv.includes('--dry-run');
  selfcheck({ dryRun }).then((r) => { console.log(r.line); process.exit(r.exit); }, (err) => { console.log(`agent-desk handoff-selfcheck ERROR: ${oneLine(err?.message ?? err, 300)}`); process.exit(2); });
}
