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

// a#41d6d2, 14 Nov: the board refused ("Thread #31 is archived; post to an active thread instead.") and the click only said "hat nicht geklappt".
// agent-board answers its own refusals as "agent-board: <reason>" on stderr with exit 2 (verified for "No thread matches"); they all happen BEFORE
// anything is written. Everything else (timeout, signal, a crash with another exit code) is unclear: the post may have gone through.
// The marker `not-posted:` at the start of the error message is the contract with the gateway (gateway/src/handoff.js): safe to offer the click again.
export const NOT_POSTED = 'not-posted:';
const ARCHIVED = /is archived|archived thread/i;
const NO_THREAD = /no thread matches|no such thread|unknown thread|not found/i;

/** True when agent-board failed in a way that proves nothing was written. Pure; exported for tests. */
// critic S4: only agent-board's own stderr decides, never err.message (Node puts the whole argv, i.e. the model-written title and task, into it):
// a handoff whose text says "Thread #31 is archived" must not turn an unclear failure into a reopen + retry + fallback (three posts).
// agent-board main(): `except ValueError: print(f"agent-board: {exc}", file=sys.stderr); return 2`, raised before the insert (checked 14 Nov).
export function refusedBeforeWrite(err, stderr = '') {
  const msg = String(stderr ?? '');
  if (err?.killed || err?.signal) return false; // our timeout / a kill: the process may have written already
  if (err?.code === 'ENOENT' || err?.code === 'EACCES') return true; // the binary never started
  if (err?.code !== 2 || /Traceback \(most recent call last\)/.test(msg)) return false; // a crash says nothing about the write
  return /(?:^|\n)agent-board: /.test(msg);
}

function boardError(err, stderr) {
  const refused = refusedBeforeWrite(err, stderr);
  const e = new Error(redact(`${refused ? `${NOT_POSTED} ` : ''}board failed: ${(stderr || err.message).slice(0, 300)}`));
  e.notPosted = refused;
  e.refusal = refused ? redact(String(stderr ?? '')).slice(0, 300) : ''; // the board's own words: the only text the retry logic reads
  return e;
}

function runBoardStrict(args) {
  const env = { ...process.env, AGENT_BOARD_NAME: HANDOFF_IDENTITY };
  return new Promise((resolve, reject) => {
    execFile(bin(), args, { env, timeout: 20000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(boardError(err, String(stderr ?? '').trim()));
      resolve(String(stdout));
    });
  });
}

// The bridge's own journal line format (bridge.js log()). The daily selfcheck (ops/handoff-selfcheck.mjs) greps "board failed" in the last 24 h: only
// a handoff that ended in failure may carry that text, a healed reopen or a fallback post must not.
const hlog = (msg) => console.log(`${new Date().toISOString()} bridge ${redact(String(msg))}`);

/** A refusal the bridge itself raises before it touches the board (validation, daily limit): same contract. */
function notPosted(message) {
  const e = new Error(`${NOT_POSTED} ${message}`);
  e.notPosted = true;
  return e;
}

/** Pure formatting, exported for tests. */
export function handoffText({ title, task, why }) {
  const parts = [`${HANDOFF_PREFIX}\n\n**${title}**\n\n${task}`];
  if (why) parts.push(`Warum: ${why}`);
  return redact(parts.join('\n\n'));
}

/** Where a handoff goes when the handoff thread cannot take it (archived and not reopenable, gone): "Ops & security" (#15), by id, not by a fuzzy title. */
export const handoffFallbackThread = () => process.env.BRIDGE_HANDOFF_FALLBACK_THREAD || '15';

const postedOf = (out) => ({
  id: /entry #(\d+)/.exec(out)?.[1],
  threadId: /thread #(\d+)/.exec(out)?.[1],
  thread: /thread #\d+ (.+?)\.?\s*$/m.exec(out)?.[1]?.trim(),
});

