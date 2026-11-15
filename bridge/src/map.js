// map.discover / map.search / map.status: the read side of the Agent Desk map (LeChonk bridge only).
// The index is built by scripts/map/build.mjs into ~/desk-knowledge/map/index.sqlite; this module opens it READ-ONLY and
// re-opens it whenever the file is replaced (the builder swaps in a finished file with one rename).
//
// Needs Node >= 22.5 (node:sqlite), loaded lazily so the Sandy bridge (Node 20) can still import bridge.js; map.* is
// registered for host lechonk only. Every text in the index was redacted by the builder; hits are cut from it.
import fs from 'node:fs';
import path from 'node:path';
import { expandQuery, groupsIn } from './searchTerms.js';
import { assertNoSecretFragment } from './secretQuery.js';
import { isDenied } from './paths.js';
import { DB_FILE, MAP_DIR, SCHEMA_VERSION, STATUS_FILE, isoMinute, openHint, squash } from './mapIndex.js';

const DEFAULT_DISCOVER = 20;
const MAX_DISCOVER = 40;
const DEFAULT_SEARCH = 10;
const MAX_SEARCH = 40;
const MAX_QUERY_CHARS = 300;
const SNIPPET_CHARS = 300;
const HEADING_WEIGHT = 3.0;
const BM25 = `bm25(chunks, 0, 0, ${HEADING_WEIGHT.toFixed(1)}, 1.0)`; // columns: doc_id, line, heading, body (the first two are unindexed)
const PER_DOC = 2; // chunks of one document shown at most

let mapDir = null;
/** Tests: another map directory (null = the default). */
export function setMapDirForTests(dir) { mapDir = dir; closeHandle(); }
const dirNow = () => mapDir ?? process.env.BRIDGE_MAP_DIR ?? MAP_DIR;

// ---- database handle ---------------------------------------------------------------------------------------------------------
let sqlite = null;
let handle = null; // {file, mtimeMs, ino, db, stmts}

function closeHandle() {
  try { handle?.db.close(); } catch { /* close failed: the handle is gone (no handle to keep) */ }
  handle = null;
}

async function database() {
  if (!sqlite) {
    try { sqlite = await import('node:sqlite'); } catch {
      throw new Error(`map needs Node >= 22.5 (node:sqlite); this bridge runs Node ${process.versions.node}`);
    }
  }
  const file = path.join(dirNow(), DB_FILE);
  let st;
  try { st = fs.statSync(file); } catch { throw new Error('the map is not built yet (scripts/map/build.mjs has not finished a run)'); }
  if (handle && handle.file === file && handle.mtimeMs === st.mtimeMs && handle.ino === st.ino) return handle;
  closeHandle();
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value);
  if (version !== SCHEMA_VERSION) { db.close(); throw new Error(`map schema version ${version} != ${SCHEMA_VERSION}; the next build rebuilds it`); }
  handle = { file, mtimeMs: st.mtimeMs, ino: st.ino, db, stmts: new Map(), df: new Map() };
  return handle;
}

const stmt = (h, sql) => { let s = h.stmts.get(sql); if (!s) { s = h.db.prepare(sql); h.stmts.set(sql, s); } return s; };

const clampInt = (v, def, min, max) => {
  const n = Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : def;
  return Math.min(max, Math.max(min, n));
};

