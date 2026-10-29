import { useState } from 'react';
import { Bot, Check, ChevronDown, Loader2, X } from 'lucide-react';
import type { HandoffCard as Card } from '../../lib/conversation';
import { discardHandoff, handedOverLabel, submitHandoff } from '../../lib/handoff';

const LONG = 240;

/** Confirmation card for a `handoff_propose` call. Posts only on the button click, never by itself. */
export default function HandoffCard({ card }: { card: Card }) {
  const [open, setOpen] = useState(false);
  const long = card.task.length > LONG || card.task.includes('\n');
  const busy = card.state === 'sending';
  const settled = card.state === 'done' || card.state === 'discarded';
  return (
    <section aria-label="Übergabe an einen Agenten" data-testid="handoff-card" data-state={card.state}
      className={`my-3 animate-rise rounded-2xl border px-4 py-3.5 ${card.state === 'done' ? 'border-moss/30 bg-moss/[0.06]' : card.state === 'discarded' ? 'border-white/[0.06] bg-white/[0.02] opacity-70' : 'border-papaya/30 bg-papaya/[0.06]'}`}>
      <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-papaya">
        <Bot className="h-3.5 w-3.5" />
        {card.state === 'done' ? 'Übergeben' : card.state === 'discarded' ? 'Verworfen' : 'Auftrag an einen Agenten übergeben?'}
      </div>
      <h3 className="mt-1.5 text-[15px] font-semibold leading-snug text-fg">{card.title}</h3>
      {!(card.state === 'discarded') && (
        <>
          <p data-testid="handoff-task" className={`mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-fg-2 ${long && !open ? 'line-clamp-3' : ''}`}>{card.task}</p>
          {long && (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1 inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-dim hover:text-fg">
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} /> {open ? 'Weniger' : 'Ganzen Auftrag zeigen'}
            </button>
          )}
          {card.why && <p className="mt-1.5 text-[13px] leading-relaxed text-dim"><span className="font-medium text-fg-2">Warum: </span>{card.why}</p>}
        </>
      )}
      {card.state === 'error' && card.error && <p role="alert" className="mt-2 text-[13px] text-red-300">{card.error}</p>}
      {card.state === 'done' && <p role="status" className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-moss"><Check className="h-4 w-4" />{handedOverLabel(card.entryId)}</p>}
      {!settled && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={() => void submitHandoff(card.id)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-papaya px-4 text-[13px] font-semibold text-ink-900 transition-[filter,transform] hover:brightness-110 active:scale-[0.97] disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
            {card.state === 'error' ? 'Erneut übergeben' : 'An Agenten übergeben'}
          </button>
          <button type="button" disabled={busy} onClick={() => void discardHandoff(card.id)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-dim transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-60">
            <X className="h-4 w-4" /> Verwerfen
          </button>
        </div>
      )}
    </section>
  );
}
