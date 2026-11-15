#!/usr/bin/env node
// Builds the Agent Desk map: the walkable table of contents (`nodes`) and the full-text index (`docs` + FTS5 `chunks`)
// over everything the desk may read, into ~/desk-knowledge/map/index.sqlite (private, never in the repo).
//
//   node scripts/map/build.mjs [--dir ~/desk-knowledge/map] [--full] [--no-board] [--board-cmd ~/bin/sandy-read]
//                              [--mirror <job-notes mirror>] [--laptop <laptop mirror>] [--max-board N] [--quiet]
//
// - Writes ONLY into --dir (0700, files 0600). The work happens in index.sqlite.build, a copy of the live index (or the
//   partial file of an earlier, interrupted run: a build that hits the timer's timeout resumes where it stopped); the
//   finished file replaces index.sqlite with one rename, so a reader never sees a half-built index.
// - Incremental by (size, mtime) per file and by the highest board entry id. A different SCHEMA_VERSION rebuilds fully.
// - Every text that enters passes the bridge redact() (chunk by chunk, so line numbers stay true); paths for which
//   isDenied() holds, other than allowlisted ones, never enter. Files > 2 MB, binaries and .jsonl are skipped.
// - A source that cannot be listed keeps its old rows (nothing is wiped because a mount was away); the reason is a warning.
// - Needs Node >= 22.5 (node:sqlite). The Sandy bridge runs Node 20 and never builds or serves the map.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { redact } from '../../src/redact.js';
import { CANON_JOBS, HOME, KNOWLEDGE_DIR, LAPTOP_MIRROR, isDenied, resolveAllowed } from '../../src/paths.js';
import { MIRROR_DIR } from '../../src/notesMirror.js';
import {
  CHUNK_SPAN, DB_FILE, MAP_DIR, SCHEMA_SQL, SCHEMA_VERSION, SOURCE_ORDER, STATUS_FILE, chunkRowid, chunkText, classify, firstRealLine,
  firstSentence, isoMinute, openHint, slug, squash, stateStatus,
} from '../../src/mapIndex.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DECISIONS_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_CHARS = 600_000; // per file: the head of a huge note is its summary, the tail is usually pasted output
const BATCH_DOCS = 300;
// A source that lists fewer than half of the files the index already holds (and holds at least SHRINK_GUARD_MIN) is treated as
// unavailable: a wiped notes mirror must not empty the index. Removals then wait for the next healthy run.
const SHRINK_GUARD_MIN = 50;
const BOARD_PAGE = 1000;
const BOARD_BODY_CHARS = 20_000;
const SKIP_DIRS = new Set(['node_modules', 'wt', 'work', '.git', 'venv', '.venv', '__pycache__', 'dist', 'build']);
const NOTE = /\.(md|txt)$/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const R = (s) => (typeof s === 'string' ? redact(s) : s);
const nul = (v) => (v === undefined ? null : v);

// ---- arguments -----------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    dir: MAP_DIR, mirror: MIRROR_DIR, laptop: LAPTOP_MIRROR, board: true, boardCmd: path.join(HOME, 'bin', 'sandy-read'),
    full: false, quiet: false, maxBoard: Infinity, shrinkMin: SHRINK_GUARD_MIN,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); i += 1; return argv[i]; };
    if (a === '--dir') o.dir = path.resolve(next());
    else if (a === '--mirror') o.mirror = path.resolve(next());
    else if (a === '--laptop') o.laptop = path.resolve(next());
    else if (a === '--board-cmd') o.boardCmd = path.resolve(next());
    else if (a === '--max-board') o.maxBoard = Number(next());
    else if (a === '--shrink-min') o.shrinkMin = Number(next());
    else if (a === '--no-board') o.board = false;
    else if (a === '--full') o.full = true;
    else if (a === '--quiet') o.quiet = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function loadSqlite() {
  try {
    return await import('node:sqlite');
  } catch {
    throw new Error(`the map builder needs Node >= 22.5 (node:sqlite); this is Node ${process.versions.node}. Run it on LeChonk (Node 24).`);
  }
}

// ---- text helpers --------------------------------------------------------------------------------------------------------
export function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(String(text).slice(0, 8000));
  if (!m) return {};
  const out = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      v = '';
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) { i += 1; v += ` ${lines[i].trim()}`; }
    }
    out[kv[1].toLowerCase()] = v.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** First paragraph of a README (consecutive text lines after the title), up to `max` characters. */
export function firstParagraph(text, max = 300) {
  const lines = String(text).split('\n', 120);
  const para = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('<!--') || l.startsWith('---') || l.startsWith('```') || /^\|/.test(l)) {
      if (para.length) break;
      continue;
    }
    para.push(l.replace(/\*\*|__|`/g, ''));
  }
  return squash(para.join(' '), max);
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ---- analysis: what a text says about itself (title, summary, sections) -----------------------------------------------------
/** "resolved-keys: …" and "Key: …" lines (also as "- Key:" / "**Key:**") are bookkeeping, not the entry's first sentence. String operations, not a regex: `^\s*…` is quadratic on a long whitespace run. */
function isMetaLine(line) {
  let t = line.trimStart();
  if (t[0] === '-' || t[0] === '*') t = t.slice(1).trimStart();
  let i = 0;
  while (t[i] === '*') i += 1;
  const head = t.slice(i, i + 14).toLowerCase();
  return head.startsWith('resolved-keys:') || head.startsWith('key:');
}

export function parseDecisions(text) {
  const lines = String(text).split('\n');
  const heads = [];
  lines.forEach((l, i) => { if (/^## /.test(l)) heads.push(i); });
  return heads.map((start, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    const heading = lines[start].slice(3).trim();
    const dm = /^(\d{4}-\d{2}-\d{2})(?:[ T]+(\d{2}:\d{2}))?/.exec(heading);
    const body = lines.slice(start + 1, end).filter((l) => !isMetaLine(l)).join('\n');
    const ms = dm ? Date.parse(`${dm[1]}T${dm[2] || '00:00'}:00Z`) : 0;
    return {
      line: start, limit: Math.min(Math.max(end - start, 1), 200), title: squash(heading, 160), summary: firstSentence(body),
      month: dm ? dm[1].slice(0, 7) : 'ohne-datum', ms: Number.isFinite(ms) ? ms : 0,
    };
  });
}

function parseSections(text) {
  const lines = String(text).split('\n');
  const heads = [];
  lines.forEach((l, i) => { if (/^## /.test(l)) heads.push(i); });
  return heads.map((start, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    return {
      line: start, limit: Math.min(Math.max(end - start, 1), 400), title: squash(lines[start].slice(3).trim(), 160),
      summary: firstRealLine(lines.slice(start + 1, end).join('\n')),
    };
  });
}

function firstUserLine(text) {
  const lines = String(text).split('\n');
  const at = lines.findIndex((l) => /^### .* — Florian\s*$/.test(l));
  if (at < 0) return '';
  for (let i = at + 1; i < lines.length; i += 1) {
    const l = lines[i].trim();
    if (l && !l.startsWith('### ') && !l.startsWith('<pasted_content')) return squash(l.replace(/\*\*|__|`/g, ''), 200);
  }
  return '';
}

