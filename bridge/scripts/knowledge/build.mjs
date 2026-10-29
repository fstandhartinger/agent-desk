#!/usr/bin/env node
// Daily refresh of the desk knowledge index (~/desk-knowledge, private, never in the repo).
//
// Each topics/<slug>.md has a curated part (written by hand/agents from the real sources) and an automatic part:
//   # Title
//   <!-- keywords: sn92, reax, subnet 92 -->
//   <!-- curated:start --> ... <!-- curated:end -->      ← never touched by this script
//   <!-- auto:start --> ## Neu seit gestern ... <!-- auto:end -->   ← rewritten on every run
// The automatic part lists DECISIONS.md entries and agent-board entries of the last 48 h that match the topic's
// keywords. INDEX.md gets one automatic line with the topics that have news. Deterministic for the same inputs and
// --now. Self-contained (no imports from bridge/src) so the timer can run a copy in ~/desk-knowledge/.generator.
//
// Usage: node build.mjs [--dir ~/desk-knowledge] [--decisions ~/DECISIONS.md] [--board-file dump.txt] [--now ISO] [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WINDOW_MS = 48 * 3600 * 1000;
export const TOPIC_MAX = 8000;
export const INDEX_MAX = 6000;
const PER_SOURCE = 8;
const SKIP_THREADS = new Set(['28']);
const LINE_MAX = 200;
const AUTO = /<!-- auto:start -->[\s\S]*?<!-- auto:end -->\n?/;
const KEYWORDS = /<!--\s*keywords:\s*(.*?)\s*-->/i;
// Narrower list for "Neu seit gestern"; the broad keywords above serve the topic search. Falls back to keywords.
const NEWS_KEYWORDS = /<!--\s*news-keywords:\s*(.*?)\s*-->/i;
const SECRETISH = [
  /(?<![A-Za-z0-9])(sk|xai|ghp|gho|cpk)[-_][A-Za-z0-9_.-]{16,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/g,
  /(api[_-]?key|token|secret|password|seed|mnemonic)\s*[:=]\s*\S{6,}/gi,
];

export const scrub = (text) => SECRETISH.reduce((t, re) => t.replace(re, '[REDACTED]'), String(text));
const oneLine = (text) => scrub(String(text).replace(/\s+/g, ' ').trim()).slice(0, LINE_MAX);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A keyword matcher returning how many DISTINCT keywords a text contains (0 = no match). Keywords of up to 4
 * characters only match whole words ("tax" not in "syntax").
 */
export function keywordMatcher(keywords) {
  const res = keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 2)
    .map((k) => new RegExp(k.length <= 4 ? `(?<![\\p{L}\\p{N}_])${escape(k)}(?![\\p{L}\\p{N}_])` : escape(k), 'iu'));
  return (text) => res.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

/** DECISIONS.md (newest first) → [{date, heading, text}]. */
export function parseDecisions(markdown) {
  const entries = [];
  let cur = null;
  for (const line of String(markdown).split('\n')) {
    const m = /^## (\d{4}-\d{2}-\d{2})\b/.exec(line);
    if (m) { cur = { date: m[1], heading: line.slice(3).trim(), lines: [] }; entries.push(cur); } else if (cur) cur.lines.push(line);
  }
  return entries.map(({ lines, ...e }) => ({ ...e, text: lines.join('\n').replace(/\nresolved-keys:.*$/s, '').trim() }));
}

/** `agent-board read` output → [{id, ts, author, text}]. */
export function parseBoard(text) {
  return String(text).split(/\n(?=#\d+ \[)/).flatMap((block) => {
    const m = /^#(\d+) \[([^\]]+)\] ([^\n]*)\n?([\s\S]*)$/.exec(block.trim());
    return m ? [{ id: Number(m[1]), ts: m[2], author: m[3].split(' · ')[0].trim(), head: m[3], text: m[4].trim() }] : [];
  });
}

/** Board entries of the last 48 h from every thread active in that window (read-only CLI). */
export function readBoardRecent(now) {
  const env = { ...process.env, AGENT_BOARD_NAME: process.env.AGENT_BOARD_NAME || 'desk:knowledge' };
  const bin = path.join(os.homedir(), 'bin', 'agent-board');
  const run = (args) => execFileSync(bin, args, { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const cutoff = new Date(now.getTime() - WINDOW_MS).toISOString();
  const threads = run(['threads']).split('\n').flatMap((line) => {
    const m = /^#(\d+) (.+?) (?:\[[^\]]*\] )?· \d+ entries · (\S+) · latest #(\d+)/.exec(line);
    return m && m[3] >= cutoff ? [{ id: m[1], title: m[2], latest: Number(m[4]) }] : [];
  });
  const out = [];
  for (const t of threads) {
    // Entry ids are global and increasing; ~3,000 ids comfortably cover 48 h of the whole board.
    const since = Math.max(0, t.latest - 3000);
    let text = '';
    try { text = run(['read', t.id, '--since', String(since)]); } catch { continue; }
    for (const e of parseBoard(text)) if (e.ts >= cutoff) out.push({ ...e, thread: t.id, threadTitle: t.title });
  }
  return out;
}

/** Splits a topic file into title, keywords and the curated text (everything except the auto block). */
export function parseTopic(text) {
  return {
    title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? '',
    keywords: (KEYWORDS.exec(text)?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean),
    newsKeywords: (NEWS_KEYWORDS.exec(text)?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean),
    curated: text.replace(AUTO, ''),
  };
}

/**
 * The automatic "Neu seit gestern" block for one topic. DECISIONS and board entries of the last 48 h compete for the
 * same space: the ones naming the most of the topic's keywords are kept first (then the newest), up to PER_SOURCE per
 * source and the size budget; the kept lines are listed newest first.
 */
export function renderAuto({ keywords, decisions, board, now, budget }) {
  const match = keywordMatcher(keywords);
  const cutoffDate = new Date(now.getTime() - WINDOW_MS).toISOString().slice(0, 10);
  const dec = decisions.filter((d) => d.date >= cutoffDate).map((d) => ({
    n: match(`${d.heading}\n${d.text}`), source: 'dec', when: `${d.date} ${d.heading.slice(11, 17)}`,
    line: `- DECISIONS ${d.date}: ${oneLine(`${d.heading.replace(/^\d{4}-\d{2}-\d{2}\s*/, '')} — ${d.text}`)}`,
  }));
  // Digest full logs (thread #28) repeat every other entry and would win every keyword count.
  const brd = board.filter((e) => !SKIP_THREADS.has(String(e.thread)) && !/^Digest full log/.test(e.text)).map((e) => ({
    n: match(e.text), source: 'brd', when: e.ts.slice(0, 16).replace('T', ' '),
    line: `- Board #${e.id} (thread #${e.thread}, ${e.ts.slice(0, 16).replace('T', ' ')}Z, ${e.author}): ${oneLine(e.text)}`,
  }));
  const candidates = [...dec, ...brd].filter((c) => c.n > 0).sort((x, y) => y.n - x.n || (y.when > x.when ? 1 : y.when < x.when ? -1 : 0));
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const head = ['<!-- auto:start -->', `## Neu seit gestern (automatisch, Stand ${stamp} UTC, letzte 48 h)`];
  const tail = ['<!-- auto:end -->', ''];
  let size = head.join('\n').length + tail.join('\n').length + 2;
  const kept = [];
  const perSource = { dec: 0, brd: 0 };
  for (const c of candidates) {
    if (perSource[c.source] >= PER_SOURCE || size + c.line.length + 1 > budget) continue;
    kept.push(c);
    perSource[c.source] += 1;
    size += c.line.length + 1;
  }
  kept.sort((x, y) => (y.when > x.when ? 1 : y.when < x.when ? -1 : 0));
  const lines = kept.length ? kept.map((c) => c.line) : ['- Keine neuen Einträge in DECISIONS oder auf dem Board zu diesem Thema.'];
  return { block: [...head, ...lines, ...tail].join('\n'), count: kept.length };
}

/** Rebuilds one topic file's text: curated part untouched, auto block replaced, total ≤ TOPIC_MAX. */
export function buildTopic(text, { decisions, board, now }) {
  const { keywords, newsKeywords, curated } = parseTopic(text);
  const base = curated.endsWith('\n') ? curated : `${curated}\n`;
  const budget = Math.max(300, TOPIC_MAX - base.length - 1);
  const { block, count } = renderAuto({ keywords: newsKeywords.length ? newsKeywords : keywords, decisions, board, now, budget });
  return { text: `${base}\n${block}`.replace(/\n{3,}/g, '\n\n'), count };
}

/** INDEX.md: curated text untouched plus one automatic line naming the topics with news. */
export function buildIndex(text, news, now) {
  const base = text.replace(AUTO, '').replace(/\n+$/, '\n');
  const list = news.filter((n) => n.count > 0).map((n) => `${n.slug} (${n.count})`).join(', ') || 'keine';
  const block = `<!-- auto:start -->\nNeu seit gestern (${now.toISOString().slice(0, 10)}): ${list}. Details: knowledge_read <thema>, Abschnitt "Neu seit gestern".\n<!-- auto:end -->\n`;
  return `${base}\n${block}`;
}

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // mode above only applies to new files
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

export function main() {
  const home = os.homedir();
  const dir = arg('dir', process.env.DESK_KNOWLEDGE_DIR || path.join(home, 'desk-knowledge'));
  const now = new Date(arg('now', new Date().toISOString()));
  const decisionsFile = arg('decisions', path.join(home, 'DECISIONS.md'));
  const boardFile = arg('board-file', null);
  const dry = process.argv.includes('--dry-run');
  const topicsDir = path.join(dir, 'topics');
  if (!fs.existsSync(topicsDir)) throw new Error(`${topicsDir} missing`);
  const head = fs.readFileSync(decisionsFile, 'utf8').slice(0, 512 * 1024);
  const decisions = parseDecisions(head);
  let board = [];
  try {
    board = boardFile ? parseBoard(fs.readFileSync(boardFile, 'utf8')).map((e) => ({ thread: '?', ...e })) : readBoardRecent(now);
  } catch (err) {
    console.error(`board skipped: ${err.message}`);
  }
  const news = [];
  for (const name of fs.readdirSync(topicsDir).filter((n) => n.endsWith('.md')).sort()) {
    const file = path.join(topicsDir, name);
    const { text, count } = buildTopic(fs.readFileSync(file, 'utf8'), { decisions, board, now });
    news.push({ slug: name.slice(0, -3), count, chars: text.length });
    if (!dry) writePrivate(file, text);
  }
  const indexFile = path.join(dir, 'INDEX.md');
  if (fs.existsSync(indexFile) && !dry) writePrivate(indexFile, buildIndex(fs.readFileSync(indexFile, 'utf8'), news, now));
  console.log(JSON.stringify({ at: now.toISOString(), decisions: decisions.length, board: board.length, topics: news }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`desk-knowledge build failed: ${err.message}`); process.exit(1); }
}
