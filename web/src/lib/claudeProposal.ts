import { patchClaudeProposal } from './conversation';
import { discardOnServer, errorFrom, errorMessage } from './api';

const inFlight = new Set<string>();

/** Opens a Claude session in the Live panel (same event as the history list). */
const openSession = (sid: string) => window.dispatchEvent(new CustomEvent('desk:open-claude-session', { detail: sid }));

/**
 * Florian's click on "Claude starten" / "An Sitzung senden": the only place a `claude_task` proposal acts. The gateway
 * looks the proposal up by id (one-time) and starts / sends exactly its stored text; nothing the model wrote reaches
 * Claude without this click.
 */
export async function submitClaudeProposal(proposalId: string): Promise<void> {
  if (inFlight.has(proposalId)) return;
  inFlight.add(proposalId);
  patchClaudeProposal(proposalId, { state: 'sending', error: undefined });
  try {
    const res = await fetch('/api/claude/proposal', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: proposalId }),
    });
    if (!res.ok) {
      const err = await errorFrom(res);
      throw res.status === 404 ? new Error('Dieser Vorschlag ist abgelaufen oder schon benutzt – bitte den Desk noch einmal darum bitten.') : err;
    }
    const body = (await res.json().catch(() => ({}))) as { sid?: unknown };
    const sid = typeof body.sid === 'string' ? body.sid : undefined;
    patchClaudeProposal(proposalId, { state: 'done', startedSid: sid });
    if (sid) openSession(sid);
  } catch (e) {
    patchClaudeProposal(proposalId, { state: 'error', error: errorMessage(e) });
  } finally {
    inFlight.delete(proposalId);
  }
}

/** "Verwerfen": settles the card at once and removes the proposal on the gateway too (critic r2 P2-3), so no other tab can click it. */
export async function discardClaudeProposal(proposalId: string): Promise<void> {
  patchClaudeProposal(proposalId, { state: 'discarded' });
  await discardOnServer('/api/claude/proposal/discard', proposalId);
}
