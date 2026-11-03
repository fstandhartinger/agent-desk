import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME } from './paths.js';
import { redact } from './redact.js';
import * as ops from './ops.js';

// state.current: the short picture for the start briefing. STATE.md auto block, newest DECISIONS headings, running jobs
// and open asks (the read-only ops commands). Every part capped; a part that fails is left out and named in `missing`.

const STATE_CAP = 2500;
const HEAD_CAP = 160;
const ASKS_SHOWN = 8;

async function readHead(file, max) {
  const fd = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fd.read(buf, 0, max, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally { await fd.close(); }
}

/** The text between the auto markers of STATE.md (pure, tested). */
export function autoBlock(text) {
  const m = /<!-- auto:start -->([\s\S]*?)(?:<!-- auto:end -->|$)/.exec(String(text));
  return m ? m[1].replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 40).join('\n') : '';
}

/** "## 2026-10-31 18:5xZ — title" headings, newest date first; the file order is not trusted (pure, tested). */
export function newestHeadings(text, n = 3) {
  const heads = String(text).split('\n').filter((l) => /^## \d{4}-\d{2}-\d{2}/.test(l)).map((l, i) => ({ l: l.slice(3).trim(), i }));
  heads.sort((a, b) => (a.l.slice(0, 16) < b.l.slice(0, 16) ? 1 : a.l.slice(0, 16) > b.l.slice(0, 16) ? -1 : b.i - a.i));
  return heads.slice(0, n).map((x) => redact(x.l).slice(0, HEAD_CAP));
}

const lines = (t) => String(t ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

export async function current() {
  const missing = [];
  const out = {};
  const [state, decisions, jobs, asks] = await Promise.allSettled([
    readHead(path.join(HOME, 'STATE.md'), 24 * 1024),
    fs.readFile(path.join(HOME, 'DECISIONS.md'), 'utf8').then((t) => t.slice(-400 * 1024)),
    ops.run({ command: 'jobs_running' }),
    ops.run({ command: 'asks_open' }),
  ]);
  if (state.status === 'fulfilled') out.state = redact(autoBlock(state.value)).slice(0, STATE_CAP); else missing.push('state');
  if (decisions.status === 'fulfilled') out.decisions = newestHeadings(decisions.value, 3); else missing.push('decisions');
  if (jobs.status === 'fulfilled') out.jobsRunning = lines(jobs.value.text).length; else missing.push('jobs');
  if (asks.status === 'fulfilled') {
    const l = lines(asks.value.text);
    out.asksOpen = l.length;
    out.asks = l.slice(0, ASKS_SHOWN).map((x) => redact(x).slice(0, 200));
  } else missing.push('asks');
  if (missing.length) out.missing = missing;
  return out;
}
