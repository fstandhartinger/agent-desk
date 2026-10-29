import { Check, Loader2, Rocket, Send, X } from 'lucide-react';
import type { ClaudeCard } from '../../lib/conversation';
import { discardClaudeProposal, submitClaudeProposal } from '../../lib/claudeProposal';

/** "Mitgegeben: …" line: what the new session gets besides the prompt (critic r2 P2-2). */
export function contextLine(turns: number | undefined): string {
  if (!turns) return 'Mitgegeben: keine Chat-Nachrichten, nur dieser Auftrag';
  return turns === 1 ? 'Mitgegeben: die letzte Nachricht aus dem Chat' : `Mitgegeben: die letzten ${turns} Nachrichten aus dem Chat`;
}

/**
 * Confirmation card for a `claude_task` proposal. Starts / sends only on the button click, never by itself. The whole
 * prompt is always visible (scroll box, at most 40 % of the screen height), so nothing below a fold can hide an
 * instruction Florian did not read (critic r2 P2-2).
 */
export default function ClaudeProposalCard({ card }: { card: ClaudeCard }) {
  const busy = card.state === 'sending';
  const settled = card.state === 'done' || card.state === 'discarded';
  const toSession = Boolean(card.sessionId);
  const action = toSession ? 'An Sitzung senden' : 'Claude starten';
  return (
    <section aria-label="An Claude übergeben" data-testid="claude-proposal-card" data-state={card.state}
      className={`my-3 animate-rise rounded-2xl border px-4 py-3.5 ${card.state === 'done' ? 'border-moss/30 bg-moss/[0.06]' : card.state === 'discarded' ? 'border-white/[0.06] bg-white/[0.02] opacity-70' : 'border-violet/30 bg-violet/[0.06]'}`}>
      <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-violet-light">
        <Rocket className="h-3.5 w-3.5" />
        {card.state === 'done' ? (toSession ? 'An Sitzung gesendet' : 'Claude gestartet') : card.state === 'discarded' ? 'Verworfen' : 'An Claude übergeben?'}
      </div>
      <h3 className="mt-1.5 text-[15px] font-semibold leading-snug text-fg">{card.title}</h3>
      {(toSession || card.model) && card.state !== 'discarded' && (
        <p className="mt-0.5 text-[12px] text-dim">{[toSession ? `Sitzung ${card.sessionId}` : 'Neue Sitzung', card.model === 'opus' ? 'Opus' : card.model === 'sonnet' ? 'Sonnet' : ''].filter(Boolean).join(' · ')}</p>
      )}
      {card.state !== 'discarded' && (
        <>
          <p data-testid="claude-proposal-prompt" tabIndex={0} aria-label="Auftrag an Claude"
            className="mt-1.5 max-h-[40vh] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-black/[0.12] px-2.5 py-2 text-[14px] leading-relaxed text-fg-2">{card.prompt}</p>
          {!toSession && <p data-testid="claude-proposal-context" className="mt-1 text-[12px] text-dim">{contextLine(card.contextTurns)}</p>}
        </>
      )}
      {card.state === 'error' && card.error && <p role="alert" className="mt-2 text-[13px] text-red-300">{card.error}</p>}
      {card.state === 'done' && (
        <p role="status" className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-moss">
          <Check className="h-4 w-4" />{card.startedSid ? `${toSession ? 'Gesendet an' : 'Läuft als'} Sitzung ${card.startedSid}` : toSession ? 'Gesendet' : 'Gestartet'}
        </p>
      )}
      {!settled && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={() => void submitClaudeProposal(card.id)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-violet px-4 text-[13px] font-semibold text-white transition-[filter,transform] hover:brightness-110 active:scale-[0.97] disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : toSession ? <Send className="h-4 w-4" /> : <Rocket className="h-4 w-4" />}
            {card.state === 'error' ? 'Erneut versuchen' : action}
          </button>
          <button type="button" disabled={busy} onClick={() => void discardClaudeProposal(card.id)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-dim transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-60">
            <X className="h-4 w-4" /> Verwerfen
          </button>
        </div>
      )}
    </section>
  );
}
