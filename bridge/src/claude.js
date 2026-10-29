import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { Normalizer } from './events.js';
import { buildPrompt, firstTurnPrompt } from './prompt.js';
import { redact } from './redact.js';

export const MAX_RUNNING = 3;
const TURN_TIMEOUT_MS = 2 * 3600 * 1000;
const POLL_MS = 150;
const SID_RE = /^d\d{8}-[0-9a-f]{6}$/;
const MODELS = new Set(['opus', 'sonnet']);
const EFFORTS = new Set(['low', 'medium', 'high']);
const ACCOUNT_DIRS = { A: '.claude-A', C: '.claude-C' }; // B is ~/.claude: CLAUDE_CONFIG_DIR stays unset
const DROP_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'BRIDGE_TOKEN', 'DESK_URL', 'BRIDGE_HOST', 'CLAUDE_CONFIG_DIR'];

const sessionsDir = () => process.env.DESK_SESSIONS_DIR || path.join(os.homedir(), 'desk-sessions');
const claudeBin = () => process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');

// `claude auth status` per account, cached 30 min: a logged-out account (e.g. C after an expired OAuth refresh) is skipped.
const authCache = new Map();
function loggedIn(account) {
  const hit = authCache.get(account);
  if (hit && Date.now() - hit.at < 30 * 60_000) return Promise.resolve(hit.ok);
  const env = { ...process.env };
  for (const k of DROP_ENV) delete env[k];
  if (ACCOUNT_DIRS[account]) env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ACCOUNT_DIRS[account]);
  return new Promise((resolve) => {
    execFile(claudeBin(), ['auth', 'status'], { timeout: 15000, env }, (err, stdout) => {
      let ok = false;
      try { ok = JSON.parse(String(stdout)).loggedIn === true; } catch { ok = false; }
      authCache.set(account, { ok, at: Date.now() });
      resolve(ok);
    });
  });
}

function quotaPick() {
  return new Promise((resolve) => {
    execFile(path.join(os.homedir(), 'bin', 'quota-pace'), ['account', '--kind', 'work'], { timeout: 15000, env: { ...process.env, QUOTA_PACE_CALLER: 'agent-desk' } }, (err, stdout) => {
      const letter = String(stdout ?? '').trim().toUpperCase();
      resolve(!err && /^[ABC]$/.test(letter) ? letter : 'B');
    });
  });
}

/** quota-pace's choice if that account is logged in, else the first logged-in of A, B, C (else the choice anyway). */
export async function pickAccount({ pick = quotaPick, isLoggedIn = loggedIn } = {}) {
  const forced = String(process.env.BRIDGE_CLAUDE_ACCOUNT ?? '').toUpperCase(); // tests / debugging only
  if (/^[ABC]$/.test(forced)) return forced;
  const first = await pick();
  if (await isLoggedIn(first)) return first;
  for (const alt of ['A', 'B', 'C']) if (alt !== first && await isLoggedIn(alt)) return alt;
  return first;
}

function childEnv(sid, dir, account) {
  const env = { ...process.env };
  for (const k of DROP_ENV) delete env[k];
  if (ACCOUNT_DIRS[account]) env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ACCOUNT_DIRS[account]);
  env.AGENT_BOARD_NAME = `claude:desk-${sid}`;
  env.AGENT_BOARD_JOBDIR = dir;
  return env;
}

/** Only ever signal a pid that is still a claude process (guards against pid reuse after a reboot/restart). */
function isClaudePid(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('claude');
  } catch { return false; }
}

function signalGroup(pid, signal) {
  if (!isClaudePid(pid)) return;
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function lastSeqOf(file) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, 16384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]).seq; } catch { /* partial first line */ }
    }
  } catch { /* no events yet */ }
  return 0;
}

/**
 * Claude Code sessions for the desk. Each turn is one `claude -p` process in its own process group writing
 * stream-json to a file; the bridge tails that file, so a session keeps running (and is re-attached) when the
 * bridge restarts. `emit(topic, data)` pushes live events to the gateway.
 */
