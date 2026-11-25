// Source registry ("Wissenslandkarte") and the public REAX docs for the desk (job agent-desk-research-upgrade-20261125).
// a#474b71 (25 Nov): the research agent answered "keine belastbare Quelle" to a rules question whose answer was one MCP call
// away. Two tools fix the path:
//  - reax_docs: the PUBLIC REAX MCP (mcp.reax.co) with a fixed host and a fixed list of read-only methods; clause search on
//    the gateway side. No free URL, so it is no web tool (no taint): our own published rules, not outsider text.
//  - source_map: ~/desk-knowledge/sources/registry.json (built every 30 min by ~/bin/desk-source-registry on Sandy, mirrored
//    to LeChonk): topic -> authoritative sources with paths and how to use them. Matched topics also go into the research
//    agent's first prompt, and a "not found" answer is refused once while the matched sources are unread (agent.js).
import { short } from '../redact.js';

export const MCP_URL = 'https://mcp.reax.co/mcp';
export const REGISTRY_PATH = '/home/flori/desk-knowledge/sources/registry.json';
/** Read-only public methods. Everything with a hotkey signature, a write or "my_" data is left out. */
export const REAX_METHODS = Object.freeze({
  training_get_rules: 'Regeln des Trainings-Wettbewerbs (Generalist), jede Klausel mit Nummer; mit query nur die passenden Klauseln',
  training_get_rules_changes: 'Was sich zwischen zwei Regel-Versionen geändert hat (args: from, to)',
  training_list_rule_versions: 'Alle Regel-Versionen mit Datum',
  training_get_status: 'Status der Runde: Champion, Warteschlange, Termine',
  training_get_schedule: 'Termine (Fenster, Fristen, Veröffentlichungen) in UTC',
  training_get_leaderboard: 'Veröffentlichte Rangliste',
  training_get_results: 'Veröffentlichte Ergebnisse einer uid (args: uid) oder eines hotkey',
  inference_get_rules: 'Regeln Inference Mining; mit query nur passende Abschnitte',
  inference_get_portfolio: 'Inference-Portfolio (Modelle, Töpfe)',
  inference_list_portfolio_changes: 'Änderungen am Inference-Portfolio',
  reax_get_faq: 'Miner-FAQ (LIVE verbindlich, PENDING nicht); mit query nur passende Einträge',
  reax_search_docs: 'Stichwortsuche (BM25) über Regeln, FAQ und Anleitung (args: query)',
  get_overview: 'Überblick über alle Mining-Arten',
});
const PASS_ARGS = { training_get_rules_changes: ['from', 'to'], training_get_results: ['uid', 'hotkey'], reax_search_docs: ['query'], training_get_rules: ['version'], training_get_leaderboard: ['track'] };
const CACHE_MS = 10 * 60_000;
const cache = new Map(); // key -> {at, value}

