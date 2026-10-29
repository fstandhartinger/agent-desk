import { createStore } from './store';
import { load, save } from './storage';
import { uid } from './format';
import type { ClaudeProposalEvent, HandoffEvent, ToolEvent } from './types';

export type Via = 'text' | 'dictation' | 'voice' | 'typed';
export type HandoffState = 'pending' | 'sending' | 'done' | 'error' | 'discarded';
export interface HandoffCard extends Omit<HandoffEvent, 'type'> { state: HandoffState; entryId?: string | number; error?: string }
export type ClaudeCardState = 'pending' | 'sending' | 'done' | 'error' | 'discarded';
export interface ClaudeCard extends Omit<ClaudeProposalEvent, 'type'> { state: ClaudeCardState; startedSid?: string; error?: string }
export type Part = { kind: 'text'; text: string } | { kind: 'tool'; tool: ToolEvent } | { kind: 'handoff'; card: HandoffCard } | { kind: 'claude'; card: ClaudeCard };
export interface Msg {
  id: string;
  role: 'user' | 'assistant';
  via: Via;
  parts: Part[];
  ts: number;
  status: 'streaming' | 'done' | 'error' | 'stopped';
  error?: string;
  model?: string;
  costUsd?: number;
  /** Label of the explainer point / page the message was asked about. */
  context?: string;
  /** Transient progress line from the server ("Ich schaue kurz in die Jobs …") while nothing else streams. */
  statusText?: string;
}
export interface Conversation { id: string; messages: Msg[] }

export const textOf = (m: Msg) => m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');

export interface ConversationMeta { id: string; title: string; createdAt: number; updatedAt: number; count: number; preview: string }

// Every conversation lives under its own key; a small index keeps the list (chutes-chat style history).
const LEGACY_KEY = 'desk.conversation.v1';
const INDEX_KEY = 'desk.conversations.v2';
const convKey = (id: string) => `desk.conv.${id}`;
const MAX_MESSAGES = 200;
const MAX_CONVERSATIONS = 60;

const initial = (): Conversation => ({ id: uid('c_'), messages: [] });
// A reload interrupts any stream; never resurrect a spinner.
const settle = (c: Conversation): Conversation => ({
  ...c,
  messages: c.messages.map((m) => {
    const parts = m.parts.map((p) => ((p.kind === 'handoff' || p.kind === 'claude') && p.card.state === 'sending' ? { ...p, card: { ...p.card, state: 'pending' as const } } : p)) as Part[];
    return m.status === 'streaming' ? { ...m, parts, status: 'stopped' as const } : { ...m, parts };
  }),
});

function restore(): { current: Conversation; items: ConversationMeta[] } {
  const index = load<{ currentId: string | null; items: ConversationMeta[] } | null>(INDEX_KEY, null);
  if (index) {
    const current = (index.currentId && load<Conversation | null>(convKey(index.currentId), null)) || initial();
    return { current: settle(current), items: index.items ?? [] };
  }
  const legacy = load<Conversation | null>(LEGACY_KEY, null);
  if (!legacy?.messages?.length) return { current: initial(), items: [] };
  const current = settle(legacy);
  save(convKey(current.id), current);
  const items = [metaOf(current)];
  save(INDEX_KEY, { currentId: current.id, items });
  removeKey(LEGACY_KEY);
  return { current, items };
}

function removeKey(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Markdown reduced to readable text for one-line previews. */
const plainText = (md: string) => md.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/-{3,}/g, ' ');

export function metaOf(c: Conversation): ConversationMeta {
  const firstUser = c.messages.find((m) => m.role === 'user');
  const lastAnswer = [...c.messages].reverse().find((m) => m.role === 'assistant' && textOf(m).trim());
  return {
    id: c.id,
    title: oneLine(firstUser ? textOf(firstUser) : 'Neues Gespräch', 60) || 'Neues Gespräch',
    createdAt: c.messages[0]?.ts ?? Date.now(),
    updatedAt: c.messages[c.messages.length - 1]?.ts ?? Date.now(),
    count: c.messages.length,
    preview: lastAnswer ? oneLine(plainText(textOf(lastAnswer)), 140) : '',
  };
}

