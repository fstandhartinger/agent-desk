// Shared by the map builder (scripts/map/build.mjs) and the map methods (src/map.js): the SQLite schema, the chunker,
// the class tagging and the helpers that turn a stored row into the hint a model can act on.
//
// The map lives in ~/desk-knowledge/map/ (private, never in the repo): index.sqlite (docs, FTS5 chunks, nodes) and
// status.json. It is written ONLY by scripts/map/build.mjs and opened read-only by the bridge.
import path from 'node:path';
import { KNOWLEDGE_DIR } from './paths.js';

export const SCHEMA_VERSION = 1;
export const MAP_DIR = process.env.BRIDGE_MAP_DIR || path.join(KNOWLEDGE_DIR, 'map');
export const DB_FILE = 'index.sqlite';
export const STATUS_FILE = 'status.json';

/** Top-level sources of the map, most useful first (the order of `discover()` at the root). */
export const SOURCE_ORDER = [
  'wissen', 'entscheidungen', 'chats/laptop', 'desk-sitzungen', 'jobs', 'board', 'chats/sandy', 'chats/lechonk', 'regeln',
  'artefakte', 'skills', 'explainer', 'code', 'ledger', 'server', 'gpu', 'mail', 'discord', 'datenbanken', 'web',
];

/** rowid of chunk n of doc id: deleting a doc's chunks is a rowid range delete (an FTS5 UNINDEXED column has no index). */
export const CHUNK_SPAN = 100_000;
export const chunkRowid = (docId, n) => docId * CHUNK_SPAN + n;

export const SCHEMA_SQL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE docs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  node TEXT NOT NULL,
  title TEXT,
  mtime INTEGER,
  size INTEGER,
  class TEXT NOT NULL DEFAULT 'open',
  kind TEXT NOT NULL DEFAULT 'file',
  summary TEXT,
  extra TEXT
);
CREATE INDEX docs_source ON docs(source);
CREATE INDEX docs_node ON docs(node);
CREATE VIRTUAL TABLE chunks USING fts5(doc_id UNINDEXED, line UNINDEXED, heading, body, tokenize = 'unicode61 remove_diacritics 2', prefix = '3 4');
CREATE TABLE nodes(
  path TEXT PRIMARY KEY,
  parent TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  size INTEGER,
  updated INTEGER,
  kind TEXT,
  open TEXT,
  class TEXT NOT NULL DEFAULT 'open',
  sort INTEGER NOT NULL DEFAULT 0,
  owner INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX nodes_parent ON nodes(parent, sort);
CREATE INDEX nodes_owner ON nodes(owner);
`;

// ---- classes ----------------------------------------------------------------------------------------------------------
export const FINANCE_RE = /tax|steuer|emission|ledger|wallet|kraken|invoice/i;
const PERSONAL_SOURCES = /^(chats(\/|$)|mail|discord)/;

/**
 * open | personal | finance. Sources that are Florian's own chats/mail/Discord (and the laptop memory) are `personal`;
 * the ledger and every doc whose path or title mentions tax/steuer/emission/ledger/wallet/kraken/invoice are `finance`.
 * A personal source stays personal (the stricter of the two is decided by the gateway, which treats both as restricted).
 */
export function classify({ source = '', path: p = '', title = '' } = {}) {
  if (PERSONAL_SOURCES.test(source)) return 'personal';
  if (source === 'ledger' || FINANCE_RE.test(p) || FINANCE_RE.test(title)) return 'finance';
  return 'open';
}

// ---- text helpers -----------------------------------------------------------------------------------------------------
export const squash = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const trimDashes = (s) => {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '-') a += 1;
  while (b > a && s[b - 1] === '-') b -= 1;
  return s.slice(a, b);
};

/** Lowercase ASCII slug for node names ("2026-11-15 19:03Z — fast-lane order" → "2026-11-15-1903z-fast-lane-order"). */
export function slug(s, max = 48) {
  const t = trimDashes(String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-'));
  return trimDashes(t.slice(0, max)) || 'x';
}

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
export const headingOf = (line) => { const m = HEADING.exec(line); return m ? m[1] : null; };

const SKIP_LINE = /^(?:[-*_=]{3,}|\|?[\s:|-]{3,}\|?|<!--.*-->|<!--.*|.*-->|```.*|---|\[!.*\])$/;
const META_LINE = /^(?:JOB_HOST|WORKER_HOST|Lead|Created|Board name|Status|Date|Stand)\s*:/i;

/**
 * First real line of a text: skips front matter, HTML comments, rules, table separators, code fences, bare metadata keys and,
 * unless `headings`, heading lines (a heading is used only when nothing else is there). Markup like `**` and a leading
 * bullet is dropped. Returns '' for an empty text.
 */
