import type { Explainer } from '../../lib/explainer';
import { fmtTime } from '../../lib/format';

export default function Chapters({ explainer, sceneId, onSeek }: { explainer: Explainer; sceneId: string | null; onSeek: (t: number) => void }) {
  const { scenes } = explainer.timeline;
  if (scenes.length < 2) return null;
  return (
    <nav aria-label="Kapitel">
      <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-mute">Kapitel</p>
      <ol className="space-y-0.5">
        {scenes.map((s, i) => {
          const cur = s.id === sceneId;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSeek(s.start + 0.01)}
                aria-current={cur ? 'step' : undefined}
                className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-[14px] transition-colors ${cur ? 'bg-violet/[0.12] text-fg' : 'text-fg-2 hover:bg-white/[0.04]'}`}
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular ${cur ? 'bg-violet text-white' : 'bg-white/[0.06] text-dim'}`}>{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{explainer.points.points[s.id]?.title || s.id}</span>
                <span className="shrink-0 text-xs text-mute tabular">{fmtTime(s.start)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
