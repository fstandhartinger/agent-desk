// Structured tool facts for the Live Canvas (viz slice). The canvas model never sees raw tool JSON: every tool call
// becomes ONE ledger entry (start → done/error merged by call id) with its current status and a few key facts
// (counts, names) read from the result. After the model answers, guardSpec() checks the spec against that ledger:
// a finished tool may never be shown as running, and numbers that occur nowhere in the input are dropped.

const LEDGER_MAX = 10;

export const STATUS_WORD = { start: 'läuft', done: 'fertig', error: 'Fehler' };

export const TOOL_WORD = {
  read_core_doc: 'Kerndokument', search_files: 'Dateisuche', read_file: 'Datei lesen', decisions_recent: 'Entscheidungen',
  list_jobs: 'Jobliste', job_status: 'Jobstatus', board_threads: 'Board-Threads', board_read: 'Board lesen',
  board_search: 'Board-Suche', search_chats: 'Chat-Suche', chats_search: 'Chat-Suche', explainer_point: 'Erklärpunkt', explainer_context: 'Hintergrund', claude_task: 'Claude-Auftrag',
  claude_status: 'Claude-Status',
};

// Words a node about a tool would use for that tool when it is the subject: "Entscheidungen" for decisions_recent etc.
// Job and Claude tools have none on purpose: "läuft"/"offen" next to a job or session is a fact about the job.
const TOPIC = {
  decisions_recent: /entscheid/i, read_core_doc: /kerndok|dokument/i, search_files: /suche|treffer/i,
  search_chats: /chat.?suche|treffer/i, chats_search: /chat.?suche|treffer/i, board_search: /board.?suche|treffer/i, board_threads: /threads?\b/i,
  board_read: /board|einträge/i, list_jobs: /jobliste|jobs? (ab)?fragen|abfrage/i,
};

const basename = (p) => String(p ?? '').replace(/(?<![\\/])[\\/]+$/, '').split(/[\\/]/).pop() || '';
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const count = (re, s) => (String(s).match(re) ?? []).length;