const restored = restore();
export const convStore = createStore<Conversation>(restored.current);
/** Past conversations, newest first. Empty conversations are never listed. */
export const libraryStore = createStore<ConversationMeta[]>(restored.items);

function persist() {
  const c = convStore.get();
  let items = libraryStore.get().filter((m) => m.id !== c.id);
  if (c.messages.length) {
    save(convKey(c.id), c);
    items = [metaOf(c), ...items];
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const dropped of items.slice(MAX_CONVERSATIONS)) removeKey(convKey(dropped.id));
  items = items.slice(0, MAX_CONVERSATIONS);
  libraryStore.set(items);
  save(INDEX_KEY, { currentId: c.messages.length ? c.id : null, items });
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
convStore.subscribe(() => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
});

/** Writes pending changes now (before switching conversations or in tests). */
export function flushConversation() {
  clearTimeout(saveTimer);
  persist();
}

/** Starts a fresh conversation; the current one stays in the history. */
export function newConversation() {
  flushConversation();
  if (convStore.get().messages.length) convStore.set(initial());
}

export function openConversation(id: string) {
  if (id === convStore.get().id) return;
  flushConversation();
  const c = load<Conversation | null>(convKey(id), null);
  if (c) convStore.set(settle(c));
  else libraryStore.set(libraryStore.get().filter((m) => m.id !== id));
}

export function deleteConversation(id: string) {
  removeKey(convKey(id));
  libraryStore.set(libraryStore.get().filter((m) => m.id !== id));
  if (id === convStore.get().id) convStore.set(initial());
  flushConversation();
}

/** Case-insensitive search over titles and full message text. */
export function searchConversations(query: string): ConversationMeta[] {
  const q = query.trim().toLowerCase();
  const items = libraryStore.get();
  if (!q) return items;
  return items.filter((m) => {
    if (m.title.toLowerCase().includes(q) || m.preview.toLowerCase().includes(q)) return true;
    const c = m.id === convStore.get().id ? convStore.get() : load<Conversation | null>(convKey(m.id), null);
    return Boolean(c?.messages.some((x) => textOf(x).toLowerCase().includes(q)));
  });
}

export type DayGroup = 'Heute' | 'Gestern' | 'Letzte 7 Tage' | 'Älter';
export function dayGroup(ts: number, now = Date.now()): DayGroup {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(now) - day(ts)) / 86_400_000);
  return diff <= 0 ? 'Heute' : diff === 1 ? 'Gestern' : diff < 7 ? 'Letzte 7 Tage' : 'Älter';
}

const patch = (id: string, fn: (m: Msg) => Msg) =>
  convStore.set((c) => ({ ...c, messages: c.messages.map((m) => (m.id === id ? fn(m) : m)) }));

export function addMessage(role: Msg['role'], via: Via, text = '', extra: Partial<Msg> = {}): string {
  const id = uid('m_');
  const msg: Msg = {
    id, role, via, ts: Date.now(),
    parts: text ? [{ kind: 'text', text }] : [],
    status: role === 'user' ? 'done' : 'streaming',
    ...extra,
  };
  convStore.set((c) => ({ ...c, messages: [...c.messages, msg].slice(-MAX_MESSAGES) }));
  return id;
}

export function appendText(id: string, text: string) {
  if (!text) return;
  patch(id, (m) => {
    const last = m.parts[m.parts.length - 1];
    const parts = last?.kind === 'text'
      ? [...m.parts.slice(0, -1), { kind: 'text' as const, text: last.text + text }]
      : [...m.parts, { kind: 'text' as const, text }];
    return { ...m, parts, statusText: undefined };
  });
}

export const setStatusText = (id: string, statusText: string) => patch(id, (m) => ({ ...m, statusText: statusText || undefined }));

export function setText(id: string, text: string) {
  patch(id, (m) => ({ ...m, parts: [...m.parts.filter((p) => p.kind !== 'text'), { kind: 'text', text }] }));
}

