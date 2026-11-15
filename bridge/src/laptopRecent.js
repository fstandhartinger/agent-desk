// laptop.recent (LeChonk bridge): the last messages of Florian's laptop main session from the compact laptop mirror
// (~/data/laptop-mirror, written every 10 minutes by the laptop chief of staff). The gateway's start briefing uses it when the
// Screen Agent sends no main-session messages: its 512 kB byte tail of the 967 MB transcript often holds only huge tool
// results and no complete message ("main-session:no-messages", 15 Nov 2026).
// Day files: sessions/<project>__<sid8>__<YYYY-MM-DD>.md with blocks "### 2026-11-15 19:46 UTC — Florian|Claude" and the text
// below; tool calls are single "[Werkzeug …]" lines and are skipped. Read-only; the bridge redacts the result like every other.
import fs from 'node:fs';
import path from 'node:path';
import { LAPTOP_MIRROR, isDenied } from './paths.js';

const MAX_TAIL = 256 * 1024; // the newest messages are at the end of a day file (files stay < 1.5 MB)
const MSG_CHARS = 600;
const HEAD = /^### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC — (.+?)\s*$/;
const DAY_FILE = /^(.+?)__([0-9a-f]{8})__(\d{4}-\d{2}-\d{2})\.md$/;

/** The main session's id from INDEX.md ("Sitzung 31036e59" in the line about the Hauptsitzung), or null. */
export function mainSessionId(indexText) {
  const line = String(indexText ?? '').split('\n').find((l) => /Hauptsitzung/i.test(l));
  return /Sitzung ([0-9a-f]{8})/.exec(line ?? '')?.[1] ?? null;
}

/** Messages of a day file's text, oldest first: [{role, at, text}] (tool-only blocks dropped). */
export function parseDay(text) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.lines.filter((l) => !/^\[Werkzeug\b/.test(l.trim())).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (body) out.push({ role: cur.role, at: cur.at, text: body.length > MSG_CHARS ? `${body.slice(0, MSG_CHARS - 1)}…` : body });
    cur = null;
  };
  for (const line of String(text ?? '').split('\n')) {
    const m = HEAD.exec(line);
    if (m) {
      flush();
      cur = { role: /^florian$/i.test(m[3]) ? 'user' : 'assistant', at: `${m[1]}T${m[2]}:00Z`, lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  flush();
  return out;
}

export async function recent({ limit = 12 } = {}, { dir = LAPTOP_MIRROR } = {}) {
  const n = Math.min(Math.max(Number.isInteger(limit) ? limit : 12, 1), 30);
  const sessions = path.join(dir, 'sessions');
  let names = [];
  try { names = (await fs.promises.readdir(sessions)).filter((f) => DAY_FILE.test(f) && !isDenied(f)); } catch { throw new Error('laptop mirror not available'); }
  if (!names.length) throw new Error('laptop mirror has no session files');
  let main = null;
  try { main = mainSessionId(await fs.promises.readFile(path.join(dir, 'INDEX.md'), 'utf8')); } catch { main = null; /* no index yet: newest file wins */ }
  const stats = await Promise.all(names.map(async (f) => ({ f, m: DAY_FILE.exec(f), mtime: (await fs.promises.stat(path.join(sessions, f))).mtimeMs })));
  const pool = main ? stats.filter((s) => s.m[2] === main) : [];
  const pick = (pool.length ? pool : stats).sort((a, b) => b.m[3].localeCompare(a.m[3]) || b.mtime - a.mtime)[0];
  const file = path.join(sessions, pick.f);
  const fh = await fs.promises.open(file, 'r');
  let text;
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - MAX_TAIL);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n### ') + 1); // start at a message head, never mid-message
  } finally { await fh.close(); }
  const messages = parseDay(text).slice(-n);
  return { source: 'laptop-mirror', session: `${pick.m[1]}/${pick.m[2]}`, day: pick.m[3], updatedAt: new Date(pick.mtime).toISOString(), messages };
}
