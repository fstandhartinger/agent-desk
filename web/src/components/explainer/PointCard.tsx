import { MessageSquarePlus, Play, X } from 'lucide-react';
import type { Point } from '../../lib/explainer';

interface Props { point: Point & { id: string }; onResume: () => void; onAsk: () => void; onClose: () => void }

export default function PointCard({ point, onResume, onAsk, onClose }: Props) {
  return (
    <section aria-label={`Erklärung: ${point.title}`} className="relative animate-rise overflow-hidden rounded-2xl border border-violet/30 bg-gradient-to-b from-violet/[0.10] to-ink-800/60 p-4 lg:p-5">
      <div aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-violet" />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-light">Punkt ausgewählt</p>
          <h3 className="mt-1 text-[19px] font-semibold leading-snug tracking-[-0.01em] text-fg">{point.title}</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Punkt schließen" className="-mr-1 -mt-1 flex h-9 w-9 items-center justify-center rounded-full text-dim hover:bg-white/[0.06] hover:text-fg">
          <X className="h-4 w-4" />
        </button>
      </div>
      {point.short && <p className="mt-2 text-[15px] leading-relaxed text-fg-2">{point.short}</p>}
      {point.more && <p className="mt-2 text-sm leading-relaxed text-dim">{point.more}</p>}
      {point.sources?.length ? (
        <p className="mt-3 break-words text-xs text-mute">Quellen: {point.sources.join(' · ')}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onAsk} className="flex h-10 items-center gap-2 rounded-full bg-violet px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-light">
          <MessageSquarePlus className="h-4 w-4" /> Dazu fragen
        </button>
        <button type="button" onClick={onResume} className="flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-medium text-fg-2 transition-colors hover:bg-white/[0.08] hover:text-fg">
          <Play className="h-3.5 w-3.5" fill="currentColor" /> Weiter abspielen
        </button>
      </div>
    </section>
  );
}
