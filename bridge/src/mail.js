// mail.search / mail.read for Sandy: READ-ONLY. Search/list goes through mail_tool.py's `list` / `search` subcommands (both
// open the folder read-only and only fetch BODY.PEEK headers); reading one message uses scripts/mail_read.py (EXAMINE +
// BODY.PEEK[]), because `mail_tool.py read` is capped at 4000 characters and lists no attachments. `send`, `delete`,
// `junk`, `purge` can never be produced: argv builders only know list/search/read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { redact } from './redact.js';

const HOME = () => process.env.BRIDGE_HOME || os.homedir();
const TOOL_DIR = () => process.env.BRIDGE_MAIL_DIR || path.join(HOME(), '.agents', 'skills', 'email-access');
const READ_HELPER = fileURLToPath(new URL('../scripts/mail_read.py', import.meta.url));
const SECRETS_FILE = () => process.env.BRIDGE_MAIL_SECRETS || path.join(HOME(), '.config', 'dev-secrets.env');
const PYTHON = () => process.env.BRIDGE_PYTHON || '/usr/bin/python3';
const TIMEOUT_MS = 25_000;
const MAX_BODY = 20_000;

const ACCOUNT_RE = /^[a-z0-9_-]{1,32}$/;
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/[\]-]{0,59}$/;
const UID_RE = /^\d{1,10}$/;

export function accounts() {
  try { return JSON.parse(fs.readFileSync(path.join(TOOL_DIR(), 'accounts.json'), 'utf8')); } catch { return {}; }
}

function account(name) {
  const n = String(name ?? '');
  if (!ACCOUNT_RE.test(n) || !Object.hasOwn(accounts(), n)) throw new Error(`unknown account; known: ${Object.keys(accounts()).join(', ')}`);
  return n;
}

function folderOf(f) {
  const v = f === undefined || f === null || f === '' ? 'INBOX' : String(f);
  if (!FOLDER_RE.test(v) || v.includes('..')) throw new Error('invalid folder');
  return v;
}

/** Pure argv builders (tested): the subcommand is fixed per builder; user text only ever appears as a `--opt=value`. */
export function buildSearchArgv({ account: acct, query, folder, limit }) {
  const n = Math.min(30, Math.max(1, Math.trunc(Number(limit)) || 10));
  const q = String(query ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  const common = [acct, `--folder=${folderOf(folder)}`, `--limit=${n}`];
  const tool = path.join(TOOL_DIR(), 'mail_tool.py');
  return q
    ? ['-I', tool, 'search', ...common, `--text=${q}`]
    : ['-I', tool, 'list', ...common];
}

export function buildReadArgv({ account: acct, uid, folder }) {
  if (!UID_RE.test(String(uid ?? ''))) throw new Error('uid must be numeric');
  return ['-I', READ_HELPER, acct, String(uid), `--folder=${folderOf(folder)}`];
}

/** Only the password variables named in accounts.json reach the child, read from the secrets file (never the bridge env). */
function childEnv() {
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: HOME(), LANG: 'C.UTF-8' };
  if (process.env.MAIL_TOOL_PATH) env.MAIL_TOOL_PATH = process.env.MAIL_TOOL_PATH;
  const wanted = new Set(Object.values(accounts()).map((a) => a?.pass_env).filter(Boolean));
  let text = '';
  try { text = fs.readFileSync(SECRETS_FILE(), 'utf8'); } catch { /* the variables may come from the environment */ }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m && wanted.has(m[1])) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  for (const k of wanted) if (!env[k] && process.env[k]) env[k] = process.env[k];
  return env;
}

function py(argv) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON(), argv, { env: childEnv(), timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(redact(`mail failed: ${(String(stderr).trim().split('\n').pop() || err.message).slice(0, 200)}`)));
      resolve(String(stdout));
    });
  });
}

const LIST_RE = /^\s*(\d+) (.) (.{25}) \| (.{38}) \| (.*)$/;
const SEARCH_RE = /^\s*(\d+) (.{25}) \| (.{38}) \| (.*)$/;

export function parseListing(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    let m = LIST_RE.exec(line);
    if (m) { out.push({ uid: m[1], unseen: m[2] === '*', date: m[3].trim(), from: m[4].trim(), subject: m[5].trim() }); continue; }
    m = SEARCH_RE.exec(line);
    if (m) out.push({ uid: m[1], date: m[2].trim(), from: m[3].trim(), subject: m[4].trim() });
  }
  return out.reverse(); // the tool prints oldest first
}

export async function search({ account: acct, query, folder, limit } = {}) {
  const names = acct ? [account(acct)] : Object.keys(accounts());
  if (!names.length) throw new Error('no mail accounts configured');
  const settled = await Promise.allSettled(names.map(async (name) => {
    const text = await py(buildSearchArgv({ account: name, query, folder, limit }));
    return parseListing(text).map((m) => ({ account: name, ...m }));
  }));
  // one mailbox without a password (or offline) must not hide the others; a single named account still fails loudly
  if (acct && settled[0].status === 'rejected') throw settled[0].reason;
  const unavailable = settled.flatMap((r, i) => (r.status === 'rejected' ? [{ account: names[i], error: redact(String(r.reason?.message ?? r.reason)).slice(0, 160) }] : []));
  if (unavailable.length === names.length) throw new Error(`no mailbox readable: ${unavailable.map((u) => `${u.account}: ${u.error}`).join('; ')}`);
  const messages = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).map((m) => ({ ...m, from: redact(m.from), subject: redact(m.subject) }));
  return { messages, ...(unavailable.length ? { unavailable } : {}), note: 'uid + account identify a message for mail_read; reading does not mark it seen' };
}

export async function read({ account: acct, uid, folder } = {}) {
  const name = account(acct);
  const raw = await py(buildReadArgv({ account: name, uid, folder }));
  let m;
  try { m = JSON.parse(raw); } catch { throw new Error('mail read returned no message'); }
  return {
    account: name, uid: String(uid), folder: folderOf(folder),
    from: redact(String(m.from ?? '')), to: redact(String(m.to ?? '')), date: String(m.date ?? ''), subject: redact(String(m.subject ?? '')),
    body: redact(String(m.body ?? '').slice(0, MAX_BODY)), truncated: Boolean(m.truncated),
    attachments: (m.attachments ?? []).map((a) => redact(String(a)).slice(0, 120)),
  };
}
