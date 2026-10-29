import type { ClaudeEvent } from './types';
import type { ClaudeState } from './claude';

// Folds the normalised Claude Code event stream into renderable blocks.
export type Block =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'text'; key: string; text: string; live: boolean }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; id: string; name: string; input?: string; path?: string; command?: string; result?: { ok: boolean; preview?: string } }
  | { kind: 'result'; key: string; durationMs?: number; costUsd?: number; turns?: number; stopped?: boolean }
  | { kind: 'error'; key: string; message: string };

export interface ClaudeView {
  blocks: Block[];
  state: ClaudeState | null;
  model?: string;
  account?: string;
  todos: { content: string; status: string }[];
  toolCount: number;
}

export function foldClaude(events: ClaudeEvent[]): ClaudeView {
  const blocks: Block[] = [];
  const tools = new Map<string, Extract<Block, { kind: 'tool' }>>();
  const view: ClaudeView = { blocks, state: null, todos: [], toolCount: 0 };
  let live: Extract<Block, { kind: 'text' }> | null = null;

  for (const e of events) {
    const key = `e${e.seq}`;
    switch (e.kind) {
      case 'status': {
        // A stopped turn still ends with the CLI's result event: it reads "Gestoppt", not "Runde fertig".
        const last = blocks[blocks.length - 1];
        if (e.state === 'stopped' && (view.state === 'running' || view.state === 'starting')) {
          if (last?.kind === 'result') last.stopped = true;
          else blocks.push({ kind: 'result', key, stopped: true });
        }
        view.state = e.state;
        view.model = e.model ?? view.model;
        view.account = e.account ?? view.account;
        break;
      }
      case 'user':
        live = null;
        blocks.push({ kind: 'user', key, text: e.text });
        break;
      case 'text_delta':
        if (!live) {
          live = { kind: 'text', key, text: '', live: true };
          blocks.push(live);
        }
        live.text += e.text;
        break;
      case 'text':
        if (live) {
          live.text = e.text;
          live.live = false;
          live = null;
        } else blocks.push({ kind: 'text', key, text: e.text, live: false });
        break;
      case 'thinking':
        blocks.push({ kind: 'thinking', key, text: e.text });
        break;
      case 'tool_use': {
        live = null;
        const b = { kind: 'tool' as const, key, id: e.id, name: e.name, input: e.input, path: e.path, command: e.command };
        tools.set(e.id, b);
        blocks.push(b);
        view.toolCount++;
        break;
      }
      case 'tool_result': {
        const b = tools.get(e.id);
        if (b) b.result = { ok: e.ok, preview: e.preview };
        break;
      }
      case 'todo':
        view.todos = e.items;
        break;
      case 'result':
        live = null;
        view.state = 'idle';
        blocks.push({ kind: 'result', key, durationMs: e.durationMs, costUsd: e.costUsd, turns: e.turns });
        break;
      case 'error':
        blocks.push({ kind: 'error', key, message: e.message });
        break;
    }
  }
  if (live && view.state !== 'running' && view.state !== 'starting') live.live = false;
  return view;
}
