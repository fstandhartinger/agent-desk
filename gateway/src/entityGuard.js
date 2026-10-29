// Round 11 (critic r10 defect 2): proper nouns and ID-like tokens on a drawn canvas must come from what the drawing was
// based on. The illustrator drew an invented company suffix, a misspelt wallet name and made-up abbreviations / chain IDs
// while the knowledge said otherwise; the prose guards (models, hosts, amounts) never looked at drawn names.
//
// Candidates (in titles, captions, node labels / details, group / edge labels, items, table cells, events, actors, messages):
//  - strong: tokens mixing letters and digits (QX3, T15; units like 10k / 24h / 2x are fine), ALL-CAPS words (ZQX, SE;
//    common acronyms like API / EUR / GPU are fine) and CamelCase (BlauWerk, canvasBus);
//  - weak: a capitalised or quoted word that is a near miss (not an inflection) of a name the sources carry ("Kapa" for
//    "kappa", "Blauwerg" for "BlauWerk").
//    German capitalises every noun, so plain capitalised words are only checked as near misses (no false alarms on "Prüfung").
// A candidate is known when the rich corpus (tool results of the turn, knowledge read, page context, conversation, previous
// version) carries it - case-insensitive, as a whole word, or for words of 5+ letters also inflected / inside a compound -
// or when the strict corpus (knowledge index, desk facts, system prompt) carries it as a whole word. Pure, no I/O.

const LETTER = 'A-Za-zÄÖÜäöüß';
const TOKEN_RE = new RegExp(`[${LETTER}0-9][${LETTER}0-9_.]*[${LETTER}0-9]|[${LETTER}0-9]`, 'g');
const QUOTED_RE = /[„"“'‚‘»«]([^„"“”'‚‘’»«\n]{3,40})[“”"'’‘«»]/g;
const UNIT_RE = /^\d+(?:[.,]\d+)?(?:k|m|mio|mrd|h|s|ms|min|x|gb|gib|mb|mib|kb|tb|px|pt|kw|mw|w|v|hz|khz|mhz|ghz|tage?|std|wo|kg|g|cm|mm|km|l|st|stk|uhr|z|utc|d|y|j|er|te[nrs]?|ste[nrs]?|fach)$/i;
const ORDINAL_RE = /^(?:\d+(?:st|nd|rd|th))$/i;
// Acronyms and words a diagram may use without a source (never a name that could be invented for Florian's world).
const COMMON = new Set(`
api apis http https sse ws wss json yaml csv ui ux url urls uri id ids ok ja nein eur usd chf gbp tao alpha kg gmbh llm llms ai ki pdf png svg jpg
cpu gpu gpus ram ssd hdd nvme db sql dns ip ipv4 ipv6 vpn ssh tls ssl csp cors cli sdk mcp pr prs ci cd utc mez cet cest mesz faq ceo cto cfo eu us de uk fr
eta todo html css js ts jsx tsx node npm git github pcm tts stt asr vad rms webrtc websocket rest grpc smtp imap oauth jwt hmac sha md5 aes rsa otp totp 2fa
mo di mi do fr sa so mon tue wed thu fri sat sun jan feb mär mar apr mai may jun jul aug sep sept okt oct nov dez dec q1 q2 q3 q4 kw
januar februar märz april juni juli august september oktober november dezember montag dienstag mittwoch donnerstag freitag samstag sonntag
florian agent agenten browser gateway bridge server client nutzer user start ende end ja nein fehler error erfolg ok tax steuer
not sent fail failed pass done hold live go no yes new old warn info debug stop run ready pending draft beta alpha ga
nur nie kein keine nicht immer alle neu alt low med medium high xhigh max min
websocket websockets webhook webhooks kb mb gb tb kib mib gib rpc tcp udp vm vms os io qa e2e mvp kpi roi sla slo cdn waf iam acl rbac crud orm ssr spa pwa ws2 cron sse2 utf ascii
good bad warn warning skip skipped true false null none note tip test prod dev hot cold off on open closed blocked allowed denied
ohne oder aber eine einer einen einem eines nach wenn dann denn also auch noch schon sonst bis seit beim vom zum zur über unter durch gegen
mit von für aus bei wie was wer wo wird werden wurde ist sind war hat haben kann muss soll darf erst jetzt heute morgen gestern hier dort
`.split(/\s+/).filter(Boolean));

