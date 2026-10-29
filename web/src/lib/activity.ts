import { createStore } from './store';
import { uid } from './format';
import type { Tone, ToolEvent, VizSpec } from './types';

export type Source = 'chat' | 'voice' | 'claude' | 'explainer' | 'system';
export interface Activity { id: string; ts: number; source: Source; label: string; detail?: string; tone: Tone }

const MAX = 400;
export const activityStore = createStore<Activity[]>([]);

export function logActivity(source: Source, label: string, detail?: string, tone: Tone = 'neutral') {
  activityStore.set((a) => [...a, { id: uid('a_'), ts: Date.now(), source, label, detail, tone }].slice(-MAX));
}

// Live layer state shared by the Live Canvas and the activity rail.
export interface LiveState { spec: VizSpec | null; tools: ToolEvent[] }
export const liveStore = createStore<LiveState>({ spec: null, tools: [] });

export function noteTool(source: Source, t: ToolEvent) {
  liveStore.set((s) => {
    const i = s.tools.findIndex((x) => x.id === t.id);
    const tools = i < 0 ? [...s.tools, t] : s.tools.map((x, j) => (j === i ? { ...x, ...t } : x));
    return { ...s, tools: tools.slice(-30) };
  });
  if (t.status === 'start') logActivity(source, toolLabel(t.name), argSummary(t.args), 'violet');
  else logActivity(source, `${toolLabel(t.name)} ${t.status === 'error' ? 'fehlgeschlagen' : 'fertig'}`, t.summary, t.status === 'error' ? 'red' : 'moss');
}

export function noteViz(spec: VizSpec) {
  liveStore.set((s) => ({ ...s, spec }));
  logActivity('system', 'Live Canvas aktualisiert', spec.title, 'amber');
}

const TOOL_LABELS: Record<string, string> = {
  decisions_recent: 'Entscheidungen',
  read_core_doc: 'Kerndokument lesen',
  search_files: 'Dateien durchsuchen',
  read_file: 'Datei lesen',
  list_jobs: 'Jobs auflisten',
  job_status: 'Job-Status',
  board_threads: 'Board-Themen',
  board_read: 'Board lesen',
  board_entry: 'Board-Eintrag',
  board_search: 'Board durchsuchen',
  search_chats: 'Chats durchsuchen',
  chats_search: 'durchsucht Agenten-Chats',
  chat_read: 'liest Agenten-Chat',
  web_read: 'liest Webseite',
  discord_read: 'liest Discord',
  mail_search: 'liest Mails',
  mail_read: 'liest Mails',
  skills_list: 'sucht Skills',
  skill_read: 'liest Skill',
  run_readonly: 'prüft Status (nur lesen)',
  explainer_context: 'liest Hintergrunddokument',
  handoff_propose: 'schlägt Übergabe vor',
  explainer_point: 'Erklärpunkt',
  claude_task: 'Claude-Aufgabe',
  claude_status: 'Claude-Status',
};
export const toolLabel = (name: string) => TOOL_LABELS[name] || name.replace(/_/g, ' ');

export function argSummary(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const v = a.path ?? a.url ?? a.query ?? a.name ?? a.command ?? a.channel ?? a.title ?? a.thread ?? a.pointId ?? a.prompt ?? a.filter;
  return typeof v === 'string' ? v.slice(0, 120) : undefined;
}

const HOSTS: Record<string, string> = { sandy: 'Sandy', lechonk: 'LeChonk' };
/** "Sandy" / "LeChonk" for a tool event's bridge host; unknown or missing hosts show nothing. */
export const hostLabel = (host?: string) => (host ? HOSTS[host.toLowerCase()] : undefined);
