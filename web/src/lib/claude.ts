import { api, errorFrom } from './api';
import { readSSE, parseJSON } from './sse';
import { createStore } from './store';
import { logActivity } from './activity';
import type { ClaudeEvent } from './types';

export type ClaudeState = 'starting' | 'running' | 'idle' | 'stopped' | 'error';
export interface ClaudeSession { sid: string; title: string; state: ClaudeState; model?: string; host?: string; createdAt?: number; updatedAt?: number }

export const runningCount = (list: ClaudeSession[]) => list.filter((s) => s.state === 'running' || s.state === 'starting').length;

export const sessionsStore = createStore<{ loaded: boolean; error: string | null; list: ClaudeSession[] }>({ loaded: false, error: null, list: [] });

const toMs = (v: unknown) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : typeof v === 'string' ? Date.parse(v) || undefined : undefined);

function normalizeSession(raw: any): ClaudeSession {
  return {
    sid: String(raw.sid ?? raw.id),
    title: String(raw.title || raw.prompt?.slice?.(0, 60) || raw.sid),
    state: (raw.state ?? raw.status ?? 'idle') as ClaudeState,
    model: raw.model,
    host: raw.host,
    createdAt: toMs(raw.createdAt ?? raw.created ?? raw.startedAt),
    updatedAt: toMs(raw.updatedAt ?? raw.lastEventAt ?? raw.updated),
  };
}

/** A session's own event stream is the freshest source for its state (header pill, badges, history). */
export function noteSessionState(sid: string, state: ClaudeState) {
  sessionsStore.set((s) => (s.list.some((x) => x.sid === sid && x.state !== state)
    ? { ...s, list: s.list.map((x) => (x.sid === sid ? { ...x, state, updatedAt: Date.now() } : x)) }
    : s));
}

export async function refreshSessions() {
  try {
    const raw = await api<any>('/api/claude/sessions');
    const list = (Array.isArray(raw) ? raw : raw?.sessions ?? []).map(normalizeSession);
    list.sort((a: ClaudeSession, b: ClaudeSession) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
    sessionsStore.set({ loaded: true, error: null, list });
  } catch (e) {
    sessionsStore.set((s) => ({ ...s, loaded: true, error: e instanceof Error ? e.message : String(e) }));
  }
}

export async function startSession(input: { title: string; prompt: string; model: 'opus' | 'sonnet'; page?: unknown; chatContext?: string }) {
  const { sid } = await api<{ sid: string }>('/api/claude/sessions', { method: 'POST', json: input });
  logActivity('claude', 'Claude-Sitzung gestartet', input.title, 'papaya');
  sessionsStore.set((s) => ({ ...s, list: [{ sid, title: input.title, state: 'starting', model: input.model, createdAt: Date.now() }, ...s.list] }));
  void refreshSessions();
  return sid;
}

export async function sendToSession(sid: string, text: string) {
  await api(`/api/claude/sessions/${sid}/messages`, { method: 'POST', json: { text } });
  logActivity('claude', 'Nachricht an Claude', text.slice(0, 120), 'papaya');
}

export async function stopSession(sid: string) {
  await api(`/api/claude/sessions/${sid}/stop`, { method: 'POST' });
  logActivity('claude', 'Claude-Sitzung gestoppt', sid, 'amber');
}

export type StreamState = 'connecting' | 'live' | 'reconnecting';

/**
 * Follows a session's SSE event stream. Reconnects with backoff and resumes from the last seen seq
 * (Last-Event-ID header + ?since= for proxies that drop custom headers).
 */
export function followSession(sid: string, onEvent: (e: ClaudeEvent) => void, onState: (s: StreamState) => void) {
  let lastSeq = -1;
  let stopped = false;
  let ctrl: AbortController | null = null;
  let delay = 1000;

  (async () => {
    while (!stopped) {
      ctrl = new AbortController();
      onState(lastSeq < 0 ? 'connecting' : 'reconnecting');
      try {
        const q = lastSeq >= 0 ? `?since=${lastSeq}` : '';
        const res = await fetch(`/api/claude/sessions/${sid}/events${q}`, {
          credentials: 'same-origin',
          headers: lastSeq >= 0 ? { 'Last-Event-ID': String(lastSeq), Accept: 'text/event-stream' } : { Accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const err = await errorFrom(res);
          if (res.status === 401 || res.status === 404) throw Object.assign(err, { fatal: true });
          throw err;
        }
        onState('live');
        delay = 1000;
        for await (const m of readSSE(res)) {
          const ev = parseJSON<ClaudeEvent>(m.data);
          if (!ev || typeof ev.seq !== 'number' || ev.seq <= lastSeq) continue;
          lastSeq = ev.seq;
          onEvent(ev);
        }
      } catch (e) {
        if (stopped || (e as { fatal?: boolean }).fatal) return;
      }
      if (stopped) return;
      onState('reconnecting');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 10000);
    }
  })();

  return () => {
    stopped = true;
    ctrl?.abort();
  };
}
