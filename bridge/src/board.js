import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { redact } from './redact.js';
import { clearWinner, rank } from './fuzzy.js';

const bin = () => process.env.BRIDGE_BOARD_BIN || path.join(os.homedir(), 'bin', 'agent-board');
const MAX_OUT = 60 * 1024;

function runBoard(args) {
  const env = { ...process.env, AGENT_BOARD_NAME: 'desk:bridge' };
  return new Promise((resolve, reject) => {
    execFile(bin(), args, { env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(redact(`board failed: ${(stderr || err.message).slice(0, 300)}`)));
      const text = redact(String(stdout));
      resolve({ text: text.slice(0, MAX_OUT), truncated: text.length > MAX_OUT });
    });
  });
}

/** Whole untruncated board output (redacted) for aggregations such as ledger.entries; read-only subcommands only. */
export function readAll(args, { timeout = 20000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const env = { ...process.env, AGENT_BOARD_NAME: 'desk:bridge' };
  return new Promise((resolve, reject) => {
    execFile(bin(), args, { env, timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(redact(`board failed: ${(stderr || err.message).slice(0, 300)}`)));
      resolve(redact(String(stdout)));
    });
  });
}

export const threads = () => runBoard(['threads']);

/** Thread lines of `agent-board threads`: "#22 Title [tag, tag] · 7990 entries · …". */
export function parseThreads(text) {
  return String(text).split('\n').flatMap((line) => {
    const m = /^#(\d{1,6}) (.+?)(?: \[([^[\]]{0,400})\])?(?: · |$)/.exec(line);
    return m ? [{ id: m[1], title: m[2], tags: m[3] ?? '' }] : [];
  });
}

/** A thread named instead of numbered ("ops and security"): the clear best match by title + tags, else the top 3. */
export function matchThread(name, threadList) {
  const ranked = rank(name, threadList, (t) => `${t.title} ${t.tags}`);
  const winner = clearWinner(ranked);
  if (winner) return { id: winner.item.id };
  const candidates = ranked.map(({ item }) => `#${item.id} ${item.title}`);
  throw new Error(candidates.length ? `thread "${name}" not found; did you mean ${candidates.join(' | ')}? Use the numeric id.` : `thread "${name}" not found; call board_threads.`);
}

/** The CLI has no --limit; the newest entries are at the end, so a limit keeps the last N entries. */
export async function read({ thread, since, limit = 20 } = {}) {
  let id = String(thread ?? '').trim().replace(/^#/, '');
  if (!/^\d{1,6}$/.test(id)) id = matchThread(id, parseThreads((await threads()).text)).id;
  const args = ['read', id];
  if (since !== undefined && since !== null && since !== '') {
    if (!/^\d{1,9}$/.test(String(since))) throw new Error('since must be a numeric entry id');
    args.push('--since', String(since));
  }
  const { text } = await runBoard(args);
  const parts = text.split(/\n(?=#\d+ \[)/);
  const head = parts[0].startsWith('#') ? '' : parts.shift();
  const n = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 20));
  const keep = parts.slice(-n);
  const joined = [head, ...keep].filter(Boolean).join('\n');
  return { text: joined.slice(-MAX_OUT), entries: keep.length, truncated: parts.length > keep.length };
}

export async function search({ query } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query required');
  return runBoard(['search', q.slice(0, 200)]);
}

// ---- board.handoff: the ONLY write method of the bridge ------------------------------------------------------------
// The gateway calls it solely from the authenticated human's click on a handoff proposal, never from a model tool call.

export const HANDOFF_THREAD = 'Agent Desk handoffs';
export const HANDOFF_PREFIX = 'Auftrag von Florian (Agent Desk, bestätigt)';
export const HANDOFF_ADDRESSEE = '@cos-deputy-opus';
export const HANDOFF_IDENTITY = 'agent-desk';
const HANDOFF_PER_DAY = 10;

function handoffCounterFile() {
  const home = process.env.BRIDGE_HOME || os.homedir();
  return path.join(home, '.cache', 'agent-desk', 'handoff-count.json');
}

/** Persistent per-UTC-day counter (survives bridge restarts). Reads today's state without consuming a slot. */
function readHandoffState(now = new Date()) {
  const file = handoffCounterFile();
  const day = now.toISOString().slice(0, 10);
  let state = { day, n: 0 };
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old.day === day && Number.isInteger(old.n)) state = old;
  } catch { /* first use today */ }
  return { file, state };
}

