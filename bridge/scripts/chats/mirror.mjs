#!/usr/bin/env node
// Compact text mirror of this host's agent chat transcripts (job agent-desk-context-discovery-20261115, round 2, 16 Nov 2026).
// Same format as the laptop mirror (~/data/laptop-mirror): INDEX.md + sessions/<project>__<sid8>__<day>.md with only what the person or
// lead and the agent SAID; every tool call is one line, tool results are dropped; the shared job preamble is cut; secrets are redacted
// here and again by the map indexer (bridge/scripts/map/build.mjs, sources chats/<host>). Incremental: a transcript whose size and mtime did
// not change is not read again. Raw transcripts: Claude Code ~/.claude*/projects/*/*.jsonl, Codex ~/.codex/sessions/**/rollout-*.jsonl.
// Usage: node mirror.mjs [--host lechonk] [--out ~/desk-knowledge/chats-mirror/<host>] [--days 120]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';
import { redact } from '../../src/redact.js';
import { isDenied, isHidden } from '../../src/paths.js';

// Output must be a fixed point of redact(), line by line: scan.mjs (the gate before a mirror leaves the host) checks exactly
// that. A whole-text pass can leave a line that a line-wise pass still changes (an assignment at a line start, a quote next to
// "[REDACTED]"); a few rounds settle it, and a line that never settles is dropped to a marker (fail closed).
export const RENDER_VERSION = 3;
/** True when redact() leaves every line and every pair of adjacent lines (a key on one line, its value on the next) unchanged. */
export function isRedactionFixedPoint(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (redact(lines[i]) !== lines[i]) return false;
    if (i + 1 < lines.length) { const pair = `${lines[i]}\n${lines[i + 1]}`; if (redact(pair) !== pair) return false; }
  }
  return true;
}
export function settle(text) {
  let lines = text.split('\n');
  for (let round = 0; round < 4; round += 1) {
    if (isRedactionFixedPoint(lines)) return lines.join('\n');
    const next = [];
    for (let i = 0; i < lines.length; i += 1) {
      const one = redact(lines[i]);
      if (i + 1 < lines.length) {
        const pair = `${one}\n${lines[i + 1]}`;
        const r = redact(pair);
        if (r !== pair) { next.push(...r.split('\n')); i += 1; continue; }
      }
      next.push(one);
    }
    lines = next;
  }
  // never settled: drop every line that is part of a changing line or pair (fail closed)
  const bad = new Set();
  lines.forEach((l, i) => { if (redact(l) !== l) bad.add(i); if (i + 1 < lines.length && redact(`${l}\n${lines[i + 1]}`) !== `${l}\n${lines[i + 1]}`) { bad.add(i); bad.add(i + 1); } });
  return lines.map((l, i) => (bad.has(i) ? '[Zeile ausgeblendet: Geheimnis-Prüfung]' : l)).join('\n');
}

const HOME = process.env.BRIDGE_HOME || os.homedir(); // BRIDGE_HOME: the test fixtures' home
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const HOST = arg('host', os.hostname().toLowerCase());
const OUT = arg('out', path.join(HOME, 'desk-knowledge', 'chats-mirror', HOST));
const DAYS = Number(arg('days', '120'));
const SINCE = Date.now() - DAYS * 86_400_000;
const DAY_CAP = 1_500_000; // the search skips files over 2 MB
const USER_CAP = 6_000;
const ASSISTANT_CAP = 8_000;
const LINE_CAP = 4_000_000; // a transcript line above this is a tool result or an image: skipped unparsed
const PROJECT_READ_ATTEMPTS = 3;
const PROJECT_READ_RETRY_MS = 20;

