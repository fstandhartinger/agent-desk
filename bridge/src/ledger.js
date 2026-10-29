import fs from 'node:fs';
import path from 'node:path';
import * as board from './board.js';
import { HOME } from './paths.js';
import { redact } from './redact.js';

// ledger.entries: real money movements, aggregated deterministically (docs/CANVAS.md "Bridge").
// Sources: the export file (LEDGER_EXPORT) and every `TAX:` line of board thread #22 (standing rule of 20 Oct 2026).

const THREAD = '22';
const CACHE_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;
export const FX_USD_EUR = 0.894; // card rate seen on the TensorX lines: USD 5.00 = EUR ~4.47
export const FX_NOTE = `EUR-Näherung: "EUR ~x" aus der Zeile, sonst bei USD Festkurs ${FX_USD_EUR} EUR je USD (Kartenkurs TensorX: 5 USD = 4,47 EUR). Schätzwerte, keine Buchhaltung.`;

export const exportPath = () => process.env.LEDGER_EXPORT || path.join(HOME, 'data', 'ledger', 'GELDBEWEGUNGEN_2026.md');

// ---------------------------------------------------------------- numbers

/** "3,210.00" / "3.210,00" / "4,47" / "4.47" / "1.234.567" -> number. A lone "." is always a decimal point. */
export function parseNumber(raw) {
  let s = String(raw).replace(/\s/g, '');
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  if (dots && commas) {
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (commas) {
    const tail = s.slice(s.lastIndexOf(',') + 1);
    s = commas === 1 && tail.length !== 3 ? s.replace(',', '.') : s.replaceAll(',', '');
  } else if (dots > 1) s = s.replaceAll('.', '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const CURRENCY = { EUR: 'EUR', '€': 'EUR', USD: 'USD', $: 'USD' };
const NUM = '(\\d[\\d.,]*\\d|\\d)';
const NOT_A_RATE = '(?![\\d.,]*\\s*\\/)(?!\\d)'; // "EUR 211.40/TAO", "EUR 2.30/h" are prices, not payments
const AMT_PREFIX = new RegExp(`(?<![A-Za-z0-9])(EUR|USD|€|\\$)\\s*[~≈]?\\s*${NUM}${NOT_A_RATE}`, 'gi');
const AMT_SUFFIX = new RegExp(`(?<![\\d.,])${NUM}\\s*(EUR|USD|€|\\$)(?![A-Za-z])`, 'gi');
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;

/** First money amount of the text: {amount, currency, index} or null. Dates and times are blanked out first. */
export function findAmount(text) {
  const blank = String(text).replace(/\d{4}-\d{2}-\d{2}(\/\d{2})?/g, (m) => ' '.repeat(m.length)).replace(/\d{1,2}:\d{2}(:\d{2})?Z?/g, (m) => ' '.repeat(m.length));
  const hits = [];
  for (const m of blank.matchAll(AMT_PREFIX)) hits.push({ index: m.index, end: m.index + m[0].length, cur: m[1], num: m[2] });
  for (const m of blank.matchAll(AMT_SUFFIX)) hits.push({ index: m.index, end: m.index + m[0].length, cur: m[2], num: m[1] });
  hits.sort((a, b) => a.index - b.index);
  for (const h of hits) {
    const amount = parseNumber(h.num);
    if (amount !== null) return { amount, currency: CURRENCY[h.cur.toUpperCase()] ?? h.cur.toUpperCase(), index: h.index, end: h.end };
  }
  return null;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function eurApprox(text, amount, currency) {
  if (currency === 'EUR') return round2(amount);
  const hint = /EUR\s*~\s*(\d[\d.,]*\d|\d)/i.exec(text);
  const n = hint ? parseNumber(hint[1]) : null;
  if (n !== null) return round2(n);
  if (currency === 'USD') return round2(amount * FX_USD_EUR);
  return undefined;
}

// ---------------------------------------------------------------- categories

// Ordered; first match wins. Tested against counterparty + purpose (lower case).
export const CATEGORY_RULES = [
  ['GPU', /runpod|\blium\b|verda|upcloud|vast\.ai|coreweave|lambda labs|\bgpu\b|\bh100\b|\bh200\b|\brtx\b|bare-metal/],
  // SN92 owner-share payouts / refunds / compensation from the REAX wallet (alpha or TAO, to a coldkey).
  ['SN92-Auszahlungen', /\bα|\balpha\b|coldkey|reax wallet|\btao\b.*→|refund of the re-registration|goodwill payment/],
  ['LLM-APIs', /openrouter|tensorx|anthropic|openai|deepinfra|together\.ai|groq|\bxai\b|chutes|mistral|elevenlabs|\bllm\b|api usage|api credit/],
  ['Domains', /domain|namecheap|godaddy|inwx|porkbun/],
  ['Steuer/Gebühren', /steuer|finanzamt|gebühr|gebuehr|\btax\b|\bfee\b|listing fee/],
  ['Hosting/Server', /hetzner|coolify|hosting|\bserver\b|\bvps\b|ionos|render\.com|cloudflare|netcup|digitalocean/],
  ['Telefonie', /telnyx|twilio|sipgate|phone line|\bsms\b/],
  ['Abos', /\babo\b|subscription|\bplan\b|claude max|chatgpt|sentry|copilot|monthly/],
];

export function categorize(counterparty, purpose) {
  const hay = `${counterparty} ${purpose}`.toLowerCase();
  for (const [name, re] of CATEGORY_RULES) if (re.test(hay)) return name;
  return 'Sonstiges';
}

// ---------------------------------------------------------------- one TAX line

const VENDORS = [
  [/upcloud/i, 'UpCloud Oy'], [/tensorx/i, 'TensorX Ltd'], [/openrouter/i, 'OpenRouter'], [/runpod/i, 'RunPod'],
  [/verda/i, 'Verda Cloud Oy'], [/\blium\b/i, 'Lium'], [/telnyx/i, 'Telnyx LLC'],
];

/** Splits at top-level separators: " | " when present, otherwise commas outside parentheses. */
export function splitFields(text) {
  if (/\s\|\s/.test(text)) return text.split(/\s\|\s/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    const inNumber = ch === ',' && /\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? ''); // 3,210.00 / 4,47
    if (ch === ',' && depth === 0 && !inNumber) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** "Example Hub / Foocorp — pro forma PF/12/345" -> "Example Hub / Foocorp": purpose and receipt text is no part of the payee. */
export function cleanCounterparty(name) {
  return String(name ?? '')
    .replace(/(?<!\s)\s+[—–]\s+[\s\S]*$/, '') // [\s\S]*$ always matches: no backtracking into \s+ (critic r7)
    .replace(/(?<!\s)\s+-\s+(?:pro forma|invoice|receipt|rechnung|beleg)\b[\s\S]*$/i, '')
    .replace(/(?<![\s,;:])[\s,;:]+(?:pro forma|invoice|receipt|rechnung|beleg)\b[\s\S]*$/i, '')
    .trim();
}

const stripParens = (s) => s.replace(/(?<!\s)\s*\([^)]{0,80}\)/g, '').replace(/(?<![.:;\s])[.:;\s]+$/, '').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function detectKg(text) {
  if (/\b(not|nicht|kein)\s+KG\b/i.test(text)) return false;
  if (/(?:^|[,|]\s*|\s)(private|privat)\s*(?:\.\s*)?$/i.test(text.trim())) return false;
  if (/\bKG\b/.test(text)) return true;
  if (/\b(private|privat)\b/i.test(text)) return false;
  return null;
}

const RECEIPT_RES = [
  /pro forma\s+PF\/[\d/]+/i, /(?<![\w./-])[\w./-]*receipts\/[\w./-]+/i,
  /(?:Gmail\s+)?UID\s+\d+/i, /invoice\s+\d{6,}/i, /receipt\s+#[\w-]+/i, /Extrinsic\s+[\d-]+/i, /\bTID\s+\w+/i,
  /receipts?\s*:\s*\S+/i, /receipt\s*=\s*[^;,]+/i,
];

function findReceipt(text) {
  for (const re of RECEIPT_RES) {
    const m = re.exec(text);
    if (m) return cut(m[0].replace(/^receipts?\s*[:=]\s*/i, '').trim(), 80);
  }
  return null;
}

function findTime(text, afterIndex) {
  const m = /(?:^|[\s,T~])(\d{1,2}:\d{2})\s*Z?/.exec(text.slice(afterIndex, afterIndex + 40));
  return m ? m[1].padStart(5, '0') : null;
}

/** "~21:20Z and ~21:30Z ... ~USD 100 each": one booking per timestamp named before the amount. */
function eachTimes(text, amt) {
  if (!/^\s*(?:\)\s*)?each\b/i.test(text.slice(amt.end, amt.end + 12))) return null;
  const times = [...new Set([...text.slice(0, amt.index).matchAll(/(\d{1,2}:\d{2})\s*Z/g)].map((m) => m[1].padStart(5, '0')))];
  return times.length > 1 ? times.slice(0, 10) : null;
}

function fieldAfterAmount(fields, amountMatch) {
  const idx = fields.findIndex((f) => f.includes(amountMatch));
  return idx >= 0 ? { counterparty: fields[idx + 1] ?? '', purpose: fields[idx + 2] ?? '', idx } : { counterparty: '', purpose: '', idx };
}

/**
 * Parses the text after "TAX:" into 0..n entries (several when the line repeats because of "each").
 * ctx: {entryId, entryTs, source}. Returns [] when there is no date or no amount (caller counts it as unparsed).
 */
export function parseTaxText(raw, ctx = {}) {
  const text = String(raw).replace(/\s+/g, ' ').trim();
  const dm = DATE_RE.exec(text);
  const date = dm ? dm[0] : (ctx.entryTs ? ctx.entryTs.slice(0, 10) : null);
  const amt = findAmount(text);
  if (!date || !amt) return [];
  const time = dm ? findTime(text, dm.index + dm[0].length) : null;
  const fields = splitFields(text);
  const amountField = fields.find((f) => f.includes(text.slice(amt.index, amt.index + 4))) ?? '';
  const vendor = VENDORS.find(([re]) => re.test(text));
  let { counterparty, purpose } = fieldAfterAmount(fields, amountField);
  counterparty = cleanCounterparty(stripParens(counterparty));
  const arrow = /(?:→|->)\s*([^,(.;]+)/.exec(text);
  if (vendor) {
    if (counterparty && !vendor[0].test(counterparty)) purpose = counterparty;
    counterparty = vendor[1];
  } else if (arrow) {
    counterparty = arrow[1].trim();
  }
  const dash = text.split(' — ')[1];
  if (dash && vendor) purpose = splitFields(dash)[0];
  const to = /\bto ([A-Z][\w]+)(?:'s)? coldkey/.exec(text);
  if (to && !vendor && !arrow) counterparty = to[1];
  const pm = /Purpose:\s{0,8}(.+?)(?:\.\s|\.$|$)/i.exec(text);
  if (pm) purpose = pm[1].trim();
  else if (!purpose) {
    const f = fields.find((x) => /\b(top-?up|refill|recharge|rental|training|subscription|payment|pro forma)\b/i.test(x) && x !== amountField);
    purpose = f ?? text.replace(DATE_RE, '').replace(/^[\s,|:~/\d()UTCZ-]+/, '');
  }
  counterparty = cut(counterparty || 'unbekannt', 80);
  purpose = cut(stripParens(purpose) || purpose, 160);
  const times = eachTimes(text, amt);
  const base = {
    date, ...(time ? { time } : {}), amount: round2(amt.amount), currency: amt.currency,
    ...(eurApprox(text, amt.amount, amt.currency) !== undefined ? { eurApprox: eurApprox(text, amt.amount, amt.currency) } : {}),
    counterparty, purpose, ref: findReceipt(text) ?? (ctx.entryId ? `#${THREAD} · Eintrag ${ctx.entryId}` : 'ohne Beleg'),
    kg: detectKg(text), category: categorize(counterparty, purpose),
    ...(ctx.entryId ? { entry: Number(ctx.entryId) } : {}),
  };
  return times ? times.map((t) => ({ ...base, time: t })) : [base];
}

/** Numbered continuation line of a multi-payment TAX post: "1. 2026-10-22 12:14Z: 120.0 α ≈ … ≈ EUR 951.30 → name (uid), …". */
function parseSubLine(line, head, ctx) {
  const body = line.replace(/^\d+\.\s*/, '');
  const dm = DATE_RE.exec(body);
  const amt = findAmount(body);
  if (!dm || !amt) return [];
  const arrow = /(?:→|->)\s*([^,(.;]+)/.exec(body);
  const pm = /Purpose:\s{0,8}(.+?)(?:\.\s|\.$|$)/i.exec(body);
  const counterparty = cut((arrow?.[1] ?? 'unbekannt').trim(), 80);
  const purpose = cut((pm?.[1] ?? body).trim(), 160);
  return [{
    date: dm[0], ...(findTime(body, dm.index + dm[0].length) ? { time: findTime(body, dm.index + dm[0].length) } : {}),
    amount: round2(amt.amount), currency: amt.currency, eurApprox: eurApprox(body, amt.amount, amt.currency),
    counterparty, purpose, ref: findReceipt(body) ?? `#${THREAD} · Eintrag ${ctx.entryId}`, kg: detectKg(head), category: categorize(counterparty, purpose),
    ...(ctx.entryId ? { entry: Number(ctx.entryId) } : {}),
  }];
}

/** All TAX lines of a board thread text. Returns {entries, unparsed:[{line}], maxId}. */
export function parseBoardText(text) {
  const entries = [];
  const unparsed = [];
  const lines = String(text).split('\n');
  const seen = new Set();
  let ctx = {};
  let maxId = 0;
  for (let i = 0; i < lines.length; i++) {
    const hm = /^#(\d+) \[(\d{4}-\d{2}-\d{2}T[\d:]+Z?)\]/.exec(lines[i]);
    if (hm) { ctx = { entryId: hm[1], entryTs: hm[2] }; maxId = Math.max(maxId, Number(hm[1])); continue; }
    const tm = /^[\s>*-]*TAX:(.*)$/.exec(lines[i]); // no \s* before (.*): the two overlapped (critic r7)
    if (!tm) continue;
    const norm = tm[1].replace(/\s+/g, ' ').trim();
    if (seen.has(norm)) continue; // the same line quoted twice
    seen.add(norm);
    // A summary that only points at another TAX entry ("- TAX: xAI USD 20 #25844", no date of its own) is a reference, not a payment.
    if (!DATE_RE.test(norm) && /#\d{4,6}(?![\d-])/.test(norm)) continue;
    const subs = [];
    while (/^\d+\.\s/.test(lines[i + 1] ?? '')) subs.push(lines[++i]);
    const got = subs.length ? subs.flatMap((l) => parseSubLine(l, tm[1], ctx)) : parseTaxText(tm[1], ctx);
    if (got.length) entries.push(...got);
    else unparsed.push({ line: cut(redact(norm), 140) });
  }
  return { entries, unparsed, maxId };
}

// ---------------------------------------------------------------- export file

const HEADER_KEYS = [
  ['date', /^(datum|date)$/i], ['amount', /^(betrag|amount|summe)$/i], ['currency', /^(währung|waehrung|currency|cur)$/i],
  ['counterparty', /^(gegenpartei|empfänger|empfaenger|counterparty|anbieter|vendor)$/i], ['purpose', /^(zweck|purpose|verwendungszweck|beschreibung)$/i],
  ['ref', /^(beleg|ref|referenz|receipt)$/i], ['kg', /^(kg|entity|zuordnung|kg\/privat)$/i],
];

/** Export file: markdown table rows (header names Datum/Betrag/Währung/Gegenpartei/Zweck/Beleg/KG) and/or `TAX:` lines. */
export function parseExport(text) {
  const entries = [];
  const unparsed = [];
  let cols = null;
  for (const line of String(text).split('\n')) {
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      const header = cells.map((c) => HEADER_KEYS.find(([, re]) => re.test(c))?.[0] ?? null);
      if (header.includes('date') && header.includes('amount')) { cols = header; continue; }
      if (!cols) continue;
      const row = Object.fromEntries(cols.map((k, i) => [k, cells[i]]).filter(([k]) => k));
      const dm = DATE_RE.exec(row.date ?? '');
      const amt = findAmount(`${row.currency ?? ''} ${row.amount ?? ''}`) ?? findAmount(`${row.amount ?? ''} ${row.currency ?? ''}`) ?? findAmount(row.amount ?? '');
      let value = amt;
      if (!value && row.amount && /^-?[\d.,]+$/.test(row.amount)) {
        const n = parseNumber(row.amount.replace(/^-/, ''));
        const cur = CURRENCY[(row.currency ?? 'EUR').toUpperCase()] ?? 'EUR';
        if (n !== null) value = { amount: n, currency: cur };
      }
      if (!dm || !value) { unparsed.push({ line: cut(redact(line.trim()), 140) }); continue; }
      const counterparty = cut(row.counterparty || 'unbekannt', 80);
      const purpose = cut(row.purpose ?? '', 160);
      entries.push({
        date: dm[0], amount: round2(value.amount), currency: value.currency,
        ...(eurApprox(`${row.amount} ${row.currency ?? ''}`, value.amount, value.currency) !== undefined ? { eurApprox: eurApprox(`${row.amount} ${row.currency ?? ''}`, value.amount, value.currency) } : {}),
        counterparty, purpose, ref: row.ref || 'Export', kg: detectKg(row.kg ?? ''), category: categorize(counterparty, purpose),
      });
    } else {
      const tm = /^[\s>*-]*TAX:(.*)$/.exec(line);
      if (!tm) continue;
      const tax = tm[1].trimStart();
      const got = parseTaxText(tax, {});
      if (got.length) entries.push(...got); else unparsed.push({ line: cut(redact(tax), 140) });
    }
  }
  return { entries, unparsed };
}

// ---------------------------------------------------------------- aggregation

const keyOf = (e) => [e.date, e.time ?? '', e.amount, e.currency, e.counterparty.toLowerCase(), e.ref].join('|');
const looseKeyOf = (e) => [e.date, e.amount, e.currency, e.counterparty.toLowerCase().slice(0, 6)].join('|');

export function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** Export wins; board entries are added when newer than the export or when the export has no matching booking. */
export function mergeSources(exportEntries, boardEntries) {
  if (!exportEntries.length) return { entries: dedupe(boardEntries), boardAdded: boardEntries.length };
  const lastExport = exportEntries.reduce((m, e) => (e.date > m ? e.date : m), '');
  const loose = new Set(exportEntries.map(looseKeyOf));
  const extra = boardEntries.filter((e) => e.date > lastExport || !loose.has(looseKeyOf(e)));
  return { entries: dedupe([...exportEntries, ...extra]), boardAdded: extra.length };
}

const GROUPS = new Set(['category', 'counterparty', 'month']);

function groupKey(e, groupBy) {
  if (groupBy === 'month') return e.date.slice(0, 7);
  return e[groupBy];
}

export function aggregate(entries, { from, to, groupBy = 'category', kgOnly = false } = {}) {
  if (!GROUPS.has(groupBy)) throw new Error('groupBy must be counterparty, category or month');
  for (const [name, v] of [['from', from], ['to', to]]) {
    if (v !== undefined && v !== null && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error(`${name} must be YYYY-MM-DD`);
  }
  const picked = entries
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to) && (!kgOnly || e.kg === true))
    .sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));
  const sums = new Map();
  const eur = new Map();
  for (const e of picked) {
    const key = groupKey(e, groupBy);
    const k = `${key}\u0000${e.currency}`;
    const t = sums.get(k) ?? { key, currency: e.currency, sum: 0, count: 0 };
    t.sum += e.amount; t.count += 1; sums.set(k, t);
    if (e.eurApprox !== undefined) {
      const x = eur.get(key) ?? { key, sumEur: 0, count: 0 };
      x.sumEur += e.eurApprox; x.count += 1; eur.set(key, x);
    }
  }
  const totals = [...sums.values()].map((t) => ({ ...t, sum: round2(t.sum) })).sort((a, b) => b.sum - a.sum);
  const totalsEurApprox = [...eur.values()].map((t) => ({ ...t, sumEur: round2(t.sumEur) })).sort((a, b) => b.sumEur - a.sumEur);
  return { entries: picked.slice(0, MAX_ENTRIES), truncated: picked.length > MAX_ENTRIES, count: picked.length, groupBy, totals, totalsEurApprox };
}

// ---------------------------------------------------------------- sources + cache

let boardCache = null; // {at, entries, unparsed, maxId}
let exportCache = null; // {at, mtimeMs, entries, unparsed}

export function resetLedgerCache() { boardCache = null; exportCache = null; }

async function loadBoard() {
  if (boardCache && Date.now() - boardCache.at < CACHE_MS) return boardCache;
  let text;
  if (boardCache?.maxId) {
    // Only the entries after the last one we saw; keeps the refresh cheap although the thread has ~38 000 lines.
    try { text = await board.readAll(['read', THREAD, '--since', String(boardCache.maxId)]); } catch { text = null; }
    if (text !== null) {
      const fresh = parseBoardText(text);
      boardCache = {
        at: Date.now(), maxId: Math.max(boardCache.maxId, fresh.maxId),
        entries: dedupe([...boardCache.entries, ...fresh.entries]), unparsed: [...boardCache.unparsed, ...fresh.unparsed],
      };
      return boardCache;
    }
  }
  const parsed = parseBoardText(await board.readAll(['read', THREAD]));
  boardCache = { at: Date.now(), ...parsed, entries: dedupe(parsed.entries) };
  return boardCache;
}

function loadExport() {
  const file = exportPath();
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (exportCache && exportCache.file === file && exportCache.mtimeMs === st.mtimeMs) return exportCache;
  exportCache = { file, mtimeMs: st.mtimeMs, ...parseExport(fs.readFileSync(file, 'utf8')) };
  return exportCache;
}

export async function entries(params = {}) {
  const { from, to, groupBy = 'category', kgOnly = false } = params ?? {};
  const exp = loadExport();
  let brd = null;
  let boardError = null;
  try { brd = await loadBoard(); } catch (err) { boardError = String(err.message).slice(0, 200); }
  if (!exp && !brd) throw new Error(`no ledger source available (${boardError ?? 'export missing'})`);
  const merged = mergeSources(exp?.entries ?? [], brd?.entries ?? []);
  const agg = aggregate(merged.entries, { from, to, groupBy, kgOnly: kgOnly === true || kgOnly === 'true' });
  const asOf = exp ? new Date(exp.mtimeMs).toISOString() : new Date(brd.at).toISOString();
  return {
    ...agg,
    fxNote: FX_NOTE,
    source: exp
      ? { kind: 'export', ref: `${exp.file}${brd ? ' + Board #22 TAX-Zeilen (neuere/fehlende)' : ''}`, asOf, boardAdded: merged.boardAdded }
      : { kind: 'board', ref: `Board #${THREAD} (TAX-Zeilen)`, asOf },
    unparsed: (exp?.unparsed.length ?? 0) + (brd?.unparsed.length ?? 0),
    unparsedSamples: [...(exp?.unparsed ?? []), ...(brd?.unparsed ?? [])].slice(0, 5),
    ...(boardError ? { boardError } : {}),
  };
}
