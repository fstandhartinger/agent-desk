import { errorFrom, errorMessage } from './api';
import { readSSE, parseJSON } from './sse';
import { createStore } from './store';
import { addMessage, appendText, convStore, fail, finish, history, setStatusText, truncateFrom, upsertClaudeProposal, upsertHandoff, upsertTool, type Via } from './conversation';
import { currentContext, selectedPoint, pageStore } from './page';
import { logActivity, noteTool, noteViz } from './activity';
import { fmtUsd } from './format';
import { focusedCanvasId } from '../canvas/bus';
import type { ChatEvent } from './types';

export const chatState = createStore<{ streamingId: string | null }>({ streamingId: null });
let controller: AbortController | null = null;

function contextLabel(): string | undefined {
  const p = pageStore.get().attached ? selectedPoint() : null;
  return p?.title;
}

/** Sends a user turn (typed or dictated) and streams the assistant answer into the thread. */
export async function sendChat(text: string, via: Via = 'text') {
  if (chatState.get().streamingId) return;
  addMessage('user', via, text, { context: contextLabel() });
  logActivity('chat', via === 'dictation' ? 'Diktat gesendet' : 'Frage gesendet', text.slice(0, 120));
  await stream();
}

/** Re-runs the answer to the last user turn before `assistantId`. */
export async function retry(assistantId: string) {
  if (chatState.get().streamingId) return;
  truncateFrom(assistantId);
  await stream();
}

export function stopChat() {
  controller?.abort();
}

async function stream() {
  const id = addMessage('assistant', 'text');
  chatState.set({ streamingId: id });
  const ctrl = new AbortController();
  controller = ctrl;
  // The gateway keeps the stream open a moment after `done` for the Live Canvas; the composer is free from `done` on.
  const release = () => {
    if (controller === ctrl) controller = null;
    if (chatState.get().streamingId === id) chatState.set({ streamingId: null });
  };
  let answered = false;
  const started = performance.now();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        conversationId: convStore.get().id,
        messages: history(),
        page: currentContext(),
        focusedCanvasId: focusedCanvasId(), // "zeichne das" means the canvas on the stage (round 11)
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw await errorFrom(res);
    for await (const m of readSSE(res)) {
      const ev = parseJSON<ChatEvent>(m.data);
      if (!ev) continue;
      if (ev.type === 'delta') appendText(id, ev.text);
      else if (ev.type === 'status') setStatusText(id, ev.text);
      else if (ev.type === 'tool') {
        upsertTool(id, ev);
        if (ev.status !== 'start') setStatusText(id, '');
        noteTool('chat', ev);
      } else if (ev.type === 'handoff') {
        upsertHandoff(id, ev);
        logActivity('chat', 'Übergabe vorgeschlagen', ev.title, 'amber');
      } else if (ev.type === 'claude_proposal') {
        upsertClaudeProposal(id, ev);
        logActivity('chat', 'Claude-Auftrag vorgeschlagen', ev.title, 'violet');
      } else if (ev.type === 'viz') noteViz(ev.spec);
      else if (ev.type === 'done') {
        answered = true;
        finish(id, { model: ev.model, costUsd: ev.costUsd });
        release();
        const secs = ((performance.now() - started) / 1000).toFixed(1);
        logActivity('chat', 'Antwort fertig', [`${secs} s`, ev.costUsd ? fmtUsd(ev.costUsd) : ''].filter(Boolean).join(' · '), 'moss');
      } else if (ev.type === 'error') throw new Error(ev.message);
    }
    finish(id);
  } catch (e) {
    if (answered) return;
    if (ctrl.signal.aborted) {
      finish(id, { status: 'stopped' });
      logActivity('chat', 'Antwort gestoppt');
    } else {
      fail(id, errorMessage(e));
      logActivity('chat', 'Antwort fehlgeschlagen', errorMessage(e), 'red');
    }
  } finally {
    release();
  }
}