/** 'jobs/2026-11/' / '/jobs' / '' → 'jobs/2026-11' / 'jobs' / ''. */
export function normalizeMapPath(p) {
  const s = String(p ?? '').trim();
  if (s.length > 400 || s.includes('\0')) throw new Error('invalid path');
  return s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

// ---- query → FTS5 ---------------------------------------------------------------------------------------------------------------
// Extra German -> English rows for the map, on top of the shared table in searchTerms.js (which serves ctx.search). A query
// word pulls a row in when it is (or starts with) one of the row's German `keys`; the English words then join its group.
// One direction on purpose: English words such as "review" are common in the notes, and widening them to ten more words
// makes a query rank 100,000 chunks (200 ms).
const EXTRA_SYNONYMS = [
  { keys: ['stund'], add: ['hour', 'hours'] },
  { keys: ['bewert', 'wertung'], add: ['bewert', 'wertung', 'scoring', 'score', 'evaluation', 'rating', 'graded'] },
  { keys: ['phase'], add: ['window', 'stage', 'period'] },
  { keys: ['anzeige'], add: ['ads', 'advert'] },
  { keys: ['runde'], add: ['round', 'rounds'] },
  { keys: ['dauer'], add: ['duration', 'length', 'lasts', 'takes'] },
  { keys: ['extern'], add: ['external', 'third-party'] },
  { keys: ['konten', 'konto'], add: ['konto', 'konten', 'account', 'accounts'] },
  { keys: ['routing'], add: ['router', 'route'] },
  { keys: ['krypto'], add: ['crypto', 'cryptocurrency', 'mining', 'miner'] },
  { keys: ['regel'], add: ['rule', 'rules', 'policy'] },
  { keys: ['verbot'], add: ['forbidden', 'never', 'prohibited'] },
  { keys: ['kosten', 'preis'], add: ['cost', 'costs', 'price'] },
  { keys: ['entscheidung'], add: ['decision', 'decided'] },
];

export const fold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const translit = (s) => s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

function widen(variants) {
  const out = new Set(variants);
  for (const row of EXTRA_SYNONYMS) {
    if (variants.some((v) => row.keys.some((k) => v === k || v.startsWith(k) || (v.length >= 4 && k.startsWith(v))))) row.add.forEach((w) => out.add(w));
  }
  for (const v of [...out]) { const t = translit(v); if (t !== v) out.add(t); }
  return [...out];
}

/** The expanded term groups of a query: [{word, variants}] (DE<->EN rows, compounds, stems, umlaut transliteration). */
export function queryGroups(query) {
  return expandQuery(query).map((g) => ({ word: g.word, variants: widen(g.variants) }));
}

/** One FTS5 term: a quoted phrase (never an operator), prefix-matched when it is a single token of 4+ characters. */
function ftsTerm(variant) {
  const clean = String(variant).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!clean) return null;
  return `"${clean}"${!clean.includes(' ') && clean.length >= 4 ? '*' : ''}`;
}

/**
 * {strict, groups}: `strict` requires every group (each an OR of its variants). Everything
 * that reaches FTS5 is a double-quoted phrase joined by our own AND/OR and parentheses, so a query cannot inject an
 * operator, a column filter (`heading:`), NEAR() or a prefix marker.
 */
export function buildMatch(query) {
  const q = String(query ?? '').trim().slice(0, MAX_QUERY_CHARS);
  const groups = queryGroups(q).map((g) => ({ ...g, terms: g.variants.map(ftsTerm).filter(Boolean) })).filter((g) => g.terms.length);
  if (!groups.length) return { groups: [], strict: null };
  const strict = groups.map((g) => `(${g.terms.join(' OR ')})`).join(' AND ');
  return { groups, strict };
}

// ---- candidates, ranking, snippets ------------------------------------------------------------------------------------------------
// curated pages first (the same idea as ctx.search: a knowledge page beats a job note that merely mentions the words)
const SOURCE_BONUS = { wissen: 8, entscheidungen: 3, regeln: 3, 'chats/laptop': 1.5, code: 1, skills: 0.5 };
const COVERAGE_WEIGHT = 6;
const FRESH_WEIGHT = 3;
const FRESH_HALF_LIFE_DAYS = 60;

function filters({ source, subtree, docPath, lines, since }) {
  const where = ['chunks MATCH ?'];
  const params = [];
  if (source) { where.push('d.source = ?'); params.push(source); }
  if (docPath) {
    // below a document (a DECISIONS month or entry, an AGENTS section): that file, and its line range when the node has one
    where.push('d.path = ?'); params.push(docPath);
    if (lines) { where.push('chunks.line BETWEEN ? AND ?'); params.push(lines[0], lines[1]); }
  } else if (subtree) { where.push('(d.node = ? OR substr(d.node, 1, ?) = ?)'); params.push(subtree, subtree.length + 1, `${subtree}/`); }
  if (since) { where.push('d.mtime >= ?'); params.push(since); }
  return { where: where.join(' AND '), params };
}

const READ_FILE = /^read_file\(("(?:[^"\\]|\\.)*")(?:, offset=(\d+))?(?:, limit=(\d+))?\)$/;
/** {path, from, to} of a node whose open call is read_file(path, offset, limit); null otherwise. */
function readRange(open) {
  const m = READ_FILE.exec(String(open ?? ''));
  if (!m) return null;
  const from = Number(m[2] ?? 0);
  return { path: JSON.parse(m[1]), from, to: m[3] ? from + Number(m[3]) - 1 : null };
}

