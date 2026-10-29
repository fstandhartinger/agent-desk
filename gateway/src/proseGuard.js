// Round 10 (critic r9 F2/C3): names and amounts in the text agent's prose must come from what the model was given.
// The model had a correct desk_status result and still wrote "gpt-4o-realtime-preview" and a bridge host "Leontin";
// knowledge answers carried "Name? nein — anderer Name" self-corrections. One sentence-streaming check for every answer:
//  - a specific model name (one with a version digit) that the system prompt, the conversation and the tool results of
//    the turn do not carry is replaced by its close sibling from the allowed list ("deepseek-v4-flash" -> "deepseek-v4.1-flash"),
//    else the sentence / table row is dropped;
//  - a host name in a host position ("Bridge → X", "Bridge (X)", "läuft auf X") that is neither a known host nor in the
//    given text is replaced by the connected bridge host (bridge context) or the sentence is dropped;
//  - a currency amount that occurs in none of that text is dropped with its sentence (rounding to a whole number or a tenth is fine);
//  - "X? — nein, Y" keeps Y; a "Korrektur zum Namen: …" sentence is dropped.
//  - Round 12 (critic r11 defects 3 / 6): a file name, path, CLI flag or domain the given text does not carry drops its
//    sentence ("benchmarkmind.io", "/home/florian/…"), and so does an unknown CamelCase product name once tools ran; the model
//    talking itself in circles ("korrekt:", "— nein …", "ich verheddere mich") and a sentence it already wrote are dropped;
//    LoopDetector stops a stream that repeats the same 6 words three times.
// Pure apart from the callbacks; no I/O.
import { parseNumber } from './canvas.js';
import { codeTokens, createCodeCorpus, createCorpus } from './entityGuard.js';

export const KNOWN_HOSTS = ['Sandy', 'LeChonk', 'sandy-prod'];
const HOST_DISPLAY = Object.fromEntries(KNOWN_HOSTS.map((h) => [h.toLowerCase(), h]));
export const hostDisplay = (host) => HOST_DISPLAY[String(host ?? '').toLowerCase()] ?? String(host ?? '');

/** Model-looking names, lower-cased: families with a version are "specific" (they must be sourced exactly). */
const MODEL_RE = /\b(?:claude[\w.-]*|opus[\w.-]*|sonnet[\w.-]*|haiku[\w.-]*|gpt[\w.-]*|gemini[\w.-]*|grok[\w.-]*|deepseek[\w.-]*|llama[\w.-]*|mistral[\w.-]*|qwen[\w.-]*|kimi[\w.-]*|glm[\w.-]*|whisper[\w.-]*|scribe[\w.-]*|eleven_[\w.-]+|o\d(?:-[\w.-]+)?)/gi;
const trimName = (n) => n.replace(/(?<![.-])[.-]+$/, '');
export function modelTokens(text) {
  return [...new Set([...String(text ?? '').matchAll(MODEL_RE)].map((m) => trimName(m[0].toLowerCase())))];
}
const specific = (name) => /\d/.test(name);
const family = (name) => /^[a-z]+/.exec(name)?.[0] ?? name;

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Is `name` carried by the allowed names (exactly, or as a shortened form "deepseek-v4.1-flash" of "deepseek-v4.1-flash-20261017")? */
export function modelAllowed(name, allowed) {
  if (!specific(name)) return allowed.some((a) => family(a) === family(name)); // "DeepSeek", "Gemini": a family word is fine when that family is sourced at all
  return allowed.some((a) => a === name || a.startsWith(`${name}-`) || a.startsWith(`${name}:`) || name.startsWith(`${a}:`));
}

/** The allowed specific name the model most likely meant (same family, edit distance <= 3), or null. */
export function closestModel(name, allowed) {
  let best = null;
  for (const a of allowed) {
    if (!specific(a) || family(a) !== family(name)) continue;
    const d = distance(name, a);
    if (d <= 3 && (!best || d < best.d)) best = { a, d };
  }
  return best?.a ?? null;
}