/** Result text as the tools send it: pretty JSON, `{header}\n---\nbody`, possibly cut ("…[abgeschnitten"). */
export function parseResult(raw) {
  const text = String(raw ?? '');
  const cut = /…\[abgeschnitten|…$/.test(text.trimEnd());
  const sep = text.indexOf('\n---\n');
  if (sep > 0) {
    let header = null;
    try { header = JSON.parse(text.slice(0, sep)); } catch { /* header cut off */ }
    return { obj: null, header, body: text.slice(sep + 5), cut, text };
  }
  let obj = null;
  try { obj = JSON.parse(text); } catch { /* cut JSON or plain text */ }
  return { obj, header: null, body: '', cut: cut || (!obj && /^\s*[[{]/.test(text)), text };
}

// A count from a cut list is only a lower bound and says so.
const atLeast = (n, cut) => (cut ? `mind. ${n}` : n);

/** Key facts of one finished tool result, as a small flat object of German keys. Never raw JSON. */
export function toolFacts(name, raw, args = {}) {
  const r = parseResult(raw);
  const o = r.obj;
  const h = r.header ?? {};
  const str = (key) => r.text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
  const num = (key) => { const m = r.text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`)); return m ? Number(m[1]) : undefined; };
  const facts = {};
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) facts[k] = v; };
  switch (name) {
    case 'list_jobs': {
      const jobs = o?.jobs;
      put('auswahl', args?.activeOnly ? 'nur aktive Jobs (offen, in den letzten 12 h geändert)' : args?.filter ? `Name enthält „${clip(args.filter, 30)}“` : 'neueste Jobs');
      const total = o?.total ?? h.total ?? num('total');
      if (Number.isInteger(total) && !Array.isArray(jobs)) { // cut list with an exact count header (bridge jobs.list)
        put('jobs', total);
        put('offen', o?.open ?? h.open ?? num('open'));
        const open = o?.open ?? h.open ?? num('open');
        if (Number.isInteger(open)) put('fertig', total - open);
        put('namen', r.header ? r.body.split('\n').filter((line) => line.includes(' | ')).slice(0, 5).map((line) => line.split(' | ')[0]) : [...r.text.matchAll(/"name"\s*:\s*"([^"]+)"/g)].slice(0, 5).map((m) => m[1]));
      } else if (Array.isArray(jobs)) {
        put('jobs', jobs.length);
        put('offen', jobs.filter((j) => !j.finalDone).length);
        put('fertig', jobs.filter((j) => j.finalDone).length);
        put('namen', jobs.slice(0, 5).map((j) => j.name));
      } else {
        const listed = count(/"finalDone"\s*:\s*(?:true|false)/g, r.text);
        put('jobs', atLeast(listed, true));
        put('offen', atLeast(count(/"finalDone"\s*:\s*false/g, r.text), true));
        put('namen', [...r.text.matchAll(/"name"\s*:\s*"([^"]+)"/g)].slice(0, 5).map((m) => m[1]));
        put('hinweis', 'Liste gekürzt, Zahlen sind Untergrenzen');
      }
      break;
    }
    case 'job_status': {
      put('job', o?.name ?? str('name'));
      const done = o ? o.finalDone : r.text.match(/"finalDone"\s*:\s*(true|false)/)?.[1] === 'true';
      if (o || /"finalDone"/.test(r.text)) put('abgeschlossen', done ? 'ja' : 'nein');
      put('host', o?.host ?? str('host'));
      break;
    }
    case 'decisions_recent': {
      put('heute', o?.entriesToday ?? num('entriesToday'));
      put('gezeigt', o?.shown ?? num('shown'));
      const since = o?.since ?? str('since');
      if (since !== new Date().toISOString().slice(0, 10)) put('seit', since);
      put('themen', (o?.entries ?? []).slice(0, 4).map((e) => clip(e.heading?.replace(/^#+\s*/, ''), 48)));
      break;
    }
    case 'read_file':
      put('datei', basename(h.path ?? str('path')));
      put('zeilen', h.lines ?? num('lines'));
      put('gesamtZeilen', h.totalLines ?? num('totalLines'));
      if ((h.offset ?? 0) > 0) put('abZeile', h.offset);
      break;
    case 'read_core_doc':
      put('dokument', h.name ?? str('name'));
      if (h.size ?? num('size')) put('kb', Math.round((h.size ?? num('size')) / 1024));
      break;
    case 'search_files': case 'search_chats': case 'chats_search': {
      const hits = o?.hits;
      put('treffer', Array.isArray(hits) ? hits.length : atLeast(count(/"text"\s*:/g, r.text), true));
      const first = Array.isArray(hits) ? hits[0] : null;
      put('ersterTreffer', basename(first?.path ?? first?.session ?? str('path') ?? ''));
      break;
    }
    case 'board_threads': case 'board_read': case 'board_search': {
      const n = h.entries ?? count(/^#\d+ /gm, r.body || r.text);
      put(name === 'board_threads' ? 'threads' : 'einträge', atLeast(n, r.cut || h.truncated === true));
      break;
    }
    case 'claude_task':
      put('session', o?.sid ?? str('sid'));
      if (o?.sent) put('gesendet', 'ja');
      break;
    case 'claude_status':
      if (Array.isArray(o?.sessions)) {
        put('sessions', o.sessions.length);
        put('laufend', o.sessions.filter((s) => s.state === 'running').length);
      } else put('zustand', o?.state ?? str('state'));
      break;
    case 'explainer_point':
      put('titel', o?.title ?? str('title'));
      break;
    default:
      put('titel', str('title') ?? str('name'));
  }
  return facts;
}

/** What a call is about, from its arguments (file name, job, thread, query). */
function target(args) {
  if (!args || typeof args !== 'object') return '';
  const v = args.path ? basename(args.path) : args.thread ? `#${String(args.thread).replace(/^#/, '')}` : args.name ?? args.query ?? args.filter ?? args.pointId ?? args.sessionId ?? args.prompt;
  return typeof v === 'string' || typeof v === 'number' ? clip(v, 60) : '';
}

/** One entry per tool call id; the latest status wins and facts are read once the call has finished. */
export function createToolLedger() {
  const calls = new Map();
  return {
    note(evt) {
      if (evt?.type !== 'tool' || !evt.name) return false;
      const id = String(evt.id ?? `${evt.name}:${calls.size}`);
      const prev = calls.get(id);
      const call = {
        id, name: evt.name,
        target: target(evt.args) || prev?.target || '',
        status: evt.status === 'error' ? 'error' : evt.status === 'done' ? 'done' : 'start',
        ms: Number.isFinite(evt.ms) ? Math.round(evt.ms) : prev?.ms,
        facts: prev?.facts ?? {},
      };
      if (call.status === 'done') call.facts = toolFacts(evt.name, evt.content ?? evt.summary, evt.args);
      if (call.status === 'error') call.facts = { fehler: clip(String(evt.summary ?? '').replace(/^ERROR:\s*/, ''), 120) };
      calls.delete(id); // re-insert so the newest activity is last
      calls.set(id, call);
      while (calls.size > LEDGER_MAX) calls.delete(calls.keys().next().value);
      return true;
    },
    /** Model input: [{tool, was, ziel?, status, ms?, fakten?}] in call order. */
    entries() {
      return [...calls.values()].map((c) => {
        const e = { tool: c.name, was: TOOL_WORD[c.name] ?? c.name, status: STATUS_WORD[c.status] };
        if (c.target) e.ziel = c.target;
        if (c.ms !== undefined && c.status !== 'start') e.ms = c.ms;
        if (Object.keys(c.facts).length) e.fakten = c.facts;
        return e;
      });
    },
    calls: () => [...calls.values()],
  };
}

// ---- post-validation --------------------------------------------------------------------------------------------

// Words that say "still running / not yet done". Only applied to things that refer to a FINISHED tool.
const RUNNING = /\b(läuft|laufen|laufend|lädt|running|pending|wartet|ausstehend|offen|in arbeit|noch nicht|unterwegs)\b/i;
// "läuft"/"offen" next to a job or Claude session describes the job, not the call; only a failed call is corrected there.
const SUBJECT_STATE = /^(job_status|claude_task|claude_status)$/;
const stale = (call, s) => (call.status === 'error' || !SUBJECT_STATE.test(call.name)) && RUNNING.test(s ?? '');
// A caption that narrates a query/tool still being in progress.
const STALE_CAPTION = /\b(abfrage|anfrage|suche|tool|werkzeug|aufruf|ladevorgang)\w*\b[^.!?]{0,40}\b(läuft|laufen|lädt|dauert|noch)\b|\bwird (gerade |noch )?(geladen|abgefragt|gesucht|gelesen|geprüft)\b|\b(schaue|prüfe|suche|lese|frage)\b[^.!?]{0,20}\b(gerade|noch|kurz)\b/i;

// A standalone number: not part of a name/slug ("reax2", "job-01-20261024" carry no count).
// After the answer, nobody is still checking: "prüft jetzt", "sucht gerade", "liest noch" narrate a finished turn.
// Present tense of the desk's own work verbs counts too ("liest #27, um … zu prüfen", "STATE.md wird gelesen").
const PROGRESS = /\b(prüft|sucht|liest|lädt|schaut|durchsucht|ruft|filtert|sammelt|wertet)\b|\bwird (gerade |noch |jetzt )?(gelesen|geladen|geprüft|gesucht|abgefragt|durchsucht)\b|\bum\b[^.!?]{0,40}\bzu (prüfen|finden|klären|lesen)\b|\b(fehlt|fehlen) (nur )?noch\b|\bantwort (folgt|steht aus|kommt)\b/i;

const NUM = /(?<![\p{L}\d_\-/.])\d+(?:[.,]\d+)?(?![\p{L}\d_\-])/gu;
const DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/g;
const norm = (n) => n.replace(',', '.').replace(/^0+(?=\d)/, '');
const GERMAN_DATE = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})?/g;
/** Standalone number tokens in a text ("0,6 s" → "0.6"); with `dates`, also the parts of ISO dates/times. */
export function numbersIn(s, isoDates = false) {
  const dates = [...String(s ?? '').matchAll(GERMAN_DATE)];
  const t = String(s ?? '').replace(GERMAN_DATE, ' ');
  const out = new Set((t.match(NUM) ?? []).map(norm));
  for (const m of dates) m.slice(1).forEach((p) => p && out.add(norm(p)));
  if (isoDates) for (const m of t.matchAll(DATE)) m.slice(1).forEach((p) => p && out.add(norm(p)));
  return out;
}
const inventsAny = (s, allowed) => [...numbersIn(s)].some((n) => !allowed.has(n));

function refersTo(node, call) {
  const hay = `${node.id} ${node.label}`.toLowerCase();
  if (hay.includes(call.name) || hay.includes(call.name.replace(/_/g, '-')) || hay.includes((TOOL_WORD[call.name] ?? '\0').toLowerCase())) return true;
  if (TOPIC[call.name]?.test(node.label)) return true;
  // A misheard job/thread name of a FAILED call must not look alive ("Rags to Next St… läuft" after "bad job name").
  if (call.status === 'error' && call.target && hay.includes(call.target.toLowerCase().slice(0, 12))) return true;
  return false;
}

/**
 * Makes a validated spec agree with the tool ledger and the input text. Returns the fixed spec and a list of what was
 * changed (for logs/tests). `source` = every text the model saw except the previous spec; `numbers: false` checks
 * only the tool state (for re-checking a spec that is already on screen when a tool finishes). `answered` = the agent's
 * answer is in and no Claude Code work is in the window: then nothing of the desk is still "in progress".
 */
export function guardSpec(spec, { calls = [], source = '', numbers = true, answered = false } = {}) {
  if (!spec) return { spec, fixes: [] };
  const fixes = [];
  const allowed = numbersIn(source, true);
  const invents = (s, set) => numbers && inventsAny(s, set);
  const finished = calls.filter((c) => c.status !== 'start');
  const running = calls.some((c) => c.status === 'start');
  const settled = answered && !running;

  const nodes = [];
  for (const n0 of spec.nodes) {
    const n = { ...n0 };
    const call = [...finished].reverse().find((c) => refersTo(n, c));
    if (call && (stale(call, n.value) || (!n.value && stale(call, n.label)))) {
      n.label = n.label.replace(RUNNING, '').replace(/\s{2,}/g, ' ').replace(/(?<![\s·:–-])[\s·:–-]+$/, '').trim() || n.label;
      n.value = STATUS_WORD[call.status];
      n.tone = call.status === 'error' ? 'red' : 'moss';
      fixes.push(`state:${n.id}`);
    } else if (call && n.kind === 'tool' && n.tone === 'amber') {
      n.tone = call.status === 'error' ? 'red' : 'moss';
      fixes.push(`tone:${n.id}`);
    }
    if (settled && n.value && PROGRESS.test(n.value)) { delete n.value; fixes.push(`progress:${n.id}`); }
    if (invents(n.label, allowed)) { fixes.push(`number-label:${n.id}`); continue; }
    if (n.value && invents(n.value, allowed)) { delete n.value; fixes.push(`number-value:${n.id}`); }
    if (n.kind === 'number' && !n.value) continue;
    nodes.push(n);
  }
  if (!nodes.length) return { spec: null, fixes: [...fixes, 'empty'] };
  const ids = new Set(nodes.map((n) => n.id));
  const edges = spec.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => {
    if (!e.label || !invents(e.label, allowed)) return e;
    fixes.push(`number-edge:${e.from}>${e.to}`);
    const { label, ...rest } = e;
    return rest;
  });
  const out = { ...spec, nodes, edges };
  if (invents(out.title, allowed)) { out.title = nodes[0].label; fixes.push('number-title'); }
  if (out.caption && (invents(out.caption, allowed) || (!running && finished.length && STALE_CAPTION.test(out.caption)) || (settled && PROGRESS.test(out.caption)))) {
    delete out.caption;
    fixes.push('caption');
  }
  if (out.focus && !ids.has(out.focus)) delete out.focus;
  if (out.steps) {
    out.steps = out.steps.filter((s) => !invents(s.label, allowed)).map((s) => {
      const call = finished.find((c) => refersTo({ id: '', label: s.label }, c));
      return (call || (settled && s.state === 'active')) && s.state !== 'done' ? { ...s, state: 'done' } : s;
    });
    if (out.steps.some((s, i) => s.state !== spec.steps[i]?.state)) fixes.push('steps');
    if (!out.steps.some((s) => s.state !== 'todo')) delete out.steps;
  }
  return { spec: out, fixes };
}
