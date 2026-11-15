#!/usr/bin/env node
// Exports the scrubbed text of every indexed document as plain files, for the Agent Desk research agent's read-only shell
// (bridge/src/sandbox.js, which sees only this tree). Runs on LeChonk after each map refresh (refresh.sh); the Sandy bridge
// pulls the result once an hour (scripts/sandbox/pull-corpus.sh).
//
//   node scripts/map/export-corpus.mjs [--db ~/desk-knowledge/map/index.sqlite] [--out ~/desk-knowledge/corpus]
//                                      [--full] [--no-redact] [--force] [--quiet]
//
// - One file per document: `<source>/<canonical path without the leading slash>.txt`, board entries `board/<thread>/<id>.txt`.
//   First line `# <canonical path> | updated <ISO>`, then the document's chunks in line order (they were redacted before they
//   entered the index; every chunk passes redact() once more here, so a secret that became known after the document was indexed
//   is masked too). Chunks that are pieces of one very long line are joined with a space, all others with a blank line.
// - The file's mtime is the document's mtime: an unchanged document keeps its size and mtime, so the hourly rsync on Sandy only
//   moves what changed, and the next export re-uses the old file as a hard link instead of re-reading and re-scrubbing it.
// - Builds into `<out>.new`, then swaps: the old tree is renamed away, the new one renamed in, the old one deleted. Directories 0700,
//   files 0600. Reads the index read-only; writes only next to `--out`.
// - A document whose path is denied (isDenied), has no text, or has a path that cannot be mapped safely never gets a file.
// - Incremental by default (hard links for unchanged documents). Everything is re-read and re-scrubbed with --full, when the exporter
//   version or the number of known secret values changed, and at least once a day.
// - Needs Node >= 22.5 (node:sqlite), like the builder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact } from '../../src/redact.js';
import { isDenied, KNOWLEDGE_DIR } from '../../src/paths.js';
import { secretValueCount, secretWindowCount } from '../../src/secretValues.js';
import { CHUNK_SPAN, DB_FILE, MAP_DIR } from '../../src/mapIndex.js';

export const EXPORT_VERSION = 1;
export const META_FILE = '.corpus-meta.json';
const FULL_EVERY_MS = 24 * 3600_000;
const SHRINK_GUARD_MIN = 1000; // a new tree with fewer than half the old files (old >= this) is not swapped in unless --force
const MAX_SEGMENT_BYTES = 200;

// ---- arguments -----------------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { db: path.join(MAP_DIR, DB_FILE), out: path.join(KNOWLEDGE_DIR, 'corpus'), full: false, redact: true, force: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); i += 1; return argv[i]; };
    if (a === '--db') o.db = path.resolve(next());
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--full') o.full = true;
    else if (a === '--no-redact') o.redact = false;
    else if (a === '--force') o.force = true;
    else if (a === '--quiet') o.quiet = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function loadSqlite() {
  try {
    return await import('node:sqlite');
  } catch {
    throw new Error(`the corpus export needs Node >= 22.5 (node:sqlite); this is Node ${process.versions.node}. Run it on LeChonk (Node 24).`);
  }
}

// ---- paths of the exported files -----------------------------------------------------------------------------------------------
const SAFE_SOURCE = /^[a-z0-9][a-z0-9/_-]*$/;
const SAFE_BOARD = /^board\/([\w.-]+)\/([\w.-]+)$/;

function safeSegment(seg) {
  if (Buffer.byteLength(seg) <= MAX_SEGMENT_BYTES) return seg;
  const head = Buffer.from(seg).subarray(0, 150).toString('utf8').replace(/�+$/u, '');
  return `${head}~${crypto.createHash('sha1').update(seg).digest('hex').slice(0, 10)}`;
}