/** {title, summary, extra} of a text, by the descriptor's analysis kind. Strings are redacted by the caller. */
function analyze(desc, text) {
  const hint = desc.titleHint;
  switch (desc.analyze) {
    case 'decisions': {
      const entries = parseDecisions(text);
      return { title: hint, summary: `${entries.length} Entscheidungen, neueste zuerst`, extra: { entries } };
    }
    case 'sections': {
      const sections = parseSections(text);
      return { title: hint, summary: firstRealLine(text), extra: { sections } };
    }
    case 'state': return { title: hint, summary: firstRealLine(text), extra: { status: stateStatus(text) } };
    case 'prompt': return { title: hint, summary: firstRealLine(text, { headings: true }), extra: null };
    case 'laptop-day': return { title: hint, summary: firstUserLine(text) || firstRealLine(text), extra: null };
    case 'readme': return { title: hint || firstRealLine(text, { headings: true, max: 120 }), summary: firstParagraph(text), extra: null };
    case 'skill': {
      const fm = frontMatter(text);
      return { title: fm.name || hint, summary: squash(fm.description || firstRealLine(text), 220), extra: null };
    }
    case 'explainer': return { title: desc.pageTitle?.() || hint, summary: firstRealLine(text), extra: null };
    default: {
      const fm = frontMatter(text);
      return {
        title: hint || fm.name || firstRealLine(text, { headings: true, max: 120 }),
        summary: squash(fm.description || firstRealLine(text), 220), extra: null,
      };
    }
  }
}

// ---- file system helpers -------------------------------------------------------------------------------------------------
const statOrNull = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const readdirOrNull = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return null; } };

/** Descriptor of a file that must pass the allowlist (resolveAllowed: lexical allow + deny list + realpath). */
function allowedFile(abs, fields) {
  let real;
  try { real = resolveAllowed(abs); } catch { return null; }
  let st;
  try { st = fs.statSync(real); } catch { return null; }
  if (!st.isFile()) return null;
  const limit = fields.maxBytes ?? MAX_FILE_BYTES;
  if (st.size > limit) return null;
  return { path: abs, real, mtime: Math.floor(st.mtimeMs), size: st.size, ...fields };
}

/** [relative path] of files below dir to a depth, skipping hidden/dependency dirs and denied names. */
function walkFiles(dir, { maxDepth, accept }) {
  const out = [];
  const walk = (d, rel, depth) => {
    for (const e of readdirOrNull(d) ?? []) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || isDenied(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < maxDepth) walk(path.join(d, e.name), r, depth + 1); } else if (e.isFile() && accept(e.name, r, depth)) out.push(r);
    }
  };
  walk(dir, '', 0);
  return out;
}

// ---- collectors: cheap listings of what exists (no file is read here) --------------------------------------------------------
const CORE_DOCS = [
  { file: path.join(HOME, 'AGENTS.md'), node: 'regeln/AGENTS.md', hint: 'AGENTS.md (gemeinsame Regeln aller Agenten)', analyze: 'sections', sort: 0 },
  { file: path.join(HOME, 'STATE.md'), node: 'regeln/STATE.md', hint: 'STATE.md (aktueller Stand)', analyze: 'plain', sort: 1 },
  { file: path.join(HOME, 'CLAUDE.md'), node: 'regeln/CLAUDE.md', hint: 'CLAUDE.md (Claude-Code-Hinweise)', analyze: 'plain', sort: 2 },
  { file: path.join(HOME, '.hermes', 'model-economy-policy.md'), node: 'regeln/model-economy-policy.md', hint: 'model-economy-policy.md (Modellwahl)', analyze: 'plain', sort: 3 },
];

function collectWissen() {
  const descs = [];
  const idx = allowedFile(path.join(KNOWLEDGE_DIR, 'INDEX.md'), { source: 'wissen', node: 'wissen/INDEX', parent: 'wissen', sort: 0, analyze: 'plain', titleHint: 'INDEX (Themenverzeichnis)' });
  if (idx) descs.push(idx);
  const dir = path.join(KNOWLEDGE_DIR, 'topics');
  const entries = readdirOrNull(dir);
  if (!entries) return { sources: ['wissen'], descs, ok: Boolean(idx) };
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) continue;
    const d = allowedFile(path.join(dir, e.name), { source: 'wissen', node: `wissen/${slug(e.name.replace(/\.md$/, ''))}`, parent: 'wissen', sort: 100, analyze: 'plain' });
    if (d) descs.push(d);
  }
  return { sources: ['wissen'], descs, ok: true };
}

function collectDecisions() {
  const d = allowedFile(path.join(HOME, 'DECISIONS.md'), {
    source: 'entscheidungen', node: 'entscheidungen', parent: '', sort: 0, analyze: 'decisions', splitRe: /^## /, maxBytes: MAX_DECISIONS_BYTES, titleHint: 'DECISIONS.md',
  });
  return { sources: ['entscheidungen'], descs: d ? [d] : [], ok: Boolean(d) };
}