/** Called only after a successful post, so a failed click does not burn a daily slot. */
function commitHandoffSlot() {
  const { file, state } = readHandoffState();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ day: state.day, n: state.n + 1 }), { mode: 0o600 });
}

function runBoardStrict(args) {
  const env = { ...process.env, AGENT_BOARD_NAME: HANDOFF_IDENTITY };
  return new Promise((resolve, reject) => {
    execFile(bin(), args, { env, timeout: 20000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(redact(`board failed: ${(stderr || err.message).slice(0, 300)}`)));
      resolve(String(stdout));
    });
  });
}

/** Pure formatting, exported for tests. */
export function handoffText({ title, task, why }) {
  const parts = [`${HANDOFF_PREFIX}\n\n**${title}**\n\n${task}`];
  if (why) parts.push(`Warum: ${why}`);
  return redact(parts.join('\n\n'));
}

export async function handoff({ title, task, why } = {}) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  const body = String(task ?? '').trim();
  const reason = String(why ?? '').trim();
  if (!t || t.length > 120) throw new Error('title required, max 120 characters');
  if (!body || body.length > 4000) throw new Error('task required, max 4000 characters');
  if (reason.length > 1000) throw new Error('why too long (max 1000 characters)');
  if (readHandoffState().state.n >= HANDOFF_PER_DAY) throw new Error('handoff limit reached (10 per day)');
  const text = handoffText({ title: t, task: body, why: reason });
  const common = ['--as', HANDOFF_IDENTITY];
  let out;
  try {
    out = await runBoardStrict([...common, 'post', '--kind', 'handoff', '--to', HANDOFF_ADDRESSEE, HANDOFF_THREAD, text]);
  } catch (err) {
    if (!/no thread matches|not found|no such thread|unknown thread/i.test(err.message)) throw err;
    out = await runBoardStrict([...common, 'new', HANDOFF_THREAD, '--kind', 'handoff', '--to', HANDOFF_ADDRESSEE, '--body', text]);
  }
  const m = /entry #(\d+)/.exec(out);
  commitHandoffSlot(); // the entry exists now, even if its id could not be parsed
  if (!m) throw new Error('handoff posted but no entry id returned');
  return { id: Number(m[1]), thread: HANDOFF_THREAD };
}

// Read one entry by its number (Sandy: the board database itself, opened read-only; no read pointer moves).
const ENTRY_PY = `import json,os,re,sqlite3,sys,urllib.parse
d=os.environ.get('AGENT_BOARD_DIR') or os.path.expanduser('~/.agent-board')
db=os.environ.get('AGENT_BOARD_DB') or os.path.join(d,'board.db')
c=sqlite3.connect('file:'+urllib.parse.quote(os.path.abspath(db),safe='/')+'?mode=ro',uri=True,timeout=10)
has_ids=any(col[1]=='artifact_ids' for col in c.execute('pragma table_info(entries)'))
column='e.artifact_ids' if has_ids else "'[]'"
r=c.execute('select e.id,e.thread_id,t.title,e.author,e.kind,e.created_at,e.body,'+column+' from entries e join threads t on t.id=e.thread_id where e.id=?',(int(sys.argv[1]),)).fetchone()
out=None if r is None else dict(zip(['id','threadId','thread','author','kind','ts','text','artifact_ids'],r))
if out is not None:
 try:
  ids=json.loads(out['artifact_ids'])
 except (ValueError,TypeError):
  ids=[]
 out['artifact_ids']=list(dict.fromkeys(i.lower() for i in ids if isinstance(i,str) and re.fullmatch('[0-9a-fA-F]{6}',i))) if isinstance(ids,list) else []
print(json.dumps(out))`;

export function entry({ id } = {}) {
  const n = Number(String(id ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n < 1) return Promise.reject(new Error('id must be a board entry number like 31239'));
  return new Promise((resolve, reject) => {
    execFile('python3', ['-I', '-c', ENTRY_PY, String(n)], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error('board entry lookup failed'));
      let row;
      try { row = JSON.parse(stdout); } catch { return reject(new Error('board entry lookup failed')); }
      if (!row) return reject(new Error(`board entry #${n} not found`));
      resolve({ ...row, author: redact(row.author), thread: redact(row.thread), text: redact(String(row.text).slice(0, 12000)) });
    });
  });
}
