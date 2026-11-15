// sandbox.exec (Sandy bridge only): a read-only shell for the Agent Desk research agent.
//
// The command runs as `bash -c <command>` inside bubblewrap with NOTHING of the host mounted except /usr (read-only) and the
// scrubbed text corpus of the map (read-only, mounted at /data): no $HOME, no /home, no /var, no /run/user, no sockets, no
// network, its own /proc, /dev, /tmp and /run. The sandbox, not a list of allowed programs, is the boundary (python3, awk,
// find -exec, sed e/w, sqlite3 .shell can all run other programs: design 15 Nov 2026, critic A2/A3). The corpus is the
// index's redacted copy of the allowed trees (scripts/map/export-corpus.mjs on LeChonk, scripts/sandbox/pull-corpus.sh here).
//
// Limits: a systemd scope (MemoryMax 1 GB, TasksMax 64, CPUQuota 100 %; falls back to prlimit when the user manager cannot do
// that), a 20 s wall clock that kills the whole process group, 50,000 bytes of output, one run at a time per bridge (two more
// may wait up to 8 s, everything else is refused) and 120 runs per hour. The caller (bridge.js handleReq) redacts the result
// with Sandy's known secret values like every other result.
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from './redact.js';
import { HOME } from './paths.js';

export const LIMITS = Object.freeze({
  commandMax: 2000,
  wallMs: 20_000,
  outMax: 50_000,
  queueMax: 2, // waiting behind the running command
  queueWaitMs: 8_000, // queue wait + 3 s probe + 20 s run + kill grace stays below the 35 s method budget
  perHour: 120,
  memoryMax: '1G',
  tasksMax: 64,
  cpuQuota: '100%',
  fsizeBytes: 64 * 1024 * 1024, // largest file a command may write into its tmpfs /tmp
});
const KILL_GRACE_MS = 400; // after the process exited: wait this long for the pipes to close, then stop reading
const PROBE_TTL_MS = 10 * 60_000;
const PROBE_FAIL_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;
const CUT_MARKER = (n) => `\n[output cut at ${n} bytes; the command was stopped]`;

const env = (name) => process.env[`BRIDGE_SANDBOX_${name}`];

export const corpusPath = () => process.env.BRIDGE_CORPUS_DIR || path.join(HOME, '.local', 'share', 'desk-corpus');

function findBin(candidates) {
  for (const p of candidates) { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ } }
  return null;
}
const bwrapBin = () => (env('BWRAP') ? (fs.existsSync(env('BWRAP')) ? env('BWRAP') : null) : findBin(['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap']));

/** The real, non-empty corpus directory (a symlink to the current generation is resolved here, so a swap mid-run cannot matter), or null. */
function resolveCorpus() {
  try {
    const real = fs.realpathSync(corpusPath());
    if (!fs.statSync(real).isDirectory() || fs.readdirSync(real).length === 0) return null;
    return real;
  } catch { return null; }
}

/** The bubblewrap arguments up to and including `--`; exported so a test can pin the exact line. */
export function bwrapArgs(corpus) {
  return [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'HOME', '/tmp',
    '--ro-bind', '/usr', '/usr',
    '--tmpfs', '/usr/local', // site-specific wrappers and packages: not needed, not shown
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--ro-bind', '/etc/alternatives', '/etc/alternatives', // awk, editor ... are symlinks through here; it holds symlinks only
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
    '--ro-bind', corpus, '/data', '--chdir', '/data',
    '--',
  ];
}

// ---- limits: systemd scope when it works, else prlimit ------------------------------------------------------------------
function hostEnv() {
  // Only what systemd-run needs. The bridge's own environment (BRIDGE_TOKEN ...) never reaches these processes.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const runtime = process.env.XDG_RUNTIME_DIR || (fs.existsSync(`/run/user/${uid}/bus`) ? `/run/user/${uid}` : '');
  const e = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: os.homedir() };
  if (runtime) e.XDG_RUNTIME_DIR = runtime;
  if (process.env.DBUS_SESSION_BUS_ADDRESS) e.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  return e;
}

const scopeProps = () => ['-p', `MemoryMax=${LIMITS.memoryMax}`, '-p', 'MemorySwapMax=0', '-p', `TasksMax=${LIMITS.tasksMax}`, '-p', `CPUQuota=${LIMITS.cpuQuota}`];
const fsizeArgs = ['--core=0', `--fsize=${LIMITS.fsizeBytes}`];