function collectRegeln() {
  const descs = [];
  for (const c of CORE_DOCS) {
    const d = allowedFile(c.file, { source: 'regeln', node: c.node, parent: 'regeln', sort: c.sort, analyze: c.analyze, titleHint: c.hint, splitRe: c.analyze === 'sections' ? /^## / : null });
    if (d) descs.push(d);
  }
  return { sources: ['regeln'], descs, ok: descs.length > 0 };
}

function jobMonth(name, firstMtime) {
  const m = /(?:^|[-_])(20\d{2})(0[1-9]|1[0-2])(\d{2})(?:\d{4})?$/.exec(name);
  if (m) return `${m[1]}-${m[2]}`;
  return new Date(firstMtime).toISOString().slice(0, 7);
}
const JOB_FILE_SORT = { 'STATE.md': 0, 'RESULT.md': 1, 'PROMPT.md': 2, 'BRIEF.md': 3, 'FACTS.md': 4 };

function collectJobs(o) {
  const jobs = readdirOrNull(o.mirror);
  if (!jobs || !fs.existsSync(path.join(o.mirror, '.synced'))) return { sources: ['jobs'], descs: [], ok: false, warning: `jobs: notes mirror ${o.mirror} not ready; the old job rows stay` };
  const descs = [];
  for (const job of jobs) {
    if (!job.isDirectory() || job.name.startsWith('.') || isDenied(job.name)) continue;
    const files = [];
    const consider = (rel) => {
      const real = path.join(o.mirror, job.name, rel);
      const st = statOrNull(real);
      const canonical = path.join(CANON_JOBS, job.name, rel);
      if (!st?.isFile() || st.size > MAX_FILE_BYTES || isDenied(canonical)) return;
      files.push({ rel, real, canonical, mtime: Math.floor(st.mtimeMs), size: st.size });
    };
    for (const e of readdirOrNull(path.join(o.mirror, job.name)) ?? []) {
      if (e.isFile() && NOTE.test(e.name)) consider(e.name);
      else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && !isDenied(e.name)) {
        for (const f of readdirOrNull(path.join(o.mirror, job.name, e.name)) ?? []) if (f.isFile() && NOTE.test(f.name)) consider(`${e.name}/${f.name}`);
      }
    }
    if (!files.length) continue;
    const month = jobMonth(job.name, Math.min(...files.map((f) => f.mtime)));
    for (const f of files) {
      const analyzeKind = f.rel === 'STATE.md' ? 'state' : f.rel === 'PROMPT.md' ? 'prompt' : 'plain';
      descs.push({
        path: f.canonical, real: f.real, mtime: f.mtime, size: f.size, source: 'jobs', node: `jobs/${month}/${job.name}/${f.rel}`,
        parent: `jobs/${month}/${job.name}`, sort: JOB_FILE_SORT[f.rel] ?? 100, analyze: analyzeKind, titleHint: f.rel,
      });
    }
  }
  return { sources: ['jobs'], descs, ok: true };
}

const LAPTOP_DAY = /^(.+)__([0-9a-f]{8})__(\d{4}-\d{2}-\d{2})\.md$/;

function collectLaptop(o) {
  const descs = [];
  const root = o.laptop;
  if (!fs.existsSync(root)) return { sources: ['chats/laptop'], descs, ok: false, warning: `chats/laptop: ${root} missing; the old rows stay` };
  const idx = allowedFile(path.join(root, 'INDEX.md'), { source: 'chats/laptop', node: 'chats/laptop/INDEX', parent: 'chats/laptop', sort: 0, analyze: 'plain', titleHint: 'INDEX.md (Inhaltsverzeichnis des Laptop-Spiegels)' });
  if (idx) descs.push(idx);
  for (const e of readdirOrNull(path.join(root, 'sessions')) ?? []) {
    const m = LAPTOP_DAY.exec(e.name);
    if (!m || !e.isFile()) continue;
    const [, project, sid, day] = m;
    const d = allowedFile(path.join(root, 'sessions', e.name), {
      source: 'chats/laptop', node: `chats/laptop/${project}/${sid}/${day}`, parent: `chats/laptop/${project}/${sid}`, sort: -Number(day.replace(/-/g, '')),
      analyze: 'laptop-day', titleHint: day,
    });
    // the mirror rewrites every day file on each sync: the content date is the day in the name (freshness ranking, "updated")
    if (d) { d.mtime = Math.min(d.mtime, Date.parse(`${day}T23:59:59Z`)); descs.push(d); }
  }
  for (const e of readdirOrNull(path.join(root, 'memory')) ?? []) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const d = allowedFile(path.join(root, 'memory', e.name), { source: 'chats/laptop', node: `chats/laptop/memory/${slug(e.name.replace(/\.md$/, ''), 80)}`, parent: 'chats/laptop/memory', sort: 100, analyze: 'plain' });
    if (d) descs.push(d);
  }
  return { sources: ['chats/laptop'], descs, ok: true };
}

function collectSkills() {
  const root = path.join(HOME, '.agents', 'skills');
  const entries = readdirOrNull(root);
  if (!entries) return { sources: ['skills'], descs: [], ok: false, warning: 'skills: directory missing' };
  const descs = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || isDenied(e.name)) continue;
    const d = allowedFile(path.join(root, e.name, 'SKILL.md'), { source: 'skills', node: `skills/${e.name}`, parent: 'skills', sort: 100, analyze: 'skill', titleHint: e.name });
    if (d) descs.push(d);
  }
  return { sources: ['skills'], descs, ok: true };
}

export const CODE_REPOS = () => [['agent-desk', path.join(HOME, 'work', 'agent-desk')], ['explainer-pages', path.join(HOME, 'Dev', 'explainer-pages')]];

function collectCode() {
  const descs = [];
  let any = false;
  for (const [name, dir] of CODE_REPOS()) {
    if (!fs.existsSync(dir)) continue;
    any = true;
    const rels = walkFiles(dir, {
      maxDepth: 3,
      accept: (file, rel, depth) => /\.md$/i.test(file) && (depth === 0 || file === 'README.md' || rel.split('/').slice(0, -1).includes('docs')),
    });
    for (const rel of rels) {
      const top = rel.includes('/') ? rel.split('/')[0] : '';
      const d = allowedFile(path.join(dir, rel), {
        source: 'code', node: `code/${name}/${rel}`, parent: top ? `code/${name}/${top}` : `code/${name}`, sort: rel === 'README.md' ? 0 : 100,
        analyze: 'readme', titleHint: top ? rel.slice(top.length + 1) : rel,
      });
      if (d) descs.push(d);
    }
  }
  return { sources: ['code'], descs, ok: any };
}