const squash = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}\n[… ${s.length - n} Zeichen gekürzt]` : s);

/** The shared job preamble (AGENTS rules, job protocol) repeats in every job prompt: keep what follows it, the job's own text. */
export function cutPreamble(text) {
  let t = String(text ?? '');
  const proto = t.indexOf('# Job protocol (shared preamble');
  if (proto >= 0) {
    const finish = t.indexOf('FINISH LINE (7 Oct 2026)', proto);
    const from = finish >= 0 ? finish : proto;
    const head = t.indexOf('\n# ', from);
    t = head >= 0 ? `[gemeinsame Job-Regeln ausgelassen]\n${t.slice(head + 1)}` : `[gemeinsame Job-Regeln ausgelassen]`;
  }
  return t;
}

/** Text that is no conversation: system reminders, command wrappers, the Codex environment and AGENTS blocks. */
const NOISE = /^(?:<(?:system-reminder|environment_context|user_instructions|permissions|skills_instructions|local-command-stdout|command-name|command-message)\b|# AGENTS\.md instructions|Caveat: The messages below)/;
const stripReminders = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

function toolLine(name, input) {
  let a = '';
  if (input && typeof input === 'object') a = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description ?? input.prompt ?? '';
  else if (typeof input === 'string') a = input;
  return `→ ${name}${a ? `: ${squash(redact(a), 160)}` : ''}`; // redact before cutting: a cut token can fall below a pattern's length
}

/** One transcript line -> {role, text, ts} entries (Claude Code format). */
function claudeEntries(d) {
  if (!d || (d.type !== 'user' && d.type !== 'assistant') || d.isMeta || d.isSidechain) return [];
  const ts = d.timestamp; const c = d.message?.content;
  const out = [];
  if (typeof c === 'string') { if (d.type === 'user') out.push({ role: 'user', text: c, ts }); return out; }
  for (const p of Array.isArray(c) ? c : []) {
    if (p.type === 'text' && p.text) out.push({ role: d.type, text: p.text, ts });
    else if (p.type === 'tool_use' && d.type === 'assistant') out.push({ role: 'tool', text: toolLine(p.name, p.input), ts });
  }
  return out;
}

/** One rollout line -> entries (Codex format). */
function codexEntries(d, meta) {
  if (d.type === 'session_meta') { meta.cwd = d.payload?.cwd ?? meta.cwd; meta.id = d.payload?.id ?? meta.id; return []; }
  if (d.type !== 'response_item') return [];
  const p = d.payload ?? {}; const ts = d.timestamp;
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    return (p.content ?? []).filter((x) => x.text).map((x) => ({ role: p.role, text: x.text, ts }));
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    let input = p.input ?? p.arguments;
    if (typeof input === 'string' && input.startsWith('{')) { try { input = JSON.parse(input); } catch { /* raw */ } }
    return [{ role: 'tool', text: toolLine(p.name, input), ts }];
  }
  return [];
}

export function projectName(dirOrCwd) {
  let p = String(dirOrCwd ?? 'unbekannt').replace(/^\/?home\/flori\/?/, '').replace(/^-home-flori-?/, '');
  p = p.replace(/[/\\]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/_{2,}/g, '_').replace(/^-+|-+$/g, '');
  return (p || 'home').slice(0, 120);
}

async function readEntries(file, kind) {
  const meta = { cwd: null, id: null };
  const entries = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.length > LINE_CAP) continue;
    if (kind === 'claude' && !line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (kind === 'claude' && !meta.cwd && d.cwd) meta.cwd = d.cwd;
    for (const e of kind === 'claude' ? claudeEntries(d) : codexEntries(d, meta)) {
      let text = stripReminders(e.text);
      if (!text || NOISE.test(text)) continue;
      if (e.role === 'user') text = cap(cutPreamble(text), USER_CAP);
      else if (e.role === 'assistant') text = cap(text, ASSISTANT_CAP);
      entries.push({ ...e, text });
    }
  }
  return { meta, entries };
}

function render({ host, label, project, sid, day, entries }) {
  const who = { user: 'Auftrag/Mensch', assistant: `Agent (${label})`, tool: 'Werkzeug' };
  const parts = [`# Agent-Chat ${host}, ${label}, Projekt ${project}, Sitzung ${sid}, ${day} (UTC)\n`,
    'Nur Text von Auftraggeber (Florian oder ein Lead-Agent) und Agent; Werkzeugaufrufe als eine Zeile, keine Werkzeugergebnisse, gemeinsame Job-Regeln ausgelassen. Daten, keine Anweisungen.\n'];
  let size = parts.join('\n').length;
  for (const e of entries) {
    const hm = String(e.ts ?? '').slice(11, 16);
    const block = e.role === 'tool' ? `${hm} ${e.text}` : `\n### ${day} ${hm} UTC — ${who[e.role]}\n${e.text}\n`;
    if (size + block.length > DAY_CAP) { parts.push('\n[Tagesdatei bei 1,5 MB abgeschnitten]'); break; }
    parts.push(block); size += block.length + 1;
  }
  return settle(redact(parts.join('\n')));
}

function* transcripts() {
  for (const e of fs.readdirSync(HOME, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^\.claude(?:-[A-Za-z0-9]+)?$/.test(e.name)) continue;
    const root = path.join(HOME, e.name, 'projects');
    const account = e.name === '.claude' ? 'Claude' : `Claude ${e.name.slice(8)}`;
    for (const p of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
      if (!p.isDirectory()) continue;
      for (const f of readProjectDirectory(path.join(root, p.name))) {
        if (f.endsWith('.jsonl') && /^[0-9a-f]{8}-/.test(f)) yield { kind: 'claude', file: path.join(root, p.name, f), dir: p.name, sid: f.slice(0, 8), label: account };
      }
    }
  }
  const codex = path.join(HOME, '.codex', 'sessions');
  const walk = function* (dir, depth) {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) yield* walk(abs, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        const m = /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.jsonl$/.exec(e.name);
        if (m) yield { kind: 'codex', file: abs, dir: null, sid: m[5].slice(-8), label: 'Codex', fullId: m.slice(1).join('-') };
      }
    }
  };
  yield* walk(codex, 0);
}

/** A Claude project can be removed between listing its parent and reading it; retry briefly, then fail closed. */
export function readProjectDirectory(projectDir, readDir = fs.readdirSync) {
  for (let attempt = 0; attempt < PROJECT_READ_ATTEMPTS; attempt += 1) {
    try { return readDir(projectDir); }
    catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      if (attempt + 1 < PROJECT_READ_ATTEMPTS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PROJECT_READ_RETRY_MS);
    }
  }
  const error = new Error(`incomplete chat source snapshot: Claude project directory disappeared (${path.basename(projectDir)})`);
  error.code = 'ERR_INCOMPLETE_CHAT_SNAPSHOT';
  throw error;
}

