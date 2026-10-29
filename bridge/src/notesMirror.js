// Local mirror of the job folders' notes (*.md, *.txt; top level and one folder below) for ctx.search.
// The job view is NFS: ripgrep over all ~1,500 folders takes 2-5 s there, over this local copy ~0.2 s. Only regular
// files are copied (no symlinks), deny-listed paths never enter, and the copy is refreshed incrementally (size+mtime)
// every few minutes. The newest job folders are still searched live, so fresh notes are never missed.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, isDenied, jobsRoot } from './paths.js';

export const MIRROR_DIR = process.env.BRIDGE_NOTES_MIRROR || path.join(HOME, '.cache', 'agent-desk', 'job-notes');
const MARKER = '.synced';
const NOTE = /\.(md|txt)$/i;
const SKIP_DIRS = new Set(['node_modules', 'wt', 'work', '.git', 'venv', '.venv', '__pycache__']);
const MAX_BYTES = 2 * 1024 * 1024;
const REFRESH_MS = 5 * 60_000;
const BATCH = 32;

let syncing = null;
let lastSync = { at: 0, files: 0, copied: 0, removed: 0, ms: 0 };

/** True once a full sync has completed (now or in an earlier bridge run). */
export function mirrorReady() {
  return fs.existsSync(path.join(MIRROR_DIR, MARKER));
}

export function mirrorStatus() {
  return { dir: MIRROR_DIR, ready: mirrorReady(), syncing: Boolean(syncing), ...lastSync };
}

async function entries(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** Every note file of the job view as [relative path]: <job>/<file> and <job>/<dir>/<file>. */
async function listNotes(root) {
  const jobs = (await entries(root)).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !isDenied(e.name));
  const out = [];
  for (let i = 0; i < jobs.length; i += BATCH) {
    const lists = await Promise.all(jobs.slice(i, i + BATCH).map(async (job) => {
      const found = [];
      for (const e of await entries(path.join(root, job.name))) {
        if (isDenied(e.name)) continue;
        if (e.isFile() && NOTE.test(e.name)) found.push(`${job.name}/${e.name}`);
        else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
          for (const f of await entries(path.join(root, job.name, e.name))) {
            if (f.isFile() && NOTE.test(f.name) && !isDenied(f.name)) found.push(`${job.name}/${e.name}/${f.name}`);
          }
        }
      }
      return found;
    }));
    for (const l of lists) out.push(...l);
  }
  return out;
}

async function copyIfChanged(root, rel) {
  const src = path.join(root, rel);
  const dst = path.join(MIRROR_DIR, rel);
  let s;
  try { s = await fs.promises.lstat(src); } catch { return false; }
  if (!s.isFile() || s.size > MAX_BYTES) return false;
  try {
    const d = await fs.promises.stat(dst);
    if (d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2) return false;
  } catch { /* new file */ }
  await fs.promises.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
  await fs.promises.copyFile(src, dst);
  await fs.promises.utimes(dst, s.mtimeMs / 1000, s.mtimeMs / 1000);
  return true;
}

async function removeStale(keep) {
  let removed = 0;
  const walk = async (dir, rel) => {
    for (const e of await entries(dir)) {
      if (!rel && e.name === MARKER) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p, r);
        if (!(await entries(p)).length) await fs.promises.rmdir(p).catch(() => {});
      } else if (!keep.has(r)) {
        await fs.promises.rm(p, { force: true });
        removed += 1;
      }
    }
  };
  await walk(MIRROR_DIR, '');
  return removed;
}

/** One incremental sync; concurrent callers share the running one. */
export function syncNotes({ root = jobsRoot() } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    const started = Date.now();
    await fs.promises.mkdir(MIRROR_DIR, { recursive: true, mode: 0o700 });
    const rels = await listNotes(root);
    let copied = 0;
    for (let i = 0; i < rels.length; i += BATCH) {
      const done = await Promise.all(rels.slice(i, i + BATCH).map((rel) => copyIfChanged(root, rel).catch(() => false)));
      copied += done.filter(Boolean).length;
    }
    const removed = await removeStale(new Set(rels));
    await fs.promises.writeFile(path.join(MIRROR_DIR, MARKER), new Date().toISOString());
    lastSync = { at: Date.now(), files: rels.length, copied, removed, ms: Date.now() - started };
    return lastSync;
  })().finally(() => { syncing = null; });
  return syncing;
}

/** Starts the periodic refresh (the bridge calls this once); returns a stop function. */
export function startNotesMirror({ log = () => {} } = {}) {
  const tick = () => syncNotes().then((r) => log(`notes mirror: ${r.files} files, ${r.copied} copied, ${r.removed} removed in ${r.ms} ms`))
    .catch((err) => log(`notes mirror failed: ${err.message}`));
  const first = setTimeout(tick, 2000);
  const timer = setInterval(tick, REFRESH_MS);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
