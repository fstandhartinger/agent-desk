// The background research agent (design §2): one question, several rounds of read-only tools, long results kept in a
// workspace (workspace.js) and inspected with grep / read / chunked sub-calls (depth 1), a short German answer with sources.
// Dependencies are injected (runTool, complete) so tests run without network. Never throws: failures end as an answer
// that says what went wrong.
import { activityLabel } from '../tools.js';
import { redact, short } from '../redact.js';
import { createWorkspace, STORE_FROM } from './workspace.js';
import { FINAL_NUDGE, SUB_SYSTEM, systemPrompt, userPrompt } from './prompt.js';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description) => ({ type: 'integer', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const BUDGET = Object.freeze({ rounds: 8, ms: 110_000, usd: 0.25, parallel: 4, subChunks: 12, subParallel: 4 });
export const WARM_CHARS = 2800;
// Questions about the internet keep the web tools: no warm start (it reads our own data, which closes the web; taint rule).
// Broader since the web tools exist (web-tools review): outside facts, prices, versions, news. An own-data question that matches only
// loses the warm start (one round), never correctness.
const WEB_QUESTION = /\b(?:web|internet|online|webseite|website|homepage|im netz|googl\w*|recherchier\w*|nachrichten|news|neueste[nrs]? version|release notes|changelog|dokumentation|docs?|github|wikipedia|hersteller|marktpreis\w*|listenpreis\w*|preisliste|was kostet .{0,40} bei)\b/i;
// Search words of a spoken question: content words only (a whole sentence is no search query, and the bridge refuses long
// tokens that look like key fragments).
const STOP = new Set(('mit wie viel viele vielen habe hab hast hat haben hatte hatten ich du er sie es wir ihr man mir mich dir mein meine meinen meinem meiner '
  + 'unser unsere unseren unserem für fuer die der das den dem des ein eine einen einem einer und oder zu zur zum was wer wann wo wie welche welcher welches welchen '
  + 'ist sind war waren wird werden wurde wurden in im ins auf an am von vom bei nach vor über ueber unter aus als auch noch schon nicht kein keine keinen '
  + 'soll sollen sollte darf dürfen durfte kann können konnte muss müssen bitte denn dass ob eigentlich gerade mal also dazu dafür davon sich sein seine '
  + 'the a an of to for and or is are was were what which who when where how much many did do does have has had our we i my me').split(' '));
export function keywords(question, max = 6) {
  const words = String(question ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w) && w.length <= 30);
  return [...new Set(words)].slice(0, max).join(' ');
}
// Florian's own words: also search the laptop mirror first.
const OWN_WORDS = /\b(?:ich|mein\w*|mir|mich|wir|unser\w*)\b/i;
const FINAL_RESERVE_MS = 12_000; // the forced final answer needs time too
export const RESULT_CHARS = 40_000; // per tool call into the workspace (the voice path gets 2,500)

/** Read tools the research model may call (existing Desk tools; everything here only reads). */
export const RESEARCH_TOOLS = [
  'search', 'discover', 'conversation_history', 'desk_sessions',
  'knowledge_read', 'read_core_doc', 'decisions_recent', 'read_file', 'list_jobs', 'job_status',
  'board_threads', 'board_read', 'board_entry', 'chats_search', 'chat_read', 'skills_list', 'skill_read',
  'ledger_spend', 'run_readonly', 'desk_status', 'session_trace', 'code_outline', 'artifact_search', 'artifact_resolve',
  'artifact_ref_read', 'shell', 'web_read', 'web_search', 'http_get', 'mail_search', 'mail_read', 'explainer_context', 'explainer_point',
];
// discord_read is left out on purpose: reading a channel moves Florian's read marker (tools.js description).
// search_files and board_search are left out: `search` (full-text index, ~40 ms) covers both; they took 2-8 s each in the eval.
const PAGE_TOOLS = new Set(['explainer_context', 'explainer_point']);
// Critic A1 (taint): tools that reach the internet exist in a run only until it reads our own data (web first, then private
// is fine). A planted page or mail can then never make the agent carry private facts out in a URL or a search query.
export const WEB_TOOLS = new Set(['web_read', 'web_search', 'http_get']);
// Text written by outsiders: after such a run is delivered, web_read and the action tools stay closed for a while (critic A4).
export const OUTSIDER_TOOLS = new Set(['web_read', 'web_search', 'http_get', 'mail_search', 'mail_read', 'discord_read']);

export const WS_TOOL_DEFS = [
  { name: 'ws_grep', description: 'Zeilen eines Arbeitsbereich-Dokuments (@wN), die einen der Begriffe enthalten (wörtlich, ohne Groß/klein), mit Zeilennummern.', parameters: obj({ ref: str('Handle, z. B. "@w2"'), terms: { type: 'array', items: { type: 'string' }, description: '1-8 Begriffe; deutsch und englisch' } }, ['ref', 'terms']) },
  { name: 'ws_read', description: 'Ein Stück eines Arbeitsbereich-Dokuments ab einer Zeile lesen (höchstens 8000 Zeichen).', parameters: obj({ ref: str('Handle'), line: int('Erste Zeile, 0-basiert'), count: int('Anzahl Zeilen (Standard 80, höchstens 400)') }, ['ref']) },
  { name: 'ws_ask', description: 'Ein Hilfsagent liest das ganze Dokument in Stücken von 30.000 Zeichen und liefert die Stellen, die die Frage beantworten (mit Zeilennummern). Für lange Transkripte, wenn ws_grep nicht reicht.', parameters: obj({ ref: str('Handle'), question: str('Was genau gesucht ist') }, ['ref', 'question']) },
  { name: 'answer', description: 'Die fertige Antwort abgeben. Beendet die Recherche.', parameters: obj({
    antwort: str('Deutsch, höchstens 600 Zeichen, zum Vorlesen'),
    gefunden: { type: 'boolean', description: 'false, wenn du nichts Belastbares gefunden hast' },
    quellen: { type: 'array', items: { type: 'object', properties: { label: str('Kurzname, z. B. "Laptop-Hauptsitzung 15.11." oder "DECISIONS 15.11."'), ref: str('Pfad mit Zeile, Board-Eintrag, a#-ID oder URL') }, required: ['label'] }, description: 'Belege aus den Werkzeugergebnissen' },
    nicht_bestaetigt: { type: 'array', items: { type: 'string' }, description: 'Was offen oder unsicher blieb' },
    sicherheit: str('hoch, mittel oder niedrig', { enum: ['hoch', 'mittel', 'niedrig'] }),
  }, ['antwort', 'gefunden']) },
];

/** Tool definitions handed to the research model: the allowed read tools that exist + the workspace tools. */
export function researchToolDefs(allDefs, ctx = {}) {
  const byName = new Map(allDefs.map((t) => [t.name, t]));
  const pick = RESEARCH_TOOLS.filter((n) => byName.has(n) && (!PAGE_TOOLS.has(n) || ctx.page?.slug)).map((n) => {
    const { name, description, parameters } = byName.get(n);
    return { name, description, parameters };
  });
  return [...pick, ...WS_TOOL_DEFS];
}

// Which sources a run touched, by class (design §5): personal (mail, chats, Desk conversations, the laptop mirror) and
// finance (ledger, tax). Decided from the tool and its arguments, never from the model's own claim.
export function classOf(name, args = {}) {
  const a = JSON.stringify(args ?? {}).toLowerCase();
  if (/^mail_|^chat|conversation_history|desk_sessions|discord/.test(name) || /laptop-mirror|chats\/|\/\.claude|\/\.codex/.test(a)) return 'personal';
  if (name === 'ledger_spend' || /steuer|\btax\b|ledger|emission|wallet|kraken|invoice|rechnung/.test(a)) return 'finance';
  return 'open';
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { const v = JSON.parse(String(raw || '{}')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; /* malformed JSON from the model */ }
}

const cleanList = (v, n, len) => (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x : null)).filter(Boolean).slice(0, n).map((x) => (typeof x === 'string' ? short(redact(x), len) : x));

/** Normalises the answer tool's arguments (or a JSON text answer) into the result shape. */
export function normaliseAnswer(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const text = short(redact(String(a.antwort ?? a.answer ?? '').trim()), 900);
  const sources = cleanList(a.quellen ?? a.sources, 8, 200).map((s) => (typeof s === 'string' ? { label: s } : { label: short(redact(String(s.label ?? s.ref ?? '')), 120), ...(s.ref ? { ref: short(redact(String(s.ref)), 240) } : {}) })).filter((s) => s.label);
  const found = a.gefunden !== false && Boolean(text);
  return {
    answer: text || 'Dazu habe ich nichts gefunden.',
    found,
    sources,
    unconfirmed: cleanList(a.nicht_bestaetigt ?? a.unconfirmed, 6, 200),
    confidence: ['hoch', 'mittel', 'niedrig'].includes(a.sicherheit) ? a.sicherheit : found && sources.length ? 'mittel' : 'niedrig',
  };
}

/** A text answer without the answer tool: JSON inside, or the text itself. */
function answerFromText(content) {
  const raw = String(content ?? '');
  const from = raw.indexOf('{'), to = raw.lastIndexOf('}'); // no regex: a long run of braces must stay linear (critic r6/r7 ReDoS tests)
  if (from >= 0 && to > from) { const parsed = parseArgs(raw.slice(from, to + 1)); if (parsed && (parsed.antwort || parsed.answer)) return normaliseAnswer(parsed); }
  const text = String(content ?? '').trim();
  return normaliseAnswer({ antwort: text, gefunden: Boolean(text), sicherheit: 'niedrig' });
}

/**
 * Runs one research. deps = {runTool(name, args, ctx), complete({model, messages, tools, json, maxTokens, signal}) ->
 * {message:{content, tool_calls:[{id,name,args}]}, costUsd}, toolDefs, now}. Returns
 * {answer, found, sources, unconfirmed, confidence, classes, rounds, steps, ms, costUsd, model, stopped}.
 */
export async function runResearch({ question, focus = '', context = '', ctx = {}, model, subModel = model, budget = BUDGET, onStep = () => {}, signal, warmStart = true, reasoning }, deps) {
  const now = deps.now ?? Date.now;
  const started = now();
  const ws = createWorkspace();
  const tools = researchToolDefs(deps.toolDefs ?? [], ctx);
  const allowed = new Set(tools.map((t) => t.name));
  const messages = [{ role: 'system', content: systemPrompt({ now: new Date(started), page: ctx.page, maxRounds: budget.rounds }) }];
  const classes = new Set();
  const touched = [];
  const timing = { modelMs: [], toolMs: {} }; // where the time goes (eval and trace)
  // read our own data: no web tools from now on. A run started while the post-delivery lock is on starts tainted (review P1-1).
  let tainted = Boolean(ctx.research?.guarded?.(ctx.sid ?? 'desk'));
  let outsider = false; // read text written by outsiders
  let webUsed = false; // web and shell are exclusive in one run: web first closes the shell, own data first closes the web
  const toolsNow = () => tools.filter((t) => !(tainted && WEB_TOOLS.has(t.name)) && !(webUsed && t.name === 'shell'));
  let cost = 0;
  let steps = 0;
  let rounds = 0;
  const left = () => budget.ms - (now() - started);
  const spendOk = () => ctx.limits?.check?.(ctx.sid ?? 'desk', 'spend')?.ok !== false; // the Desk daily cap (review P2-4)
  const over = () => left() < FINAL_RESERVE_MS || cost >= budget.usd || !spendOk();
  const done = (res, stopped) => ({ ...res, timing, classes: [...classes], outsider, touched: touched.slice(0, 30), rounds, steps, ms: now() - started, costUsd: Math.round(cost * 10000) / 10000, model, stopped });
  const ask = async (msgs, opts = {}) => {
    const timeout = AbortSignal.timeout(Math.max(3000, Math.min(left(), 45_000)));
    const m0 = now();
    const r = await deps.complete({ model, messages: msgs, maxTokens: 2000, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, ...(reasoning ? { reasoning: { effort: reasoning } } : {}), ...opts });
    timing.modelMs.push(now() - m0);
    cost += Number(r.costUsd) || 0;
    return r.message ?? { content: '', tool_calls: [] };
  };

  async function subAsk(ref, q) {
    const parts = ws.chunks(ref).slice(0, budget.subChunks);
    const out = [];
    for (let i = 0; i < parts.length; i += budget.subParallel) {
      if (over() || signal?.aborted) { out.push(`(abgebrochen nach ${i} von ${parts.length} Stücken: Budget)`); break; }
      const batch = parts.slice(i, i + budget.subParallel);
      const answers = await Promise.all(batch.map(async (p, j) => {
        try {
          const timeout = AbortSignal.timeout(Math.max(3000, Math.min(left() - FINAL_RESERVE_MS / 2, 25_000)));
          const r = await deps.complete({ model: subModel, json: true, maxTokens: 400, messages: [{ role: 'system', content: SUB_SYSTEM }, { role: 'user', content: `Frage: ${short(q, 400)}\n--- Stück ${i + j + 1} (ab Zeile ${p.line}) ---\n${p.text}` }], signal: timeout });
          cost += Number(r.costUsd) || 0;
          const v = parseArgs(r.message?.content);
          if (!v?.relevant) return null;
          const line = Number.isInteger(v.zeile) ? p.line + v.zeile : p.line;
          return `Z.${line}: ${short(redact(String(v.auszug ?? '')), 500)}`;
        } catch (err) { return `(Stück ${i + j + 1} nicht gelesen: ${short(err.message ?? err, 60)})`; }
      }));
      out.push(...answers.filter(Boolean));
    }
    const total = ws.chunks(ref).length;
    return `${ref}: ${out.length} Fundstellen in ${Math.min(total, budget.subChunks)} von ${total} Stücken${total > budget.subChunks ? ' (Rest nicht gelesen)' : ''}\n${out.join('\n') || '(nichts Passendes)'}`;
  }

  async function exec(call, { store = true } = {}) {
    const args = parseArgs(call.args);
    const t0 = now();
    const label = call.name.startsWith('ws_') ? `Arbeitsbereich: ${call.name.slice(3)}` : activityLabel(call.name, args ?? {});
    onStep({ phase: 'start', id: call.id, name: call.name, label });
    let content;
    let ok = true;
    try {
      if (args === null) throw new Error('arguments were not valid JSON');
      if (!allowed.has(call.name)) throw new Error(`tool ${short(call.name, 40)} is not available here; use one of: ${[...allowed].filter((n) => n !== 'answer').join(', ')}`);
      if (call.name === 'shell' && webUsed) throw new Error('shell is closed in this research after a web tool (a page could steer commands); answer from what you have');
      if (tainted && WEB_TOOLS.has(call.name)) throw new Error('web tools are closed in this research after reading Florian\'s own data (privacy rule); answer from what you have');
      if (call.name === 'ws_grep') content = ws.grep(args.ref, args.terms);
      else if (call.name === 'ws_read') content = ws.read(args.ref, args.line, args.count);
      else if (call.name === 'ws_ask') content = await subAsk(args.ref, args.question);
      else {
        classes.add(classOf(call.name, args));
        if (OUTSIDER_TOOLS.has(call.name)) outsider = true;
        if (WEB_TOOLS.has(call.name)) webUsed = true;
        if (!WEB_TOOLS.has(call.name)) tainted = true; // set before the call: parallel calls of this round already count
        touched.push({ tool: call.name, args: short(JSON.stringify(args), 160) });
        // research: only the lock is visible inside a run (no start, so no recursion); the web_read lock applies here too (review P1-1)
        const res = await deps.runTool(call.name, args, { ...ctx, maxChars: RESULT_CHARS, research: { guarded: (s) => Boolean(ctx.research?.guarded?.(s)) }, voiceTurn: undefined, researchRun: true }); // researchRun: web_search / http_get exist only here (tools.js)
        ok = res.ok !== false;
        content = String(res.content ?? '');
        if (store && content.length > STORE_FROM) content = ws.stub(ws.put(content, `${call.name} ${short(JSON.stringify(args), 120)}`));
      }
    } catch (err) {
      ok = false;
      content = `ERROR: ${short(err.message ?? err, 300)}`;
    }
    steps += 1;
    (timing.toolMs[call.name] ??= []).push(now() - t0);
    onStep({ phase: ok ? 'done' : 'fail', id: call.id, name: call.name, label, ms: now() - t0 });
    return content;
  }

  // Warm start: the desk searches once before the first model call (saves a round). Counts as a step; reads our own data.
  let warm = '';
  const webQuestion = WEB_QUESTION.test(question);
  if (webQuestion) context = ''; // a web question keeps the web tools, so no private conversation text before them (review P2-3)
  if (warmStart && allowed.has('search') && !webQuestion) {
    const q = keywords(question);
    const own = OWN_WORDS.test(String(question));
    const calls = q ? [{ id: 'warm1', name: 'search', args: JSON.stringify({ query: q }) }, ...(own ? [{ id: 'warm2', name: 'search', args: JSON.stringify({ query: q, source: 'chats/laptop' }) }] : [])] : [];
    const got = await Promise.all(calls.map((c) => exec(c, { store: false })));
    warm = got.filter((g) => !g.startsWith('ERROR')).map((g, i) => `${i ? '[Laptop-Sitzungen] ' : ''}${short(g, WARM_CHARS / calls.length)}`).join('\n---\n');
  }
  messages.push({ role: 'user', content: userPrompt(question, { focus, context, warm }) });

  try {
    for (rounds = 0; rounds < budget.rounds && !over() && !signal?.aborted;) {
      rounds += 1;
      const message = await ask(messages, { tools: toolsNow() });
      const calls = message.tool_calls ?? [];
      const final = calls.find((c) => c.name === 'answer');
      if (final) { const a = parseArgs(final.args); if (a) return done(normaliseAnswer(a), 'answer'); }
      if (!calls.length) return done(answerFromText(message.content), 'text');
      const run = calls.filter((c) => c.name !== 'answer').slice(0, budget.parallel);
      messages.push({ role: 'assistant', content: message.content || null, tool_calls: run.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}) } })) });
      if (run.some((c) => !WEB_TOOLS.has(c.name) && !c.name.startsWith('ws_') && allowed.has(c.name))) tainted = true; // same round: no web call next to a private read
      const results = await Promise.all(run.map(exec));
      run.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: results[i] }));
      const notes = [];
      if (calls.length > run.length) notes.push(`Nur die ersten ${budget.parallel} Werkzeugaufrufe wurden ausgeführt.`);
      if (rounds >= 2) notes.push(`Runde ${rounds} von ${budget.rounds}. Steht die Antwort belegt in den Ergebnissen, rufe JETZT answer auf; sonst suche gezielt anders (nicht dasselbe noch einmal).`);
      if (notes.length) messages.push({ role: 'user', content: notes.join(' ') });
    }
    if (signal?.aborted) return done(normaliseAnswer({ antwort: 'Die Recherche wurde abgebrochen.', gefunden: false }), 'aborted');
    // budget or rounds used up: one last call that must answer
    messages.push({ role: 'user', content: FINAL_NUDGE });
    const message = await ask(messages, { tools: tools.filter((t) => t.name === 'answer'), maxTokens: 900 });
    const final = (message.tool_calls ?? []).find((c) => c.name === 'answer');
    const res = final && parseArgs(final.args) ? normaliseAnswer(parseArgs(final.args)) : answerFromText(message.content);
    return done({ ...res, confidence: res.confidence === 'hoch' ? 'mittel' : res.confidence }, 'budget');
  } catch (err) {
    return done(normaliseAnswer({ antwort: `Die Recherche ist fehlgeschlagen (${short(err.message ?? err, 120)}).`, gefunden: false, sicherheit: 'niedrig' }), 'error');
  }
}

/** The result as text for a model (voice tool result or say() note): answer, sources, open points. */
const NO_URLS = /\bhttps?:\/\/\S+|\bwww\.\S+/gi; // critic A4: a spoken answer carries no address that invites a web_read

export function formatResult(r, { maxChars = 1800, voice = true } = {}) {
  const clean = (t) => (voice ? String(t ?? '').replace(NO_URLS, '[Link]') : String(t ?? ''));
  const lines = [
    `Antwort${r.found ? '' : ' (nichts Belastbares gefunden)'}: ${clean(r.answer)}`,
    ...(r.sources?.length ? [`Quellen: ${r.sources.map((s) => (s.ref ? `${clean(s.label)} (${clean(s.ref)})` : clean(s.label))).join('; ')}`] : ['Quellen: keine']),
    ...(r.unconfirmed?.length ? [`Nicht bestätigt: ${r.unconfirmed.map(clean).join('; ')}`] : []),
    `Sicherheit: ${r.confidence}. Recherche: ${r.steps} Schritte, ${Math.round(r.ms / 1000)} s.`,
  ];
  return short(lines.join('\n'), maxChars);
}