/** The search scope of a node: a subtree by default; for entries, sections and months of one file, that file and its line range. */
function scopeOf(h, p, node) {
  if (!p) return { subtree: '' };
  if (node.kind === 'entry' || node.kind === 'section') {
    const r = readRange(node.open);
    if (r) return { docPath: r.path, lines: [r.from, r.to ?? r.from] };
  }
  if (node.kind === 'month') {
    const ranges = stmt(h, 'SELECT open FROM nodes WHERE parent = ?').all(p).map((k) => readRange(k.open)).filter(Boolean);
    if (ranges.length) return { docPath: ranges[0].path, lines: [Math.min(...ranges.map((r) => r.from)), Math.max(...ranges.map((r) => r.to ?? r.from))] };
  }
  if (node.kind === 'document') {
    const r = readRange(stmt(h, 'SELECT open FROM nodes WHERE parent = ? AND open LIKE ? LIMIT 1').get(p, 'read_file(%')?.open);
    if (r) return { docPath: r.path };
  }
  return { subtree: p };
}

function fetchRows(h, match, f, limit) {
  const { where, params } = filters(f);
  const sql = `SELECT chunks.rowid AS rid, chunks.line AS line, chunks.heading AS heading, chunks.body AS body, ${BM25} AS rank,
      d.id AS id, d.path AS path, d.title AS title, d.mtime AS mtime, d.size AS size, d.class AS class, d.kind AS kind, d.source AS source,
      d.node AS node, d.summary AS summary
    FROM chunks JOIN docs d ON d.id = chunks.doc_id WHERE ${where} ORDER BY rank LIMIT ?`;
  try {
    return stmt(h, sql).all(match, ...params, limit);
  } catch (err) {
    throw new Error(`search failed: ${squash(err.message, 120)}`);
  }
}

/** How many chunks a group matches (cached per open index): decides which group the any-match pass may leave out. */
function groupDf(h, g) {
  const expr = g.terms.join(' OR ');
  let n = h.df.get(expr);
  if (n === undefined) {
    n = stmt(h, 'SELECT count(*) AS n FROM chunks WHERE chunks MATCH ?').get(expr).n;
    if (h.df.size > 2000) h.df.clear();
    h.df.set(expr, n);
  }
  return n;
}

/**
 * Ranked chunk candidates. Pass 1: every group must match. Pass 2 (several groups): every group except the most common
 * one, which finds notes that spell one word differently ("Wertung" for "Bewertungsphase") without ranking the 100,000
 * matches of an any-word query (that costs 200 ms; this one is bounded by the rarer groups).
 */
function candidates(h, built, f, need) {
  const pool = clampInt(need * 4, 60, 60, 300);
  const seen = new Map();
  const take = (rows) => { for (const r of rows) if (!seen.has(r.rid)) seen.set(r.rid, r); };
  take(fetchRows(h, built.strict, f, pool));
  if (built.groups.length > 1) {
    const dfs = built.groups.map((g) => groupDf(h, g));
    const drop = dfs.indexOf(Math.max(...dfs));
    const rest = built.groups.filter((_, i) => i !== drop);
    take(fetchRows(h, rest.map((g) => `(${g.terms.join(' OR ')})`).join(' AND '), f, pool));
  }
  const foldedGroups = built.groups.map((g) => ({ word: g.word, variants: g.variants.map(fold) }));
  const now = Date.now();
  const scored = [...seen.values()].map((r) => {
    const matched = groupsIn(fold(`${r.heading} ${r.body}`), foldedGroups).length;
    const ageDays = Math.max(0, (now - (r.mtime || 0)) / 86_400_000);
    const score = -r.rank + COVERAGE_WEIGHT * (matched / built.groups.length) + FRESH_WEIGHT * 0.5 ** (ageDays / FRESH_HALF_LIFE_DAYS) + (SOURCE_BONUS[r.source] ?? 0);
    return { ...r, matched, score };
  });
  scored.sort((a, b) => b.score - a.score || a.rid - b.rid);
  return scored;
}

/** At most PER_DOC chunks per document, best first. */
function perDoc(rows) {
  const count = new Map();
  return rows.filter((r) => { const n = (count.get(r.id) ?? 0) + 1; count.set(r.id, n); return n <= PER_DOC; });
}

