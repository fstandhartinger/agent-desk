// Human one-liners for tool calls (ActivityRail). Tool results reach the browser only as `summary`: the first ~200
// characters of the tool's JSON, flattened and often cut mid-value. Raw JSON is never shown; we pull out the few fields
// a person cares about (job name, file name, thread number, hit count, short result) and fall back to the call target.

const TOOL_LABEL: Record<string, string> = {
  read_core_doc: 'Kerndokument', search_files: 'Dateisuche', read_file: 'Datei lesen', decisions_recent: 'Entscheidungen',
  list_jobs: 'Jobliste', job_status: 'Jobstatus',
  board_threads: 'Board-Threads', board_read: 'Board lesen', board_entry: 'Board-Eintrag', board_search: 'Board-Suche', search_chats: 'Chat-Suche',
  chats_search: 'Agenten-Chats', chat_read: 'Agenten-Chat', web_read: 'Webseite', discord_read: 'Discord', mail_search: 'Mails', mail_read: 'Mail',
  skills_list: 'Skills', skill_read: 'Skill', run_readonly: 'Status lesen', explainer_context: 'Hintergrunddokument', handoff_propose: 'Übergabe',
  explainer_point: 'Erklärpunkt', claude_task: 'Claude-Auftrag', claude_status: 'Claude-Status',
};
export const TOOL_NAMES = Object.keys(TOOL_LABEL);
/** German display name of a tool ("job_status" → "Jobstatus"); unknown tools keep their name. */
export const toolLabel = (name: string) => TOOL_LABEL[name] ?? name;

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** First string value of `key` in (possibly truncated) JSON text. */
function field(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return m?.[1].replace(/\\(.)/g, '$1');
}
const flag = (text: string, key: string) => text.match(new RegExp(`"${key}"\\s*:\\s*(true|false|-?\\d+)`))?.[1];
const looksJson = (text: string) => /^\s*[[{]/.test(text);

/** Every string value of `key`, in order. */
function fields(text: string, key: string): string[] {
  return [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g'))].map((m) => m[1]);
}

function kb(bytes: string | undefined): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`;
}

const quote = (q: string) => `„${q.length > 40 ? `${q.slice(0, 39)}…` : q}“`;
const join = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' · ');

/** What the call is about, from its arguments: file name, job name, `#thread`, „query“. */
export function callTarget(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');
  if (name === 'read_core_doc') return s('name') ? `${s('name')}.md` : '';
  if (s('path')) return basename(s('path'));
  if (name === 'board_entry' && s('id')) return `#${s('id').replace(/^#/, '')}`;
  if (name === 'board_read' && s('thread')) return `#${s('thread').replace(/^#/, '')}`;
  if (s('name')) return s('name');
  if (s('query')) return quote(s('query'));
  if (s('filter')) return `Filter ${quote(s('filter'))}`;
  if (s('pointId')) return s('pointId');
  if (s('sessionId')) return `Session ${s('sessionId')}`;
  if (s('prompt')) return quote(s('prompt'));
  return '';
}

/** Short human result of a finished call; '' when there is nothing better than the target. */
export function resultSummary(name: string, summary: string | undefined): string {
  const t = (summary ?? '').trim();
  if (!t) return '';
  if (!looksJson(t)) return t.length > 90 ? `${t.slice(0, 89)}…` : t;
  switch (name) {
    case 'read_core_doc': return join(field(t, 'name') && `${field(t, 'name')}.md`, kb(flag(t, 'size')));
    case 'read_file': {
      const path = field(t, 'path');
      const lines = flag(t, 'lines');
      return join(path && basename(path), lines && `${lines} Zeilen`);
    }
    case 'decisions_recent': {
      const n = flag(t, 'entriesToday');
      return n === undefined ? 'Entscheidungen geladen' : n === '0' ? 'heute keine' : `${n} heute`;
    }
    case 'list_jobs': {
      if (/"jobs"\s*:\s*\[\s*\]/.test(t)) return 'keine Jobs';
      const total = flag(t, 'total');
      if (total) return `${total} Jobs${flag(t, 'open') ? ` · ${flag(t, 'open')} offen` : ''}`;
      const names = fields(t, 'name');
      return names.length ? `${names.slice(0, 2).join(', ')}${names.length > 2 || t.endsWith('…') ? ' …' : ''}` : 'Jobliste geladen';
    }
    case 'job_status': {
      const done = flag(t, 'finalDone');
      return join(field(t, 'name'), done === 'true' ? 'fertig' : done === 'false' ? 'offen' : '');
    }
    case 'search_files': case 'board_search': case 'search_chats': {
      if (/"(hits|results)"\s*:\s*\[\s*\]/.test(t)) return 'keine Treffer';
      const first = field(t, 'path') ?? field(t, 'file') ?? field(t, 'title');
      return first ? `Treffer: ${basename(first)}` : 'Treffer gefunden';
    }
    case 'board_read': return 'Einträge gelesen';
    case 'board_threads': return 'Threads geladen';
    case 'claude_task': {
      const sid = field(t, 'sid');
      if (!sid) return 'Vorschlag angezeigt, wartet auf Klick'; // claude_task only proposes (critic round 1, P0-1)
      return flag(t, 'sent') === 'true' || flag(t, 'queued') ? `an ${sid} gesendet` : `Session ${sid} gestartet`;
    }
    case 'claude_status': {
      const state = field(t, 'state');
      if (state) return `Session ${state}`;
      const n = fields(t, 'sid').length;
      return n ? `${n}${t.endsWith('…') ? '+' : ''} Sessions` : 'keine Sessions';
    }
    case 'explainer_point': return field(t, 'title') ?? 'Erklärpunkt geladen';
    default: {
      const v = field(t, 'title') ?? field(t, 'name') ?? field(t, 'path');
      return v ? basename(v) : '';
    }
  }
}

/** The line shown under the tool label: target while running, result (or target) when done, message on error. */
export function callDetail(call: { name: string; status: 'start' | 'done' | 'error'; target: string; summary?: string }): string {
  if (call.status === 'start') return call.target || 'läuft …';
  if (call.status === 'error') {
    const msg = (call.summary ?? '').trim();
    return looksJson(msg) || !msg ? 'Fehler' : msg.length > 90 ? `${msg.slice(0, 89)}…` : msg;
  }
  return resultSummary(call.name, call.summary) || call.target || 'fertig';
}

/**
 * Detail line of an Activity-tab entry. Tool entries carry the raw result `summary`; `tool` is the call's tool name
 * when known. Never returns JSON: a JSON-looking detail is summarised or dropped.
 */
export function activityDetail(detail: string | undefined, tool?: string, status?: 'start' | 'done' | 'error'): string {
  const t = (detail ?? '').trim();
  if (!t) return '';
  if (tool && status && status !== 'start') return callDetail({ name: tool, status, target: '', summary: t });
  if (!looksJson(t)) return t;
  const v = field(t, 'title') ?? field(t, 'name') ?? field(t, 'path');
  return v ? basename(v) : '';
}

/**
 * Label and detail of an Activity-tab row. Tool calls are logged by lib/activity as "<label>" (start) and
 * "<label> fertig|fehlgeschlagen" with the raw result summary as detail; `logLabel` is that labeler. Tools it has no
 * German name for ("decisions recent") get the viz name; the detail never contains JSON.
 */
export function activityRow(a: { source: string; label: string; detail?: string }, logLabel: (tool: string) => string): { label: string; detail: string } {
  const m = a.label.match(/^(.*?)(?: (fertig|fehlgeschlagen))?$/)!;
  const tool = a.source === 'chat' || a.source === 'voice' ? TOOL_NAMES.find((n) => logLabel(n) === m[1]) : undefined;
  const label = tool && logLabel(tool) === tool.replace(/_/g, ' ') ? `${toolLabel(tool)}${m[2] ? ` ${m[2]}` : ''}` : a.label;
  const status = m[2] === 'fertig' ? 'done' : m[2] ? 'error' : undefined;
  return { label, detail: activityDetail(a.detail, status && tool, status) };
}