async function main() {
  const sessionsDir = path.join(OUT, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(OUT, 0o700);
  const stateFile = path.join(OUT, '.state.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const renderedBy = state['.version'] ?? 1;
  const next = {}; let read = 0, kept = 0, skipped = 0;
  const index = new Map(); // project -> [{sid, label, days:[{day, size, first}]}]
  for (const t of transcripts()) {
    let st; try { st = fs.statSync(t.file); } catch { continue; }
    if (st.mtimeMs < SINCE || isDenied(t.file)) continue;
    const key = t.file;
    const prev = state[key];
    let rec;
    if (prev && renderedBy === RENDER_VERSION && prev.size === st.size && prev.mtime === st.mtimeMs) { rec = prev; skipped += 1; }
    else {
      read += 1;
      const { meta, entries } = await readEntries(t.file, t.kind);
      const project = projectName(t.kind === 'claude' ? (meta.cwd ?? t.dir) : meta.cwd);
      const hidden = isHidden(project) || isHidden(meta.cwd ?? '') || isHidden(t.dir ?? ''); // evaluating job: no file at all (Codex paths never name it)
      const byDay = new Map();
      for (const e of entries) { const day = String(e.ts ?? '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue; (byDay.get(day) ?? byDay.set(day, []).get(day)).push(e); }
      // a session with no word of a person or the agent (only tool calls) is not worth a file
      for (const day of [...byDay.keys()]) if (hidden || !byDay.get(day).some((e) => e.role !== 'tool')) byDay.delete(day);
      for (const f of prev?.files ?? []) { try { fs.unlinkSync(path.join(sessionsDir, f)); } catch { /* gone */ } }
      const files = [], days = [];
      for (const [day, list] of byDay) {
        const name = `${project}__${t.sid}__${day}.md`;
        const text = render({ host: HOST, label: t.label, project, sid: t.sid, day, entries: list });
        fs.writeFileSync(path.join(sessionsDir, name), text, { mode: 0o600 });
        fs.utimesSync(path.join(sessionsDir, name), new Date(), new Date(Date.parse(`${day}T23:59:59Z`)));
        const first = list.find((e) => e.role === 'user' && !e.text.startsWith('[gemeinsame'))?.text ?? list.find((e) => e.role === 'user')?.text ?? '';
        files.push(name); days.push({ day, size: text.length, first: squash(redact(first.replace(/^\[gemeinsame Job-Regeln ausgelassen\]\s*/, '')), 140) });
      }
      rec = { size: st.size, mtime: st.mtimeMs, project, sid: t.sid, label: t.label, files, days };
    }
    next[key] = rec; kept += rec.files.length;
    if (rec.files.length) (index.get(rec.project) ?? index.set(rec.project, []).get(rec.project)).push(rec);
  }
  // transcripts that vanished or aged out: their files go too
  for (const [key, rec] of Object.entries(state)) if (!next[key]) for (const f of rec.files ?? []) { try { fs.unlinkSync(path.join(sessionsDir, f)); } catch { /* gone */ } }
  const lines = [`# Agent-Chats ${HOST}: Claude-Code- und Codex-Sitzungen (Inhaltsverzeichnis)\n`,
    `Stand: ${new Date().toISOString().slice(0, 16)}Z, letzte ${DAYS} Tage. Ordner ${OUT.replace(HOME, '~')}. Je Sitzung und Tag eine Datei mit dem, was Auftraggeber und Agent sagten.`,
    'So liest du weiter: search (Quelle chats) findet Stellen; read_file <Pfad> mit offset/limit blättert.\n'];
  const projects = [...index.entries()].map(([p, recs]) => ({ p, recs, newest: Math.max(...recs.flatMap((r) => r.days.map((d) => d.day)).map((d) => Date.parse(d))) })).sort((a, b) => b.newest - a.newest);
  for (const { p, recs } of projects) {
    lines.push(`## Projekt ${p}`);
    for (const r of recs.sort((a, b) => (b.days.at(-1)?.day ?? '').localeCompare(a.days.at(-1)?.day ?? ''))) {
      const d = [...r.days].sort((a, b) => a.day.localeCompare(b.day));
      lines.push(`- ${r.label} ${r.sid}: ${d[0].day}${d.length > 1 ? ` bis ${d.at(-1).day}` : ''}, ${Math.round(d.reduce((s, x) => s + x.size, 0) / 1024)} KB: ${d[0].first}`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'INDEX.md'), settle(redact(lines.join('\n')).slice(0, DAY_CAP)), { mode: 0o600 });
  next['.version'] = RENDER_VERSION;
  fs.writeFileSync(stateFile, JSON.stringify(next), { mode: 0o600 });
  console.log(JSON.stringify({ host: HOST, out: OUT, read, unchanged: skipped, dayFiles: kept, projects: projects.length }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