/** About SNIPPET_CHARS characters of the chunk around the densest cluster of matches, cut at word boundaries. */
export function snippetOf(body, groups) {
  const text = String(body).replace(/\s+/g, ' ').trim();
  if (text.length <= SNIPPET_CHARS) return text;
  const folded = fold(text); // same length for precomposed characters, so positions carry over
  const positions = [];
  for (const g of groups) {
    let best = -1;
    for (const v of g.variants) { const i = folded.indexOf(fold(v)); if (i >= 0 && (best < 0 || i < best)) best = i; }
    if (best >= 0) positions.push(best);
  }
  let start = 0;
  if (positions.length) {
    let top = -1;
    for (const p of positions) {
      const from = Math.max(0, p - 80);
      const n = positions.filter((x) => x >= from && x < from + SNIPPET_CHARS).length;
      if (n > top) { top = n; start = from; }
    }
  }
  // the window plus its ellipses stay within SNIPPET_CHARS
  const room = SNIPPET_CHARS - (start > 0 ? 1 : 0) - 1;
  let end = Math.min(text.length, start + room);
  if (start > 0) { const sp = text.indexOf(' ', start); if (sp > 0 && sp - start < 30) { start = sp + 1; end = Math.min(text.length, start + room); } }
  if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > start + 150) end = sp; }
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

const openFor = (r) => (r.kind === 'board' ? openHint.boardEntry(r.path.split('/').at(-1)) : openHint.readFile(r.path, r.line));

function hitOf(r, groups) {
  return {
    path: r.path, line: r.kind === 'board' ? 0 : r.line, title: r.title, heading: r.heading || '', snippet: snippetOf(r.body, groups),
    score: Math.round(r.score * 100) / 100, updated: isoMinute(r.mtime), class: r.class, open: openFor(r), node: r.node, source: r.source,
  };
}

function parseSince(since) {
  if (since === undefined || since === null || since === '') return 0;
  const ms = Date.parse(String(since));
  if (!Number.isFinite(ms)) throw new Error('since must be an ISO date such as 2026-11-01');
  return ms;
}

function searchArgs(h, { query, source, path: p, since }) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query required');
  assertNoSecretFragment(q);
  const built = buildMatch(q);
  if (!built.groups.length) throw new Error('query has no searchable words');
  const subtree = normalizeMapPath(p);
  const scope = subtree ? scopeOf(h, subtree, resolveNode(h, subtree)) : { subtree: '' };
  return { q, built, f: { source: source ? normalizeMapPath(source) : '', ...scope, since: parseSince(since) } };
}

// ---- methods ----------------------------------------------------------------------------------------------------------------------
/** Full-text search over the whole map: ranked hits with a snippet and the tool call that opens the place. */
export async function search(params = {}) {
  const h = await database();
  const { q, built, f } = searchArgs(h, params);
  const limit = clampInt(params.limit, DEFAULT_SEARCH, 1, MAX_SEARCH);
  const offset = clampInt(params.offset, 0, 0, 500);
  const t0 = Date.now();
  const ranked = perDoc(candidates(h, built, f, offset + limit)).filter((r) => !isDenied(r.path));
  const page = ranked.slice(offset, offset + limit);
  return {
    query: q, terms: built.groups.map((g) => g.variants.join('|')), total: ranked.length, ms: Date.now() - t0,
    nextOffset: offset + limit < ranked.length ? offset + limit : null,
    hits: page.map((r) => hitOf(r, built.groups)),
  };
}

const NODE_COLS = 'path, parent, title, summary, size, updated, kind, open, class, sort';
const lineOf = (n) => ({ path: n.path, title: n.title, summary: n.summary, size: n.size, updated: isoMinute(n.updated), class: n.class, open: n.open });

function rootNode(h) {
  const total = stmt(h, 'SELECT count(*) AS n FROM nodes WHERE parent = ?').get('').n;
  return { path: '', title: 'Agent-Desk-Karte', summary: `Inhaltsverzeichnis von allem, was der Desk lesen kann (${total} Quellen). Mit discover("<pfad>") eine Ebene tiefer, mit discover("<pfad>", query="…") nur dort suchen, mit map_search überall.` };
}

