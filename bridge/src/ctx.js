import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redact } from './redact.js';
import { recentJobDirs } from './jobs.js';
import { expandQuery, groupsIn, variantPattern } from './searchTerms.js';
import { assertNoSecretFragment, hitInSecret } from './secretQuery.js';
import { MIRROR_DIR, mirrorReady, mirrorStatus, syncNotes } from './notesMirror.js';
import {
  CANON_JOBS, HOME, KNOWLEDGE_DIR, LAPTOP_MIRROR, MAX_READ_BYTES, claudeProjectDirs, fromCanonical, isDenied, jobsRoot, resolveAllowed, toCanonical,
} from './paths.js';

export { redact };
const run = promisify(execFile);
const RG = '/usr/bin/rg';

const CORE = {
  AGENTS: path.join(HOME, 'AGENTS.md'),
  DECISIONS: path.join(HOME, 'DECISIONS.md'),
  STATE: path.join(HOME, 'STATE.md'),
  CLAUDE: path.join(HOME, 'CLAUDE.md'),
  MODEL_POLICY: path.join(HOME, '.hermes', 'model-economy-policy.md'),
};

function clampInt(v, def, min, max) {
  const n = Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : def;
  return Math.min(max, Math.max(min, n));
}

const COUNT_ALL_LINES_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Read lines [offset, offset+limit) of an allowlisted file, streaming, capped at 512 KB of output.
 * offset and limit are LINES (not characters). The answer carries `totalLines` and, when more follows, `nextOffset`.
 */
