// Discovery tools (design §1, §2, §4): discover (the walkable map of all sources), search (full-text index over everything),
// research (background research agent, research/), research_result. Kept out of tools.js on purpose: tools.js only
// registers these definitions and handlers (another job edits tools.js at the same time).
// The map and the index live on the LeChonk bridge (bridge/src/map*, methods map.discover / map.search); until that bridge
// serves them, discover answers with a static root and search falls back to ctx.search.
import { redact, short } from './redact.js';
import { formatResult } from './research/agent.js';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description) => ({ type: 'integer', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const VOICE_RESEARCH_WAIT_MS = 2500; // critic B4: GPT-Live already needs up to ~9 s to its first call
export const TEXT_RESEARCH_WAIT_MS = 170_000; // above a worst-case run (110 s budget + final call + a slow tool)
export const VOICE_LINES = 6; // critic B5: a voice result must stay far below 2,500 characters
export const PENDING_MARK = '"status":"recherchiere"';

export const DISCOVERY_TOOL_DEFS = () => [
  { name: 'discover', description: 'Inhaltsverzeichnis ALLER Quellen des Desks: Wissen, Entscheidungen, Florians Laptop-Sitzungen (sein Wortlaut), Desk-Gespräche, Jobs (auch alte), Board, Agenten-Chats, Regeln, Artefakte, Skills, Code, Ledger, Server, Mails, Discord. Ohne Argumente: die Quellen mit Umfang und Stand; path geht eine Ebene tiefer ("jobs", "jobs/2026-11", "chats/laptop"); query sucht nur in diesem Zweig. Jede Zeile nennt den Aufruf, der sie öffnet. Nutze es, wenn du nicht weißt, wo etwas steht, statt "das kann ich nicht sehen" zu sagen.',
    parameters: obj({ path: str('Knoten aus einem früheren discover-Ergebnis, z. B. "jobs" oder "chats/laptop"'), query: str('Optional: Suchwörter in diesem Zweig'), offset: int('Weiterblättern: nextOffset aus dem letzten Ergebnis') }) },
  { name: 'search', description: 'Volltextsuche über alles Geschriebene auf einmal (alle Job-Ordner auch alte, Entscheidungen, Board, Wissen, Florians Laptop-Hauptsitzung im Wortlaut, Skills, Erklärseiten), in unter einer Sekunde, deutsch und englisch. Treffer mit Fundstelle, Datum und dem Aufruf zum Lesen. source grenzt ein: "chats/laptop" (was Florian am Laptop gesagt hat), "entscheidungen", "jobs", "board", "wissen", "skills".',
    parameters: obj({ query: str('Suchwörter (Florians Worte oder Fachbegriffe)'), source: str('Optional: Quelle, z. B. "chats/laptop", "jobs", "board", "entscheidungen"'), since: str('Optional: nur ab diesem Datum YYYY-MM-DD') }, ['query']) },
  { name: 'research', description: 'Recherche im Hintergrund durch einen eigenen Agenten (10 bis 120 Sekunden, mehrere Suchschritte über alle Quellen, liest lange Texte stückweise). Nimm es, sobald eine Frage mehr als einen Griff braucht oder du nicht weißt, wo die Antwort steht, z. B. "Was habe ich zu X gesagt / entschieden / gerechnet?", "Wie lange dauerte …?", "Wie viele … haben wir?", "Was ist aus … geworden?", "Warum …?". Nicht für heutige Entscheidungen (decisions_recent), eine bekannte Datei (read_file) oder Smalltalk. Kommt "läuft" zurück, sag genau den Satz aus dem Ergebnis und nenne noch KEIN Ergebnis; es kommt später als Hinweis vom Desk.',
    parameters: obj({ question: str('Die Frage in Florians Worten, vollständig (wer, was, welcher Zeitraum)'), focus: str('Optional: wo es stehen könnte (z. B. "Laptop-Sitzung von gestern", "Board Thread 22")') }, ['question']) },
  { name: 'shell', researchOnly: true, description: 'Einen Lese-Befehl in einem abgeschotteten Sandkasten ausführen (bash, ohne Netz, nur lesen, 20 s, 50.000 Zeichen Ausgabe): /data enthält eine bereinigte Textkopie aller indizierten Quellen als <quelle>/<pfad>.txt (jobs/, board/<thread>/<nummer>.txt, chats/laptop/, entscheidungen/, wissen/, daten/, skills/); die erste Zeile jeder Datei nennt den echten Pfad für read_file. Werkzeuge: rg, grep, find, awk, sed, sort, uniq, wc, jq, python3 -I, sqlite3. Für Zählen, Vergleichen, Durchsuchen vieler Dateien auf einmal. Nicht nach einer Websuche im selben Lauf.',
    parameters: obj({ command: str('Ein bash-Befehl, höchstens 2000 Zeichen, z. B. rg -l "Bewertungsphase" jobs | head') }, ['command']) },
  { name: 'research_result', description: 'Stand oder Ergebnis der Recherchen dieser Sitzung (für "schon was gefunden?"). Ohne id: die letzten drei.',
    parameters: obj({ id: str('Optional: Recherche-ID wie "r3"') }) },
];

// ---------------------------------------------------------------------------------------------------------------
// Map lines. Titles and summaries are DATA from files and board entries (critic A11): shown quoted, the open call is
// built by the bridge from ids and paths only.

const q = (s, n) => JSON.stringify(short(String(s ?? '').replace(/\s+/g, ' ').trim(), n));
const day = (iso) => String(iso ?? '').slice(0, 10);
const size = (n) => (!Number.isFinite(n) || n <= 0 ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

export const STATIC_ROOT = [
  ['wissen', 'Desk-Wissen: Florians Themen mit Kernfakten', 'knowledge_read()'],
  ['entscheidungen', 'Florians Entscheidungen, neueste zuerst', 'decisions_recent(days)'],
  ['chats/laptop', 'Florians Laptop-Hauptsitzung und weitere Laptop-Sitzungen im Wortlaut (Tagesdateien)', 'read_file("/home/flori/data/laptop-mirror/INDEX.md")'],
  ['desk-sitzungen', 'Frühere Desk-Gespräche (Sprache und Chat)', 'session_trace(which)'],
  ['jobs', 'Alle Agenten-Jobs mit Stand und Ergebnis', 'list_jobs() / job_status(name)'],
  ['board', 'Agent-Board: Threads und Einträge', 'board_threads() / board_search(query)'],
  ['chats/agenten', 'Chats der Agenten auf Sandy und LeChonk', 'chats_search(query)'],
  ['regeln', 'AGENTS, STATE, Modell-Politik', 'read_core_doc(name)'],
  ['artefakte', 'a#-IDs, Karten, Erklärseiten', 'artifact_search(q)'],
  ['skills', 'Skills der Werkstatt', 'skills_list()'],
  ['ledger', 'Geldbewegungen, summiert', 'ledger_spend()'],
  ['server', 'Quoten, Platten, laufende Jobs, Termine', 'run_readonly(command)'],
  ['mail', 'Florians Mails (nur lesen)', 'mail_search(query)'],
];

function staticRoot(voice) {
  const rows = STATIC_ROOT.slice(0, voice ? 9 : undefined).map(([p, title, open]) => `${p} — ${title} → ${open}`);
  return `Quellen (die Karte wird gerade aufgebaut; bis dahin die direkten Werkzeuge):\n${rows.join('\n')}\nFür Fragen über mehrere Quellen: research(question).`;
}

/** map.discover result -> text; voice: at most VOICE_LINES short lines (critic B5). */
export function formatDiscover(r, { voice = false, max = 6000 } = {}) {
  if (!r || !Array.isArray(r.lines)) return redact(JSON.stringify(r ?? {}));
  const rows = r.lines.slice(0, voice ? VOICE_LINES : 40).map((l) => {
    const meta = [size(l.size), day(l.updated)].filter(Boolean).join(', ');
    return voice
      ? `${l.path}: ${q(l.title, 50)}${meta ? ` (${meta})` : ''}`
      : `${l.path} — ${q(l.title, 80)}${l.summary ? `: ${q(l.summary, 140)}` : ''}${meta ? ` [${meta}]` : ''}${l.open ? ` → ${l.open}` : ''}`;
  });
  const more = r.lines.length > rows.length || r.nextOffset != null ? `\n… weitere: discover(${JSON.stringify(r.path ?? '')}${r.nextOffset != null ? `, offset ${r.nextOffset}` : ''})` : '';
  const head = `${r.path ? `${r.path}: ${q(r.title ?? r.path, 80)}` : 'Quellen'}${r.total != null ? ` (${r.total} Einträge)` : ''}`;
  return short(redact(`${head}\n${rows.join('\n')}${more}${voice ? '\nMehr als ein Griff nötig: research(question).' : ''}`), max);
}

/** map.search result -> text. */
export function formatSearch(r, { voice = false, max = 6000 } = {}) {
  const hits = Array.isArray(r?.hits) ? r.hits : [];
  if (!hits.length) return `Keine Treffer für ${q(r?.query ?? '', 80)}${r?.source ? ` in ${r.source}` : ''}.`;
  const rows = hits.slice(0, voice ? 5 : 15).map((h) => {
    const where = `${h.path}${Number.isInteger(h.line) ? `:${h.line}` : ''}`;
    return voice
      ? `${day(h.updated)} ${q(h.title, 50)}: ${q(h.snippet, 160)} → ${h.open ?? where}`
      : `${where} (${day(h.updated)}) ${q(h.title, 80)}${h.heading ? ` › ${q(h.heading, 60)}` : ''}\n  ${q(h.snippet, 300)}${h.open ? `\n  → ${h.open}` : ''}`;
  });
  return short(redact(`${hits.length} Treffer${r.total > hits.length ? ` von ${r.total}` : ''}:\n${rows.join('\n')}`), max);
}

const isVoice = (ctx) => Boolean(ctx?.voiceTurn);
// the map not served (old bridge), not built yet (first run takes minutes), no node:sqlite, or an old schema: fall back (review P2-5)
const missingMethod = (err) => /unknown method|no bridge|not connected|method not found|nicht verbunden|keine bridge|not built yet|node:sqlite|needs Node|schema/i.test(String(err?.message ?? err).slice(0, 400));

async function discoverTool({ path, query, offset }, ctx, max) {
  const voice = isVoice(ctx);
  try {
    const r = await ctx.hub.call('map.discover', { path, query, offset, limit: voice ? VOICE_LINES : 25 });
    return { result: formatDiscover(r, { voice, max }), host: ctx.hub.pick?.('map.discover') ?? 'lechonk' };
  } catch (err) {
    if (!missingMethod(err) || path) throw err;
    return { result: staticRoot(voice), host: 'gateway' };
  }
}

async function searchTool({ query, source, since }, ctx, max) {
  const voice = isVoice(ctx);
  try {
    const r = await ctx.hub.call('map.search', { query, source, since, limit: voice ? 5 : 15 });
    return { result: formatSearch({ ...r, query, source }, { voice, max }), host: ctx.hub.pick?.('map.search') ?? 'lechonk', empty: !r?.hits?.length };
  } catch (err) {
    if (!missingMethod(err)) throw err;
    const r = await ctx.hub.call('ctx.search', { query, scope: 'all', maxHits: voice ? 5 : 15 });
    return { result: r, host: ctx.hub.pick?.('ctx.search') ?? 'bridge', empty: !r?.hits?.length };
  }
}

/** Florian's last spoken sentences as context for the research agent (data, at most 1,500 characters). */
function spokenContext(ctx) {
  const spoken = ctx.voiceTurn?.spoken?.() ?? [];
  return spoken.slice(-4).map((s) => `Florian: ${short(s.text, 300)}`).join('\n');
}

export function pendingText(run) {
  const said = run.reused ? 'Die Recherche dazu läuft schon' : 'Ich lass das kurz recherchieren';
  return `{${PENDING_MARK},"id":"${run.id}","schritte":${run.steps?.length ?? 0}}\nRecherche ${run.id} ${run.reused ? 'läuft bereits' : 'läuft'} (bis zu zwei Minuten). Sag Florian genau einen kurzen Satz, zum Beispiel: "${said}, ich melde mich gleich." Nenne KEIN Ergebnis und keine Zahl, bevor der Hinweis vom Desk mit dem Ergebnis kommt; red danach normal weiter.`;
}

async function researchTool({ question, focus }, ctx) {
  if (!ctx.research?.start) throw new Error('Die Recherche ist in diesem Kontext nicht verfügbar.');
  const voice = isVoice(ctx);
  const run = ctx.research.start({ sid: ctx.sid ?? 'desk', question, focus, context: voice ? spokenContext(ctx) : String(ctx.chatContext ?? '').slice(-1500), ctx });
  const result = await run.wait(ctx.researchWaitMs ?? (voice ? VOICE_RESEARCH_WAIT_MS : TEXT_RESEARCH_WAIT_MS)); // researchWaitMs: tests only
  if (result) { ctx.research.claimed?.(run); return { result: formatResult(result, { voice }), host: 'gateway' }; }
  if (voice) run.detach();
  else run.detach?.();
  return { result: pendingText(run), host: 'gateway' };
}

async function researchResultTool({ id }, ctx) {
  if (!ctx.research?.results) throw new Error('Die Recherche ist in diesem Kontext nicht verfügbar.');
  const list = ctx.research.results(ctx.sid ?? 'desk', id);
  return { result: list.length ? list.map((r) => (r.result ? `${r.id} (${r.question}): fertig\n${r.result}` : `${r.id} (${r.question}): läuft seit ${r.laeuftSeit} s, ${r.schritte} Schritte`)).join('\n\n') : 'Keine Recherche in dieser Sitzung.', host: 'gateway' };
}

/** shell (research agent only): one read-only command in the Sandy bridge's bubblewrap sandbox over the scrubbed corpus. */
async function shellTool({ command }, ctx) {
  const r = await ctx.hub.call('sandbox.exec', { command });
  const head = `exit ${r.exitCode}${r.timedOut ? ', Zeitlimit erreicht' : ''}${r.truncated ? ', Ausgabe gekürzt' : ''}, ${r.ms} ms`;
  return { result: `${head}\n---\n${String(r.output ?? '')}`, host: ctx.hub.pick?.('sandbox.exec') ?? 'sandy' };
}

export const DISCOVERY_HANDLERS = { discover: discoverTool, search: searchTool, research: researchTool, research_result: researchResultTool, shell: shellTool };

// Critic B3: a quick search in voice that finds nothing hands the question to the research agent by itself.
const QUICK_SEARCH = new Set(['search', 'search_files', 'chats_search', 'board_search']);
/** After a voice quick search with no hits: start research for his last sentence; returns the text to append, or ''.
 *  Synchronous on purpose: runTool must not get an extra await for every tool (result order of parallel calls). */
export function escalate(name, result, ctx) {
  if (!isVoice(ctx) || !QUICK_SEARCH.has(name) || !ctx.research?.start) return '';
  const hits = typeof result === 'object' && result ? (Array.isArray(result.hits) ? result.hits.length : result.empty ? 0 : null) : null;
  if (hits !== 0) return '';
  const question = ctx.voiceTurn?.spoken?.()?.at(-1)?.text;
  if (!question || question.length < 8) return '';
  try {
    const run = ctx.research.start({ sid: ctx.sid ?? 'desk', question, context: spokenContext(ctx), ctx, escalated: name });
    run.detach();
    return `\n${pendingText(run)}\n(Die schnelle Suche fand nichts; der Desk hat die Recherche selbst gestartet.)`;
  } catch { return ''; /* two runs already: no third */ }
}