function collectExplainer() {
  const root = path.join(HOME, 'Dev', 'explainer-pages', 'pages');
  const entries = readdirOrNull(root);
  if (!entries) return { sources: ['explainer'], descs: [], ok: false, warning: 'explainer: pages directory missing' };
  const descs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || isDenied(e.name)) continue;
    const dir = path.join(root, e.name);
    const deep = path.join(dir, 'deepdive.md');
    const html = path.join(dir, 'index.html');
    const base = { source: 'explainer', node: `explainer/${e.name}`, parent: 'explainer', sort: 100, analyze: 'explainer', titleHint: e.name };
    const pageTitle = () => {
      try { const t = JSON.parse(fs.readFileSync(path.join(dir, 'context.json'), 'utf8')).title; if (typeof t === 'string' && t.trim()) return squash(t, 160); } catch { /* no context.json */ }
      try {
        const m = /<title>([^<]*)<\/title>/i.exec(fs.readFileSync(html, 'utf8').slice(0, 20_000));
        return m ? squash(decodeEntities(m[1]), 160) : '';
      } catch { return ''; }
    };
    const d = allowedFile(deep, { ...base, pageTitle }) ?? allowedFile(html, { ...base, pageTitle, readTitleOnly: true });
    if (d) descs.push(d);
  }
  return { sources: ['explainer'], descs, ok: true };
}

const COLLECTORS = [collectWissen, collectDecisions, collectRegeln, collectJobs, collectLaptop, collectSkills, collectCode, collectExplainer];