let probeCache = null; // {mode, until}
/** 'scope' when a transient scope with our limits really applies them (read back from the cgroup files), else 'prlimit'. */
export async function limitsMode() {
  const forced = env('LIMITS');
  if (forced === 'scope' || forced === 'prlimit') return forced;
  if (probeCache && probeCache.until > Date.now()) return probeCache.mode;
  const mode = await new Promise((resolve) => {
    const readBack = 'cd "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)" 2>/dev/null && cat pids.max memory.max';
    execFile('/usr/bin/systemd-run', ['--user', '--scope', '--quiet', '--collect', ...scopeProps(), '--', '/usr/bin/bash', '-c', readBack],
      { env: hostEnv(), timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
        const [pids, mem] = String(stdout || '').trim().split('\n');
        resolve(!err && pids === String(LIMITS.tasksMax) && mem === String(1024 ** 3) ? 'scope' : 'prlimit');
      });
  });
  probeCache = { mode, until: Date.now() + (mode === 'scope' ? PROBE_TTL_MS : PROBE_FAIL_TTL_MS) };
  return mode;
}

let unitSeq = 0;
function buildArgv(mode, bwrap, corpus, command) {
  const unit = `desk-sandbox-${process.pid}-${(unitSeq += 1)}-${crypto.randomBytes(3).toString('hex')}`;
  if (mode === 'scope') {
    return {
      unit,
      argv: ['/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, ...scopeProps(), '--',
        '/usr/bin/prlimit', ...fsizeArgs, '--', bwrap, ...bwrapArgs(corpus), 'bash', '-c', command],
    };
  }
  // No scope: address space and CPU seconds outside (cheap), the process cap INSIDE the namespace: set outside, it would count
  // every process of the bridge's user on the host (hundreds) and bwrap could not even fork.
  return {
    unit: null,
    argv: ['/usr/bin/prlimit', '--as=1073741824', '--cpu=20', ...fsizeArgs, '--', bwrap, ...bwrapArgs(corpus),
      'prlimit', `--nproc=${LIMITS.tasksMax}`, '--', 'bash', '-c', command],
  };
}

// ---- one run -----------------------------------------------------------------------------------------------------------------
const SYSTEMD_RUN_FAILED = /^(Failed to (start|connect|create|allocate|call|set|open)|Couldn't|Unknown assignment|Access denied)/;

function runOnce({ mode, bwrap, corpus, command, wallMs, outMax }) {
  return new Promise((resolve, reject) => {
    const { unit, argv } = buildArgv(mode, bwrap, corpus, command);
    const t0 = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env: hostEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { reject(new Error(`sandbox could not start: ${err.message}`)); return; }
    const chunks = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let done = false;
    let graceTimer = null;

    const killAll = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      if (unit) execFile('/usr/bin/systemctl', ['--user', 'kill', '--signal=SIGKILL', `${unit}.scope`], { env: hostEnv(), timeout: 3000 }, () => {});
    };
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(wall);
      clearTimeout(graceTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      let text = Buffer.concat(chunks).toString('utf8');
      if (truncated) text = text.replace(/�+$/u, '') + CUT_MARKER(outMax); // a multi-byte character cut in half
      const exitCode = timedOut ? 124 : code !== null && code !== undefined ? code : 128 + (os.constants.signals[signal] || 9);
      resolve({ exitCode, timedOut, truncated, ms: Date.now() - t0, output: text });
    };
    const onData = (buf) => {
      if (truncated || done) return;
      const room = outMax - size;
      if (buf.length > room) {
        chunks.push(buf.subarray(0, room));
        size = outMax;
        truncated = true;
        killAll(); // nothing more can be returned: stop the command instead of letting `yes` run
      } else { chunks.push(buf); size += buf.length; }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { if (!done) { done = true; clearTimeout(wall); reject(new Error(`sandbox could not start: ${err.message}`)); } });
    child.on('exit', (code, signal) => { graceTimer = setTimeout(() => finish(code, signal), KILL_GRACE_MS); });
    child.on('close', (code, signal) => finish(code, signal));
    const wall = setTimeout(() => { timedOut = true; killAll(); }, wallMs);
  });
}