function resolveNode(h, p) {
  if (!p) return rootNode(h);
  const n = stmt(h, `SELECT ${NODE_COLS} FROM nodes WHERE path = ?`).get(p);
  if (n) return n;
  // a canonical file path (e.g. /home/flori/jobs/x/STATE.md) or a board entry path leads to its node
  const d = stmt(h, 'SELECT node, path, title, summary, size, mtime, class, kind FROM docs WHERE path = ?').get(`/${p}`) ?? stmt(h, 'SELECT node, path, title, summary, size, mtime, class, kind FROM docs WHERE path = ?').get(p);
  if (d) {
    const own = stmt(h, `SELECT ${NODE_COLS} FROM nodes WHERE path = ?`).get(d.node);
    if (own && d.kind !== 'board' && d.node !== d.node.split('/')[0]) return own;
    return { path: d.path, parent: d.node, title: d.title, summary: d.summary, size: d.size, updated: d.mtime, kind: 'file', open: d.kind === 'board' ? openHint.boardEntry(d.path.split('/').at(-1)) : openHint.readFile(d.path), class: d.class };
  }
  const top = p.split('/')[0];
  const near = stmt(h, 'SELECT path FROM nodes WHERE parent = ? OR parent = ? ORDER BY sort LIMIT 12').all(top, '').map((r) => r.path);
  throw new Error(`unknown map path "${squash(p, 80)}"; try one of: ${near.join(', ')}`);
}

/** One level of the table of contents, or a search inside one branch. */
export async function discover(params = {}) {
  const p = normalizeMapPath(params.path);
  const limit = clampInt(params.limit, DEFAULT_DISCOVER, 1, MAX_DISCOVER);
  const offset = clampInt(params.offset, 0, 0, 100_000);
  const h = await database();
  const node = resolveNode(h, p);
  const head = { path: node.path, title: node.title, summary: node.summary, ...(node.open ? { open: node.open } : {}), ...(node.class && node.class !== 'open' ? { class: node.class } : {}) };
  const query = String(params.query ?? '').trim();
  if (query) {
    const { built, f } = searchArgs(h, { query, path: p, since: params.since });
    const rows = candidates(h, built, f, offset + limit * 2).filter((r) => !isDenied(r.path));
    const docs = new Map();
    for (const r of rows) if (!docs.has(r.id)) docs.set(r.id, r); // best chunk per document
    const all = [...docs.values()];
    const lines = all.slice(offset, offset + limit).map((r) => ({
      path: r.kind === 'board' || r.node === r.source ? r.path : r.node, title: r.title, summary: r.summary || '', size: r.size, updated: isoMinute(r.mtime), class: r.class,
      open: openFor(r), snippet: snippetOf(r.body, built.groups),
    }));
    return { ...head, query, lines, total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null };
  }
  const total = stmt(h, 'SELECT count(*) AS n FROM nodes WHERE parent = ?').get(node.path).n;
  const kids = stmt(h, `SELECT ${NODE_COLS} FROM nodes WHERE parent = ? ORDER BY sort, path LIMIT ? OFFSET ?`).all(node.path, limit, offset);
  return { ...head, lines: kids.map(lineOf), total, nextOffset: offset + kids.length < total ? offset + kids.length : null };
}

function readStatusFile() {
  try { return JSON.parse(fs.readFileSync(path.join(dirNow(), STATUS_FILE), 'utf8')); } catch { return null; /* absent or malformed status file */ }
}

/** Size and freshness of the map, and what the last build said. */
export async function status() {
  const file = path.join(dirNow(), DB_FILE);
  const sf = readStatusFile();
  let h;
  try { h = await database(); } catch (err) {
    return { built: null, docs: 0, chunks: 0, nodes: 0, bytes: 0, sources: {}, lastError: sf?.lastError?.message ?? err.message, warnings: [] };
  }
  const meta = (k) => stmt(h, 'SELECT value FROM meta WHERE key = ?').get(k)?.value;
  const counts = JSON.parse(meta('counts') || 'null');
  const sources = Object.fromEntries(stmt(h, 'SELECT source, count(*) AS n, max(mtime) AS newest FROM docs GROUP BY source').all().map((r) => [r.source, { docs: r.n, newest: isoMinute(r.newest) }]));
  const bytes = fs.statSync(file).size;
  return {
    built: meta('built_at') || null,
    docs: counts?.docs ?? stmt(h, 'SELECT count(*) AS n FROM docs').get().n,
    chunks: counts?.chunks ?? null,
    nodes: counts?.nodes ?? stmt(h, 'SELECT count(*) AS n FROM nodes').get().n,
    bytes, sources,
    lastError: sf?.lastError?.message ?? null,
    warnings: JSON.parse(meta('warnings') || '[]'),
  };
}