// ---- board (sandy-read board-sql, incremental by entry id) ------------------------------------------------------------------
function boardSql(o, sql) {
  const out = execFileSync(o.boardCmd, ['board-sql', sql], { encoding: 'utf8', timeout: 180_000, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  return lines.slice(1).map((l) => { const row = JSON.parse(l); return Object.fromEntries(header.map((h, i) => [h, row[i]])); });
}

const boardFirstLine = (body) => squash(firstRealLine(body, { headings: true, max: 300 }) || String(body).slice(0, 200), 140);

// ---- the build ---------------------------------------------------------------------------------------------------------------
function acquireLock(dir) {
  const lock = path.join(dir, '.build.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = () => { try { fs.rmSync(lock, { force: true }); } catch { /* already gone */ } };
      process.on('exit', release);
      return release;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      let alive = false;
      if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
      if (alive) return null; // another build is running
      fs.rmSync(lock, { force: true }); // stale lock of a dead process
    }
  }
  return null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeStatus(dir, status) {
  const file = path.join(dir, STATUS_FILE);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(status, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export async function build(o) {
  const t0 = Date.now();
  const log = (m) => { if (!o.quiet) console.log(m); };
  const { DatabaseSync } = await loadSqlite();
  fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(o.dir, 0o700);
  const release = acquireLock(o.dir);
  if (!release) { log('another map build is running; nothing to do'); return { skipped: true }; }
  const live = path.join(o.dir, DB_FILE);
  const work = `${live}.build`;
  const previous = readJson(path.join(o.dir, STATUS_FILE));
  const startedAt = new Date().toISOString();
  try {
    // 1. the working file: the partial file of an interrupted run, else a copy of the live index, else a fresh one
    let fresh = o.full;
    const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
    if (!fresh) {
      const resume = mtimeOf(work) > mtimeOf(live);
      if (!resume && fs.existsSync(live)) { fs.rmSync(work, { force: true }); fs.copyFileSync(live, work, fs.constants.COPYFILE_FICLONE); }
      fresh = !fs.existsSync(work);
    }
    if (fresh) { fs.rmSync(work, { force: true }); fs.rmSync(`${work}-journal`, { force: true }); }
    let db = new DatabaseSync(work);
    const schemaOf = (d) => { try { return Number(d.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value); } catch { return 0; } };
    if (!fresh && schemaOf(db) !== SCHEMA_VERSION) {
      db.close();
      fs.rmSync(work, { force: true });
      db = new DatabaseSync(work);
      fresh = true;
      log(`schema version changed: full rebuild`);
    }
    fs.chmodSync(work, 0o600);
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -131072');
    if (fresh) { db.exec(SCHEMA_SQL); db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION)); }
    const meta = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;
    const setMeta = (k, v) => db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

    const st = {
      insDoc: db.prepare('INSERT INTO docs(path, source, node, title, mtime, size, class, kind, summary, extra) VALUES(?,?,?,?,?,?,?,?,?,?)'),
      updDoc: db.prepare('UPDATE docs SET source=?, node=?, title=?, mtime=?, size=?, class=?, kind=?, summary=?, extra=? WHERE id=?'),
      touchDoc: db.prepare('UPDATE docs SET node=?, class=? WHERE id=?'),
      docById: db.prepare('SELECT * FROM docs WHERE id = ?'),
      delDoc: db.prepare('DELETE FROM docs WHERE id = ?'),
      delChunks: db.prepare('DELETE FROM chunks WHERE rowid BETWEEN ? AND ?'),
      insChunk: db.prepare('INSERT INTO chunks(rowid, doc_id, line, heading, body) VALUES(?,?,?,?,?)'),
      delNodes: db.prepare('DELETE FROM nodes WHERE owner = ?'),
      insNode: db.prepare('INSERT OR REPLACE INTO nodes(path, parent, title, summary, size, updated, kind, open, class, sort, owner) VALUES(?,?,?,?,?,?,?,?,?,?,?)'),
    };
    let inTx = 0;
    const begin = () => { if (!inTx) { db.exec('BEGIN'); } inTx += 1; };
    const commit = (force = false) => { if (inTx && (force || inTx >= BATCH_DOCS)) { db.exec('COMMIT'); inTx = 0; } };
    const wipeDoc = (id) => { st.delChunks.run(chunkRowid(id, 0), chunkRowid(id, CHUNK_SPAN - 1)); st.delNodes.run(id); };
    const addNodes = (nodes) => { for (const n of nodes) st.insNode.run(n.path, n.parent, nul(n.title), nul(n.summary), nul(n.size), nul(n.updated), n.kind, nul(n.open), n.class, n.sort, n.owner); };

    const stats = { added: 0, updated: 0, touched: 0, removed: 0, skipped: 0, unchanged: 0, chunks: 0, boardAdded: 0 };
    const warnings = [];
    const existing = new Map(db.prepare("SELECT id, path, source, node, mtime, size, class FROM docs WHERE source != 'board'").all().map((r) => [r.path, r]));

    // 2. files
    const seen = new Set();
    const okSources = new Set();
    const timings = {};
    for (const collect of COLLECTORS) {
      const c0 = Date.now();
      let res;
      try { res = collect(o); } catch (err) { res = { sources: [], descs: [], ok: false, warning: `${collect.name}: ${String(err.message).slice(0, 160)}` }; }
      if (res.warning) warnings.push(res.warning);
      if (res.ok) res.sources.forEach((s) => okSources.add(s));
      for (const desc of res.descs) {
        seen.add(desc.path);
        desc.cls = classify({ source: desc.source, path: desc.path, title: desc.titleHint || '' });
        const ex = existing.get(desc.path);
        const same = ex && ex.size === desc.size && ex.mtime === desc.mtime && !o.full;
        begin();
        if (same && ex.node === desc.node && ex.class === desc.cls) { stats.unchanged += 1; commit(); continue; }
        if (same) { // same content, other place or class: nodes follow, the chunks stay
          st.touchDoc.run(desc.node, desc.cls, ex.id);
          st.delNodes.run(ex.id);
          addNodes(docNodes(desc, st.docById.get(ex.id)));
          stats.touched += 1; commit(); continue;
        }
        const done = indexDoc(desc, ex);
        if (done === 'skipped') stats.skipped += 1; else if (ex) stats.updated += 1; else stats.added += 1;
        commit();
      }
      timings[collect.name] = Date.now() - c0;
      log(`${collect.name}: ${res.descs.length} files (${timings[collect.name]} ms)`);
    }
    const held = new Map();
    const listed = new Map();
    for (const [p, ex] of existing) { held.set(ex.source, (held.get(ex.source) ?? 0) + 1); if (seen.has(p)) listed.set(ex.source, (listed.get(ex.source) ?? 0) + 1); }
    for (const src of okSources) {
      if ((held.get(src) ?? 0) >= o.shrinkMin && (listed.get(src) ?? 0) < (held.get(src) ?? 0) / 2) {
        okSources.delete(src);
        warnings.push(`${src}: only ${listed.get(src) ?? 0} of ${held.get(src)} indexed files are listed; nothing is removed this run`);
      }
    }
    for (const [p, ex] of existing) {
      if (seen.has(p) || !okSources.has(ex.source)) continue;
      begin(); wipeDoc(ex.id); st.delDoc.run(ex.id); stats.removed += 1; commit();
    }
    commit(true);

    function indexDoc(desc, ex) {
      let text;
      try { text = desc.readTitleOnly ? `# ${desc.pageTitle?.() || desc.titleHint}\n` : fs.readFileSync(desc.real, 'utf8'); } catch { return 'skipped'; }
      if (text.includes('\0') || PRIVATE_KEY.test(text)) { // binary, or a secret store: not indexed (and removed if it was)
        if (ex) { wipeDoc(ex.id); st.delDoc.run(ex.id); }
        return 'skipped';
      }
      let truncated = false;
      if (text.length > (desc.maxChars ?? MAX_INDEX_CHARS) && desc.analyze !== 'decisions') {
        text = text.slice(0, text.lastIndexOf('\n', desc.maxChars ?? MAX_INDEX_CHARS) + 1 || (desc.maxChars ?? MAX_INDEX_CHARS));
        truncated = true;
      }
      const a = analyze(desc, text);
      const title = R(squash(a.title || desc.titleHint || path.basename(desc.path), 200));
      const extra = a.extra ? JSON.stringify(redactDeepStrings(a.extra)) : truncated ? '{"truncated":true}' : null;
      const summary = R(a.summary || '');
      const chunks = chunkText(text, { splitRe: desc.splitRe });
      let id;
      if (ex) {
        id = ex.id;
        wipeDoc(id);
        st.updDoc.run(desc.source, desc.node, title, desc.mtime, desc.size, desc.cls, 'file', summary, extra, id);
      } else {
        id = Number(st.insDoc.run(desc.path, desc.source, desc.node, title, desc.mtime, desc.size, desc.cls, 'file', summary, extra).lastInsertRowid);
      }
      chunks.forEach((c, n) => { st.insChunk.run(chunkRowid(id, n), id, c.line, R(c.heading), R(c.body)); });
      stats.chunks += chunks.length;
      addNodes(docNodes(desc, st.docById.get(id)));
      return 'ok';
    }

    // 3. board
    let boardMax = Number(meta('board_max_id') || 0);
    if (o.board) {
      try {
        const b0 = Date.now();
        const threads = Object.fromEntries(boardSql(o, 'select id, title from threads').map((t) => [String(t.id), R(String(t.title ?? ''))]));
        setMeta('board_threads', JSON.stringify(threads));
        for (;;) {
          const rows = boardSql(o, `select id, thread_id, author, kind, created_at, substr(body, 1, ${BOARD_BODY_CHARS}) as body from entries where id > ${Math.trunc(boardMax)} order by id limit ${BOARD_PAGE}`);
          if (!rows.length) break;
          begin();
          for (const r of rows) {
            const body = String(r.body ?? '');
            const ms = Date.parse(r.created_at) || 0;
            const node = `board/${r.thread_id}`;
            const dpath = `${node}/${r.id}`;
            const title = R(boardFirstLine(body));
            const id = Number(st.insDoc.run(dpath, 'board', node, title, ms, body.length, classify({ source: 'board', path: dpath, title }), 'board', R(squash(`${r.kind} · ${r.author}`, 100)), null).lastInsertRowid);
            const chunks = chunkText(body);
            chunks.forEach((c, n) => { st.insChunk.run(chunkRowid(id, n), id, 0, R(c.heading), R(c.body)); });
            stats.chunks += chunks.length;
            stats.boardAdded += 1;
            boardMax = Math.max(boardMax, Number(r.id));
          }
          setMeta('board_max_id', boardMax);
          commit(true);
          if (stats.boardAdded >= o.maxBoard || rows.length < BOARD_PAGE) break;
        }
        timings.board = Date.now() - b0;
        log(`board: ${stats.boardAdded} new entries up to #${boardMax} (${timings.board} ms)`);
      } catch (err) {
        if (inTx) { db.exec('COMMIT'); inTx = 0; }
        warnings.push(`board: skipped (${String(err.message).split('\n')[0].slice(0, 160)}); old entries stay`);
      }
    }

    // 4. the tree: aggregate nodes (owner 0) are rebuilt from the docs table every run
    begin();
    st.delNodes.run(0);
    addNodes(aggregateNodes(db, o, meta));
    commit(true);

    // 5. finish: counts, meta, atomic replace
    const counts = {
      docs: db.prepare('SELECT count(*) AS n FROM docs').get().n,
      chunks: db.prepare('SELECT count(*) AS n FROM chunks').get().n,
      nodes: db.prepare('SELECT count(*) AS n FROM nodes').get().n,
    };
    const bySource = Object.fromEntries(db.prepare('SELECT source, count(*) AS n, max(mtime) AS newest FROM docs GROUP BY source').all().map((r) => [r.source, { docs: r.n, newest: isoMinute(r.newest) }]));
    setMeta('counts', JSON.stringify(counts));
    setMeta('built_at', new Date().toISOString());
    setMeta('warnings', JSON.stringify(warnings));
    db.exec('PRAGMA optimize');
    db.close();
    fs.chmodSync(work, 0o600);
    fs.renameSync(work, live);
    const bytes = fs.statSync(live).size;
    const status = {
      ok: true, startedAt, finishedAt: new Date().toISOString(), ms: Date.now() - t0, full: fresh, schema: SCHEMA_VERSION, ...counts, bytes,
      changes: stats, sources: bySource, timings, warnings, lastError: null,
    };
    writeStatus(o.dir, status);
    console.log(JSON.stringify({ docs: counts.docs, chunks: counts.chunks, nodes: counts.nodes, bytes, ms: status.ms, full: fresh, changes: stats, warnings })); // the one line the refresh log keeps
    return status;
  } catch (err) {
    const message = redact(String(err?.stack ?? err)).split('\n').slice(0, 4).join(' | ').slice(0, 500);
    writeStatus(o.dir, { ...(previous ?? {}), ok: false, lastError: { at: new Date().toISOString(), message } });
    throw err;
  } finally {
    release();
  }
}

/** redact() every string of a small JSON value (decision/section titles and summaries). */
function redactDeepStrings(v) {
  if (typeof v === 'string') return R(v);
  if (Array.isArray(v)) return v.map(redactDeepStrings);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeepStrings(x)]));
  return v;
}

