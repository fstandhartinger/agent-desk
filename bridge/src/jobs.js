import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.js';
import { isDenied, jobsRoot, toCanonical } from './paths.js';
import { clearWinner, rank } from './fuzzy.js';

const ACTIVE_WINDOW_MS = 12 * 3600 * 1000;
const NAME = /^(?!.*\.\.)[A-Za-z0-9][\w.-]{0,119}$/;

async function readEdge(file, bytes, fromEnd) {
  let fd;
  try {
    fd = await fs.promises.open(file, 'r');
    const { size } = await fd.stat();
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, fromEnd ? size - len : 0);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

function firstMeaningful(state) {
  for (const raw of (state ?? '').split('\n')) {
    const line = raw.trim();
    if (line && !line.startsWith('#') && line !== '---') return line.replace(/^[-*]\s*/, '').slice(0, 240);
  }
  return '';
}

async function hostOf(dir) {
  const marker = await readEdge(path.join(dir, '.host'), 200, false);
  const choice = await readEdge(path.join(dir, '.host-choice'), 200, false);
  return /^(lechonk|sandy)(?=\s|$)/.exec((marker ?? choice ?? '').trim())?.[1] ?? null;
}

async function statAll(root, filter) {
  const needle = String(filter ?? '').toLowerCase();
  const names = (await fs.promises.readdir(root)).filter((n) => NAME.test(n) && !isDenied(n) && (!needle || n.toLowerCase().includes(needle)));
  const out = [];
  for (let i = 0; i < names.length; i += 64) {
    const batch = await Promise.all(names.slice(i, i + 64).map(async (name) => {
      try {
        const st = await fs.promises.stat(path.join(root, name));
        return st.isDirectory() ? { name, mtimeMs: st.mtimeMs } : null;
      } catch { return null; }
    }));
    out.push(...batch.filter(Boolean));
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

let recentCache = { at: 0, dirs: [] };

/** Newest job folders (full paths in the live view); rg over the whole NFS jobs tree takes minutes, so searches use these. */
export async function recentJobDirs(count) {
  if (Date.now() - recentCache.at > 30_000) {
    const root = jobsRoot();
    recentCache = { at: Date.now(), dirs: (await statAll(root)).slice(0, 200).map((j) => path.join(root, j.name)) };
  }
  return recentCache.dirs.slice(0, count);
}

const INDEX_TTL_MS = 30_000;
const INDEX_SIZE = 100;
const INDEX_IDLE_MS = 10 * 60_000; // stop refreshing in the background when nobody asked for 10 minutes

let index = { at: 0, usedAt: 0, jobs: null, loading: null };

async function describe(root, { name, mtimeMs }) {
  const dir = path.join(root, name);
  const [head, tail, host] = await Promise.all([
    readEdge(path.join(dir, 'STATE.md'), 2048, false),
    readEdge(path.join(dir, 'STATE.md'), 4096, true),
    hostOf(dir),
  ]);
  return {
    name,
    path: toCanonical(dir),
    mtimeMs,
    modified: new Date(mtimeMs).toISOString(),
    finalDone: /^- FINAL DONE\s*$/m.test(tail ?? ''),
    host,
    summary: redact(firstMeaningful(head)),
  };
}

async function buildIndex(filter) {
  const root = jobsRoot();
  const newest = (await statAll(root, filter)).slice(0, INDEX_SIZE);
  const jobs = [];
  for (let i = 0; i < newest.length; i += 16) jobs.push(...await Promise.all(newest.slice(i, i + 16).map((j) => describe(root, j))));
  return jobs;
}

/** The newest jobs, served from a 30 s cache; a stale cache is returned at once and refreshed in the background. */
async function jobIndex() {
  index.usedAt = Date.now();
  const refresh = () => {
    index.loading ||= buildIndex().then((jobs) => { index = { ...index, at: Date.now(), jobs }; }).finally(() => { index.loading = null; });
    return index.loading;
  };
  if (!index.jobs) await refresh();
  else if (Date.now() - index.at > INDEX_TTL_MS) refresh().catch(() => {});
  return index.jobs;
}

/** Keeps the index warm while the desk is in use so the first question of a conversation is not the slow one. */
export function startJobIndexRefresh() {
  buildIndex().then((jobs) => { index = { ...index, at: Date.now(), jobs }; }).catch(() => {});
  const timer = setInterval(() => {
    if (index.usedAt && Date.now() - index.usedAt < INDEX_IDLE_MS && Date.now() - index.at > INDEX_TTL_MS - 5000) jobIndex().catch(() => {});
  }, 10_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function resetJobIndexForTests() {
  index = { at: 0, usedAt: 0, jobs: null, loading: null };
}

export async function list({ filter, activeOnly = false, limit = 30 } = {}) {
  const cap = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 30));
  const needle = String(filter ?? '').toLowerCase();
  let pool = (await jobIndex()).filter((j) => !needle || j.name.toLowerCase().includes(needle));
  if (needle && !pool.length) pool = await buildIndex(filter); // an older job outside the cached newest 100
  const now = Date.now();
  const jobs = pool
    .filter((j) => !activeOnly || (!j.finalDone && now - j.mtimeMs <= ACTIVE_WINDOW_MS))
    .slice(0, cap)
    .map(({ mtimeMs, ...job }) => job);
  // Counts first: a long list gets cut for the model, the counts must survive.
  return { total: jobs.length, open: jobs.filter((j) => !j.finalDone).length, jobs };
}

async function readJob(name) {
  const dir = path.join(jobsRoot(), name);
  const st = await fs.promises.stat(dir).catch(() => null);
  if (!st?.isDirectory()) return null;
  const state = await readEdge(path.join(dir, 'STATE.md'), 4096, true);
  const result = await readEdge(path.join(dir, 'RESULT.md'), 4096, false);
  const prompt = await readEdge(path.join(dir, 'PROMPT.md'), 2048, false);
  return {
    name,
    path: toCanonical(dir),
    modified: st.mtime.toISOString(),
    finalDone: /^- FINAL DONE\s*$/m.test(state ?? ''),
    host: await hostOf(dir),
    state: redact(state ?? ''),
    result: redact(result ?? ''),
    prompt: redact(prompt ?? ''),
  };
}

const candidate = ({ item, score }) => ({ name: item.name, modified: item.modified, summary: item.summary, match: Math.round(score * 100) / 100 });

/** Job names the speaker may have meant: the cached newest jobs first, then every job folder name (no stat per folder). */
async function similarJobs(query) {
  let ranked = rank(query, await jobIndex(), (j) => j.name);
  if (clearWinner(ranked)) return ranked;
  const root = jobsRoot();
  const indexed = new Set(ranked.map((r) => r.item.name));
  const names = (await fs.promises.readdir(root)).filter((n) => NAME.test(n) && !isDenied(n) && !indexed.has(n));
  ranked = [...ranked, ...rank(query, names)].sort((a, b) => b.score - a.score).slice(0, 3);
  return Promise.all(ranked.map(async (r) => {
    if (typeof r.item !== 'string') return r;
    const st = await fs.promises.stat(path.join(root, r.item)).catch(() => null);
    return st?.isDirectory() ? { ...r, item: await describe(root, { name: r.item, mtimeMs: st.mtimeMs }) } : null;
  })).then((rows) => rows.filter(Boolean));
}

/**
 * Status of one job. A name that is not an exact job folder is matched against the job names (slug, words, typos):
 * a clear winner is answered as that job (with `resolvedFrom`), otherwise the top 3 candidates come back.
 */
export async function get({ name } = {}) {
  const query = String(name ?? '').trim();
  if (query.includes('..') || /^[.]/.test(query) || /[\\/]/.test(query)) throw new Error('invalid job name');
  if (!query) throw new Error('job name required');
  if (NAME.test(query) && !isDenied(query)) {
    const exact = await readJob(query);
    if (exact) return exact;
  }
  const ranked = await similarJobs(query);
  const winner = clearWinner(ranked);
  if (winner) return { ...await readJob(winner.item.name), resolvedFrom: query, candidates: ranked.map(candidate) };
  return { found: false, query, candidates: ranked.map(candidate), hint: ranked.length ? 'No exact job; ask which one is meant or call list_jobs.' : 'No similar job name; call list_jobs.' };
}
