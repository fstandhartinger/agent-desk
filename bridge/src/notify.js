import fs from 'node:fs/promises';
import { HOME } from './paths.js';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { redact } from './redact.js';

// notify.loginLink: sends the desk login link to Florian through the central notify command (docs/CANVAS.md "Login UX gap").
// The gateway signs the link; the bridge only delivers it. BRIDGE_NOTIFY_BIN lets tests substitute a fake script.

const URL_RE = /^https:\/\/desk\.app\.mintapis\.com\/[^\s"'`<>\\]*$/;
const notifyBin = () => process.env.BRIDGE_NOTIFY_BIN || path.join(os.homedir(), 'bin', 'notify');

// CANVAS.md words this card in German, but notify rejects German prose ("rewrite the body in plain English") and
// requires a result sentence after "Worum geht's:"; this wording passes `notify now --dry-run --requested`.
export const loginCard = (url) => `✅ ERLEDIGT\nWorum geht's: Your Agent Desk login link (desk.app.mintapis.com) is ready to open.\n${url}\n${url.includes('#k=L2.') ? 'Valid for 5 min, one use.' : 'Valid for 24 h, 3 uses.'}`;

export async function loginLink({ url } = {}) {
  if (typeof url !== 'string' || url.length > 600 || !URL_RE.test(url)) throw new Error('url must be an https://desk.app.mintapis.com/ link');
  const args = ['now', '--requested', loginCard(url)];
  return new Promise((resolve) => {
    execFile(notifyBin(), args, { timeout: 240_000, env: { ...process.env, AGENT_BOARD_NAME: 'desk:bridge' }, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // The link is a secret: it never goes back into the detail text.
      const clean = (s) => redact(String(s ?? '')).replaceAll(url, '[link]').trim().slice(-300);
      const out = clean(`${stdout}\n${stderr}`) || clean(err?.message);
      if (/QUEUED: outbox [0-9]+/.test(String(stdout))) return resolve({ sent: false, queued: true, detail: 'queued in notify' });
      if (!err) return resolve({ sent: !/NOT SENT|BOARD ONLY/.test(String(stdout)), detail: out || 'sent' });
      resolve({ sent: false, detail: out || 'notify failed', ...(typeof err.code === 'number' ? { exit: err.code } : {}) });
    });
  });
}

/** Fixed notify card index only; no details body or arbitrary files. */
export async function cardLink({ id } = {}) {
  if (typeof id !== 'string' || !/^[1-9]\d{0,11}$/.test(id)) throw new Error('invalid card id');
  const file = path.join(HOME, '.notify', 'cards', `${id}.json`);
  const fd = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(65537);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    if (bytesRead > 65536) throw new Error('card too large');
    const card = JSON.parse(buf.toString('utf8', 0, bytesRead));
    const url = String(card.text ?? '').match(/https:\/\/cards\.app\.mintapis\.com\/p\/[A-Za-z0-9_-]+/)?.[0];
    return { title: `Karte ${id}`, ...(url ? { url } : {}), note: 'Nur Link und Titel verfügbar; Karteninhalt nicht freigegeben.' };
  } finally { await fd.close(); }
}

const PAGE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const READ_CAP = 3500;
const DETAILS_CAP = 4000;

const BLOCK_END = new Set(['p', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'div', 'table']);
const ENTITIES = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&amp;': '&' };

/**
 * Plain text of a stored copy page or card: scripts, styles, <head> and the artifact badge are dropped, block ends
 * become line breaks, table cells " | ". A single indexOf scanner (no backtracking regex), so hostile input stays linear.
 */
