import { Copy, X } from 'lucide-react';
import { dismissMainAgentPrompt, type MainPromptCard } from '../../lib/conversation';
import { copyText } from '../../lib/clipboard';

/**
 * A prompt for the main agent that could not be typed because no app was connected. The text is plain text (never HTML)
 * in a scroll box; it is copied only when Florian clicks the button.
 */
export default function MainAgentPromptCard({ card }: { card: MainPromptCard }) {
  if (card.state === 'dismissed') return null;
  return (
    <section aria-label="Für deinen Main Agent" data-testid="main-agent-prompt-card"
      className="my-3 animate-rise rounded-2xl border border-white/[0.1] bg-white/[0.03] px-4 py-3.5">
      <h3 className="text-[13px] font-semibold text-fg">Für deinen Main Agent (nicht eingetippt)</h3>
      <p data-testid="main-agent-prompt-text" tabIndex={0} aria-label="Prompt für den Main Agent"
        className="mt-1.5 max-h-[40vh] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-black/[0.12] px-2.5 py-2 text-[14px] leading-relaxed text-fg-2">{card.text}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void copyText(card.text)}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-violet px-4 text-[13px] font-semibold text-white transition-[filter,transform] hover:brightness-110 active:scale-[0.97]">
          <Copy className="h-4 w-4" /> Kopieren
        </button>
        <button type="button" onClick={() => dismissMainAgentPrompt(card.id)}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-dim transition-colors hover:bg-white/[0.06] hover:text-fg">
          <X className="h-4 w-4" /> Verwerfen
        </button>
      </div>
    </section>
  );
}
