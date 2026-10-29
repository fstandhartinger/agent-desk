import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { redact } from './redact.js';
import { HOME, isDenied, claudeProjectDirs, toCanonical } from './paths.js';
import { recentJobDirs } from './jobs.js';
import { assertNoSecretFragment, hitInSecret } from './secretQuery.js';

const run = promisify(execFile);
const RG = '/usr/bin/rg';
// Transcript trees are GBs: search at low CPU/IO priority with few threads so a desk question never loads the host (load guard 28 Oct).
const NICE = ['/usr/bin/nice', '/usr/bin/ionice'].every((f) => fs.existsSync(f));
const rgCmd = (args) => (NICE ? ['/usr/bin/nice', ['-n', '15', '/usr/bin/ionice', '-c3', RG, '-j', '3', ...args]] : [RG, ['-j', '3', ...args]]);
const MAX_HITS = 30;

/** Project folders are the session cwd with "/" turned into "-"; jobs are the interesting ones. */
function sessionName(file) {
  const rel = path.relative(path.dirname(path.dirname(file)), file).split(path.sep);
  const project = rel.length > 1 ? rel[0] : path.basename(path.dirname(file));
  return project.replace(/^-home-flori-jobs-/, '').replace(/^-home-flori-?/, 'home') || 'home';
}

function messageText(obj) {
  const c = obj?.message?.content ?? obj?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join('\n');
}

// ---- safe rendering (critic round 3, P0-1) ------------------------------------------------------------------------
// Text is redacted BEFORE it is cut: a cut that starts in the middle of `KEY=value` would lose the key name, and then no
// pattern recognises the value. Lines that look like an environment dump are never shown at all.