async function mcpCall(name, args, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const key = `${name} ${JSON.stringify(args)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const res = await fetchImpl(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'agent-desk/1 (read-only)' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`REAX MCP antwortet nicht (HTTP ${res.status})`);
  const raw = await res.text();
  const lines = raw.split('\n').map((l) => (l.startsWith('data:') ? l.slice(5) : l).trim()).filter((l) => l.startsWith('{'));
  if (!lines.length) throw new Error('REAX MCP: keine Antwort');
  const msg = JSON.parse(lines.at(-1));
  if (msg.error) throw new Error(`REAX MCP: ${short(msg.error.message ?? 'Fehler', 120)}`);
  const r = msg.result ?? {};
  if (r.isError) throw new Error(`REAX MCP: ${short(r.content?.[0]?.text ?? 'Fehler', 160)}`);
  const value = r.structuredContent ?? r;
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return value;
}

const norm = (t) => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
// German question words -> the English rule wording (the rules and FAQ are English)
const SYNONYMS = [
  [/entwickler|halter|besitzer|inhaber|gleiche[nr]? (?:person|miner)/, ['holder']],
  [/podium|platz|plaetze|platze|rang/, ['podium', 'place']],
  [/champion|krone|sieger|gewinner/, ['champion', 'crown']],
  [/auszahl|belohn|anteil|emission|bezahl/, ['share', 'paid', 'reward', 'payout']],
  [/kopie|kopier/, ['copy']],
  [/eltern|vorgaenger|basis/, ['parent', 'lineage']],
  [/frist|termin|wann/, ['deadline', 'window', 'utc']],
  [/marge|schwelle|abstand/, ['margin', 'bar', 'se']],
  [/verbrannt|burn/, ['burn', 'unfilled']],
  [/streit|einspruch/, ['dispute', 'objection']],
];
const STOP = new Set('the and for with that this from what when does into der die das und ist ein eine wenn dann auch noch nur alle oder wie was sind wird hat haben kann soll'.split(' '));

export function terms(query) {
  const q = norm(query);
  const out = new Set(q.split(/[^a-z0-9.]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
  for (const [re, add] of SYNONYMS) if (re.test(q)) add.forEach((w) => out.add(w));
  return [...out].slice(0, 24);
}

function score(text, ts) {
  const t = norm(text);
  let s = 0;
  for (const w of ts) {
    const n = t.split(w).length - 1;
    if (n) s += Math.min(n, 4) * (w.length >= 6 ? 2 : 1);
  }
  return s;
}

function formatSections(r, query, max, what) {
  const sections = Array.isArray(r.sections) ? r.sections : [];
  const head = `${what} ${r.version ?? r.rules_version ?? ''}${r.effective_from_utc ? `, gültig ab ${r.effective_from_utc}` : ''}${r.as_of ? `, Stand ${r.as_of}` : ''} (Quelle: ${r.source_url ?? MCP_URL}, live)`;
  if (!query) return short(`${head}\nKlauseln (Nummer: Titel), mit query gezielt lesen:\n${sections.map((s) => `${s.id}: ${s.title ?? ''}`).join('\n')}`, max);
  const ts = terms(query);
  const ranked = sections.map((s) => ({ s, sc: score(`${s.title ?? ''} ${s.text ?? ''}`, ts) + score(s.title ?? '', ts) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc);
  if (!ranked.length) return short(`${head}\nKeine Klausel passt zu "${short(query, 80)}". Klauseln: ${sections.map((s) => `${s.id} ${s.title ?? ''}`).join('; ')}`, max);
  let out = `${head}\nPassende Klauseln für "${short(query, 80)}" (beste zuerst; zitiere die Nummer):`;
  for (const { s } of ranked.slice(0, 6)) {
    const block = `\n\n[${s.id}] ${s.title ?? ''}\n${s.text ?? ''}`;
    if (out.length + block.length > max - 200) { out += `\n\n[${s.id}] ${s.title ?? ''}\n${short(s.text ?? '', Math.max(300, max - out.length - 300))}`; break; }
    out += block;
  }
  return short(`${out}\n\nWeitere Treffer: ${ranked.slice(6, 14).map((x) => x.s.id).join(', ') || 'keine'}`, max);
}

function formatFaq(r, query, max) {
  const items = Array.isArray(r.items) ? r.items : [];
  const head = `REAX Miner-FAQ ${r.faq_version ?? ''} (Regeln ${r.rules_version ?? ''}; Quelle ${r.source_url ?? MCP_URL}, live). Status LIVE = verbindlich, PENDING = nur vorgeschlagen.`;
  const ts = query ? terms(query) : [];
  const ranked = query ? items.map((i) => ({ i, sc: score(`${i.question} ${i.answer}`, ts) + 2 * score(i.question, ts) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).map((x) => x.i) : items;
  let out = head;
  for (const i of ranked.slice(0, query ? 5 : 60)) {
    const block = query ? `\n\n#${i.anchor} (${i.status ?? 'LIVE'}): ${i.question}\n${i.answer}` : `\n- #${i.anchor}: ${i.question}`;
    if (out.length + block.length > max) break;
    out += block;
  }
  return short(out, max);
}