// ---- nodes of a single doc (its leaf and, for DECISIONS.md / AGENTS.md, its entries and sections) -------------------------------
function docNodes(desc, doc) {
  const extra = doc.extra ? JSON.parse(doc.extra) : {};
  const own = { owner: doc.id, class: doc.class };
  if (desc.analyze === 'decisions') return decisionNodes(desc, doc, extra, own);
  const kids = extra.sections ?? [];
  const nodes = [{
    path: desc.node, parent: desc.parent, title: doc.title, summary: doc.summary, size: doc.size, updated: doc.mtime,
    kind: kids.length ? 'document' : desc.source === 'chats/laptop' && desc.analyze === 'laptop-day' ? 'day' : 'file',
    open: kids.length ? openHint.discover(desc.node) : openHint.readFile(doc.path), sort: desc.sort, ...own,
  }];
  if (kids.length) nodes[0].summary = squash(`${doc.summary} [${doc.path}; ${kids.length} Abschnitte]`, 300);
  const used = new Set();
  kids.forEach((s, i) => {
    let p = `${desc.node}/${slug(s.title, 50)}`;
    for (let n = 2; used.has(p); n += 1) p = `${desc.node}/${slug(s.title, 50)}-${n}`;
    used.add(p);
    nodes.push({ path: p, parent: desc.node, title: s.title, summary: s.summary, size: null, updated: doc.mtime, kind: 'section', open: openHint.readFile(doc.path, s.line, s.limit), sort: i, ...own, class: classify({ source: 'regeln', path: p, title: s.title }) });
  });
  return nodes;
}

function decisionNodes(desc, doc, extra, own) {
  const entries = extra.entries ?? [];
  const nodes = [];
  const months = new Map();
  const used = new Set();
  entries.forEach((e, i) => {
    if (!months.has(e.month)) months.set(e.month, { count: 0, newest: e.ms, first: e.title });
    const m = months.get(e.month);
    m.count += 1;
    let p = `entscheidungen/${e.month}/${slug(e.title, 60)}`;
    for (let n = 2; used.has(p); n += 1) p = `entscheidungen/${e.month}/${slug(e.title, 60)}-${n}`;
    used.add(p);
    nodes.push({
      path: p, parent: `entscheidungen/${e.month}`, title: e.title, summary: e.summary, size: null, updated: e.ms || doc.mtime, kind: 'entry',
      open: openHint.readFile(doc.path, e.line, e.limit), sort: i, ...own, class: classify({ source: 'entscheidungen', path: p, title: e.title }),
    });
  });
  const order = [...months.keys()].sort().reverse();
  order.forEach((month, i) => {
    const m = months.get(month);
    nodes.push({
      path: `entscheidungen/${month}`, parent: 'entscheidungen', title: month, summary: squash(`${m.count} Entscheidungen; neueste: ${m.first}`, 240), size: null,
      updated: m.newest, kind: 'month', open: openHint.discover(`entscheidungen/${month}`), sort: i, ...own, class: 'open',
    });
  });
  return nodes;
}

