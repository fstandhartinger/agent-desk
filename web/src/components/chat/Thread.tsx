import { ArrowDown, Bot, Lightbulb, MessagesSquare, Sparkles } from 'lucide-react';
import { useStore } from '../../lib/store';
import { convStore, type Msg } from '../../lib/conversation';
import { pageStore, type PageState } from '../../lib/page';
import { retry, sendChat } from '../../lib/chat';
import { currentContext } from '../../lib/page';
import { handoffDraft, requestClaudeTask } from '../../lib/handoff';
import { useAutoScroll } from '../ui/useAutoScroll';
import MessageView from './MessageView';

export default function Thread() {
  const { messages } = useStore(convStore);
  const last = messages[messages.length - 1];
  const scrollKey = `${messages.length}:${last?.status}:${last?.statusText ?? ''}:${last?.parts.length}:${last && last.parts[last.parts.length - 1]?.kind === 'text' ? (last.parts[last.parts.length - 1] as { text: string }).text.length : 0}`;
  const { ref, pinned, toBottom } = useAutoScroll<HTMLDivElement>(scrollKey);
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} className="scroll-y h-full [mask-image:linear-gradient(to_bottom,transparent,black_14px)]" role="log" aria-label="Unterhaltung" aria-live="polite">
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-4 pb-6 pt-5 lg:px-6">
            {messages.map((m: Msg) => (
              <MessageView
                key={m.id}
                m={m}
                streaming={m.status === 'streaming'}
                onRetry={m.role === 'assistant' && m.via === 'text' && m.id === lastAssistant?.id && m.status !== 'streaming' ? () => void retry(m.id) : undefined}
                onHandoff={m.role === 'assistant' ? () => requestClaudeTask(handoffDraft(convStore.get().messages, m.id, currentContext())) : undefined}
              />
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={toBottom}
        aria-label="Zum Ende springen"
        className={`absolute bottom-3 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-white/10 bg-ink-750/95 text-fg-2 shadow-lg backdrop-blur transition-all duration-200 hover:text-fg ${pinned ? 'pointer-events-none translate-y-2 opacity-0' : 'opacity-100'}`}
      >
        <ArrowDown className="h-4 w-4" />
      </button>
    </div>
  );
}

function suggestions(p: PageState): string[] {
  const x = p.explainer;
  const point = p.pointId && x?.points.points[p.pointId];
  if (point) return [`Erklär mir „${point.title}“ genauer.`, `Welche Quellen stützen „${point.title}“?`, 'Was bedeutet das konkret für die nächsten Schritte?'];
  if (x) {
    const scene = p.sceneId ? x.points.points[p.sceneId]?.title : null;
    const title = x.points.page.title || x.slug;
    return [
      `Fasse „${title}“ in drei Sätzen zusammen.`,
      scene ? `Was genau passiert in „${scene}“?` : 'Was ist die wichtigste Aussage?',
      'Wie ist der aktuelle Stand im Workshop dazu?',
    ];
  }
  return ['Welche Jobs laufen gerade?', 'Was steht heute im Board an?', 'Was wurde zuletzt in DECISIONS.md entschieden?'];
}

function EmptyState() {
  const page = useStore(pageStore);
  const items = suggestions(page);
  const icons = [Sparkles, Lightbulb, Bot];
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-[520px] animate-rise">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-moss/25 bg-moss/10 text-moss">
          <MessagesSquare className="h-5 w-5" />
        </div>
        <h2 className="text-[24px] font-semibold leading-tight tracking-[-0.02em] text-fg">
          {page.explainer ? 'Frag zur Erklärung – oder zum Workshop.' : 'Worüber willst du sprechen?'}
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-dim">
          Tippen, diktieren oder live sprechen. Der Desk liest Board, Jobs und Dokumente mit und kann Aufgaben an Claude Code geben.
        </p>
        <div className="mt-6 grid gap-2">
          {items.map((s, i) => {
            const Icon = icons[i];
            return (
              <button
                key={s}
                type="button"
                onClick={() => void sendChat(s)}
                className="group flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] px-4 py-3.5 text-left text-[15px] text-fg-2 transition-[background-color,border-color,transform] hover:-translate-y-px hover:border-white/[0.14] hover:bg-white/[0.05] hover:text-fg"
              >
                <Icon className="h-4 w-4 shrink-0 text-mute transition-colors group-hover:text-moss" />
                <span className="min-w-0 flex-1">{s}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