/** reax_docs tool: {method, query?, uid?, hotkey?, from?, to?, version?, track?} -> text. */
export async function reaxDocs(args = {}, { max = 6000, fetchImpl } = {}) {
  const method = String(args.method ?? '').trim();
  if (!Object.hasOwn(REAX_METHODS, method)) throw new Error(`unbekannte Methode "${short(method, 40)}"; erlaubt: ${Object.keys(REAX_METHODS).join(', ')}`);
  const pass = {};
  for (const k of PASS_ARGS[method] ?? []) if (args[k] != null && String(args[k]).length <= 200) pass[k] = method === 'training_get_results' && k === 'uid' ? Number(args[k]) : String(args[k]);
  if (method === 'reax_search_docs' && !pass.query && args.query) pass.query = String(args.query).slice(0, 200);
  const r = await mcpCall(method, pass, { fetchImpl });
  if (method === 'training_get_rules') return formatSections(r, args.query, max, 'Regeln Trainings-Wettbewerb');
  if (method === 'inference_get_rules') return formatSections(r, args.query, max, 'Regeln Inference Mining');
  if (method === 'reax_get_faq') return formatFaq(r, args.query, max);
  return short(`${method} (Quelle ${MCP_URL}, live):\n${JSON.stringify(r, null, 1)}`, max);
}

// ---------------------------------------------------------------- registry
let registryCache = { at: 0, value: null };
const REGISTRY_MS = 5 * 60_000;

/** registry.json through the bridge (Sandy first, LeChonk mirror second); cached 5 min; null when unreadable. */
export async function loadRegistry(hub, { force = false } = {}) {
  if (!force && registryCache.value && Date.now() - registryCache.at < REGISTRY_MS) return registryCache.value;
  if (!hub?.call) return registryCache.value;
  for (const host of ['sandy', 'lechonk']) {
    try {
      const r = await hub.call('ctx.read', { path: REGISTRY_PATH, offset: 0, limit: 5000 }, { host, timeoutMs: 8000 });
      const reg = JSON.parse(String(r?.text ?? ''));
      if (Array.isArray(reg?.topics)) { registryCache = { at: Date.now(), value: reg }; return reg; }
    } catch { /* next host */ }
  }
  return registryCache.value;
}

