import { patchHandoff, textOf, type Msg } from './conversation';
import { discardOnServer, errorFrom, errorMessage } from './api';
import { fmtTime } from './format';
import type { PageContext } from './types';

export interface ClaudeDraft { title: string; prompt: string; chatContext?: string }

const MAX_TURNS = 12;

/** Plain transcript of the last turns up to `uptoId` (inclusive), cut from the oldest end to `maxChars`. */
export function chatTranscript(messages: Msg[], uptoId?: string, maxChars = 6000): string {
  const end = uptoId ? messages.findIndex((m) => m.id === uptoId) + 1 : messages.length;
  const lines = messages
    .slice(0, end > 0 ? end : messages.length)
    .filter((m) => m.status !== 'error' && textOf(m).trim())
    .slice(-MAX_TURNS)
    .map((m) => `${m.role === 'user' ? 'Florian' : 'Desk'}: ${textOf(m).trim()}`);
  let out = lines.join('\n\n');
  while (out.length > maxChars && lines.length > 1) out = (lines.shift(), lines.join('\n\n'));
  return out.length > maxChars ? `…${out.slice(-(maxChars - 1))}` : out;
}

const quote = (s: string, n: number) => {
  const t = s.trim();
  return (t.length > n ? `${t.slice(0, n - 1)}…` : t).replace(/^/gm, '> ');
};

/** Prefilled Claude Code task that continues from one assistant answer, with the chat as context. */
export function handoffDraft(messages: Msg[], answerId: string, page?: PageContext): ClaudeDraft {
  const i = messages.findIndex((m) => m.id === answerId);
  const answer = messages[i];
  const question = [...messages.slice(0, Math.max(0, i))].reverse().find((m) => m.role === 'user');
  const q = question ? textOf(question).replace(/\s+/g, ' ').trim() : '';
  const lines: string[] = [];
  if (page) lines.push(`Kontext: Erklärseite „${page.title || page.slug}“ (${page.slug}) bei ${fmtTime(page.t)}${page.point ? `, Punkt „${page.point.title}“` : ''}.`);
  if (q) lines.push(`Frage im Desk-Chat: „${q.length > 300 ? `${q.slice(0, 299)}…` : q}“`);
  if (answer) lines.push(`Antwort des Desks, an die du anknüpfst:\n${quote(textOf(answer), 1500)}`);
  lines.push('Der Chatverlauf liegt bei. Prüfe die Aussagen an den echten Dateien, bevor du handelst.');
  return {
    title: q ? `Weiter: ${q.length > 50 ? `${q.slice(0, 49)}…` : q}` : 'Aus dem Desk-Chat',
    prompt: `${lines.join('\n\n')}\n\nAufgabe: `,
    chatContext: chatTranscript(messages, answerId),
  };
}

/** Opens the Claude task form (Live panel) with a draft. */
export function requestClaudeTask(draft?: ClaudeDraft) {
  window.dispatchEvent(new CustomEvent('desk:new-claude-task', { detail: draft }));
}

/** Entry id from the gateway answer ({entryId} or {id}); undefined when it sent none. */
export function entryIdOf(body: unknown): string | number | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const v = b.entryId ?? b.entry_id ?? b.boardId ?? b.id;
  return typeof v === 'number' || (typeof v === 'string' && v.trim()) ? (v as string | number) : undefined;
}

/** "Übergeben (Board #123)" – or plain "Übergeben" when no id came back. */
export const handedOverLabel = (entryId?: string | number) => (entryId != null ? `Übergeben (Board #${String(entryId).replace(/^#/, '')})` : 'Übergeben');

/** Where a handoff landed when it did not go to its own board thread (a#41d6d2, 14 Nov: the handoff thread was archived). */
export interface HandoffWhere { fallback: boolean; thread?: string; threadId?: number; intendedThreadId?: number }

// The card keeps the gateway's verdict next to its state: `retry` (may Florian click again?) and `where` (fallback thread).
declare module './conversation' {
  interface HandoffCard { retry?: boolean; where?: HandoffWhere }
}

/** "im Thema #15 (Ops & security) statt #31 gepostet" for a fallback post, else undefined. */
export function fallbackNote(where?: HandoffWhere): string | undefined {
  if (!where?.fallback) return undefined;
  const to = where.threadId != null ? `im Thema #${where.threadId}${where.thread ? ` (${where.thread})` : ''}` : where.thread ? `im Thema „${where.thread}“` : 'in einem anderen Thema';
  return `${to}${where.intendedThreadId != null ? ` statt #${where.intendedThreadId}` : ' statt im Übergabe-Thema'} gepostet`;
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : undefined);

/** The fallback info out of the gateway answer ({fallback, thread, threadId, intendedThreadId}); undefined for a normal post. */
export function whereOf(body: unknown): HandoffWhere | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  return b.fallback === true ? { fallback: true, thread: str(b.thread, 80), threadId: int(b.threadId), intendedThreadId: int(b.intendedThreadId) } : undefined;
}

const LEGACY_GONE = 'Dieser Vorschlag ist abgelaufen – bitte den Desk noch einmal darum bitten.';
const inFlight = new Set<string>();

/** Florian's click on "An Agenten übergeben": the only place that posts. A proposal is sent at most once. */
export async function submitHandoff(proposalId: string): Promise<void> {
  if (inFlight.has(proposalId)) return;
  inFlight.add(proposalId);
  patchHandoff(proposalId, { state: 'sending', error: undefined });
  try {
    const res = await fetch('/api/handoff', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: proposalId }),
    });
    if (!res.ok) {
      // a#41d6d2: show the gateway's own reason (it says what happened and what to do next) and honour its `retry` flag
      const raw = await res.clone().json().catch(() => ({})) as Record<string, unknown>;
      const err = await errorFrom(res);
      const gone = res.status === 404 || res.status === 410;
      const said = typeof raw?.error === 'string' && raw.error.trim() !== '';
      patchHandoff(proposalId, { state: 'error', error: gone && !said ? LEGACY_GONE : errorMessage(err), retry: typeof raw?.retry === 'boolean' ? raw.retry : !gone });
      return;
    }
    const body = await res.json().catch(() => ({}));
    patchHandoff(proposalId, { state: 'done', entryId: entryIdOf(body), where: whereOf(body), error: undefined, retry: undefined });
  } catch (e) {
    // the request may or may not have arrived: another click is safe, the gateway answers "schon angekommen" / "unklar" truthfully
    patchHandoff(proposalId, { state: 'error', error: errorMessage(e), retry: true });
  } finally {
    inFlight.delete(proposalId);
  }
}

/** "Verwerfen": settles the card at once and removes the proposal on the gateway too (critic r2 P2-3). */
export async function discardHandoff(proposalId: string): Promise<void> {
  patchHandoff(proposalId, { state: 'discarded' });
  await discardOnServer('/api/handoff/discard', proposalId);
}