// ---- aggregate nodes: root, jobs, board, laptop projects/sessions, code repos --------------------------------------------------
const ROOT_INFO = {
  wissen: { title: 'Wissen', text: 'Kuratierte Themenseiten (Steuer, Server, Engines, Kunden …): die verlässlichsten Zusammenfassungen, zuerst lesen.', live: false },
  entscheidungen: { title: 'Entscheidungen', text: 'DECISIONS.md: jede Entscheidung von Florian und den Agenten, neueste zuerst, nach Monat und Eintrag.', live: false },
  'chats/laptop': { title: 'Laptop-Chats', text: 'Florians eigene Worte und die Antworten des Laptop-Agenten: Projekt → Sitzung → Tag; dazu die Notizen des Laptop-Agenten (memory/).', live: false },
  'desk-sitzungen': { title: 'Desk-Sitzungen', text: 'Frühere Gespräche mit dem Agent Desk (Sprache und Text). Live: conversation_history, desk_sessions, session_trace.', open: 'desk_sessions()', live: true },
  jobs: { title: 'Jobs', text: 'Alle Job-Ordner der Agenten (Notizen STATE/RESULT/PROMPT), nach Monat; jeder Job mit Status und erster Zeile des Ergebnisses.', live: false },
  board: { title: 'Agent-Board', text: 'Das gemeinsame Board der Agenten: Threads und alle Einträge (volltextindiziert). Live: board_threads, board_read, board_search.', live: false },
  'chats/sandy': { title: 'Agent-Chats Sandy', text: 'Claude-/Codex-Sitzungen auf Sandy. Live-Suche mit chats_search, kein Index.', open: 'chats_search(query="<Stichwort>", host="sandy")', live: true },
  'chats/lechonk': { title: 'Agent-Chats LeChonk', text: 'Claude-/Codex-Sitzungen auf LeChonk. Live-Suche mit chats_search, kein Index.', open: 'chats_search(query="<Stichwort>", host="lechonk")', live: true },
  regeln: { title: 'Regeln und Stand', text: 'AGENTS.md (gemeinsame Regeln, nach Abschnitten), STATE.md, CLAUDE.md, Modellwahl-Regeln.', live: false },
  artefakte: { title: 'Artefakte', text: 'Register der Artefakt-IDs (a#abc123): Seiten, Karten, Jobs. Live: artifact_search, artifact_resolve.', open: 'artifact_search(q="<Stichwort>")', live: true },
  skills: { title: 'Skills', text: 'Die Fähigkeiten-Handbücher der Agenten (SKILL.md): Name und Beschreibung.', live: false },
  explainer: { title: 'Erklärseiten', text: 'Interaktive Erklärvideos (explainers.app.mintapis.com): Titel und Slug.', live: false },
  code: { title: 'Code', text: 'Die Code-Repos (agent-desk, explainer-pages): README und Doku indiziert, Ordner mit code_outline.', live: false },
  ledger: { title: 'Ledger', text: 'Geldbewegungen und Ausgaben (finanziell, nur lesen). Live: ledger_spend.', open: 'ledger_spend()', live: true },
  server: { title: 'Server', text: 'Zustand der Server über feste Lesebefehle: run_readonly quota_status, disk, jobs_running, sched_list, asks_open.', open: 'run_readonly(command="quota_status")', live: true },
  gpu: { title: 'GPU', text: 'GPU-Ledger, kommt.', live: true },
  mail: { title: 'Mail', text: 'Florians Postfächer (nur lesen, live). mail_search.', open: 'mail_search(query="<Stichwort>")', live: true },
  discord: { title: 'Discord', text: 'Discord-DMs und Kanäle (nur lesen, live). discord_read.', open: 'discord_read()', live: true },
  datenbanken: { title: 'Datenbanken', text: 'App-Datenbanken (Umsatz, Logs, Benchmark Heaven): Phase 2, noch nicht angeschlossen.', live: true },
  web: { title: 'Web', text: 'Websuche und HTTP-Abruf: Phase 2, noch nicht angeschlossen.', live: true },
};

const plural = (n, one, many) => `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`;

