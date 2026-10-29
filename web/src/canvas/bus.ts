// Canvas bus client: one SSE stream (`GET /api/canvas/events`, cookie auth, reconnect with Last-Event-ID) plus the
// history (`GET /api/canvas`) on every (re)connect. State is a pure reducer, deduped by id + at, so the same event seen
// twice (replay after reconnect, history overlap) changes nothing.
import { createStore, type Store } from '../lib/store';
import { readSSE, parseJSON } from '../lib/sse';
import type { CanvasBusEvent, CanvasBy, CanvasKind, CanvasSpec } from './types';

export interface CanvasEntry {
  id: string;
  phase: 'pending' | 'ready' | 'error';
  /** Latest ready spec (kept while an update of the same id is pending or failed). */
  spec?: CanvasSpec;
  kind?: CanvasKind;
  title?: string;
  by: CanvasBy;
  provider?: string;
  at: number;
  message?: string;
}

export type Conn = 'idle' | 'connecting' | 'open' | 'retry' | 'stopped';

export interface CanvasState {
  entries: Record<string, CanvasEntry>;
  /** Ids, most recently changed first (max HISTORY). */
  order: string[];
  /** The canvas on screen. Follows new events unless the user picked one from history within FOLLOW_PAUSE_MS. */
  current: string | null;
  pinnedAt: number;
  seen: string[];
  lastEventId?: string;
  conn: Conn;
  attempt: number;
  /** Upgrades 28 Oct (§5): canvas ids whose detailed version is on screen (default: the simple view). */
  details?: Record<string, boolean>;
}

export const HISTORY = 20;
const SEEN_MAX = 300;
export const FOLLOW_PAUSE_MS = 20_000;

export const initialCanvasState = (): CanvasState => ({ entries: {}, order: [], current: null, pinnedAt: 0, seen: [], conn: 'idle', attempt: 0 });

export const toMs = (at: string | number | undefined): number => {
  if (typeof at === 'number') return at;
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : 0;
};

export function isCanvasEvent(x: unknown): x is CanvasBusEvent {
  const e = x as CanvasBusEvent;
  return !!e && typeof e === 'object' && e.type === 'canvas' && typeof e.id === 'string' && ['pending', 'ready', 'error', 'dropped'].includes(e.phase);
}

/** Applies one bus event. Duplicates (same id + at) and events older than what is shown for that id are ignored. */
export function applyEvent(s: CanvasState, ev: CanvasBusEvent, now = Date.now()): CanvasState {
  if (!isCanvasEvent(ev)) return s;
  if (ev.phase === 'dropped') return dropEntry(s, ev);
  if (ev.phase === 'ready' && (!ev.spec || typeof ev.spec !== 'object')) return s;
  const at = toMs(ev.at);
  const key = `${ev.id}|${ev.at}`;
  if (s.seen.includes(key)) return s;
  const prev = s.entries[ev.id];
  const seen = [...s.seen, key].slice(-SEEN_MAX);
  if (prev && at < prev.at) return { ...s, seen };
  const spec = ev.phase === 'ready' ? ev.spec : prev?.spec;
  const entry: CanvasEntry = {
    id: ev.id,
    phase: ev.phase,
    spec,
    kind: ev.spec?.kind ?? ev.kind ?? prev?.kind,
    title: ev.spec?.title ?? ev.title ?? prev?.title,
    by: ev.by ?? prev?.by ?? 'text',
    provider: ev.provider ?? (ev.by === prev?.by ? prev?.provider : undefined),
    at,
    message: ev.phase === 'error' ? ev.message || 'Zeichnung fehlgeschlagen' : undefined,
  };
  const order = [ev.id, ...s.order.filter((x) => x !== ev.id)];
  const dropped = order.slice(HISTORY);
  const entries = { ...s.entries, [ev.id]: entry };
  for (const d of dropped) delete entries[d];
  let details = s.details;
  if (details && (dropped.some((d) => details![d]) || (details[ev.id] && ev.phase === 'ready' && !ev.spec?.detail))) {
    details = { ...details };
    for (const d of dropped) delete details[d];
    if (ev.phase === 'ready' && !ev.spec?.detail) delete details[ev.id]; // an update without details shows the simple view
  }
  // `focus: false` (a late draw of an earlier turn / another topic): history only, never takes the stage - unless nothing is shown yet
  const lateDraw = (ev as CanvasBusEvent & { focus?: boolean }).focus === false;
  const follow = lateDraw ? !s.current : !s.pinnedAt || now - s.pinnedAt > FOLLOW_PAUSE_MS || s.current === ev.id || !s.current;
  return { ...s, seen, entries, order: order.slice(0, HISTORY), current: follow ? ev.id : s.current, pinnedAt: follow ? 0 : s.pinnedAt, ...(details ? { details } : {}) };
}

/** `dropped`: a run ended without a drawing. A new id disappears; an id that already has a spec shows that spec again. */
function dropEntry(s: CanvasState, ev: CanvasBusEvent): CanvasState {
  const prev = s.entries[ev.id];
  if (!prev) return s;
  if (prev.spec) return { ...s, entries: { ...s.entries, [ev.id]: { ...prev, phase: 'ready', message: undefined } } };
  const entries = { ...s.entries };
  delete entries[ev.id];
  const order = s.order.filter((x) => x !== ev.id);
  return { ...s, entries, order, current: s.current === ev.id ? order[0] ?? null : s.current };
}

