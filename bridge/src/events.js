import { redact, redactDeep } from './redact.js';
import { CanvasStream, stripCanvasBlocks } from './canvas.js';

const PREVIEW_MAX = 600;
const INPUT_MAX = 300;

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
}

function shortInput(input) {
  let s;
  try { s = JSON.stringify(input ?? {}); } catch { s = ''; }
  return redact(s.length > INPUT_MAX ? `${s.slice(0, INPUT_MAX)}…` : s);
}

/**
 * Turns Claude Code `--output-format stream-json --include-partial-messages` lines into the desk events
 * (docs/SPEC.md, "Normalised events") without seq/ts. One instance per turn; `claudeSessionId` is captured
 * from the first line that carries it so the next turn can `--resume`.
 */
export class Normalizer {
  claudeSessionId = null;
  #announced = new Set(); // desk-canvas blocks already announced in this turn (streaming and complete message both see them)
  #canvas = new CanvasStream(this.#announced);

  /** End of the turn: whatever a half-streamed desk-canvas block still holds back. */
  flush() {
    return this.#canvas.flush().map((e) => redactDeep(e));
  }

  feed(obj) {
    if (!obj || typeof obj !== 'object') return [];
    if (obj.session_id && !this.claudeSessionId) this.claudeSessionId = obj.session_id;
    const events = this.#map(obj);
    if (obj.type === 'result') events.unshift(...this.#canvas.flush());
    return events.map((e) => redactDeep(e));
  }

  #map(obj) {
    switch (obj.type) {
      case 'stream_event': return this.#stream(obj.event);
      case 'assistant': return this.#blocks(obj.message?.content);
      case 'user': return this.#results(obj.message?.content);
      case 'result': return this.#result(obj);
      default: return [];
    }
  }

  #stream(ev) {
    if (ev?.type === 'content_block_stop' || ev?.type === 'message_stop') return this.#canvas.flush();
    const d = ev?.type === 'content_block_delta' ? ev.delta : null;
    return d?.type === 'text_delta' && d.text ? this.#canvas.push(d.text) : [];
  }

  #blocks(content) {
    if (!Array.isArray(content)) return [];
    const out = [];
    for (const b of content) {
      if (b.type === 'text' && b.text) {
        const { text, events } = stripCanvasBlocks(b.text, this.#announced);
        out.push(...events, { kind: 'text', text });
      }
      else if (b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', text: b.thinking });
      else if (b.type === 'tool_use') out.push(...this.#toolUse(b));
    }
    return out;
  }

  #toolUse(b) {
    const input = b.input ?? {};
    const ev = { kind: 'tool_use', id: b.id, name: b.name, input: shortInput(input) };
    const p = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof p === 'string') ev.path = p;
    if (b.name === 'Bash' && typeof input.command === 'string') ev.command = input.command.slice(0, 500);
    const out = [ev];
    if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
      out.push({ kind: 'todo', items: input.todos.map((t) => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending') })) });
    }
    return out;
  }

  #results(content) {
    if (!Array.isArray(content)) return [];
    return content.filter((b) => b.type === 'tool_result').map((b) => ({
      kind: 'tool_result',
      id: b.tool_use_id,
      ok: !b.is_error,
      preview: toolResultText(b.content).slice(0, PREVIEW_MAX),
    }));
  }

  #result(obj) {
    // Claude runs on the subscription (never a paid API): costUsd is the API-equivalent value, not money spent.
    const ev = { kind: 'result', durationMs: obj.duration_ms, turns: obj.num_turns, agentSteps: obj.num_turns, subscription: true };
    if (typeof obj.total_cost_usd === 'number') ev.costUsd = obj.total_cost_usd;
    const out = [ev];
    if (obj.is_error) out.push({ kind: 'error', message: String(obj.result ?? obj.subtype ?? 'claude reported an error').slice(0, 600) });
    return out;
  }
}