export function pageText(html) {
  const src = String(html ?? '');
  let out = '', i = 0, skip = null;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { if (!skip) out += src.slice(i); break; }
    if (!skip) out += src.slice(i, lt);
    const gt = src.indexOf('>', lt);
    if (gt < 0) { if (!skip) out += src.slice(lt); break; }
    const tag = src.slice(lt + 1, gt);
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9]{0,9})/.exec(tag);
    const name = m?.[2].toLowerCase();
    if (skip) { if (m?.[1] && name === skip) skip = null; }
    else if (m && !m[1] && (name === 'script' || name === 'style' || name === 'head' || (name === 'div' && tag.includes('data-card-artifacts')))) skip = name;
    else if (m && (m[1] && BLOCK_END.has(name) || name === 'br')) out += '\n';
    else if (m && m[1] && (name === 'td' || name === 'th')) out += ' | ';
    i = gt + 1;
  }
  const text = out.replace(/&(?:nbsp|lt|gt|quot|#x27|#39|amp);/g, (e) => ENTITIES[e]);
  return text.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

async function readCapped(file, max) {
  const fd = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    if (bytesRead > max) throw new Error('file too large');
    return buf.toString('utf8', 0, bytesRead);
  } finally { await fd.close(); }
}

/**
 * Agent Desk reader for a Telegram card by its message number (a#xxxxxx resolves to card:N in the registry).
 * Returns the card's own text (headline, Why/Catch, the chosen button, "↳ Agent" lines), the text of its Details page
 * from the local page store, and the a# ids it mentions. Fixed ~/.notify/cards/<n>.json and pages/<id>.json only.
 */
export async function cardRead({ id, includeState = false } = {}) {
  if (typeof id !== 'string' || !/^[1-9]\d{0,11}$/.test(id)) throw new Error('invalid card id');
  const card = JSON.parse(await readCapped(path.join(HOME, '.notify', 'cards', `${id}.json`), 65536));
  const raw = String(card.text ?? '');
  // HTML cards (card v2) lose their tags; plain cards keep every character ("<reviewed-sha>" is content there).
  const lines = (card.parse_mode === 'HTML' ? pageText(raw) : raw.split('\n').map((l) => l.trim()).filter(Boolean).join('\n')).split('\n');
  const footer = lines.findLastIndex((l) => /^a#[0-9a-f]{6}(?:\s*·\s*Karte\s+\d+)?$/i.test(l));
  const body = lines.filter((_, i) => i !== footer).join('\n');
  const own = /a#([0-9a-f]{6})/i.exec(footer >= 0 ? lines[footer] : '')?.[1]?.toLowerCase() ?? (typeof card.aid === 'string' ? card.aid : null);
  const linked = [...new Set([...body.matchAll(/(?<!\w)a#([0-9a-f]{6})(?!\w)/gi)].map((m) => m[1].toLowerCase()))].filter((x) => x !== own);
  const url = raw.match(/https:\/\/cards\.app\.mintapis\.com\/p\/([A-Za-z0-9_-]+)/);
  let details = null;
  if (url && PAGE_ID.test(url[1])) {
    try {
      const page = JSON.parse(await readCapped(path.join(HOME, '.notify', 'pages', `${url[1]}.json`), MAX_PAGE_BYTES));
      if (!(Number(page.expires) < Date.now() / 1000)) details = redact(pageText(page.html).slice(0, DETAILS_CAP));
    } catch { /* The page may be expired or never published; the card text still stands. */ }
  }
  return {
    id, ...(own ? { aid: own } : {}), source: redact(String(card.source ?? '')).slice(0, 200),
    ...(card.answered ? { answered: true } : {}), bot: card.bot === 'TG_URGENT_BOT_TOKEN' ? 'urgent' : 'main',
    text: redact(body.slice(0, READ_CAP)), ...(url ? { url: url[0] } : {}), ...(details ? { details } : {}),
    ...(includeState ? {
      ask: card.ask === true, status: redact(String(card.status ?? '')).slice(0, 40),
      ...(card.settled ? { settled: redact(String(card.settled.line ?? '')).slice(0, 300) || true } : {}),
    } : {}),
    ...(linked.length ? { linked_ids: linked.map((x) => `a#${x}`) } : {}),
  };
}
const MAX_PAGE_BYTES = 512 * 1024;
const CARD_DIR = path.join(HOME, '.notify', 'cards');
const CARD_ID = /^[1-9]\d{0,11}$/;
const summaries = new Map();

function headline(lines) {
  return lines.find((line) => /^Worum geht['’]s:/i.test(line))?.replace(/^[^:]+:\s*/, '')
    ?? lines.find((line) => !/^(?:[🧑🤖✅🚨]|a#)/u.test(line)) ?? '';
}

async function indexedSummary(id) {
  const file = path.join(CARD_DIR, `${id}.json`);
  const { ino, mtimeMs } = await fs.stat(file);
  const cached = summaries.get(id);
  if (cached?.ino === ino && cached.mtimeMs === mtimeMs) return cached.value;
  const card = JSON.parse(await readCapped(file, 65536));
  const lines = (card.parse_mode === 'HTML' ? pageText(card.text) : String(card.text ?? '')).split('\n').map((line) => line.trim()).filter(Boolean);
  const footer = lines.findLast((line) => /^a#[0-9a-f]{6}(?:\s*·\s*Karte\s+\d+)?$/i.test(line));
  const aid = (footer?.slice(2, 8) ?? card.aid ?? '').toLowerCase();
  const status = card.settled || /^✅/.test(card.status || lines[0] || '') ? 'erledigt'
    : card.answered ? 'beantwortet' : card.ask ? 'offen' : '';
  const rawTitle = typeof card.voice_summary === 'string' ? card.voice_summary : headline(lines);
  const title = redact(rawTitle).replace(/https?:\/\/\S+|\ba#[0-9a-f]{6}\b/gi, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const value = title ? { id, aid, title, status } : null;
  summaries.delete(id);
  summaries.set(id, { ino, mtimeMs, value });
  if (summaries.size > 100) summaries.delete(summaries.keys().next().value);
  return value;
}

export async function prefetchCardSummaries() {
  const ids = (await fs.readdir(CARD_DIR)).map((name) => name.replace(/\.json$/, '')).filter((id) => CARD_ID.test(id));
  // Message numbers increase on each send. Older files can still be read on demand.
  await Promise.allSettled(ids.sort((a, b) => Number(b) - Number(a)).slice(0, 50).map(indexedSummary));
}

export async function cardVoiceSummary({ id, aid } = {}) {
  if (aid !== undefined && !/^[0-9a-f]{6}$/.test(aid)) return null;
  if (!id && aid) id = [...summaries.values()].find(({ value }) => value?.aid === aid)?.value.id;
  if (typeof id !== 'string' || !CARD_ID.test(id)) return null;
  try {
    const summary = await indexedSummary(id);
    return aid && summary?.aid !== aid ? null : summary;
  } catch { /* The local card may have been removed, or its cached file may be unreadable. */ return null; }
}

/**
 * notify.cardsRecent: Telegram cards of the last hours for the start briefing. Reads ~/.notify/cards/*.json directly
 * (read-only, no token); the file's mtime is the time. Status line = the first line, headline = "Worum geht's:" line
 * or the first bold line.
 */
export async function cardsRecent({ hours = 12, limit = 20 } = {}) {
  const h = Math.min(72, Math.max(1, Number(hours) || 12));
  const n = Math.min(50, Math.max(1, Math.trunc(Number(limit)) || 20));
  const dir = path.join(HOME, '.notify', 'cards');
  const since = Date.now() - h * 3600_000;
  let names;
  try { names = (await fs.readdir(dir)).filter((f) => /^[1-9]\d{0,11}\.json$/.test(f)); } catch { return { hours: h, cards: [] }; }
  const stats = (await Promise.all(names.map(async (f) => {
    try { return { id: f.slice(0, -5), mtime: (await fs.stat(path.join(dir, f))).mtimeMs }; } catch { /* absent */ return null; }
  }))).filter((x) => x && x.mtime >= since).sort((a, b) => b.mtime - a.mtime).slice(0, n * 3);
  const cards = [];
  for (const { id, mtime } of stats) {
    if (cards.length >= n) break;
    try {
      const card = JSON.parse(await readCapped(path.join(dir, `${id}.json`), 65536));
      const raw = String(card.text ?? '');
      const lines = (card.parse_mode === 'HTML' ? pageText(raw) : raw).split('\n').map((l) => l.trim()).filter(Boolean);
      const head = lines.find((l) => /^(?:Worum geht's|Worum geht’s):/i.test(l))?.replace(/^[^:]+:\s*/, '') ?? lines[1] ?? '';
      cards.push({
        card: id, at: new Date(mtime).toISOString(), status: redact(lines[0] ?? '').slice(0, 40),
        headline: redact(head).slice(0, 200), answered: !!card.answered,
        ...(typeof card.aid === 'string' && /^[0-9a-f]{6}$/i.test(card.aid) ? { aid: `a#${card.aid.toLowerCase()}` } : {}),
      });
    } catch { /* unreadable card: skipped */ }
  }
  return { hours: h, cards };
}