/** Topics of the registry that fit a question, best first: [{topic, score}]. */
export function matchTopics(reg, question, { limit = 3 } = {}) {
  if (!reg?.topics) return [];
  const q = ` ${norm(question)} `;
  const qs = terms(question);
  const out = [];
  for (const t of reg.topics) {
    let sc = 0;
    for (const k of t.keywords ?? []) {
      const kw = norm(k);
      if (kw.length >= 3 && q.includes(kw)) sc += kw.includes(' ') ? 3 : kw.length >= 6 ? 2 : 1;
    }
    sc += 0.5 * score(`${t.title} ${t.key}`, qs);
    if (sc > 0) out.push({ topic: t, score: sc });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function formatTopic(t, { max = 1600 } = {}) {
  const lines = [`Thema "${t.title}" (${t.key})`, `Vorgehen: ${t.playbook ?? ''}`, ...(t.sources ?? []).slice(0, 12).map((s) => `- ${s.label}: ${s.ref}${s.how ? ` (${s.how})` : ''}`)];
  return short(lines.join('\n'), max);
}

/** The block for the research agent's first prompt: the 1-2 best topics with their sources. '' without a match. */
export function registryHint(reg, question, { max = 2600 } = {}) {
  const hits = matchTopics(reg, question, { limit: 2 });
  if (!hits.length) return '';
  const body = hits.map((h) => formatTopic(h.topic, { max: Math.floor(max / hits.length) - 40 })).join('\n\n');
  return short(`${reg.rule ?? ''}\n${body}`, max);
}

/** The refs a "not found" answer must have looked at first: local files and MCP of the best topic (at most 4). */
export function mustCheck(reg, question) {
  const best = matchTopics(reg, question, { limit: 1 })[0]?.topic;
  if (!best) return [];
  return (best.sources ?? []).filter((s) => s.kind === 'live' || s.kind === 'mcp' || (s.kind === 'file' && /\.md$/.test(s.ref))).slice(0, 4);
}

/** source_map tool: {topic?, question?} -> the matching topics with sources, or the topic index. */
export async function sourceMap(args = {}, ctx = {}, max = 6000) {
  const reg = await loadRegistry(ctx.hub);
  if (!reg) return 'Die Wissenslandkarte ist gerade nicht lesbar (registry.json). Nutze search und discover.';
  const want = String(args.topic ?? args.question ?? '').trim();
  if (!want) return short(`Wissenslandkarte (Stand ${reg.built}). ${reg.rule}\nThemen:\n${reg.topics.map((t) => `- ${t.key}: ${t.title}`).join('\n')}`, max);
  const exact = reg.topics.find((t) => t.key === want);
  const hits = exact ? [{ topic: exact }] : matchTopics(reg, want, { limit: 3 });
  if (!hits.length) return short(`Kein Thema passt zu "${short(want, 80)}". Themen: ${reg.topics.map((t) => t.key).join(', ')}`, max);
  return short(`Wissenslandkarte (Stand ${reg.built}). ${reg.rule}\n\n${hits.map((h) => formatTopic(h.topic, { max: Math.floor(max / hits.length) - 50 })).join('\n\n')}`, max);
}

export const SOURCE_TOOL_DEFS = () => [
  { name: 'reax_docs', description: 'Die ÖFFENTLICHEN, geltenden REAX/SN92-Dokumente live vom REAX MCP (mcp.reax.co): Regeln des Trainings-Wettbewerbs (jede Klausel mit Nummer), FAQ, Zeitplan, Status, Rangliste, Inference-Regeln. Für JEDE Regelfrage (Podium, Holder, Champion, Auszahlung, Lineage, Fristen) ZUERST hier nachsehen; die Live-Regeln schlagen Erklärseiten, Entwürfe und alte Kopien. Mit query bekommst du nur die passenden Klauseln (englische Begriffe helfen, z. B. "podium place holder").',
    parameters: { type: 'object', properties: { method: { type: 'string', enum: Object.keys(REAX_METHODS), description: Object.entries(REAX_METHODS).map(([k, v]) => `${k}: ${v}`).join(' | ') }, query: { type: 'string', description: 'Suchbegriffe für training_get_rules, inference_get_rules, reax_get_faq, reax_search_docs' }, uid: { type: 'integer', description: 'nur training_get_results' }, hotkey: { type: 'string', description: 'nur training_get_results' }, from: { type: 'string', description: 'Version, nur training_get_rules_changes' }, to: { type: 'string', description: 'Version, nur training_get_rules_changes' }, version: { type: 'string', description: 'Regel-Version (Standard: geltende)' } }, required: ['method'], additionalProperties: false } },
  { name: 'source_map', description: 'Die Wissenslandkarte: zu einem Thema oder einer Frage die MASSGEBLICHEN Quellen (Live-Regeln, Status-Dateien, DECISIONS, Job-Ordner, aktueller Code mit Pfad) und wie man sie liest. Ohne Argument: alle Themen. Nutze sie, bevor du sagst, dass du nichts findest.',
    parameters: { type: 'object', properties: { topic: { type: 'string', description: 'Themen-Schlüssel oder Stichwort' }, question: { type: 'string', description: 'Die Frage, für die Quellen gesucht werden' } }, required: [], additionalProperties: false } },
];

export const SOURCE_HANDLERS = {
  reax_docs: async (args, ctx, max) => ({ result: await reaxDocs(args, { max }), host: 'gateway' }),
  source_map: async (args, ctx, max) => ({ result: await sourceMap(args, ctx, max), host: 'gateway' }),
};