export async function read({ path: p, offset = 0, limit = 400 } = {}) {
  const real = resolveAllowed(fromCanonical(String(p ?? '')));
  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) throw new Error('not a file');
  const start = clampInt(offset, 0, 0, 1e9);
  const max = clampInt(limit, 400, 1, 5000);
  const countAll = stat.size <= COUNT_ALL_LINES_MAX_BYTES;
  const lines = [];
  let bytes = 0;
  let n = 0;
  let truncated = false;
  const rl = readline.createInterface({ input: fs.createReadStream(real, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    n += 1;
    if (n <= start) continue;
    if (truncated) continue; // keep counting for totalLines
    if (lines.length >= max || bytes + line.length > MAX_READ_BYTES) {
      truncated = true;
      if (!countAll) break;
      continue;
    }
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  rl.close();
  const result = { path: toCanonical(real), offset: start, lines: lines.length, size: stat.size, truncated, totalLines: countAll ? n : null };
  if (truncated) result.nextOffset = start + lines.length;
  else if (n > 0 && start >= n) result.note = `offset ${start} is beyond the end of the file (${n} lines); offsets count LINES, not characters`;
  return { ...result, text: redact(lines.join('\n')) };
}

const CORE_NOTES = {
  DECISIONS: 'DECISIONS.md is newest-first: the first chunk is today / the newest decisions. Read more with read_file (offset/limit are LINES) only when the first chunk does not answer the question.',
};

export async function core({ name, maxChars = 6000 } = {}) {
  const key = String(name).toUpperCase();
  const file = CORE[key];
  if (!file) throw new Error(`unknown core doc; use ${Object.keys(CORE).join(', ')}`);
  const cap = clampInt(maxChars, 6000, 200, 60000);
  // DECISIONS.md is kept newest-first, so the head is the newest part; the other docs are read from the top as well.
  const fd = await fs.promises.open(resolveAllowed(file), 'r');
  try {
    const { size } = await fd.stat();
    const buf = Buffer.alloc(Math.min(size, cap * 4));
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const full = buf.toString('utf8', 0, bytesRead);
    const text = full.slice(0, cap);
    const note = CORE_NOTES[key];
    return { name: key, path: file, size, truncated: size > Buffer.byteLength(text), ...(note ? { note } : {}), text: redact(text) };
  } finally {
    await fd.close();
  }
}

const DECISION_HEAD = /^## (\d{4}-\d{2}-\d{2})\b(.*)$/;
const DECISIONS_READ_BYTES = 256 * 1024;
const MIN_ENTRY_CHARS = 220;

/** Splits the newest-first DECISIONS.md head into dated entries: [{date, heading, text}]. */
export function parseDecisions(markdown) {
  const entries = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const m = DECISION_HEAD.exec(line);
    if (m) {
      current = { date: m[1], heading: line.slice(3).trim(), lines: [] };
      entries.push(current);
    } else if (current) current.lines.push(line);
  }
  return entries.map(({ lines, ...e }) => ({ ...e, text: lines.join('\n').replace(/\nresolved-keys:.*$/s, '').trim() }));
}

/** The decisions of today and the days before (default: yesterday too), newest first, within maxChars (default 5500, max 8000). */
export async function decisionsToday({ days = 2, maxChars = 5500, now = new Date() } = {}) {
  const span = clampInt(days, 2, 1, 7);
  const cap = clampInt(maxChars, 5500, 1000, 8000);
  const oldest = new Date(now.getTime() - (span - 1) * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const fd = await fs.promises.open(resolveAllowed(CORE.DECISIONS), 'r');
  let head;
  try {
    const buf = Buffer.alloc(DECISIONS_READ_BYTES);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    head = buf.toString('utf8', 0, bytesRead);
  } finally {
    await fd.close();
  }
  const entries = parseDecisions(head).filter((e) => e.date >= oldest && e.date <= today);
  const fromToday = entries.filter((e) => e.date === today);
  const older = entries.filter((e) => e.date !== today);
  // Every entry of today gets a share of the budget (75 % when older days follow), so "what was decided today" is
  // complete; the older days fill what is left.
  const out = [];
  let used = 0;
  const take = (group, budget) => {
    const per = Math.max(MIN_ENTRY_CHARS, Math.floor(budget / Math.max(1, group.length)));
    for (const e of group) {
      const text = e.text.length > per ? `${e.text.slice(0, per)}… [gekürzt, ${e.text.length - per} Zeichen mehr]` : e.text;
      if (used + text.length + e.heading.length > cap) break;
      used += text.length + e.heading.length;
      out.push({ date: e.date, heading: redact(e.heading), text: redact(text) });
    }
  };
  take(fromToday, older.length ? cap * 0.75 : cap);
  take(older, cap - used);
  return {
    today,
    since: oldest,
    note: 'Newest first (UTC dates). Entries dated today are what was decided today; entriesToday is their full count.',
    entriesToday: fromToday.length,
    shown: out.length,
    omitted: entries.length - out.length,
    entries: out,
  };
}

// Search covers every job folder, not only the newest: the local notes mirror (all job folders' *.md/*.txt, see
// notesMirror.js) plus the newest LIVE_JOBS folders read live, the core docs, the skills, ~/desk-knowledge and the
// laptop memory mirror. Until the first mirror sync is done the job view is searched directly (slower, NFS). All tiers
// run in parallel against one deadline, so an answer comes back in < 3 s.
const LIVE_JOBS = 20;
const RECENT_JOBS = 150;
const SEARCH_DEADLINE_MS = 2300;
const MAX_LINES_PER_FILE = 12;
const LINES_SHOWN_PER_FILE = 3;
const PRIORITY_FILES = new Set(['STATE.md', 'RESULT.md', 'PROMPT.md', 'BRIEF.md', 'FACTS.md', 'SKILL.md', 'INDEX.md']);
const NOTE_GLOBS = ['*.md', '*.txt'];

let jobDirCache = { at: 0, dirs: [] };
async function allJobDirs() {
  if (Date.now() - jobDirCache.at > 60_000) {
    const root = jobsRoot();
    let names = [];
    try { names = await fs.promises.readdir(root); } catch { /* no job view */ }
    jobDirCache = { at: Date.now(), dirs: names.filter((n) => !n.startsWith('.') && !isDenied(n)).map((n) => path.join(root, n)) };
  }
  return jobDirCache.dirs;
}

/** [{roots, depth, rank, globs?}] - lower rank = more authoritative. */
async function searchTiers(scope) {
  const tiers = [];
  if (scope === 'docs' || scope === 'all') tiers.push({ roots: [...Object.values(CORE), KNOWLEDGE_DIR, LAPTOP_MIRROR], depth: 3, rank: 0 });
  if (scope === 'skills' || scope === 'all') tiers.push({ roots: [path.join(HOME, '.agents', 'skills')], depth: 2, rank: 1 });
  if (scope === 'jobs' || scope === 'all') {
    const recent = await recentJobDirs(RECENT_JOBS);
    if (mirrorReady()) {
      tiers.push({ roots: recent.slice(0, LIVE_JOBS), depth: 2, rank: 2, globs: NOTE_GLOBS });
      tiers.push({ roots: [MIRROR_DIR], depth: 3, rank: 2, globs: NOTE_GLOBS });
    } else {
      const seen = new Set(recent.map((d) => path.basename(d)));
      tiers.push({ roots: recent, depth: 2, rank: 2, globs: NOTE_GLOBS });
      tiers.push({ roots: (await allJobDirs()).filter((d) => !seen.has(path.basename(d))), depth: 1, rank: 3, globs: NOTE_GLOBS });
    }
    syncIfStale();
  }
  return { tiers, recentIndex: new Map((await recentJobDirs(RECENT_JOBS)).map((d, i) => [path.basename(d), i])) };
}

let lastKick = 0;
function syncIfStale() {
  // The bridge refreshes the mirror on a timer; this covers a bridge started without it (tests, manual runs).
  if (Date.now() - lastKick < 5 * 60_000 || mirrorStatus().syncing) return;
  lastKick = Date.now();
  if (!mirrorReady() || Date.now() - mirrorStatus().at > 10 * 60_000) syncNotes().catch(() => {});
}

async function rgTier(tier, groups, regex, query, deadline) {
  const roots = tier.roots.filter((r) => fs.existsSync(r));
  if (!roots.length) return '';
  const patterns = regex ? ['-e', query] : groups.flatMap((g) => g.variants.flatMap((v) => ['-e', variantPattern(v)]));
  const args = [
    // Plain "path\0line:text" output: parsing rg's JSON for common words (20 MB) cost more than the search itself.
    '--no-heading', '--with-filename', '--line-number', '--null', '--color', 'never', '--max-columns', '400', '--max-columns-preview',
    '--max-count', String(MAX_LINES_PER_FILE), '--max-filesize', '2M', '--no-follow', '--ignore-case',
    '--max-depth', String(tier.depth), '-g', '!node_modules', '-g', '!wt', '-g', '!work', '-g', '!*.log', '-g', '!.git',
    '-g', '!*.jsonl', '-g', '!*.json', '-g', '!*.csv', ...(tier.globs ?? []).flatMap((g) => ['-g', g]), ...patterns, '--', ...roots,
  ];
  try {
    const { stdout } = await run(RG, args, { timeout: Math.max(200, deadline - Date.now()), maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    // rg exits 1 for no matches and 2 when some files were unreadable; a timeout keeps the partial output.
    if (typeof err.code !== 'number' && !err.killed && !err.stdout) throw new Error(`search failed: ${redact(String(err.message)).slice(0, 200)}`);
    if (err.killed) tier.timedOut = true;
    return err.stdout ?? '';
  }
}

const inMirror = (file) => file.startsWith(MIRROR_DIR + path.sep);
/** The canonical path a hit is shown under (no file system access). */
const canonicalOf = (file) => (inMirror(file) ? path.join(CANON_JOBS, file.slice(MIRROR_DIR.length + 1)) : toCanonical(file));

/** Allowlist check for a hit; null when it must not surface. Mirror files hold only regular files copied from jobs. */
function allowedHit(file) {
  try {
    if (!inMirror(file)) return toCanonical(resolveAllowed(file));
    const real = fs.realpathSync(file);
    const canonical = canonicalOf(file);
    return real.startsWith(fs.realpathSync(MIRROR_DIR) + path.sep) && !isDenied(canonical) ? canonical : null;
  } catch { return null; }
}

function jobOf(canonical) {
  return canonical.startsWith(CANON_JOBS + path.sep) ? canonical.slice(CANON_JOBS.length + 1).split(path.sep)[0] : '';
}

function fileBonus(canonical, groups) {
  const name = path.basename(canonical);
  if (canonical.startsWith(KNOWLEDGE_DIR + path.sep)) return 8; // curated: beats a topic-named job's STATE.md (4 + 3)
  if (Object.values(CORE).includes(canonical)) return 4;
  // A job folder named after a query word ("sn92-fast-launch" for "SN92") is about that topic, not just mentioning it.
  const job = jobOf(canonical);
  const named = job && groupsIn(job.replace(/[-_]/g, ' '), groups).length ? 4 : 0;
  return named + (PRIORITY_FILES.has(name) ? 3 : name.endsWith('.md') ? 1 : 0);
}

/**
 * Full-text search. The query is split into term groups (DE<->EN synonyms, compounds split); a file scores by how many
 * groups it matches, then knowledge/STATE/RESULT/PROMPT files, how often it matches, and newer jobs first. Each file
 * shows its best lines. regex=true searches the query as one regular expression instead.
 */
export async function search({ query, scope = 'all', maxHits = 30, regex = false } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query required');
  // regex=true: the literal runs of the pattern count as terms
  assertNoSecretFragment(regex ? q.replace(/\\[dDwWsSbB]|[\\^$.*+?()[\]{}|]/g, ' ') : q);
  const hits = clampInt(maxHits, 30, 1, 100);
  let rx = null;
  if (regex) { try { rx = new RegExp(q, 'i'); } catch { rx = null; } }
  const groups = regex ? [{ word: q, variants: [q] }] : expandQuery(q);
  if (!groups.length) throw new Error('query has no searchable words');
  const { tiers, recentIndex } = await searchTiers(['jobs', 'docs', 'skills'].includes(scope) ? scope : 'all');
  const deadline = Date.now() + SEARCH_DEADLINE_MS;
  const outputs = await Promise.all(tiers.map((t) => rgTier(t, groups, regex, q, deadline)));
  const files = new Map(); // canonical path -> entry; live tiers come before the mirror, so a live copy wins
  outputs.forEach((stdout, ti) => {
    const tier = tiers[ti];
    for (const line of stdout.split('\n')) {
      const nul = line.indexOf('\0');
      if (nul <= 0) continue;
      const file = line.slice(0, nul);
      const colon = line.indexOf(':', nul);
      const lineNo = Number(line.slice(nul + 1, colon));
      if (colon < 0 || !Number.isInteger(lineNo)) continue;
      const canonical = canonicalOf(file);
      let entry = files.get(canonical);
      if (entry && entry.file !== file) continue;
      if (!entry) {
        const idx = recentIndex.get(jobOf(canonical));
        entry = { file, canonical, tier: tier.rank, recency: idx === undefined ? 0 : 1 - idx / RECENT_JOBS, bonus: fileBonus(canonical, groups), groups: new Set(), lines: [] };
        files.set(canonical, entry);
      }
      const text = line.slice(colon + 1).trim();
      if (text.startsWith('<!--')) continue; // keyword/marker comments of the knowledge files are not content
      // P2-1: only what still matches after redaction counts (a hit inside a secret is no hit at all)
      const safe = redact(text);
      const matched = safe === text ? (regex ? [0] : groupsIn(text, groups))
        : regex ? (rx?.test(safe) || !hitInSecret(text, safe, rx?.exec(text)?.[0] ?? q) ? [0] : [])
          : groupsIn(text, groups).filter((g) => !groups[g].variants.some((v) => hitInSecret(text, safe, v)));
      if (!matched.length) continue;
      matched.forEach((g) => entry.groups.add(g));
      entry.lines.push({ line: lineNo, text: safe, n: matched.length });
    }
  });
  // Coverage of the query's groups dominates; then file kind, how often it matches, and recency.
  const ranked = [...files.values()].filter((f) => f.lines.length)
    .map((f) => ({ ...f, score: f.groups.size * 10 + f.bonus + Math.min(f.lines.length, 30) / 10 + f.recency * 2 - f.tier * 0.5 }))
    .sort((a, b) => b.score - a.score);
  const out = [];
  for (const f of ranked) {
    if (out.length >= hits) break;
    const shown = allowedHit(f.file); // deny-listed or symlinked files never surface
    if (!shown) continue;
    const best = f.lines.slice().sort((a, b) => b.n - a.n || a.line - b.line).slice(0, LINES_SHOWN_PER_FILE);
    for (const l of best) {
      if (out.length >= hits) break;
      out.push({ path: shown, line: l.line, text: l.text.slice(0, 300), terms: `${f.groups.size}/${groups.length}` });
    }
  }
  const result = { query: q, terms: groups.map((g) => g.variants.join('|')), files: ranked.length, hits: out };
  if (tiers.some((t) => t.timedOut)) result.note = 'Teilergebnis: die Suche lief in das Zeitlimit; genauere Begriffe helfen.';
  return result;
}

export async function list({ path: p = '/home/flori/jobs', limit = 200 } = {}) {
  const real = resolveAllowed(fromCanonical(String(p)));
  const entries = await fs.promises.readdir(real, { withFileTypes: true });
  const cap = clampInt(limit, 200, 1, 500);
  const out = [];
  for (const e of entries) {
    if (out.length >= cap) break;
    try {
      resolveAllowed(path.join(real, e.name));
    } catch { continue; }
    out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' });
  }
  return { path: toCanonical(real), entries: out };
}

export { claudeProjectDirs };