export function createClaude({ emit }) {
  const sessions = new Map();
  let poller = null;

  const activeCount = () => [...sessions.values()].filter((s) => s.turn).length;

  function summary(s) {
    const { sid, title, state, model, account, created, updated, turns } = s.meta;
    return { sid, title, state, model, account, created, updated, turns };
  }

  function addEvent(s, ev) {
    const evt = { seq: ++s.seq, ts: new Date().toISOString(), ...ev };
    fs.appendFileSync(path.join(s.dir, 'events.jsonl'), `${JSON.stringify(evt)}\n`, { mode: 0o600 });
    s.events?.push(evt);
    s.meta.updated = evt.ts;
    emit(`claude:${s.meta.sid}`, evt);
    return evt;
  }

  function save(s) {
    writeJson(path.join(s.dir, 'meta.json'), s.meta);
  }

  function setState(s, state) {
    s.meta.state = state;
    addEvent(s, { kind: 'status', state, account: s.meta.account, model: s.meta.model });
    save(s);
    emit('claude:list', summary(s));
  }

  function ensureEvents(s) {
    if (s.events) return s.events;
    s.events = [];
    try {
      for (const line of fs.readFileSync(path.join(s.dir, 'events.jsonl'), 'utf8').split('\n')) {
        if (line) s.events.push(JSON.parse(line));
      }
    } catch { /* partial or missing file */ }
    return s.events;
  }

  function startPoller() {
    if (poller) return;
    poller = setInterval(() => {
      for (const s of sessions.values()) if (s.turn) pump(s);
      if (activeCount() === 0) { clearInterval(poller); poller = null; }
    }, POLL_MS).unref();
  }

  function pump(s) {
    const t = s.turn;
    const alive = t.child ? t.child.exitCode === null && t.child.signalCode === null : isClaudePid(t.pid);
    const chunks = [];
    try {
      const fd = fs.openSync(t.rawFile, 'r');
      const buf = Buffer.alloc(1 << 20);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, t.offset);
        if (n <= 0) break;
        chunks.push(Buffer.from(buf.subarray(0, n)));
        t.offset += n;
      }
      fs.closeSync(fd);
    } catch { /* raw file not there yet */ }
    if (chunks.length) {
      // Work on bytes so a multi-byte character split across reads is never decoded half-way.
      const data = Buffer.concat([t.pending, ...chunks]);
      const end = data.lastIndexOf(0x0a) + 1;
      t.pending = data.subarray(end);
      for (const line of data.subarray(0, end).toString('utf8').split('\n')) handleLine(s, line);
      s.meta.rawOffset = t.offset - t.pending.length;
      if (t.norm.claudeSessionId) s.meta.claudeSessionId = t.norm.claudeSessionId;
      s.meta.sawResult = t.sawResult;
      save(s);
    }
    if (!alive) finish(s);
  }

  function handleLine(s, line) {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj.type === 'result') s.turn.sawResult = true;
    for (const ev of s.turn.norm.feed(obj)) {
      // The error a SIGINT'd turn reports (error_during_execution) is the requested stop, not a failure.
      if (ev.kind === 'error' && s.turn.stopRequested && !s.turn.failed) continue;
      if (ev.kind === 'error') s.turn.sawError = true;
      // `turns` counts the user turns of the desk session; Claude's own num_turns moves to `agentSteps`.
      if (ev.kind === 'result') ev.turns = s.meta.turns;
      addEvent(s, ev);
    }
  }

  function finish(s) {
    const t = s.turn;
    clearTimeout(t.timer);
    clearTimeout(t.killTimer);
    for (const ev of t.norm.flush()) addEvent(s, ev); // a desk-canvas block the turn never closed
    s.turn = null;
    s.meta.pid = null;
    let state = 'idle';
    if (t.stopRequested && !t.failed) state = 'stopped';
    else if (!t.sawResult || t.sawError || t.failed) {
      const code = t.child?.exitCode;
      let errText = '';
      try { errText = fs.readFileSync(t.errFile, 'utf8').trim().slice(-400); } catch { /* none */ }
      if (!t.sawResult) addEvent(s, { kind: 'error', message: redact(`claude exited without a result${code ? ` (exit ${code})` : ''}${errText ? `: ${errText}` : ''}`) });
      state = 'error';
    }
    setState(s, state);
    const next = s.queue.shift();
    if (next && state !== 'stopped') launchSafe(s, next);
    else s.queue.length = 0;
  }

  function launchSafe(s, text) {
    try { launchTurn(s, text); } catch (err) { failTurn(s, err); }
  }

  function failTurn(s, err) {
    s.turn = null;
    addEvent(s, { kind: 'error', message: redact(String(err.message)).slice(0, 400) });
    setState(s, 'error');
  }

  function launchTurn(s, text) {
    const { meta } = s;
    meta.turns += 1;
    const rawFile = path.join(s.dir, `turn-${meta.turns}.out`);
    const errFile = path.join(s.dir, `turn-${meta.turns}.err`);
    const outFd = fs.openSync(rawFile, 'w', 0o600);
    const errFd = fs.openSync(errFile, 'w', 0o600);
    const args = ['-p', text, '--model', meta.model, '--effort', meta.effort, '--dangerously-skip-permissions',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (meta.turns > 1) {
      if (!meta.claudeSessionId) throw new Error('first turn never reported a Claude session id');
      args.push('--resume', meta.claudeSessionId);
    }
    const child = spawn(claudeBin(), args, {
      cwd: s.dir, env: childEnv(meta.sid, s.dir, meta.account), detached: true, stdio: ['ignore', outFd, errFd],
    });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    child.on('error', (err) => { if (s.turn?.child === child) failTurn(s, err); });
    child.unref();
    const norm = new Normalizer();
    norm.claudeSessionId = meta.claudeSessionId;
    s.turn = { child, pid: child.pid, rawFile, errFile, offset: 0, pending: Buffer.alloc(0), norm, sawResult: false, sawError: false, stopRequested: false };
    s.turn.timer = setTimeout(() => stopSession(s, 'turn timeout (2 h)'), TURN_TIMEOUT_MS).unref();
    meta.pid = child.pid;
    meta.rawFile = rawFile;
    meta.errFile = errFile;
    meta.rawOffset = 0;
    meta.sawResult = false;
    setState(s, 'running');
    startPoller();
  }

  function stopSession(s, reason) {
    const t = s.turn;
    s.queue.length = 0;
    if (!t) return;
    t.stopRequested = true;
    if (reason) {
      t.failed = true;
      addEvent(s, { kind: 'error', message: reason });
    }
    signalGroup(t.pid, 'SIGINT');
    t.killTimer = setTimeout(() => {
      signalGroup(t.pid, 'SIGTERM');
      t.killTimer = setTimeout(() => signalGroup(t.pid, 'SIGKILL'), 5000).unref();
    }, 5000).unref();
  }

  function need(sid) {
    const s = sessions.get(String(sid));
    if (!s) throw new Error('unknown session');
    return s;
  }

  async function start({ title, prompt, page, chatContext, model = 'sonnet', effort = 'medium' } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt required');
    if (!MODELS.has(model)) throw new Error('model must be opus or sonnet');
    if (!EFFORTS.has(effort)) throw new Error('effort must be low, medium or high');
    const account = await pickAccount();
    if (activeCount() >= MAX_RUNNING) throw new Error(`max ${MAX_RUNNING} Claude sessions running`);
    const sid = `d${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(sessionsDir(), sid);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const promptMd = buildPrompt({ sid, title: title || prompt.slice(0, 80), prompt, page, chatContext, dir });
    fs.writeFileSync(path.join(dir, 'PROMPT.md'), promptMd, { mode: 0o600 });
    const now = new Date().toISOString();
    const s = {
      dir, seq: 0, events: [], queue: [], turn: null,
      meta: { sid, title: String(title || prompt.slice(0, 80)).slice(0, 120), state: 'starting', model, effort, account, created: now, updated: now, turns: 0, claudeSessionId: null, pid: null },
    };
    sessions.set(sid, s);
    setState(s, 'starting');
    addEvent(s, { kind: 'user', text: redact(prompt) });
    launchSafe(s, firstTurnPrompt(promptMd));
    return { sid };
  }

  async function send({ sid, text } = {}) {
    const s = need(sid);
    if (typeof text !== 'string' || !text.trim()) throw new Error('text required');
    if (!s.turn && !s.meta.claudeSessionId) throw new Error('session has no Claude session to resume yet');
    addEvent(s, { kind: 'user', text: redact(text) });
    if (s.turn) {
      s.queue.push(text);
      return { sid: s.meta.sid, queued: true };
    }
    if (activeCount() >= MAX_RUNNING) throw new Error(`max ${MAX_RUNNING} Claude sessions running`);
    launchSafe(s, text);
    return { sid: s.meta.sid, queued: false };
  }

  function stop({ sid } = {}) {
    const s = need(sid);
    if (s.turn) stopSession(s);
    else if (s.meta.state !== 'stopped') setState(s, 'stopped');
    return { sid: s.meta.sid, state: s.meta.state };
  }

  function list() {
    return { sessions: [...sessions.values()].map(summary).sort((a, b) => b.updated.localeCompare(a.updated)) };
  }

  function get({ sid, sinceSeq = 0 } = {}) {
    const s = need(sid);
    const all = ensureEvents(s);
    const events = all.filter((e) => e.seq > Number(sinceSeq)).slice(0, 3000);
    const tools = all.filter((e) => e.kind === 'tool_use').slice(-5).map(({ name, path: p, command }) => ({ name, path: p, command }));
    const lastText = all.findLast((e) => e.kind === 'text')?.text.slice(0, 1500) ?? '';
    return { ...summary(s), lastSeq: s.seq, events, recentTools: tools, lastText, queued: s.queue.length };
  }

  /** Load sessions from disk; turns whose process is still alive are re-attached, finished ones are drained. */
  function restore() {
    let names = [];
    try { names = fs.readdirSync(sessionsDir()); } catch { return; }
    for (const name of names.filter((n) => SID_RE.test(n))) {
      const dir = path.join(sessionsDir(), name);
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { continue; }
      const s = { dir, meta, seq: lastSeqOf(path.join(dir, 'events.jsonl')), events: null, queue: [], turn: null };
      sessions.set(name, s);
      if (meta.state === 'running' || meta.state === 'starting') {
        if (meta.rawFile && meta.pid) {
          const norm = new Normalizer();
          norm.claudeSessionId = meta.claudeSessionId;
          s.turn = { child: null, pid: meta.pid, rawFile: meta.rawFile, errFile: meta.errFile, offset: meta.rawOffset ?? 0, pending: Buffer.alloc(0), norm, sawResult: Boolean(meta.sawResult), sawError: false, stopRequested: false };
          s.turn.timer = setTimeout(() => stopSession(s, 'turn timeout (2 h)'), TURN_TIMEOUT_MS).unref();
        } else {
          s.meta.state = meta.claudeSessionId ? 'idle' : 'stopped';
          save(s);
        }
      }
    }
    if (activeCount() > 0) startPoller();
  }

  function shutdown() {
    clearInterval(poller);
    poller = null;
    for (const s of sessions.values()) if (s.turn) { clearTimeout(s.turn.timer); clearTimeout(s.turn.killTimer); }
  }

  return { start, send, stop, list, get, restore, shutdown, running: activeCount, max: MAX_RUNNING };
}