const lower = (s) => String(s ?? '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasLetter = (t) => new RegExp(`[${LETTER}]`).test(t);
const hasDigit = (t) => /\d/.test(t);
const isCaps = (t) => /^[A-ZÄÖÜ][A-ZÄÖÜ0-9]+$/.test(t);
const isCamel = (t) => /[a-zäöüß][A-ZÄÖÜ]/.test(t) || /^[A-ZÄÖÜ]{2,}[a-zäöüß]{2,}/.test(t);
const isTitle = (t) => /^[A-ZÄÖÜ][a-zäöüß]{2,}$/.test(t);

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const nearLimit = (n) => (n <= 5 ? 1 : 2);
/** German and English spellings of one word count as the same ("Transkript" / "transcript", "Kode" / "code"). */
const spelling = (w) => w.replace(/ph/g, 'f').replace(/c(?=[aou]|k|$)/g, 'k').replace(/c/g, 'z').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

/** The words (tokens, and the parts of "a-b" / "a/b" compounds) of one text, in order. */
function wordsOf(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(TOKEN_RE)) {
    const t = m[0].replace(/(?<!\.)\.+$/, '');
    if (!t) continue;
    out.push(t);
  }
  return out;
}

// Round 12 (critic r11 defect 1): lower-case code tokens passed the name check - a Grok architecture drew six invented files
// (voice-relay.js, keys.js, ...) and a flow the invented flag "notify --send". File names, paths, CLI flags and domains are
// checked against the corpus as whole tokens: a file / flag / domain is known when the corpus carries it, a path when the
// corpus carries it (also as the tail of a longer path) or its directory is known and its file name is.
const FILE_EXT = 'js|mjs|cjs|ts|tsx|jsx|py|sh|md|json|jsonl|ya?ml|toml|txt|html?|css|svg|sql|env|log|csv|pcm|png';
const FILE_RE = new RegExp(`(?<![\\w./~-])(?:~?/|\\.{1,2}/)?(?:[\\w.@-]{1,255}/)*[\\w-]+(?:\\.[\\w-]+)*\\.(?:${FILE_EXT})(?![\\w/-])`, 'gi');
// a path segment starts with a letter / digit / "." / "_" ("/p/-Link" is the "/p/" link in a German compound, no path)
const PATH_RE = /(?<![\w./~:-])(?:~\/|\.{1,2}\/|\/)[\w.@][\w.@-]*(?:\/[\w.@][\w.@-]*)*\/?|(?<![\w./~:-])(?:gateway|bridge|web|src|bin|lib|test|tests|docs|scripts|jobs|work|voice|viz|topics)\/[\w.@][\w.@-]*(?:\/[\w.@][\w.@-]*)*\/?/g;
const FLAG_RE = /(?<![\w-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\w-])/gi;
const DOMAIN_RE = /(?<![\w.@/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|io|de|ai|app|net|org|dev|co|xyz|me|so|cloud|tech|eu|info|gg|tv)(?![\w-])/gi;
// framework / runtime names that look like files ("Node.js")
const PRODUCT_FILES = new Set(['node.js', 'next.js', 'nuxt.js', 'vue.js', 'three.js', 'd3.js', 'express.js', 'react.js', 'chart.js', 'deno.js', 'bun.js']);
const WRONG_PATHS = /\/home\/florian\b|(?<![\w/])\/app\b/gi; // the prompts' "never /home/florian, never /app" rules name what is wrong
const trimTok = (t) => t.replace(/(?<![.,;:)!?'"`])[.,;:)!?'"`]+$/, '');

/** The code-like tokens of one text: [{token, type: 'file'|'path'|'flag'|'domain'}], in order, unique. */
export function codeTokens(text) {
  const src = String(text ?? '');
  const out = [];
  const seen = new Set();
  const push = (token, type) => { const t = trimTok(token); if (t && !seen.has(`${type}|${t}`)) { seen.add(`${type}|${t}`); out.push({ token: t, type }); } };
  const urls = [];
  for (const m of src.matchAll(/https?:\/\/([^\s/)"'`<>]+)[^\s)"'`<>]*/gi)) { urls.push([m.index, m.index + m[0].length]); push(m[1].toLowerCase(), 'domain'); }
  const inUrl = (i) => urls.some(([a, b]) => i >= a && i < b);
  const paths = [];
  for (const m of src.matchAll(PATH_RE)) {
    if (inUrl(m.index)) continue;
    const t = trimTok(m[0]).replace(/\/$/, '');
    if (t.split('/').filter(Boolean).length < 2 && !/\.\w+$/.test(t)) continue; // "/p", "/" or a bare word is no path
    if (/^\/[\w.-]+\/\?/.test(m[0])) continue;
    paths.push([m.index, m.index + m[0].length]);
    push(t, 'path');
  }
  const inPath = (i) => paths.some(([a, b]) => i >= a && i < b);
  for (const m of src.matchAll(FILE_RE)) {
    if (inUrl(m.index) || inPath(m.index) || PRODUCT_FILES.has(m[0].toLowerCase())) continue;
    push(m[0], m[0].includes('/') ? 'path' : 'file');
  }
  for (const m of src.matchAll(FLAG_RE)) push(m[0], 'flag');
  for (const m of src.matchAll(DOMAIN_RE)) {
    if (inUrl(m.index) || inPath(m.index)) continue;
    const before = src.slice(Math.max(0, m.index - 1), m.index);
    if (before === '/') continue;
    const d = m[0].toLowerCase();
    if (new RegExp(`\\.(?:${FILE_EXT})$`, 'i').test(d)) continue;
    push(d, 'domain');
  }
  return out;
}

/** A checker for code tokens against `corpus` text (the same text the names come from). */
export function createCodeCorpus(text) {
  const lowerText = String(text ?? '').toLowerCase().replace(WRONG_PATHS, ' ').replace(/~\//g, '/home/flori/');
  const has = (t) => new RegExp(`(?<![\\w-])${esc(t)}(?![\\w-])`).test(lowerText);
  const fileKnown = (name) => PRODUCT_FILES.has(name) || has(name);
  const pathKnown = (raw) => {
    let p = raw.toLowerCase().replace(/^~\//, '/home/flori/').replace(/^\.\//, '').replace(/(?<!\/)\/+$/, '');
    if (!p) return true;
    if (new RegExp(`(?<![\\w.-])${esc(p)}(?![\\w-])`).test(lowerText) || (!p.startsWith('/') && lowerText.includes(`/${p}`))) return true;
    const cut = p.lastIndexOf('/');
    if (cut <= 0) return p.replace(/^\//, '') ? has(p.replace(/^\//, '')) : true;
    const dir = p.slice(0, cut);
    const name = p.slice(cut + 1);
    return Boolean(name) && has(name) && pathKnown(dir);
  };
  return {
    known({ token, type }) {
      const t = token.toLowerCase();
      if (type === 'flag') return has(t);
      if (type === 'domain') { const parts = t.split('.'); return has(t) || (parts.length > 2 && has(parts.slice(-2).join('.'))) || has(`www.${t}`); }
      if (type === 'file') return fileKnown(t);
      return pathKnown(t);
    },
  };
}

/** The code tokens of `text` the corpus does not carry (strings, in order). */
export function unknownCodeTokens(text, codeCorpus) {
  return codeTokens(text).filter((c) => !codeCorpus.known(c)).map((c) => c.token);
}

/** The visible strings of a spec, each with the place it sits in (for dropping). */
export function specStrings(spec) {
  const out = [];
  const add = (text, where) => { if (typeof text === 'string' && text.trim()) out.push({ text, where }); };
  add(spec?.title, 'title');
  add(spec?.caption, 'caption');
  for (const g of spec?.groups ?? []) add(g?.label, 'group');
  for (const n of spec?.nodes ?? []) { add(n?.label, 'node'); add(n?.detail, 'detail'); }
  for (const e of spec?.edges ?? []) add(e?.label, 'edge');
  for (const i of spec?.items ?? []) { add(i?.label, 'item'); add(i?.detail, 'detail'); }
  for (const c of spec?.columns ?? []) add(c, 'column');
  for (const r of spec?.rows ?? []) for (const c of Array.isArray(r) ? r : []) add(typeof c === 'number' ? String(c) : c, 'row');
  for (const e of spec?.events ?? []) { add(e?.label, 'event'); add(e?.detail, 'detail'); }
  for (const a of spec?.actors ?? []) add(a?.label, 'actor');
  for (const m of spec?.messages ?? []) { add(m?.label, 'message'); add(m?.note, 'detail'); }
  for (const s of spec?.series ?? []) add(s?.name, 'series');
  if (spec?.detail && typeof spec.detail === 'object') out.push(...specStrings({ ...spec.detail, detail: undefined })); // the detailed version is shown too
  return out;
}

/**
 * The corpus check. `rich` = what the drawing may draw from (inflections / compounds count), `strict` = background text
 * (whole words only). Returns {known(token), entities} where `entities` are the name-like tokens of both (for near misses).
 */
export function createCorpus({ rich = '', strict = '', plain = '' } = {}) {
  const richLower = lower(rich);
  const words = new Set();
  const strictWords = new Set();
  const entities = new Set();
  const noteEntities = (text) => {
    for (const t of wordsOf(text)) if (t.length >= 3 && (isCaps(t) || isCamel(t) || (hasDigit(t) && hasLetter(t)))) entities.add(lower(t));
    // quoted names: typographic quotes, capitalised words, or a lowercase word in ASCII quotes right after a word (Coldkey "kappa");
    // code and JSON ("state": …, type: 'transcript', x = "host") name nothing
    const src = String(text);
    for (const m of src.matchAll(QUOTED_RE)) {
      const ws = wordsOf(m[1]);
      if (ws.length > 2) continue;
      const typo = m[0][0] !== '"' && m[0][0] !== "'";
      const prose = /[A-Za-zÄÖÜäöüß]\s$/.test(src.slice(Math.max(0, m.index - 2), m.index)) && !/^\s*[:=(]/.test(src.slice(m.index + m[0].length, m.index + m[0].length + 3));
      for (const t of ws) if (t.length >= 3 && (typo || prose || /^[A-ZÄÖÜ]/.test(t))) entities.add(lower(t));
    }
  };
  for (const t of wordsOf(rich)) for (const p of [t, ...t.split(/[._]/)]) if (p) words.add(lower(p));
  for (const t of wordsOf(`${strict}\n${plain}`)) for (const p of [t, ...t.split(/[._]/)]) if (p) strictWords.add(lower(p));
  noteEntities(rich);
  noteEntities(strict); // `plain` (the prompt's own words, "ONE", "ONLY") only counts as known words, it names nothing
  const known = (token, strong = false) => {
    const t = lower(token);
    if (!t || COMMON.has(t) || words.has(t) || strictWords.has(t)) return true;
    if (hasDigit(t) && hasLetter(t)) {
      // "QX7" next to "QX 7" / "QX-7": letters and digits separated in the source
      const m = /^([a-zäöüß]+)[-\s]?(\d+)$/.exec(t);
      if (m && new RegExp(`(?<![a-z0-9äöüß])${esc(m[1])}[\\s-]${m[2]}(?!\\d)`).test(richLower)) return true;
      return richLower.includes(t) && new RegExp(`(?<![a-z0-9äöüß])${esc(t)}`).test(richLower);
    }
    // a name-like token keeps its spelling: only a plural ending is tolerated ("WebSockets"), never a stem ("BlauWerg" is not "BlauWerk")
    if (strong) {
      const base = t.replace(/(?:es|s|en|n)$/, '');
      if (base.length >= 3 && base !== t && (words.has(base) || strictWords.has(base))) return true;
      // a CamelCase part of a sourced identifier ("CanvasSession" in createCanvasSession) is that identifier's name
      return isCamel(token) && t.length >= 6 && new RegExp(`[a-z0-9]${esc(t)}|${esc(t)}[a-z0-9]`).test(richLower);
    }
    if (t.length < 5) return false;
    if (richLower.includes(t)) return true; // inside a compound or with an ending ("Rücklage" in "Steuerrücklage")
    const stem = t.slice(0, Math.max(5, t.length - 3));
    return new RegExp(`(?<![a-z0-9äöüß])${esc(stem)}`).test(richLower); // "Auszahlung" -> "Auszahlungen", "prüfung" no, "prüfen" -> stem 5
  };
  return { known, entities: [...entities], code: createCodeCorpus(`${rich}\n${strict}`) };
}

/** Candidate name tokens of one string: [{token, strong}]; quoted names come as their words. */
function candidatesOf(text) {
  const out = [];
  const seen = new Set();
  const push = (token, strong) => { const k = `${token}|${strong}`; if (!seen.has(k)) { seen.add(k); out.push({ token, strong }); } };
  // a quoted word („Kapa“, `--flag "Grund"`) is checked like a capitalised word: only a near miss of a sourced name counts
  for (const raw of wordsOf(text)) {
    for (const t of new Set([raw, ...raw.split(/[._]/).filter(Boolean)])) {
      if (UNIT_RE.test(t) || ORDINAL_RE.test(t) || (/^\d/.test(t) && !/[a-zäöüß]{2}/i.test(t.replace(/^\d+/, '')))) continue;
      if (/^[A-Za-z]\d{1,2}(?:\.\d+)*$/.test(t)) continue; // R7, T6, Q3, v2, v3.4: round / tranche / version labels, too short to guard
      if (hasDigit(t) && hasLetter(t)) push(t, true);
      else if (isCaps(t)) push(t, !(t.length >= 6 && /^[A-ZÄÖÜ]+$/.test(t))); // round 12: "GESENDET" is an emphasised word, not a name: checked like one
      else if (isCamel(t)) push(t, true);
      else if (isTitle(t)) push(t, false);
    }
  }
  return out;
}

/**
 * The tokens of `spec` that name something the corpus does not carry, in order of appearance (unique). Strong candidates
 * count when unknown; weak ones (capitalised words) only when they are a near miss of a name in the corpus.
 */
export function unknownEntities(spec, corpus) {
  const c = corpus?.known ? corpus : createCorpus(corpus);
  const out = [];
  for (const { text } of specStrings(spec)) {
    for (const token of unknownCodeTokens(text, c.code)) if (!out.includes(token)) out.push(token);
    for (const { token, strong } of candidatesOf(text)) {
      if (out.includes(token) || c.known(token, strong)) continue;
      if (strong) { out.push(token); continue; }
      const t = lower(token);
      // a near miss, not an inflection ("Texte" next to "TEXT" is German, "Kapa" next to "kappa" is a misspelt name)
      const near = (e) => e !== t && !e.startsWith(t) && !t.startsWith(e) && e[0] === t[0] && Math.abs(e.length - t.length) <= 2 && spelling(e) !== spelling(t) && distance(t, e) <= nearLimit(Math.min(t.length, e.length));
      if (t.length >= 3 && c.entities.some(near)) out.push(token);
    }
  }
  return out;
}

/**
 * The spec without the unknown entities: nodes / items / rows / events / actors / messages whose label names one are dropped
 * (with their edges / links / messages), details / notes / edge labels that name one are removed, titles / captions /
 * group labels / columns / series names lose the word. Never invents a replacement.
 */
export function dropEntities(spec, tokens) {
  if (!tokens?.length) return spec;
  const res = tokens.map((t) => new RegExp(`(?<![${LETTER}0-9])${esc(t)}(?![${LETTER}0-9])`, 'i'));
  const names = (s) => typeof s === 'string' && res.some((re) => re.test(s));
  const scrub = (s) => {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const t of tokens) out = out.replace(new RegExp(`[„"“'‚‘»«]?(?<![${LETTER}0-9])${esc(t)}(?![${LETTER}0-9])[“”"'’‘«»]?`, 'gi'), '');
    // r7 (critic r6 P1-1): blank runs are collapsed first, so a blank run is at most 1 char below and `\s?` is exact (`\s*` rescanned long runs: quadratic)
    return out.replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s{2,}/g, ' ').replace(/\s?[-/]\s?(?=[\s,.;:)]|$)/g, '').replace(/(^|\s)[-/:,]\s*/g, '$1').replace(/\s{2,}/g, ' ').replace(/(?<!\s)\s+([,.;:)])/g, '$1').trim();
  };
  const out = { ...spec };
  for (const key of ['title', 'caption']) if (names(out[key])) out[key] = scrub(out[key]);
  if (out.groups) out.groups = out.groups.map((g) => (names(g.label) ? { ...g, label: scrub(g.label) || g.id } : g));
  if (out.nodes) {
    const gone = new Set(out.nodes.filter((n) => names(n.label)).map((n) => n.id));
    out.nodes = out.nodes.filter((n) => !gone.has(n.id)).map((n) => (names(n.detail) ? (({ detail, ...rest }) => rest)(n) : n));
    if (out.edges) out.edges = out.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)).map((e) => (names(e.label) ? (({ label, ...rest }) => rest)(e) : e));
    if (out.links) out.links = out.links.filter((l) => !gone.has(l.from) && !gone.has(l.to));
    if (out.highlight && gone.has(out.highlight)) delete out.highlight;
  }
  if (out.items) out.items = out.items.filter((i) => !names(i.label)).map((i) => (names(i.detail) ? (({ detail, ...rest }) => rest)(i) : i));
  if (out.columns) out.columns = out.columns.map((c) => (names(c) ? scrub(c) : c));
  if (out.rows) out.rows = out.rows.filter((r) => !(Array.isArray(r) && r.some((c) => names(c))));
  if (out.events) out.events = out.events.filter((e) => !names(e.label)).map((e) => (names(e.detail) ? (({ detail, ...rest }) => rest)(e) : e));
  if (out.actors) {
    const gone = new Set(out.actors.filter((a) => names(a.label)).map((a) => a.id));
    out.actors = out.actors.filter((a) => !gone.has(a.id));
    if (out.messages) out.messages = out.messages.filter((m) => !gone.has(m.from) && !gone.has(m.to) && !names(m.label)).map((m) => (names(m.note) ? (({ note, ...rest }) => rest)(m) : m));
  } else if (out.messages) out.messages = out.messages.filter((m) => !names(m.label)).map((m) => (names(m.note) ? (({ note, ...rest }) => rest)(m) : m));
  if (out.series) out.series = out.series.map((s) => (names(s.name) ? { ...s, name: scrub(s.name) || 'Reihe' } : s));
  if (names(out.highlight)) delete out.highlight;
  if (out.detail && typeof out.detail === 'object') out.detail = dropEntities(out.detail, tokens);
  return out;
}

/** The rejection text for a repair round. */
export const entityError = (tokens) => `the drawing names ${tokens.length === 1 ? 'an entity' : 'entities'} that no tool result, knowledge read, page or conversation carries: ${tokens.slice(0, 12).map((t) => `"${t}"`).join(', ')}. Use only names spelled exactly as in the facts, or leave those parts out (never guess a name, ID or abbreviation)`;