async function handoffOnce({ title, task, why } = {}) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  const body = String(task ?? '').trim();
  const reason = String(why ?? '').trim();
  if (!t || t.length > 120) throw notPosted('title required, max 120 characters');
  if (!body || body.length > 4000) throw notPosted('task required, max 4000 characters');
  if (reason.length > 1000) throw notPosted('why too long (max 1000 characters)');
  if (readHandoffState().state.n >= HANDOFF_PER_DAY) throw notPosted('handoff limit reached (10 per day)');
  const text = handoffText({ title: t, task: body, why: reason });
  const common = ['--as', HANDOFF_IDENTITY];
  const post = (thread, content) => runBoardStrict([...common, 'post', '--kind', 'handoff', '--to', HANDOFF_ADDRESSEE, thread, content]);
  const reopen = (ref) => runBoardStrict([...common, 'unarchive', ref]).then(() => true, () => false);
  let out;
  let reopened = false;
  let intendedId; // the numeric id of the handoff thread, when the board named it in a refusal
  try {
    try {
      out = await post(HANDOFF_THREAD, text);
    } catch (err) {
      if (!err.notPosted) throw err;
      if (ARCHIVED.test(err.refusal ?? '')) {
        // a#41d6d2: the board archives threads quiet for 7 days. Reopen it (the heal) and retry ONCE; the daily selfcheck also pins it as a topic.
        intendedId = /thread #(\d+)/i.exec(err.refusal ?? '')?.[1];
        if (!(await reopen(intendedId ?? HANDOFF_THREAD))) throw err;
        reopened = true;
        out = await post(HANDOFF_THREAD, text);
        hlog(`handoff: thread #${intendedId ?? '?'} was archived, reopened it and posted`);
      } else if (NO_THREAD.test(err.refusal ?? '')) {
        out = await runBoardStrict([...common, 'new', HANDOFF_THREAD, '--kind', 'handoff', '--to', HANDOFF_ADDRESSEE, '--body', text]); // the thread does not exist yet
      } else throw err;
    }
  } catch (err) {
    if (!err.notPosted) throw err; // unclear (timeout, crash): nothing is retried or redirected, a second post could duplicate
    intendedId ??= /thread #(\d+)/i.exec(err.refusal ?? '')?.[1];
    // Nothing reached the board and the handoff thread is no option: post into the active "Ops & security" thread, first line says why.
    const lead = `Fallback: das Thema „${HANDOFF_THREAD}“${intendedId ? ` (#${intendedId})` : ''} war ${ARCHIVED.test(err.refusal ?? '') ? 'archiviert' : 'nicht verfügbar'} und ließ sich nicht nutzen; die Übergabe steht deshalb hier.`;
    try {
      out = await post(handoffFallbackThread(), redact(`${lead}\n\n${text}`));
    } catch (second) {
      if (!second.notPosted) throw second; // the fallback may have been written: unclear
      const bare = (e) => e.message.replace(/^not-posted:\s*/, '');
      throw notPosted(`${bare(err)}; Ausweichthema ${handoffFallbackThread()} ebenfalls abgelehnt: ${bare(second)}`);
    }
    const p = postedOf(out);
    commitHandoffSlot();
    hlog(`handoff: FALLBACK post into thread ${handoffFallbackThread()} (entry #${p.id ?? '?'}); the handoff thread ${intendedId ? `#${intendedId} ` : ''}was ${ARCHIVED.test(err.refusal ?? '') ? 'archived' : 'unavailable'}`);
    if (!p.id) throw new Error('handoff posted but no entry id returned');
    return { id: Number(p.id), thread: p.thread ?? handoffFallbackThread(), ...(p.threadId ? { threadId: Number(p.threadId) } : {}), fallback: true, intendedThread: HANDOFF_THREAD, ...(intendedId ? { intendedThreadId: Number(intendedId) } : {}) };
  }
  const m = /entry #(\d+)/.exec(out);
  commitHandoffSlot(); // the entry exists now, even if its id could not be parsed
  if (!m) throw new Error('handoff posted but no entry id returned');
  return { id: Number(m[1]), thread: HANDOFF_THREAD, ...(reopened ? { reopened: true } : {}) };
}

/** board.handoff: posts one entry (see handoffOnce); a terminal failure leaves ONE journal line carrying the error (the selfcheck counts "board failed"). */
export async function handoff(args = {}) {
  try {
    return await handoffOnce(args);
  } catch (err) {
    if (!err.notPosted || /board failed/.test(err.message)) hlog(`handoff failed (${err.notPosted ? 'nothing posted' : 'unclear'}): ${String(err.message).replace(/\s+/g, ' ').slice(0, 300)}`);
    throw err;
  }
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
      try { row = JSON.parse(stdout); } catch { return reject(new Error('board entry lookup failed')); /* malformed */ }
      if (!row) return reject(new Error(`board entry #${n} not found`));
      resolve({ ...row, author: redact(row.author), thread: redact(row.thread), text: redact(String(row.text).slice(0, 12000)) });
    });
  });
}

// board.recent: newest entries over all threads, for the start briefing. Same read-only database path as board.entry:
// `agent-board inbox/read` move the read pointer, this does not.
const RECENT_PY = `import json,os,sys,sqlite3,urllib.parse
d=os.environ.get('AGENT_BOARD_DIR') or os.path.expanduser('~/.agent-board')
db=os.environ.get('AGENT_BOARD_DB') or os.path.join(d,'board.db')
c=sqlite3.connect('file:'+urllib.parse.quote(os.path.abspath(db),safe='/')+'?mode=ro',uri=True,timeout=10)
cut,n=sys.argv[1],int(sys.argv[2])
rows=c.execute('select e.id,t.title,e.author,e.kind,e.created_at,substr(e.body,1,1200) from entries e join threads t on t.id=e.thread_id order by e.id desc limit ?',(n*4,)).fetchall()
out=[]
for r in rows:
 ts=str(r[4] or '').replace(' ','T')
 if ts[:len(cut)]<cut: continue
 out.append(dict(zip(['id','thread','author','kind','at','text'],r)))
 if len(out)>=n: break
print(json.dumps(out))`;

const RECENT_TEXT = 240;

export function recent({ hours = 6, limit = 40 } = {}) {
  const h = Math.min(72, Math.max(1, Number(hours) || 6));
  const n = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 40));
  const cut = new Date(Date.now() - h * 3600_000).toISOString().slice(0, 19);
  return new Promise((resolve, reject) => {
    execFile('python3', ['-I', '-c', RECENT_PY, cut, String(n)], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      let rows;
      try { rows = JSON.parse(stdout); } catch { rows = null; }
      if (err || !Array.isArray(rows)) return reject(new Error('board recent lookup failed'));
      resolve({
        hours: h,
        entries: rows.map((r) => ({
          id: r.id, thread: redact(String(r.thread ?? '')).slice(0, 80), kind: String(r.kind ?? '').slice(0, 20),
          author: redact(String(r.author ?? '')).slice(0, 60), at: String(r.at ?? '').slice(0, 25),
          text: redact(String(r.text ?? '').replace(/\s+/g, ' ').trim()).slice(0, RECENT_TEXT),
        })),
      });
    });
  });
}