function aggregateNodes(db, o, meta) {
  const nodes = [];
  const add = (n) => nodes.push({ owner: 0, size: null, updated: null, open: null, summary: '', class: 'open', ...n });
  const bySource = Object.fromEntries(db.prepare('SELECT source, count(*) AS n, max(mtime) AS newest, sum(size) AS bytes FROM docs GROUP BY source').all().map((r) => [r.source, r]));

  // root
  SOURCE_ORDER.forEach((name, i) => {
    const info = ROOT_INFO[name];
    const s = bySource[name];
    const counts = s ? ` (${plural(s.n, 'Dokument', 'Dokumente')}, neueste ${isoMinute(s.newest).slice(0, 10)})` : '';
    add({
      path: name, parent: '', title: info.title, summary: `${info.text}${info.live ? '' : counts}`, size: s?.bytes ?? null, updated: s?.newest ?? null,
      kind: info.live ? 'live' : 'source', open: info.open ?? openHint.discover(name), class: classify({ source: name, path: name, title: info.title }), sort: i * 10,
    });
  });

  // jobs: month -> job
  const jobs = new Map();
  for (const r of db.prepare("SELECT path, node, mtime, size, summary, extra FROM docs WHERE source = 'jobs'").all()) {
    const parts = r.node.split('/');
    const key = `${parts[1]}/${parts[2]}`;
    const j = jobs.get(key) ?? { month: parts[1], name: parts[2], size: 0, mtime: 0, files: new Map() };
    const rel = parts.slice(3).join('/');
    j.files.set(rel, { summary: r.summary, extra: r.extra });
    j.size += r.size ?? 0;
    j.mtime = Math.max(j.mtime, r.mtime ?? 0);
    jobs.set(key, j);
  }
  const months = new Map();
  for (const j of jobs.values()) {
    const state = j.files.get('STATE.md');
    const status = state ? (JSON.parse(state.extra ?? '{}').status ?? 'open') : 'no STATE.md';
    const line = j.files.get('RESULT.md')?.summary || j.files.get('PROMPT.md')?.summary || state?.summary || '';
    j.node = {
      path: `jobs/${j.month}/${j.name}`, parent: `jobs/${j.month}`, title: j.name, summary: squash(line ? `${status} · ${line}` : status, 260), size: j.size, updated: j.mtime,
      kind: 'job', open: openHint.jobStatus(j.name), class: classify({ source: 'jobs', path: j.name, title: line }),
    };
    const m = months.get(j.month) ?? { jobs: [], mtime: 0 };
    m.jobs.push(j);
    m.mtime = Math.max(m.mtime, j.mtime);
    months.set(j.month, m);
  }
  [...months.keys()].sort().reverse().forEach((month, i) => {
    const m = months.get(month);
    m.jobs.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    m.jobs.forEach((j, k) => add({ ...j.node, sort: k }));
    const done = m.jobs.filter((j) => j.node.summary.startsWith('FINAL DONE')).length;
    add({
      path: `jobs/${month}`, parent: 'jobs', title: month, summary: squash(`${plural(m.jobs.length, 'Job', 'Jobs')}, ${done} FINAL DONE; zuletzt aktiv: ${m.jobs[0].name}`, 240),
      size: m.jobs.reduce((s, j) => s + j.size, 0), updated: m.mtime, kind: 'month', open: openHint.discover(`jobs/${month}`), sort: i,
    });
  });

  // board threads
  const threadTitles = JSON.parse(meta('board_threads') || '{}');
  const threads = db.prepare("SELECT node, count(*) AS n, max(mtime) AS newest, sum(size) AS bytes FROM docs WHERE source = 'board' GROUP BY node ORDER BY newest DESC").all();
  threads.forEach((t, i) => {
    const id = t.node.slice('board/'.length);
    const title = threadTitles[id] || `Thread ${id}`;
    add({
      path: t.node, parent: 'board', title, summary: `Thread #${id}: ${plural(t.n, 'Eintrag', 'Einträge')}, zuletzt ${isoMinute(t.newest)}`, size: t.bytes, updated: t.newest,
      kind: 'thread', open: openHint.boardRead(id), class: classify({ source: 'board', path: t.node, title }), sort: i,
    });
  });

  // laptop: project -> session (days are per-doc nodes), memory
  const projects = new Map();
  let memory = 0;
  let memoryNewest = 0;
  for (const r of db.prepare("SELECT node, mtime, size FROM docs WHERE source = 'chats/laptop'").all()) {
    const parts = r.node.split('/');
    if (parts[2] === 'memory') { memory += 1; memoryNewest = Math.max(memoryNewest, r.mtime ?? 0); continue; }
    if (parts.length < 5) continue; // INDEX
    const [, , project, sid, day] = parts;
    const p = projects.get(project) ?? new Map();
    const s = p.get(sid) ?? { days: [], size: 0, newest: 0 };
    s.days.push(day);
    s.size += r.size ?? 0;
    s.newest = Math.max(s.newest, r.mtime ?? 0);
    p.set(sid, s);
    projects.set(project, p);
  }
  if (memory) add({ path: 'chats/laptop/memory', parent: 'chats/laptop', title: 'Notizen des Laptop-Agenten (memory/)', summary: `${plural(memory, 'Notizdatei', 'Notizdateien')}: Regeln, Feedback und Projektwissen des Laptop-Agenten (MEMORY.md ist das Verzeichnis)`, updated: memoryNewest, kind: 'folder', open: openHint.discover('chats/laptop/memory'), class: 'personal', sort: 1 });
  [...projects.entries()].map(([name, sessions]) => ({ name, sessions, newest: Math.max(...[...sessions.values()].map((s) => s.newest)) })).sort((a, b) => b.newest - a.newest).forEach((p, i) => {
    const days = [...p.sessions.values()].reduce((n, s) => n + s.days.length, 0);
    add({
      path: `chats/laptop/${p.name}`, parent: 'chats/laptop', title: `Projekt ${p.name}`, summary: `${plural(p.sessions.size, 'Sitzung', 'Sitzungen')}, ${plural(days, 'Tag', 'Tage')}`,
      updated: p.newest, kind: 'project', open: openHint.discover(`chats/laptop/${p.name}`), class: 'personal', sort: 10 + i,
    });
    [...p.sessions.entries()].sort((a, b) => b[1].newest - a[1].newest).forEach(([sid, s], k) => {
      const sorted = [...s.days].sort();
      add({
        path: `chats/laptop/${p.name}/${sid}`, parent: `chats/laptop/${p.name}`, title: `Sitzung ${sid}`, summary: `${plural(s.days.length, 'Tag', 'Tage')}, ${sorted[0]} bis ${sorted.at(-1)}, ${Math.round(s.size / 1024)} KB`,
        size: s.size, updated: s.newest, kind: 'session', open: openHint.discover(`chats/laptop/${p.name}/${sid}`), class: 'personal', sort: k,
      });
    });
  });

  // code: repos and their top-level folders
  for (const [name, dir] of CODE_REPOS()) {
    if (!fs.existsSync(dir)) continue;
    const readme = db.prepare('SELECT summary, mtime FROM docs WHERE path = ?').get(path.join(dir, 'README.md'));
    const docsIn = new Map();
    for (const r of db.prepare("SELECT node FROM docs WHERE source = 'code' AND node LIKE ? ESCAPE '\\'").all(`code/${name.replace(/[%_\\]/g, '\\$&')}/%`)) {
      const top = r.node.split('/')[2];
      docsIn.set(top, (docsIn.get(top) ?? 0) + 1);
    }
    add({ path: `code/${name}`, parent: 'code', title: name, summary: squash(readme?.summary || `Repo ${name}`, 300), updated: readme?.mtime ?? null, kind: 'repo', open: openHint.discover(`code/${name}`), sort: name === 'agent-desk' ? 0 : 1 });
    const dirs = (readdirOrNull(dir) ?? []).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && !isDenied(e.name)).map((e) => e.name).sort();
    dirs.forEach((d, i) => {
      const docs = docsIn.get(d) ?? 0;
      const isDocs = d === 'docs';
      add({
        path: `code/${name}/${d}`, parent: `code/${name}`, title: `${d}/`, summary: isDocs ? plural(docs, 'Dokument', 'Dokumente') : `Quellcode${docs ? `; ${plural(docs, 'Doku-Datei', 'Doku-Dateien')} über discover` : ''}`,
        kind: 'dir', open: isDocs ? openHint.discover(`code/${name}/${d}`) : openHint.codeOutline(path.join(dir, d)), sort: 10 + i,
      });
    });
  }
  return nodes;
}

// ---- entry point ------------------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await build(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`map build failed: ${redact(String(err?.message ?? err))}`);
    process.exit(1);
  }
}