export function firstRealLine(text, { headings = false, max = 200 } = {}) {
  const lines = String(text ?? '').split('\n', 200);
  let i = 0;
  if (lines[0]?.trim() === '---') { // YAML front matter
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }
  let firstHeading = '';
  let inComment = false;
  for (; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (inComment) { if (raw.includes('-->')) inComment = false; continue; }
    if (raw.startsWith('<!--') && !raw.includes('-->')) { inComment = true; continue; }
    if (!raw || SKIP_LINE.test(raw) || META_LINE.test(raw)) continue;
    const h = headingOf(raw);
    if (h !== null) {
      if (!firstHeading) firstHeading = h;
      if (headings) return squash(h.replace(/[*_`]/g, ''), max);
      continue;
    }
    return squash(raw.replace(/^[-*+>]\s+/, '').replace(/\*\*|__|`/g, ''), max);
  }
  return squash(firstHeading.replace(/[*_`]/g, ''), max);
}

/** First sentence of a block (up to `max` chars): ends at ". ", "! ", "? " or the end of the first line. */
export function firstSentence(text, max = 220) {
  const line = firstRealLine(text, { max: 4000 });
  const m = /^(.{12,}?[.!?])(?:\s|$)/.exec(line);
  return squash(m ? m[1] : line, max);
}

/** FINAL DONE | PARKED | open, from the last non-empty line of a STATE.md (the job protocol's finish line). */
export function stateStatus(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^[-*\s]*FINAL DONE\b/i.test(l)) return 'FINAL DONE';
    if (/^[-*\s]*PARKED\b/i.test(l)) return 'PARKED';
    return 'open';
  }
  return 'open';
}

// ---- chunker ----------------------------------------------------------------------------------------------------------
export const CHUNK_MIN = 1200;
export const CHUNK_MAX = 1800;
const HEADING_FLUSH_MIN = 500;

/**
 * Cuts a text into chunks of about CHUNK_MIN..CHUNK_MAX characters, at headings and paragraph breaks where possible.
 * Each chunk is {line, heading, body}: `line` is the 0-based line the chunk starts on (the offset for read_file, whose
 * offsets are LINES), `heading` the nearest heading above (or at) the start. `splitRe` lines (e.g. /^## /) always start a
 * new chunk, so a chunk never holds two decisions. A single line longer than CHUNK_MAX is cut on spaces; its pieces keep
 * the line number. At most `maxChunks` chunks are produced.
 */
export function chunkText(text, { splitRe = null, maxChunks = 90_000 } = {}) {
  const lines = String(text ?? '').split('\n');
  const chunks = [];
  let heading = '';
  let cur = null; // {line, heading, parts, len}
  const flush = () => {
    if (cur) {
      const body = cur.parts.join('\n').trim();
      if (body) chunks.push({ line: cur.line, heading: cur.heading, body });
    }
    cur = null;
  };
  const start = (line) => { cur = { line, heading, parts: [], len: 0 }; };
  const add = (s) => { cur.parts.push(s); cur.len += s.length + 1; };
  for (let i = 0; i < lines.length && chunks.length < maxChunks; i += 1) {
    const raw = lines[i].trimEnd();
    const h = headingOf(raw);
    if (h !== null) {
      if (cur && (splitRe?.test(raw) || cur.len >= HEADING_FLUSH_MIN)) flush();
      heading = squash(h.replace(/[*_`]/g, ''), 160);
    } else if (!raw) {
      // paragraph break: a good place to cut once the chunk is big enough; never start a chunk on a blank line
      if (cur) { if (cur.len >= CHUNK_MIN) flush(); else add(''); }
      continue;
    }
    if (!cur) start(i);
    if (raw.length > CHUNK_MAX) {
      // a long line (a table row, a pasted blob): cut on spaces; every piece keeps the line number
      if (cur.len > 0) { flush(); start(i); }
      let rest = raw;
      while (rest.length > CHUNK_MAX && chunks.length < maxChunks) {
        let cut = rest.lastIndexOf(' ', CHUNK_MAX);
        if (cut < CHUNK_MIN) cut = CHUNK_MAX;
        add(rest.slice(0, cut));
        flush();
        rest = rest.slice(cut).trimStart();
        start(i);
      }
      add(rest);
      continue;
    }
    if (cur.len > 0 && cur.len + raw.length + 1 > CHUNK_MAX) { flush(); start(i); }
    add(raw);
  }
  flush();
  return chunks;
}

// ---- timestamps and open hints ----------------------------------------------------------------------------------------
/** epoch ms → "2026-11-15T19:03Z" (minute precision); null/0 → ''. */
export function isoMinute(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

const q = (s) => JSON.stringify(String(s));

/** The tool call that opens a node or a hit. `line` is a 0-based chunk start line; `limit` an optional line count. */
export const openHint = {
  discover: (p) => `discover(${q(p)})`,
  readFile: (p, line = 0, limit = 0) => `read_file(${q(p)}${line > 0 ? `, offset=${line}` : ''}${limit > 0 ? `, limit=${limit}` : ''})`,
  jobStatus: (name) => `job_status(${q(name)})`,
  boardEntry: (id) => `board_entry(${q(String(id))})`,
  boardRead: (thread) => `board_read(${q(String(thread))})`,
  codeOutline: (p) => `code_outline(${q(p)})`,
};