// ---- the method -------------------------------------------------------------------------------------------------------------
function validate(params) {
  const command = params?.command;
  if (typeof command !== 'string') throw new Error('command must be a string');
  if (command.includes('\0')) throw new Error('command must not contain NUL characters');
  if (command.trim().length === 0) throw new Error('command is empty');
  if (command.length > LIMITS.commandMax) throw new Error(`command too long (${command.length} characters; at most ${LIMITS.commandMax})`);
  return command;
}

/** A sandbox with its own queue and hourly counter (the bridge uses the default one below; tests build their own). */
export function createSandbox({ log = (msg) => console.log(`${new Date().toISOString()} bridge ${redact(String(msg))}`) } = {}) {
  let active = false;
  const waiting = [];
  const starts = []; // epoch ms of the runs started in the last hour

  const cfg = () => ({
    wallMs: Math.min(LIMITS.wallMs, Number(env('WALL_MS')) || LIMITS.wallMs), // the environment can only shorten the clock
    queueWaitMs: Math.min(LIMITS.queueWaitMs, Number(env('QUEUE_WAIT_MS')) || LIMITS.queueWaitMs),
    perHour: Math.min(LIMITS.perHour, Number(env('PER_HOUR')) || LIMITS.perHour),
  });
  const hourlyCount = () => {
    const cutoff = Date.now() - 3_600_000;
    while (starts.length && starts[0] < cutoff) starts.shift();
    return starts.length;
  };
  const refuseIfRateLimited = (perHour) => {
    if (hourlyCount() >= perHour) {
      const mins = Math.max(1, Math.ceil((starts[0] + 3_600_000 - Date.now()) / 60_000));
      throw new Error(`sandbox rate limit: ${perHour} runs per hour reached; try again in about ${mins} min`);
    }
  };
  const acquire = (waitMs) => {
    if (!active) { active = true; return Promise.resolve(); }
    if (waiting.length >= LIMITS.queueMax) return Promise.reject(new Error(`sandbox busy: 1 command running and ${waiting.length} waiting; try again in a few seconds`));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = waiting.indexOf(w);
        if (i >= 0) waiting.splice(i, 1);
        reject(new Error(`sandbox busy: waited ${Math.round(waitMs / 1000)} s for the running command; try again`));
      }, waitMs);
      waiting.push(w);
    });
  };
  const release = () => {
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); } else active = false;
  };

  async function exec(params = {}) {
    const command = validate(params);
    const bwrap = bwrapBin();
    if (!bwrap) throw new Error('sandbox unavailable: bubblewrap (bwrap) is not installed on this host');
    if (!resolveCorpus()) throw new Error('sandbox unavailable: the corpus copy is missing or empty (the hourly corpus pull has not run yet)');
    const c = cfg();
    refuseIfRateLimited(c.perHour);
    await acquire(c.queueWaitMs);
    try {
      refuseIfRateLimited(c.perHour);
      const corpus = resolveCorpus(); // again: the pull may have swapped generations while this run waited
      if (!corpus) throw new Error('sandbox unavailable: the corpus copy is missing or empty (the hourly corpus pull has not run yet)');
      starts.push(Date.now());
      let mode = await limitsMode();
      const args = { bwrap, corpus, command, wallMs: c.wallMs, outMax: LIMITS.outMax };
      let result = await runOnce({ ...args, mode });
      // `systemd-run` itself failed (no user bus, no cgroup delegation any more): that is not the command's exit code. Run it again with prlimit.
      if (mode === 'scope' && result.exitCode === 1 && result.ms < 1500 && !result.timedOut && SYSTEMD_RUN_FAILED.test(result.output)) {
        probeCache = { mode: 'prlimit', until: Date.now() + PROBE_FAIL_TTL_MS };
        mode = 'prlimit';
        result = await runOnce({ ...args, mode });
      }
      log(`sandbox.exec limits=${mode} exit=${result.exitCode} ms=${result.ms}${result.timedOut ? ' timeout' : ''}${result.truncated ? ' truncated' : ''} cmd=${JSON.stringify(command.slice(0, 160))}`);
      return result;
    } finally { release(); }
  }

  return { exec, status: () => ({ active, waiting: waiting.length, runsLastHour: hourlyCount() }) };
}

const defaultSandbox = createSandbox();
export const exec = (params) => defaultSandbox.exec(params);
export const status = () => defaultSandbox.status();