/** Inserts a tool chip at the current stream position, or updates it in place when the id is known. */
export function upsertTool(id: string, tool: ToolEvent) {
  patch(id, (m) => {
    const i = m.parts.findIndex((p) => p.kind === 'tool' && p.tool.id === tool.id);
    if (i < 0) return { ...m, parts: [...m.parts, { kind: 'tool', tool }] };
    const prev = (m.parts[i] as { tool: ToolEvent }).tool;
    const parts = [...m.parts];
    parts[i] = { kind: 'tool', tool: { ...prev, ...tool, args: tool.args ?? prev.args } };
    return { ...m, parts };
  });
}

/** Adds the confirmation card of a `handoff_propose` call (once per proposal id). Never submits anything. */
export function upsertHandoff(id: string, ev: HandoffEvent) {
  patch(id, (m) => {
    if (m.parts.some((p) => p.kind === 'handoff' && p.card.id === ev.id)) return m;
    const { type: _t, ...rest } = ev;
    return { ...m, parts: [...m.parts, { kind: 'handoff', card: { ...rest, state: 'pending' } }] };
  });
}

/** Updates one proposal card wherever it sits in the current conversation. */
export function patchHandoff(proposalId: string, change: Partial<HandoffCard>) {
  convStore.set((c) => ({
    ...c,
    messages: c.messages.map((m) =>
      m.parts.some((p) => p.kind === 'handoff' && p.card.id === proposalId)
        ? { ...m, parts: m.parts.map((p) => (p.kind === 'handoff' && p.card.id === proposalId ? { ...p, card: { ...p.card, ...change } } : p)) }
        : m),
  }));
}

/** Adds the confirmation card of a `claude_task` proposal (once per proposal id). Never starts anything. */
export function upsertClaudeProposal(id: string, ev: ClaudeProposalEvent) {
  patch(id, (m) => {
    if (m.parts.some((p) => p.kind === 'claude' && p.card.id === ev.id)) return m;
    const { type: _t, ...rest } = ev;
    return { ...m, parts: [...m.parts, { kind: 'claude', card: { ...rest, state: 'pending' } }] };
  });
}

/** Updates one Claude proposal card wherever it sits in the current conversation. */
export function patchClaudeProposal(proposalId: string, change: Partial<ClaudeCard>) {
  convStore.set((c) => ({
    ...c,
    messages: c.messages.map((m) =>
      m.parts.some((p) => p.kind === 'claude' && p.card.id === proposalId)
        ? { ...m, parts: m.parts.map((p) => (p.kind === 'claude' && p.card.id === proposalId ? { ...p, card: { ...p.card, ...change } } : p)) }
        : m),
  }));
}

export function finish(id: string, extra: Partial<Msg> = {}) {
  const message = convStore.get().messages.find((m) => m.id === id);
  if (message?.role === 'assistant' && message.via === 'voice' && !message.parts.some((p) => p.kind !== 'text') && !/[\p{L}\p{N}\p{S}]/u.test(textOf(message))) {
    convStore.set((c) => ({ ...c, messages: c.messages.filter((m) => m.id !== id) }));
    return;
  }
  patch(id, (m) => ({ ...m, status: m.status === 'streaming' ? 'done' : m.status, statusText: undefined, ...extra }));
}

export const fail = (id: string, error: string) => patch(id, (m) => ({ ...m, status: 'error', error, statusText: undefined }));

/** Drops `id` and everything after it (used by retry). */
export function truncateFrom(id: string) {
  convStore.set((c) => {
    const i = c.messages.findIndex((m) => m.id === id);
    return i < 0 ? c : { ...c, messages: c.messages.slice(0, i) };
  });
}

/** History for /api/chat: plain role/content pairs, without failed or empty turns. */
export function history(): { role: 'user' | 'assistant'; content: string }[] {
  return convStore
    .get()
    .messages.filter((m) => m.status !== 'error' && textOf(m).trim())
    .slice(-40)
    .map((m) => ({ role: m.role, content: textOf(m) }));
}