export const ENV_HIDDEN = '[Umgebungsvariablen ausgeblendet]';
const LINE_SPLIT = /(\r?\n|(?:\\r)?\\n)/; // real or JSON-escaped newlines
const ENV_PAIR = /(?:^|[\s;,{(]|\\[nt])(?:export\s+|declare\s+-x\s+)?[A-Z_][A-Z0-9_]+=(?=\S)/g;
const ENV_LINE = /^\s*(?:export\s+|declare\s+-x\s+)?[A-Z_][A-Z0-9_]*=\S/;
const UPPER_JSON_KEY = /(?<!\\)\\*["'][A-Z][A-Z0-9_]{2,}\\*["']\s*:/g;
const MAYBE_ENV = /[A-Z0-9_]{2}=|environ|declare\s+-x|["'][A-Z][A-Z0-9_]{2,}\\*["']\s*:/;

/** One line that is an environment dump: >= 3 NAME=value pairs, `declare -x`, os.environ / environ({ reprs, >= 3 UPPER_SNAKE JSON keys. */
export function isEnvDump(line) {
  if (/\bdeclare\s+-x\s/.test(line) || /\bos\.environ\b|\benviron\(\{/.test(line)) return true;
  if ((line.match(ENV_PAIR) || []).length >= 3) return true;
  return (line.match(UPPER_JSON_KEY) || []).length >= 3;
}

/** Replace env-dump lines (and runs of >= 3 consecutive NAME=value lines) with one placeholder each. */
export function hideEnvDumps(text) {
  const s = String(text ?? '');
  if (!MAYBE_ENV.test(s)) return s;
  const parts = s.split(LINE_SPLIT);
  const lines = parts.filter((_, i) => i % 2 === 0);
  const hide = lines.map(isEnvDump);
  for (let i = 0; i < lines.length;) {
    if (!ENV_LINE.test(lines[i])) { i++; continue; }
    let j = i;
    while (j < lines.length && ENV_LINE.test(lines[j])) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) hide[k] = true;
    i = j;
  }
  if (!hide.some(Boolean)) return s;
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const sep = i > 0 ? parts[2 * i - 1] : '';
    if (!hide[i]) out += sep + lines[i];
    else if (!hide[i - 1]) out += sep + ENV_HIDDEN;
  }
  return out;
}

/** Everything that leaves chats.* as text: env dumps hidden, then redacted (patterns + known values + fragments). */
export const safeText = (text) => redact(hideEnvDumps(text));

const SNIP_BEFORE = 100;
const SNIP_AFTER = 160;
const SNIP_CONTEXT = 2000; // redacted around the hit, so every key name on the hit's line is still in view

async function rg(args, roots, timeout = 8000) {
  try {
    const [cmd, argv] = rgCmd([...args, ...roots]);
    const { stdout } = await run(cmd, argv, { timeout, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    // exit 1 = no matches, 2 = some files unreadable; timeouts keep partial output
    if (typeof err.code !== 'number' && !err.killed && !err.stdout) throw new Error(`chat search failed: ${redact(String(err.message)).slice(0, 200)}`);
    return err.stdout ?? '';
  }
}

function matches(stdout) {
  return stdout.split('\n').filter((l) => l.startsWith('{"type":"match"')).flatMap((l) => {
    try { return [JSON.parse(l).data]; } catch { return []; }
  });
}

const SEARCH_BUDGET_MS = 8000;
const MAX_CANDIDATE_FILES = 60;
const AGENTS = ['claude', 'codex', 'opencode'];

/** Opaque transcript references: an HMAC of agent + path, resolved through a per-process map. Raw paths never leave the bridge. */
const REF_KEY = crypto.randomBytes(32);
const REFS = new Map();
const REFS_MAX = 4000;

export function makeRef(agent, file, extra = {}) {
  const ref = `c${crypto.createHmac('sha256', REF_KEY).update(`${agent}\0${file}`).digest('hex').slice(0, 20)}`;
  REFS.delete(ref);
  REFS.set(ref, { agent, file, ...extra });
  if (REFS.size > REFS_MAX) REFS.delete(REFS.keys().next().value);
  return ref;
}

function chatRoots(agent) {
  const h = HOME;
  const roots = {
    claude: [...claudeProjectDirs(), path.join(h, '.claude', 'archived_projects'), path.join(h, '.claude', 'history.jsonl')],
    codex: [path.join(h, '.codex', 'sessions'), path.join(h, '.codex', 'archived_sessions'), path.join(h, '.codex', 'history.jsonl')],
    opencode: [
      path.join(h, '.local', 'share', 'opencode', 'storage', 'session'),
      path.join(h, '.local', 'share', 'opencode', 'storage', 'message'),
      path.join(h, '.local', 'state', 'opencode', 'prompt-history.jsonl'),
    ],
  };
  return roots[agent] ?? [];
}

function agentOf(file) {
  for (const a of AGENTS) {
    if (chatRoots(a).some((r) => file === r || file.startsWith(r + path.sep))) return a;
  }
  return null;
}

const isHistoryFile = (file) => /(^|[\\/])(history|prompt-history)\.jsonl$/.test(file);

/** Search terms: "a OR b" / "a | b" gives alternatives, otherwise the whole query is one fixed string. */
export function searchTerms(query) {
  // r7 (critic r6 P1-1): starts only at a blank-run start / at the pipe (the parts are trimmed), so long blank runs stay linear
  const parts = String(query).split(/(?<!\s)\s+OR\s+|\|\s*/).map((t) => t.trim()).filter((t) => t.length >= 2);
  return [...new Set(parts.length ? parts : [String(query).trim()])].slice(0, 6);
}

function findFirst(text, terms) {
  const low = text.toLowerCase();
  let best = -1;
  let len = 0;
  for (const t of terms) {
    const i = low.indexOf(t.toLowerCase());
    if (i >= 0 && (best < 0 || i < best)) { best = i; len = t.length; }
  }
  return [best, len];
}

/** Snippet around the first hit: redact the surrounding source text first, cut second, drop partial tokens at the cuts. */
export function snippetAny(text, terms) {
  const [best, len] = findFirst(text, terms);
  if (best < 0) return null;
  const from = Math.max(0, best - SNIP_CONTEXT);
  const raw = text.slice(from, best + len + SNIP_CONTEXT);
  const safe = safeText(raw);
  // find the hit again in the redacted text (the occurrence nearest to where it was); a hidden/redacted hit keeps its place
  const expect = Math.round(((best - from) * safe.length) / Math.max(1, raw.length));
  let at = -1;
  let alen = 0;
  const low = safe.toLowerCase();
  for (const t of terms) {
    const tl = t.toLowerCase();
    for (let i = low.indexOf(tl); i >= 0; i = low.indexOf(tl, i + 1)) {
      if (at < 0 || Math.abs(i - expect) < Math.abs(at - expect)) { at = i; alen = t.length; }
      if (i > expect) break;
    }
  }
  // Critic round 4, P2-1: the hit sat inside a redacted secret: no hit, so the search reveals nothing about it. A hit
  // hidden for other reasons (an env-dump line) keeps its place.
  if (at < 0 && terms.some((t) => hitInSecret(raw, safe, t))) return null;
  if (at < 0) { at = Math.min(expect, safe.length); alen = 0; }
  const a = Math.max(0, at - SNIP_BEFORE);
  const b = Math.min(safe.length, at + alen + SNIP_AFTER);
  let snip = safe.slice(a, b);
  // the cut starts mid-token: drop the partial token (unless the hit itself is in it, then start at the hit)
  if (a > 0 && /\S/.test(safe[a - 1]) && /^\S/.test(snip)) {
    const lead = snip.match(/^\S*/)[0].length;
    snip = lead <= at - a ? snip.slice(lead) : snip.slice(at - a);
  }
  if (b < safe.length && /\S/.test(safe[b]) && /\S$/.test(snip)) {
    const tail = snip.match(/(?<!\S)\S*$/)[0].length;
    if (snip.length - tail >= Math.min(snip.length, at - a + alen)) snip = snip.slice(0, snip.length - tail);
  }
  return snip.replace(/\s+/g, ' ').trim();
}

async function codexCwd(file) {
  try {
    const fd = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      return /"cwd":"([^"]+)"/.exec(buf.toString('utf8', 0, bytesRead))?.[1] ?? null;
    } finally { await fd.close(); }
  } catch { return null; }
}

const jobLabel = (cwd) => (cwd ? cwd.replace(/^\/home\/flori\/jobs\//, '').replace(/^\/home\/flori\/?/, '~/').slice(0, 120) : '');

function codexText(obj) {
  const p = obj?.payload;
  if (!p || obj.type !== 'response_item') return null;
  if (p.type === 'message') {
    if (p.role === 'developer') return null;
    return { role: p.role, text: (p.content ?? []).map((b) => b?.text ?? '').filter(Boolean).join('\n') };
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call') return { role: 'tool', text: `${p.name ?? ''} ${typeof p.arguments === 'string' ? p.arguments : p.input ?? ''}` };
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') return { role: 'tool_result', text: typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '') };
  return null;
}

function hitFromLine(file, kind, raw, terms) {
  if (kind === 'history') {
    let o;
    try { o = JSON.parse(raw); } catch { return null; }
    const text = o.display ?? o.text ?? o.input ?? '';
    const snip = snippetAny(String(text), terms);
    if (!snip) return null;
    const ts = o.timestamp ?? (o.ts ? o.ts * (o.ts < 1e12 ? 1000 : 1) : null);
    return { source: 'prompt-history', role: 'user', ts: ts ? new Date(ts).toISOString() : null, project: jobLabel(o.project ?? ''), sessionId: o.sessionId ?? o.session_id ?? null, text: snip };
  }
  if (kind === 'claude') {
    let o;
    try { o = JSON.parse(raw); } catch { return null; }
    if (o.type !== 'user' && o.type !== 'assistant') return null;
    const snip = snippetAny(messageText(o), terms);
    if (!snip) return null;
    return { source: 'session', role: o.type ?? o.message?.role, ts: o.timestamp ?? null, text: snip };
  }
  if (kind === 'codex') {
    let o;
    try { o = JSON.parse(raw); } catch { return null; }
    const t = codexText(o);
    const snip = t ? snippetAny(t.text, terms) : null;
    if (!snip) return null;
    return { source: 'session', role: t.role, ts: o.timestamp ?? null, text: snip };
  }
  // opencode json (session or message file): the matched line is enough
  const snip = snippetAny(raw, terms);
  return snip ? { source: 'session', role: undefined, ts: null, text: snip } : null;
}

function classify(file) {
  const agent = agentOf(file);
  if (!agent) return null;
  if (isHistoryFile(file)) return { agent, kind: 'history' };
  return { agent, kind: agent };
}

/** Newest first per agent, then round-robin across agents up to `cap`. */
function balance(hits, cap) {
  const lanes = new Map();
  for (const h of [...hits].sort((a, b) => String(b.ts).localeCompare(String(a.ts)))) {
    if (!lanes.has(h.agent)) lanes.set(h.agent, []);
    lanes.get(h.agent).push(h);
  }
  const out = [];
  while (out.length < cap && [...lanes.values()].some((l) => l.length)) {
    for (const l of lanes.values()) if (l.length && out.length < cap) out.push(l.shift());
  }
  return out;
}

export async function search({ query, agent = 'all', limit = 15 } = {}) {
  const q = String(query ?? '').trim();
  if (q.length < 2) throw new Error('query too short');
  assertNoSecretFragment(q);
  const which = String(agent ?? 'all').toLowerCase();
  if (which !== 'all' && !AGENTS.includes(which)) throw new Error('agent must be claude, codex, opencode or all');
  const agents = which === 'all' ? AGENTS : [which];
  const cap = Math.min(MAX_HITS, Math.max(1, Math.trunc(Number(limit)) || 15));
  const terms = searchTerms(q);
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const left = () => Math.max(500, deadline - Date.now());
  const termArgs = terms.flatMap((t) => ['-e', t]);
  const base = ['--fixed-strings', '--ignore-case', '--max-filesize', '30M', '-g', '*.jsonl', '-g', '*.json'];

  // Stage 1: which files match at all (parallel, fast); stage 2: snippets from the newest files only.
  const roots = agents.flatMap(chatRoots).filter((r) => fs.existsSync(r));
  const listed = roots.length ? (await rg(['-l', ...base, ...termArgs, '--'], roots, Math.min(left(), 6000))).split('\n').filter(Boolean) : [];
  const stamped = (await Promise.all(listed.filter((f) => !isDenied(f)).map(async (f) => {
    const st = await fs.promises.stat(f).catch(() => null);
    return st ? { file: f, mtime: st.mtimeMs } : null;
  }))).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  // Newest files first, but every agent gets its share of the candidates (Claude would otherwise crowd out the rest).
  const perAgent = Math.ceil(MAX_CANDIDATE_FILES / agents.length);
  const taken = {};
  const candidates = stamped.filter((f) => {
    const a = agentOf(f.file);
    taken[a] = (taken[a] ?? 0) + 1;
    return taken[a] <= perAgent;
  });

  const hits = [];
  if (candidates.length && Date.now() < deadline) {
    // Many early matches in a file are boilerplate (developer prompts), so look at more lines than we keep (2 per file).
    const out = await rg(['--json', '--max-count', '8', ...base, ...termArgs, '--'], candidates.map((s) => s.file), left());
    const perFile = new Map();
    const cwdCache = new Map();
    for (const m of matches(out)) {
      const file = m.path?.text;
      const cls = file && classify(file);
      if (!cls || (perFile.get(file) ?? 0) >= 2) continue;
      const hit = hitFromLine(file, cls.kind, m.lines?.text ?? '', terms);
      if (!hit) continue;
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
      if (cls.kind === 'history') {
        hits.push({ agent: cls.agent, ref: null, ...hit, text: redact(hit.text) });
        continue;
      }
      let project;
      let sessionId;
      if (cls.agent === 'claude') {
        project = sessionName(file);
        sessionId = path.basename(file, '.jsonl');
      } else if (cls.agent === 'codex') {
        if (!cwdCache.has(file)) cwdCache.set(file, jobLabel(await codexCwd(file)));
        project = cwdCache.get(file);
        sessionId = path.basename(file, '.jsonl').replace(/^rollout-[\d-]+T[\d-]+-/, '');
      } else {
        const inMessage = file.includes(`${path.sep}message${path.sep}`);
        sessionId = inMessage ? path.basename(path.dirname(file)) : path.basename(file, '.json');
        project = '';
      }
      const ts = hit.ts ?? new Date(candidates.find((s) => s.file === file)?.mtime ?? Date.now()).toISOString();
      hits.push({ agent: cls.agent, ref: makeRef(cls.agent, file, { sessionId }), project, sessionId, source: hit.source, role: hit.role, ts, text: redact(hit.text) });
    }
  }

  hits.splice(0, hits.length, ...balance(hits, cap));

  if (agents.includes('claude') && Date.now() < deadline) {
    const outputFiles = (await recentJobDirs(200).catch(() => [])).map((d) => path.join(d, 'OUTPUT.md')).filter((f) => !isDenied(f));
    const outputs = outputFiles.length ? matches(await rg(['--json', '--max-count', '2', ...base.slice(0, 4), ...termArgs, '--'], outputFiles, left())) : [];
    for (const m of outputs) {
      if (hits.length >= cap) break;
      const file = m.path?.text;
      if (!file || isDenied(file)) continue;
      const raw = m.lines?.text ?? '';
      // a term rg matched but findFirst does not see (case folding) falls back to the line start; a redacted hit is dropped
      const snip = findFirst(raw, terms)[0] >= 0 ? snippetAny(raw, terms) : safeText(raw.slice(0, SNIP_CONTEXT)).trim().slice(0, 260).replace(/(?<!\S)\S*$/, '');
      if (!snip) continue;
      const mtime = await fs.promises.stat(file).then((s) => s.mtime.toISOString()).catch(() => null);
      hits.push({ agent: 'claude', ref: null, source: 'job-output', project: path.basename(path.dirname(file)), sessionId: null, path: toCanonical(file), line: m.line_number, ts: mtime, text: redact(snip) });
    }
  }
  hits.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  // Older consumers read `session`; keep it as an alias of `project`.
  for (const h of hits) h.session = h.project;
  return { query: q, agents, terms, hits };
}

// ---- chats.read ---------------------------------------------------------------------------------------------------

const MAX_TRANSCRIPT_BYTES = 60 * 1024 * 1024;
const TURN_TEXT_MAX = 1500;
const RESULT_MAX = 300;
const ARG_MAX = 160;

// Turns keep their raw text; only the requested page is rendered (redacted first, then clipped: see safeText).
const turn = (role, ts, raw, max = TURN_TEXT_MAX, prefix = '', flat = false) => ({ role, ts, raw: String(raw ?? ''), max, prefix, flat });
const argText = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

function renderTurn(t) {
  const full = t.raw.replace(/\r/g, '');
  let safe = safeText(full.slice(0, t.max + SNIP_CONTEXT));
  if (t.flat) safe = safe.replace(/\s+/g, ' ');
  const text = safe.length > t.max || full.length > t.max + SNIP_CONTEXT ? `${safe.slice(0, t.max)}… [+${Math.max(0, full.length - t.max)} chars]` : safe;
  return `${t.prefix}${text}`;
}

function claudeTurns(lines) {
  const turns = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const c = o.message?.content ?? o.content;
    const ts = o.timestamp ?? null;
    if (typeof c === 'string') { if (c.trim()) turns.push(turn(o.type, ts, c)); continue; }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'text' && b.text?.trim()) turns.push(turn(o.type, ts, b.text));
      else if (b?.type === 'tool_use') turns.push(turn('tool', ts, argText(b.input), ARG_MAX, `${b.name ?? 'tool'} `, true));
      else if (b?.type === 'tool_result') {
        const r = Array.isArray(b.content) ? b.content.map((x) => x?.text ?? '').join('\n') : b.content;
        turns.push(turn('tool_result', ts, r, RESULT_MAX));
      }
    }
  }
  return turns;
}

function codexTurns(lines) {
  const turns = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = codexText(o);
    if (!t || !t.text.trim()) continue;
    const p = o.payload;
    const ts = o.timestamp ?? null;
    if (t.role === 'tool') turns.push(turn('tool', ts, argText(typeof p.arguments === 'string' ? p.arguments : p.input), ARG_MAX, `${p.name ?? 'tool'} `, true));
    else if (t.role === 'tool_result') turns.push(turn('tool_result', ts, t.text, RESULT_MAX));
    else turns.push(turn(t.role, ts, t.text));
  }
  return turns;
}

async function opencodeTurns(file, sessionId) {
  const storage = file.slice(0, file.lastIndexOf(`${path.sep}storage${path.sep}`) + '/storage'.length);
  const msgDir = path.join(storage, 'message', sessionId);
  const names = (await fs.promises.readdir(msgDir).catch(() => [])).filter((n) => n.endsWith('.json')).sort();
  const msgs = [];
  for (const n of names.slice(0, 2000)) {
    try { msgs.push(JSON.parse(await fs.promises.readFile(path.join(msgDir, n), 'utf8'))); } catch { /* skip */ }
  }
  msgs.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  const turns = [];
  for (const m of msgs) {
    const ts = m.time?.created ? new Date(m.time.created).toISOString() : null;
    const partDir = path.join(storage, 'part', String(m.id ?? ''));
    const partNames = m.id ? (await fs.promises.readdir(partDir).catch(() => [])).filter((n) => n.endsWith('.json')).sort() : [];
    let any = false;
    for (const n of partNames) {
      let part;
      try { part = JSON.parse(await fs.promises.readFile(path.join(partDir, n), 'utf8')); } catch { continue; }
      if (part.type === 'text' && part.text?.trim()) { turns.push(turn(m.role ?? 'assistant', ts, part.text)); any = true; }
      else if (part.type === 'tool') {
        turns.push(turn('tool', ts, argText(part.state?.input), ARG_MAX, `${part.tool ?? 'tool'} `, true));
        if (part.state?.output) turns.push(turn('tool_result', ts, part.state.output, RESULT_MAX));
        any = true;
      }
    }
    if (!any) {
      const text = typeof m.content === 'string' ? m.content : m.summary?.title ?? '';
      if (text?.trim()) turns.push(turn(m.role ?? 'assistant', ts, text));
    }
  }
  return turns;
}

function allowedChatFile(file) {
  if (!file || isDenied(file) || isHistoryFile(file)) return false;
  const agent = agentOf(file);
  if (!agent) return false;
  let real;
  try { real = fs.realpathSync(file); } catch { return false; }
  if (isDenied(real)) return false;
  return chatRoots(agent).some((r) => {
    let rr;
    try { rr = fs.realpathSync(r); } catch { return false; }
    return real.startsWith(rr + path.sep);
  });
}

export async function read({ ref, offset = 0, limit = 40 } = {}) {
  const entry = REFS.get(String(ref ?? ''));
  if (!entry) throw new Error('unknown or expired ref; run chats_search again');
  if (!allowedChatFile(entry.file)) throw new Error('transcript not available');
  const st = await fs.promises.stat(entry.file);
  if (st.size > MAX_TRANSCRIPT_BYTES) throw new Error('transcript too large to render');
  let turns;
  if (entry.agent === 'opencode') {
    turns = await opencodeTurns(entry.file, entry.sessionId);
  } else {
    const lines = (await fs.promises.readFile(entry.file, 'utf8')).split('\n').filter(Boolean);
    turns = entry.agent === 'codex' ? codexTurns(lines) : claudeTurns(lines);
  }
  const start = Math.min(turns.length, Math.max(0, Math.trunc(Number(offset)) || 0));
  const n = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 40));
  const page = turns.slice(start, start + n).map((t, i) => ({ n: start + i, role: t.role, ts: t.ts, text: redact(renderTurn(t)) }));
  return {
    ref: entry.ref ?? String(ref), agent: entry.agent, session: entry.sessionId ?? null, total: turns.length, offset: start,
    nextOffset: start + n < turns.length ? start + n : null, turns: page,
  };
}

async function firstUserText(file) {
  const fd = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && !obj.isSidechain) return safeText(messageText(obj).slice(0, SNIP_CONTEXT)).replace(/\s+/g, ' ').trim().slice(0, 220);
      } catch { /* last line may be cut */ }
    }
    return '';
  } finally {
    await fd.close();
  }
}

export async function recent({ limit = 10 } = {}) {
  const cap = Math.min(MAX_HITS, Math.max(1, Math.trunc(Number(limit)) || 10));
  const files = [];
  for (const root of claudeProjectDirs()) {
    let projects;
    try { projects = await fs.promises.readdir(root); } catch { continue; }
    for (const p of projects) {
      let names;
      try { names = await fs.promises.readdir(path.join(root, p)); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const file = path.join(root, p, n);
        const st = await fs.promises.stat(file).catch(() => null);
        if (st && !isDenied(file)) files.push({ file, mtime: st.mtime });
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const sessions = [];
  for (const { file, mtime } of files.slice(0, cap)) {
    sessions.push({
      session: sessionName(file),
      sessionId: path.basename(file, '.jsonl'),
      modified: mtime.toISOString(),
      firstUser: redact(await firstUserText(file).catch(() => '')),
    });
  }
  return { sessions };
}