/** Merges `GET /api/canvas` (newest first). Only fills ids the bus has not shown newer; never steals the screen. */
export function applyHistory(s: CanvasState, list: unknown[]): CanvasState {
  let next = s;
  const hadCurrent = s.current;
  const items = [...list].reverse(); // oldest first, so the newest ends up at the front of `order`
  for (const raw of items) {
    const r = raw as Partial<CanvasBusEvent> & Partial<CanvasSpec> & { spec?: CanvasSpec };
    const spec = (r.spec ?? (r.kind && r.id ? r : undefined)) as CanvasSpec | undefined;
    if (!spec?.id) continue;
    const at = (r.at as string | number | undefined) ?? (spec as { at?: string | number }).at ?? 0;
    const known = next.entries[spec.id];
    if (known && known.at >= toMs(at)) continue;
    const current = next.current;
    next = applyEvent(next, { type: 'canvas', phase: 'ready', id: spec.id, spec, by: (r.by as CanvasBy) ?? 'text', provider: r.provider as string | undefined, at }, 0);
    next = { ...next, current: current ?? next.current };
  }
  // Fresh page: show the newest canvas from the history.
  return hadCurrent ? next : { ...next, current: next.order[0] ?? null };
}

/** Switches one canvas between its simple and its detailed version (kept per id, also across history selections). */
export function toggleDetail(s: CanvasState, id: string): CanvasState {
  if (!s.entries[id]) return s;
  const details = { ...(s.details ?? {}) };
  if (details[id]) delete details[id]; else details[id] = true;
  return { ...s, details };
}

export function selectCanvas(s: CanvasState, id: string, now = Date.now()): CanvasState {
  return s.entries[id] ? { ...s, current: id, pinnedAt: s.order[0] === id ? 0 : now } : s;
}

/** Reconnect delay: 1 s, 2 s, 4 s … capped at 15 s, ±20 % jitter. */
export function backoff(attempt: number, rnd = Math.random): number {
  const base = Math.min(15_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * rnd()));
}

export interface BusDeps {
  fetch: typeof fetch;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  random?: () => number;
  /** Called once per event that changed the state (not for duplicates). */
  onEvent?: (ev: CanvasBusEvent) => void;
}

export interface CanvasBus {
  store: Store<CanvasState>;
  start(): void;
  stop(): void;
  select(id: string): void;
  /** Simple <-> detailed version of one canvas. */
  toggleDetail(id: string): void;
  /** Feeds an event from another stream (chat SSE / voice WS); the same dedupe applies. */
  push(ev: CanvasBusEvent): void;
}

export function createCanvasBus(deps: BusDeps, store: Store<CanvasState> = createStore(initialCanvasState())): CanvasBus {
  let ac: AbortController | null = null;
  let timer: unknown = null;
  let running = false;
  const set = (fn: (s: CanvasState) => CanvasState) => store.set(fn);

  async function loadHistory(signal: AbortSignal) {
    try {
      const res = await deps.fetch('/api/canvas', { credentials: 'same-origin', signal });
      if (!res.ok) return;
      const body = (await res.json()) as { canvases?: unknown[] };
      if (Array.isArray(body?.canvases)) set((s) => applyHistory(s, body.canvases!));
    } catch { /* history is best effort */ }
  }

  async function connect() {
    if (!running) return;
    ac = new AbortController();
    const signal = ac.signal;
    set((s) => ({ ...s, conn: 'connecting' }));
    const last = store.get().lastEventId;
    try {
      const res = await deps.fetch('/api/canvas/events', {
        credentials: 'same-origin',
        signal,
        headers: { Accept: 'text/event-stream', ...(last ? { 'Last-Event-ID': last } : {}) },
      });
      if (res.status === 401) {
        window.dispatchEvent(new Event('desk:unauthorized'));
        set((s) => ({ ...s, conn: 'stopped' }));
        running = false;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      set((s) => ({ ...s, conn: 'open', attempt: 0 }));
      void loadHistory(signal);
      for await (const msg of readSSE(res)) {
        const data = parseJSON<unknown>(msg.data);
        const before = store.get();
        set((s) => {
          const next = isCanvasEvent(data) ? applyEvent(s, data) : s;
          return msg.id && msg.id !== next.lastEventId ? { ...next, lastEventId: msg.id } : next;
        });
        if (isCanvasEvent(data) && store.get().entries !== before.entries) deps.onEvent?.(data);
      }
    } catch {
      if (signal.aborted && !running) return;
    }
    if (!running) return;
    const attempt = store.get().attempt;
    set((s) => ({ ...s, conn: 'retry', attempt: s.attempt + 1 }));
    timer = deps.setTimeout(() => { timer = null; void connect(); }, backoff(attempt, deps.random));
  }

  return {
    store,
    start() {
      if (running) return;
      running = true;
      void connect();
    },
    stop() {
      running = false;
      if (timer) deps.clearTimeout(timer);
      timer = null;
      ac?.abort();
      set((s) => ({ ...s, conn: 'stopped' }));
    },
    select(id) { set((s) => selectCanvas(s, id)); },
    toggleDetail(id) { set((s) => toggleDetail(s, id)); },
    push(ev) { set((s) => applyEvent(s, ev)); },
  };
}

let shared: CanvasBus | null = null;
/** The app-wide bus (browser deps). */
export function canvasBus(onEvent?: (ev: CanvasBusEvent) => void): CanvasBus {
  shared ??= createCanvasBus({
    fetch: (...a) => window.fetch(...a),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t as number),
    onEvent,
  });
  return shared;
}

/** Round 11: the id of the canvas the stage shows now (null = none); sent with every chat request and voice message. */
export function focusedCanvasId(): string | null {
  return shared?.store.get().current ?? null;
}

/** Calls `fn` whenever the canvas on the stage changes (voice tells the gateway); returns the unsubscribe function. */
export function watchFocusedCanvas(fn: (id: string | null) => void): () => void {
  if (!shared) return () => {};
  let last = focusedCanvasId();
  return shared.store.subscribe(() => {
    const id = focusedCanvasId();
    if (id !== last) { last = id; fn(id); }
  });
}
