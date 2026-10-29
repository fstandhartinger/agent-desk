// Keeps the Live Canvas honest between model updates: tool events reach the browser instantly, the next VizSpec ~1–2 s
// later. A node about a tool that has finished in the meantime is shown finished at once (läuft → fertig, moss tick).
// Mirrors the gateway's guard (gateway/src/vizFacts.js) for the part that only needs the tool events.
import type { VizNode, VizSpec } from '../lib/types';
import { toolLabel } from './describe';

export interface ToolActivity { name: string; status: string }
export type ToolState = 'start' | 'done' | 'error';

const RUNNING = /\b(läuft|laufen|laufend|lädt|running|pending|wartet|ausstehend|offen|in arbeit|noch nicht|unterwegs)\b/i;
// "läuft"/"offen" next to a job or Claude session describes the job, not the call.
const SUBJECT_STATE = /^(job_status|claude_task|claude_status)$/;

/** Latest status per tool name (the last event of that name wins). */
export function latestByTool(activity: ToolActivity[] = []): Map<string, ToolState> {
  const out = new Map<string, ToolState>();
  for (const a of activity) out.set(a.name, a.status === 'error' ? 'error' : a.status === 'done' ? 'done' : 'start');
  return out;
}

/**
 * The tool a node is about: its id or label names the tool ("list_jobs", "list-jobs") or its German label ("Jobliste").
 * With `strict` the German label only counts on a node of kind "tool" ("Entscheidungen heute" is the result, not the call).
 */
export function toolOfNode(node: Pick<VizNode, 'id' | 'label'> & { kind?: VizNode['kind'] }, tools: Iterable<string>, strict = false): string | undefined {
  const hay = `${node.id} ${node.label}`.toLowerCase();
  for (const name of tools) {
    if (hay.includes(name) || hay.includes(name.replace(/_/g, '-'))) return name;
    if ((!strict || node.kind === 'tool') && hay.includes(toolLabel(name).toLowerCase())) return name;
  }
  return undefined;
}

/** Tool state to draw on each node (spinner, moss tick, red cross); only nodes that are about a tool get one. */
export function nodeToolStates(spec: VizSpec | null, activity: ToolActivity[] = []): Map<string, ToolState> {
  const out = new Map<string, ToolState>();
  if (!spec) return out;
  const latest = latestByTool(activity);
  for (const n of spec.nodes) {
    const name = toolOfNode(n, latest.keys(), true);
    // The gateway sets fertig/Fehler per call; it beats the latest call of the same name (a retry after an error).
    if ((name || n.kind === 'tool') && n.value === 'Fehler') out.set(n.id, 'error');
    else if ((name || n.kind === 'tool') && n.value === 'fertig') out.set(n.id, 'done');
    else if (name) out.set(n.id, latest.get(name)!);
  }
  return out;
}

/** The spec with finished tools no longer shown as running. Returns the same object when nothing changes. */
export function reconcileSpec(spec: VizSpec | null, activity: ToolActivity[] = []): VizSpec | null {
  if (!spec) return spec;
  const latest = latestByTool(activity);
  let changed = false;
  const nodes = spec.nodes.map((n) => {
    const name = toolOfNode(n, latest.keys());
    const state = name && latest.get(name);
    if (!name || !state || state === 'start' || !n.value || !RUNNING.test(n.value)) return n;
    if (state !== 'error' && SUBJECT_STATE.test(name)) return n;
    changed = true;
    return { ...n, value: state === 'error' ? 'Fehler' : 'fertig', tone: state === 'error' ? 'red' as const : 'moss' as const };
  });
  return changed ? { ...spec, nodes } : spec;
}