/** Relative file name of a document in the corpus, or null when its path cannot be mapped safely. */
export function corpusRel(doc) {
  if (doc.kind === 'board' || doc.source === 'board') {
    const m = SAFE_BOARD.exec(doc.path);
    return m ? `board/${m[1]}/${m[2]}.txt` : null;
  }
  if (!SAFE_SOURCE.test(doc.source) || doc.source.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  if (typeof doc.path !== 'string' || !doc.path.startsWith('/') || doc.path.includes('\0') || doc.path.includes('\\')) return null;
  const segs = doc.path.slice(1).split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return `${doc.source}/${segs.map(safeSegment).join('/')}.txt`;
}

const oneLine = (s) => String(s).replace(/[\r\n\u2028\u2029]+/g, ' ');
const isoSeconds = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : 'unknown');

/** The text of one document from its chunks (already in line order). */
export function assemble(doc, chunks, scrub) {
  const parts = [`# ${oneLine(doc.path)} | updated ${isoSeconds(doc.mtime)}\n`];
  let prevLine = null;
  for (const c of chunks) {
    const body = scrub(String(c.body ?? ''));
    parts.push(prevLine === null ? '\n' : c.line === prevLine ? ' ' : '\n\n', body);
    prevLine = c.line;
  }
  parts.push('\n');
  return parts.join('');
}