const HOST_RE = /\b(?:(?:Bridge|Gateway|Host|Server|Rechner|Maschine)\b\s*(?:\(\s*|→\s*|->\s*|(?:läuft\s+)?auf\s+(?:dem\s+|der\s+)?(?:Host\s+|Server\s+)?)|(?:läuft|laufen|liegt|liegen|steht|stehen)\s+auf\s+(?:dem\s+|der\s+)?(?:Host\s+|Server\s+)?)([A-ZÄÖÜ][\wäöüß-]{2,})/g;
/** Host-looking words in host positions: [{word, bridge, index}]. */
export function hostMentions(text) {
  return [...String(text ?? '').matchAll(HOST_RE)].map((m) => ({ word: m[1].replace(/(?<!-)-+$/, ''), bridge: /bridge/i.test(m[0]), index: m.index + m[0].length - m[1].length }));
}

const AMOUNT_RE = /(?:€|\$|\bUSD|\bEUR)\s*(\d[\d.,]*\d|\d)|(?=\d)(?<!\d)(?<!\d[.,]+)(\d[\d.,]*\d|\d)\s*(?:€|\bEUR\b|\bEuro\b|\bUSD\b|\bDollar\b|\$)/gi;
function numberSet(text) {
  const out = new Set();
  for (const token of String(text ?? '').match(/\d[\d.,]*\d|\d/g) ?? []) {
    for (const n of [parseNumber(token), Number(token.replace(/,/g, ''))]) if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

// P2-3 (critic r4): identifiers a model invents once tools ran: commit SHAs, repo slugs "owner/name", mail uids, ISO dates
const SHA_RE = /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/g;
const SLUG_RE = /(?<![\w./:@~-])[a-z0-9][a-z0-9-]*[a-z0-9]\/[a-z0-9][a-z0-9._-]*[a-z0-9](?![\w/-]|\.\w)/g;
const MAIL_UID_RE = /\b(?:mail|e-mail|uid|nachricht|message)\s*(?:#|nr\.?\s*|uid\s*|id\s*)?(\d{3,})\b/gi;
const ISO_DATE_RE = /(?<![\d-])\d{4}-\d{2}-\d{2}(?![\d-])/g;
// Critic r6 P2-4: mail tools return RFC-2822 dates ("tue, 28 oct 2026 19:04:00"), pages German ones ("28.10.2026",
// "28. Oktober 2026"); a model that writes the ISO form names the same day. Source dates are normalised to ISO first.
const MONTHS = { jan: 1, feb: 2, mar: 3, mär: 3, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12 };
const MONTH = '(jan|feb|mär|mar|apr|ma[iy]|jun|jul|aug|sep|o[ck]t|nov|de[cz])[a-zä]{0,7}\\.?';
const DMY_DOT_RE = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/g;
const DMY_NAME_RE = new RegExp(`(?<![\\d.])(\\d{1,2})\\.?[ \\t-]{1,3}${MONTH}[ \\t,-]{1,3}(\\d{4})(?!\\d)`, 'g');
const MDY_NAME_RE = new RegExp(`(?<![a-zä])${MONTH}[ \\t]{1,3}(\\d{1,2})(?:st|nd|rd|th)?,?[ \\t]{1,3}(\\d{4})(?!\\d)`, 'g');
const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
let datesMemo = { src: null, set: null };
/** ISO forms of the DD.MM.YYYY, DD Mon YYYY (RFC 2822 included) and Mon DD, YYYY dates of a lower-cased source text. */
export function sourceIsoDates(lowerSource) {
  if (datesMemo.src === lowerSource) return datesMemo.set;
  const set = new Set();
  const add = (v) => { if (v) set.add(v); };
  for (const m of lowerSource.matchAll(DMY_DOT_RE)) add(iso(m[3], Number(m[2]), Number(m[1])));
  for (const m of lowerSource.matchAll(DMY_NAME_RE)) add(iso(m[3], MONTHS[m[2].slice(0, 3)], Number(m[1])));
  for (const m of lowerSource.matchAll(MDY_NAME_RE)) add(iso(m[3], MONTHS[m[1].slice(0, 3)], Number(m[2])));
  datesMemo = { src: lowerSource, set };
  return set;
}
/** Identifier-looking strings of one sentence that the given text does not carry (for the final text answer, after tool results). */
export function unknownIdentifiers(text, lowerSource) {
  const src = String(text ?? '');
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const has = (t, tail = '(?![\\w-])') => new RegExp(`(?<![\\w-])${esc(t)}${tail}`).test(lowerSource);
  // r6 P1-2: a short SHA / UUID prefix (>= 7 hex) of a longer token in the source is known; an ISO date also matches in front of "T" / " hh:mm"
  const hasSha = (t) => has(t, '');
  const hasDate = (t) => has(t, '(?![\\d-])') || sourceIsoDates(lowerSource).has(t);
  const out = [];
  for (const m of src.matchAll(SHA_RE)) if (!hasSha(m[0].toLowerCase()) && !isDateLike(m[0])) out.push(m[0]);
  for (const m of src.matchAll(SLUG_RE)) if ((/[-\d]/.test(m[0])) && !modelTokens(m[0]).length && !has(m[0].toLowerCase()) && !/^\d+\/\d+$/.test(m[0])) out.push(m[0]);
  for (const m of src.matchAll(MAIL_UID_RE)) if (!has(m[1])) out.push(m[0].trim());
  for (const m of src.matchAll(ISO_DATE_RE)) if (!hasDate(m[0])) out.push(m[0]);
  return out;
}
const isDateLike = (t) => /^\d{8}$/.test(t);

const CARD_WORD = /\b(?:karte|button|vorschlag|übergabe|übergeben|übernehmen|card)\b/i;
// critic r7: the content excludes its own opening quote, so a run of „ or » is not rescanned 120 chars from every one
const QUOTE_RE = /„([^“”"\n„]{3,120})[“"”]|"([^"\n]{3,120})"|»([^«\n»]{3,120})«|'([^'\n]{3,120})'(?![\p{L}])/gu;
const normTitle = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const SELF_FIX = /\?\s*(?:[—–-]+\s*)?nein\b\s*(?:[,:;]|[—–-]+)?\s*(?:[—–-]+\s*)?/gi;
// "Korrektur zum Namen: …", and the model talking about its own mistakes (r10 live: "Ich habe hier zwei Einträge verwechselt — korrigiert", "Ich habe mich verrannt", "Lass mich nicht raten")
const CORRECTION_SENTENCE = /^\s*(?:[-*•]\s*)?(?:\*\*)?Korrektur\b[^:\n]{0,30}:|\bich habe mich (?:verrannt|geirrt|vertan)\b|\b(?:ich habe|hab) [^.\n]{0,40}\bverwechselt\b|\blass mich nicht raten\b|\bratespielerei\b|\bkorrekt:|\bich verheddere\b|\bverheddert\b|\bich korrigiere\b|\bich beende das\b|[…]\s*genauer\b|\bgenauer:\s*richtig\b|\brichtig ist:\s*$|(?<!\?\s{0,3})[—–…]\s*nein\b|(?<!\?\s{0,3}),\s*nein\s*[,—–…]/i;
// Round 12: "Nein, …" opening a later sentence that does not answer a question of the answer itself is the model correcting itself
const NEIN_START = /^\s*(?:[-*•]\s*)?(?:\*\*)?nein\b\s*[,—–:.…]/i;
// CamelCase product / company names any answer may use without a tool result
const PRODUCTS = new Set('openai openrouter deepseek github gitlab youtube javascript typescript websocket websockets chatgpt elevenlabs telegram whatsapp linkedin paypal iphone ipad macos ios postgresql mongodb mysql sqlite fastapi nodejs nextjs powerpoint playwright devin claude anthropic xai coolify runpod jevbench lechonk'.split(' '));
const CAMEL_RE = /(?<![\w./äöüßÄÖÜ-])[A-Za-zÄÖÜ][a-zäöüß0-9]+(?:[A-ZÄÖÜ][a-zäöüß0-9]+)+(?![\w-])/g;

/** "CTO Max? nein — Erika Muster" -> "Erika Muster": the clause before "? — nein" is dropped, the rest stays. */
export function stripSelfCorrections(unit) {
  let text = String(unit ?? '');
  for (let guard = 0; guard < 5; guard += 1) {
    SELF_FIX.lastIndex = 0;
    const m = SELF_FIX.exec(text);
    if (!m) break;
    const before = text.slice(0, m.index);
    // the clause starts after the last "(", ",", ";", ":", sentence end, line break or "**"
    let start = /^\s*(?:[-*•]\s+|\d+\.\s+|\|\s*)?/.exec(before)[0].length; // a list marker / table cell start stays
    for (const b of before.matchAll(/[(,;:]\s*|[.!?]\s+|\n|\*\*/g)) start = b.index + b[0].length;
    text = text.slice(0, start) + text.slice(m.index + m[0].length);
  }
  return text;
}

/**
 * The check for one answer. `given()` = everything the model was given this turn (system prompt, conversation, tool
 * results; called per sentence, so tool results that arrive later count), `bridgeHosts()` = connected bridge hosts.
 * check(unit) -> {text, notes[]}; `notes` name what was replaced or dropped (for the audit log).
 */
export function createProseGuard({ given = () => '', bridgeHosts = () => [], checkAmounts = () => true, checkNames = checkAmounts, proposalTitles = () => [] } = {}) {
  let cache = { src: null };
  const view = () => {
    const src = String(given() ?? '');
    if (cache.src !== src) {
      const lower = src.toLowerCase();
      cache = { src, lower, models: modelTokens(src), numbers: numberSet(src), code: createCodeCorpus(src), names: null };
    }
    return cache;
  };
  const namesOf = (v) => (v.names ??= createCorpus({ rich: v.src }));
  const said = new Set(); // sentences of this answer so far (normalised): a repeated one is a loop
  let previous = null; // the last sentence that was kept
  const grounded = (v, numbers) => [...numbers].some((n) => n.toFixed(2) === v.toFixed(2) || (Number.isInteger(v) && Math.round(n) === v) || n.toFixed(1) === v.toFixed(1));

  return {
    check(unit) {
      const notes = [];
      const lead = /^\s*/.exec(unit)[0];
      const trail = /(?<!\s)\s*$/.exec(unit)[0]; // r7: starts only at a run start (a 20 kB blank run was quadratic)
      const drop = (why) => { notes.push(why); return { text: `${lead.includes('\n') ? '\n' : ''}${trail.includes('\n') ? '\n' : ''}`, notes, dropped: true }; };
      let text = String(unit ?? '');
      if (!text.trim()) return { text, notes };
      if (CORRECTION_SENTENCE.test(text)) return drop('self-correction sentence');
      if (NEIN_START.test(text) && previous !== null && !/\?\s*$/.test(previous)) return drop('self-correction sentence');
      // r6 P2-5: a sentence about the handoff / Claude card that quotes a title other than the card's own is invented
      const titles = proposalTitles().map(normTitle).filter(Boolean);
      if (titles.length && CARD_WORD.test(text)) {
        for (const q of text.matchAll(QUOTE_RE)) {
          const quoted = normTitle(q[1] ?? q[2] ?? q[3] ?? q[4]);
          if (quoted.length >= 4 && !titles.some((t) => t.includes(quoted) || quoted.includes(t))) return drop(`card title "${quoted.slice(0, 40)}"`);
        }
      }
      const fixed = stripSelfCorrections(text);
      if (fixed !== text) { notes.push('self-correction'); text = fixed; }
      const key = text.toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();
      if (key.length >= 30 && said.has(key)) return drop('repeated sentence');
      const v = view();

      // Round 12: files / paths / flags / domains always, CamelCase product names once the turn fetched data
      const code = codeTokens(text).filter((c) => !v.code.known(c));
      if (code.length) return drop(`unknown ${code.map((c) => c.token).slice(0, 3).join(', ')}`);
      if (checkNames()) {
        for (const m of text.matchAll(CAMEL_RE)) {
          const word = m[0];
          if (PRODUCTS.has(word.toLowerCase()) || modelTokens(word).length || namesOf(v).known(word, true)) continue;
          return drop(`name ${word}`);
        }
      }

      if (checkNames()) {
        const ids = unknownIdentifiers(text, v.lower);
        if (ids.length) {
          // r6 P1-2: only the unknown identifier goes ("Commit …"), the rest of the sentence stays
          for (const id of ids) text = text.split(id).join('…');
          notes.push(`identifier ${ids.slice(0, 3).join(', ')}`);
        }
      }

      for (const name of modelTokens(text)) {
        if (modelAllowed(name, v.models)) continue;
        const near = closestModel(name, v.models);
        if (!near) return drop(`model ${name}`);
        text = text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), near);
        notes.push(`model ${name} -> ${near}`);
      }

      const hosts = (bridgeHosts() ?? []).map(String).filter(Boolean);
      const knownHosts = new Set([...KNOWN_HOSTS, ...hosts].map((h) => h.toLowerCase()));
      for (const h of hostMentions(text).reverse()) {
        const word = h.word.toLowerCase();
        if (knownHosts.has(word) || v.lower.includes(word)) continue;
        if (h.bridge && hosts.length) {
          const host = hostDisplay(hosts[0]);
          text = `${text.slice(0, h.index)}${host}${text.slice(h.index + h.word.length)}`;
          notes.push(`host ${h.word} -> ${host}`);
        } else return drop(`host ${h.word}`);
      }

      if (checkAmounts()) for (const m of text.matchAll(AMOUNT_RE)) {
        const value = parseNumber(m[1] ?? m[2]);
        if (Number.isFinite(value) && value !== 0 && !grounded(value, v.numbers)) return drop(`amount ${m[0].trim()}`);
      }
      if (key.length >= 30) said.add(key);
      if (text.trim()) previous = text.trim();
      return { text, notes };
    },
  };
}

/**
 * End of the first complete sentence / line in `buf` (exclusive), -1 when none is complete yet. A "?" is no end when a
 * "— nein" follows (the self-correction must stay in one piece), and is only decided once 12 more characters are in.
 */
const MONTH_AFTER = /^\s+(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|Jan|Feb|Mär|Apr|Jun|Jul|Aug|Sep|Sept|Okt|Nov|Dez)\b/;
const isOrdinalDot = (buf, i) => /(?<![\d.,])\d{1,2}$/.test(buf.slice(0, i)) && MONTH_AFTER.test(buf.slice(i + 1));
export function cutAt(buf) {
  const re = /[.!?](?=\s)|\n/g;
  for (let m = re.exec(buf); m; m = re.exec(buf)) {
    if (m[0] === '.' && isOrdinalDot(buf, m.index)) continue; // "am 24. Juni": the dot after a day number is no sentence end
    if (m[0] !== '?') return m.index + 1;
    const after = buf.slice(m.index + 1);
    if (after.length < 12 && !after.includes('\n')) return -1;
    if (!/^\s*(?:[—–-]+\s*)?nein\b/i.test(after)) return m.index + 1;
  }
  return -1;
}

/** Streaming wrapper (same sentence cut as TaxClaimFilter): push(text) returns the checked sentences so far, flush() the rest. */
export class ProseGuardFilter {
  constructor(guard, onNote = () => {}) { this.guard = guard; this.onNote = onNote; this.buf = ''; }
  run(unit) {
    const r = this.guard.check(unit);
    if (r.notes.length) this.onNote(r.notes);
    return r.text;
  }
  push(text) {
    this.buf += text;
    let out = '';
    for (;;) {
      const end = cutAt(this.buf);
      if (end < 0) break;
      out += this.run(this.buf.slice(0, end));
      this.buf = this.buf.slice(end);
    }
    return out;
  }
  flush() {
    const rest = this.buf;
    this.buf = '';
    return rest ? this.run(rest) : '';
  }
}

/**
 * Round 12 (critic r11 defect 3): a stream that says the same 6 words for the third time is looping ("Quelle ist … — nein …
 * Quelle ist …"). push(text) -> true once that happened; numbers and words count, punctuation and Markdown do not.
 * A 6-gram of fewer than 3 different words ("ja ja ja …", table filler) does not count.
 * Critic round 7, P2-2: a legitimate list repeats words too ("3. … address not allowed (private, loopback, link-local or
 * reserved)"). So (a) 6-grams that occur in this turn's tool results never count (allow(text)), and (b) the 6-grams of a
 * list item only stay counted when the whole item repeats an earlier one: a new item gives its counts back at its line end.
 */
const LIST_ITEM = /^[ \t>]*(?:\*\*)?(?:\d{1,3}[.)]|[-*•+])[ \t]/;
const COUNTER_ITEMS = 8;
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
export class LoopDetector {
  constructor({ n = 6, times = 3, allowed = new Set() } = {}) {
    this.n = n; this.times = times; this.words = []; this.counts = new Map(); this.tail = ''; this.looping = false;
    this.allowed = allowed; this.line = ''; this.lineGrams = []; this.lines = new Map(); this.shapes = new Map();
  }
  /** Text the model may quote (this turn's tool results): its 6-grams never count as a loop. */
  allow(text) {
    const words = String(text ?? '').toLowerCase().split(WORD_SPLIT).filter(Boolean);
    for (let i = this.n; i <= words.length && this.allowed.size < 200_000; i++) this.allowed.add(words.slice(i - this.n, i).join(' '));
  }
  #word(w) {
    this.words.push(w.toLowerCase());
    if (this.words.length > 4 * this.n) this.words.splice(0, this.words.length - this.n);
    if (this.words.length < this.n) return false;
    const gram = this.words.slice(-this.n);
    if (new Set(gram).size < 3) return false;
    const k = gram.join(' ');
    if (this.allowed.has(k)) return false;
    const c = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, c);
    if (LIST_ITEM.test(this.line)) this.lineGrams.push(k);
    if (c >= this.times) { this.looping = true; return true; }
    return false;
  }
  #endLine() {
    if (LIST_ITEM.test(this.line)) {
      const key = this.line.replace(LIST_ITEM, '').toLowerCase().split(WORD_SPLIT).filter(Boolean).join(' ');
      const seen = this.lines.get(key);
      // items that differ only by a counter ("Ziel 3 …", "Versuch 4 …") are a template for a while, a loop after
      // COUNTER_ITEMS of them (critic-8 P2-1: 30 "N. Versuch N: ich schaue noch einmal …" lines were never cut)
      const shape = key.replace(/\d+/g, '#');
      const shapeN = (this.shapes.get(shape) ?? 0) + (seen ? 0 : 1);
      this.shapes.set(shape, shapeN);
      if (!seen && shape !== key && shapeN > COUNTER_ITEMS) this.looping = true;
      if (!seen) { // a new item: its words repeat a template, not a loop; kept aside in case the item comes again
        this.lines.set(key, { n: 1, grams: this.lineGrams });
        for (const k of this.lineGrams) this.counts.set(k, this.counts.get(k) - 1);
      } else {
        if (seen.n === 1) for (const k of seen.grams) this.counts.set(k, (this.counts.get(k) ?? 0) + 1); // the same item twice: both count
        seen.n += 1;
        if (this.lineGrams.some((k) => this.counts.get(k) >= this.times)) this.looping = true;
      }
    }
    this.line = '';
    this.lineGrams = [];
  }
  push(text) {
    if (this.looping) return true;
    const segs = (this.tail + String(text ?? '')).split('\n');
    this.tail = '';
    for (let i = 0; i < segs.length; i++) {
      let seg = segs[i];
      if (i === segs.length - 1) { // the last word may still grow
        const m = /(?<![\p{L}\p{N}])[\p{L}\p{N}]+$/u.exec(seg);
        if (m) { this.tail = m[0]; seg = seg.slice(0, m.index); }
      }
      this.line = (this.line + seg).slice(0, 4000);
      for (const w of seg.split(WORD_SPLIT)) if (w && this.#word(w)) return true;
      if (i < segs.length - 1) { this.#endLine(); if (this.looping) return true; }
    }
    return false;
  }
}

/**
 * Critic round 7, P2-2: the closing summary after a loop said "Für den Rest deiner Liste habe ich keine Ergebnisse vorliegen"
 * while all tool results were there. When this turn has tool results, such sentences are dropped (sentence by sentence).
 */
const NO_RESULTS_CLAIM = /\b(?:keine|kein)\s+(?:weiteren\s+)?(?:Ergebnisse?|Resultate?|Werkzeugergebnisse?|Daten|Rückmeldung(?:en)?)\b[^.!?\n]{0,60}\b(?:vor(?:liegen)?|erhalten|bekommen|geliefert|da)\b|\b(?:Ergebnisse?|Resultate?)\b[^.!?\n]{0,40}\b(?:fehlen|liegen\s+(?:mir\s+)?nicht\s+vor|stehen\s+noch\s+aus)\b/i;
export class NoResultsClaimFilter {
  constructor(active = () => true) { this.active = active; this.buf = ''; }
  #release(text) {
    if (!this.active() || !NO_RESULTS_CLAIM.test(text)) return text;
    return text.split(/(?<=[.!?\n])(?=\s)/).filter((sentence) => !NO_RESULTS_CLAIM.test(sentence)).join('');
  }
  push(piece) {
    this.buf += piece ?? '';
    const end = Math.max(this.buf.lastIndexOf('. '), this.buf.lastIndexOf('! '), this.buf.lastIndexOf('? '), this.buf.lastIndexOf('\n'));
    if (end < 0) return '';
    const out = this.buf.slice(0, end + 1);
    this.buf = this.buf.slice(end + 1);
    return this.#release(out);
  }
  flush() {
    const rest = this.buf;
    this.buf = '';
    return rest ? this.#release(rest) : '';
  }
}