// ---- lock ------------------------------------------------------------------------------------------------------------------------
function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = () => { try { fs.rmSync(file, { force: true }); } catch { /* already gone */ } };
      process.on('exit', release);
      return release;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
      if (alive) return null; // another export is running
      fs.rmSync(file, { force: true }); // stale lock of a dead process
    }
  }
  return null;
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// ---- the export ------------------------------------------------------------------------------------------------------------------
/** Runs one export. Returns the summary (also written to <out>/.corpus-meta.json). */
export async function exportCorpus({ db: dbFile, out, full = false, redact: doRedact = true, force = false, log = () => {} }) {
  const { DatabaseSync } = await loadSqlite();
  if (!fs.existsSync(dbFile)) throw new Error(`index not found: ${dbFile}`);
  const t0 = Date.now();
  const parent = path.dirname(out);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const release = acquireLock(`${out}.lock`);
  if (!release) { log('another corpus export is running'); return { skipped: 'locked' }; }
  const staged = `${out}.new`;
  for (const name of fs.readdirSync(parent)) { // leftovers of an interrupted run (we hold the lock)
    const full_ = path.join(parent, name);
    if (full_ === staged || full_.startsWith(`${out}.old-`)) fs.rmSync(full_, { recursive: true, force: true });
  }

  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    const docs = db.prepare('SELECT id, path, source, kind, mtime FROM docs ORDER BY id').all();
    if (docs.length === 0) throw new Error('the index holds no documents (is the first build still running?)');
    // The chunk text lives in FTS5's own content table (%_content: id = rowid, c0 doc_id, c1 line, c2 heading, c3 body). A rowid range on the
    // virtual table scans all 268,000 chunks (267 ms per document, measured); the content table answers the same range in 0.2 ms.
    const cols = db.prepare('PRAGMA table_info(chunks_content)').all().map((r) => r.name).join(',');
    if (cols !== 'id,c0,c1,c2,c3') throw new Error(`unexpected layout of the FTS5 content table chunks_content (${cols || 'missing'})`);
    const chunksOf = db.prepare('SELECT c1 AS line, c3 AS body FROM chunks_content WHERE id >= ? AND id < ? ORDER BY id');

    // the scrubber; its state (known secret values) is part of the "can old files be re-used" decision
    const scrub = doRedact ? (s) => redact(s) : (s) => s;
    if (doRedact) redact('warm-up');
    const redactSig = doRedact ? `${secretValueCount()}:${secretWindowCount()}` : 'off';
    const prev = readJson(path.join(out, META_FILE));
    const fullAt = prev?.fullAt ? Date.parse(prev.fullAt) : 0;
    const reuse = !full && prev?.exportVersion === EXPORT_VERSION && prev.redactSig === redactSig && Date.now() - fullAt < FULL_EVERY_MS && fs.existsSync(out);

    fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
    const made = new Set([staged]);
    const mkdirs = (dir) => {
      if (made.has(dir)) return;
      mkdirs(path.dirname(dir));
      fs.mkdirSync(dir, { mode: 0o700 });
      made.add(dir);
    };
    const used = new Set();
    const stats = { docs: docs.length, files: 0, bytes: 0, written: 0, reused: 0, denied: 0, empty: 0, unmappable: 0, collisions: 0 };
    const perSource = {};
    for (const doc of docs) {
      const rel = corpusRel(doc);
      if (!rel) { stats.unmappable += 1; continue; }
      if (doc.kind !== 'board' && isDenied(doc.path)) { stats.denied += 1; continue; }
      if (used.has(rel)) { stats.collisions += 1; continue; }
      const dest = path.join(staged, rel);
      const mtimeMs = Number.isFinite(doc.mtime) && doc.mtime > 0 ? doc.mtime : 0;
      let done = false;
      if (reuse) {
        const old = path.join(out, rel);
        try {
          const st = fs.lstatSync(old);
          if (st.isFile() && st.size > 0 && (mtimeMs === 0 || Math.abs(st.mtimeMs - mtimeMs) < 2)) {
            mkdirs(path.dirname(dest));
            fs.linkSync(old, dest);
            stats.reused += 1;
            stats.files += 1;
            stats.bytes += st.size;
            done = true;
          }
        } catch { /* not there, or not linkable: write it */ }
      }
      if (!done) {
        const chunks = chunksOf.all(doc.id * CHUNK_SPAN, (doc.id + 1) * CHUNK_SPAN);
        if (chunks.length === 0) { stats.empty += 1; continue; }
        const text = assemble(doc, chunks, scrub);
        mkdirs(path.dirname(dest));
        fs.writeFileSync(dest, text, { mode: 0o600 });
        if (mtimeMs) { const t = new Date(mtimeMs); fs.utimesSync(dest, t, t); }
        stats.written += 1;
        stats.files += 1;
        stats.bytes += Buffer.byteLength(text);
      }
      used.add(rel);
      perSource[doc.source] = (perSource[doc.source] ?? 0) + 1;
    }

    const summary = {
      exportVersion: EXPORT_VERSION,
      builtAt: new Date().toISOString(),
      indexBuiltAt: meta.built_at ?? null,
      fullAt: reuse ? prev.fullAt : new Date().toISOString(),
      redact: doRedact,
      redactSig,
      ...stats,
      sources: perSource,
      ms: 0,
    };
    // shrink guard: a broken index must not empty the corpus the sandbox reads
    if (!force && prev?.files >= SHRINK_GUARD_MIN && stats.files < prev.files / 2) {
      fs.rmSync(staged, { recursive: true, force: true });
      throw new Error(`refusing to swap in a corpus of ${stats.files} files over ${prev.files} (less than half; use --force)`);
    }
    summary.ms = Date.now() - t0;
    fs.writeFileSync(path.join(staged, META_FILE), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

    // swap: old tree away, new tree in, old tree deleted. Between the two renames `out` does not exist for a moment: the pull retries.
    const old = `${out}.old-${process.pid}`;
    const hadOld = fs.existsSync(out);
    if (hadOld) fs.renameSync(out, old);
    try {
      fs.renameSync(staged, out);
    } catch (err) {
      if (hadOld) { try { fs.renameSync(old, out); } catch { /* nothing more to do */ } }
      throw err;
    }
    if (hadOld) fs.rmSync(old, { recursive: true, force: true });
    summary.ms = Date.now() - t0;
    return summary;
  } finally {
    db.close();
    release();
  }
}

// ---- command line ------------------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    const o = parseArgs(process.argv.slice(2));
    const s = await exportCorpus({ ...o, log: (m) => { if (!o.quiet) console.log(m); } });
    if (s.skipped) process.exit(0);
    const mb = (s.bytes / 1048576).toFixed(0);
    console.log(`export-corpus: ${s.docs} docs -> ${s.files} files, ${mb} MB; written ${s.written}, reused ${s.reused}; skipped ${s.denied} denied, ${s.empty} empty, ${s.unmappable} unmappable, ${s.collisions} duplicate names; ${(s.ms / 1000).toFixed(1)} s`);
  } catch (err) {
    console.error(`export-corpus failed: ${err.message}`);
    process.exit(1);
  }
}
