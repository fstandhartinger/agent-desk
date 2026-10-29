import type { Explainer } from '../../lib/explainer';

interface Props { explainer: Explainer; wordIdx: number; onSeek: (t: number) => void; onMore: (pointId: string) => void }

/** Current narration sentence; the spoken word is highlighted, any word seeks. */
export default function Caption({ explainer, wordIdx, onSeek, onMore }: Props) {
  const { sentences, timeline, points } = explainer;
  if (!sentences.length) return null;
  const si = Math.max(0, sentences.findIndex((s) => s[s.length - 1] >= wordIdx));
  const sentence = sentences[si];
  const scene = timeline.words[sentence[0]]?.scene;
  const more = scene && points.points[scene] ? scene : null;
  return (
    <p aria-live="off" className="min-h-[3.4em] text-[17px] leading-[1.7] lg:text-[18px]">
      {sentence.map((i) => {
        const w = timeline.words[i];
        const state = i < wordIdx ? 'text-fg-2' : i === wordIdx ? 'text-white bg-violet/35 shadow-[0_0_0_2px_rgb(139_92_246/0.35)]' : 'text-mute';
        return (
          <span key={i}>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onSeek(w.s)}
              className={`rounded-[5px] px-[1px] transition-colors duration-100 hover:text-white ${state}`}
            >
              {w.w}
            </button>{' '}
          </span>
        );
      })}
      {more && (
        <button type="button" onClick={() => onMore(more)} className="ml-1 whitespace-nowrap text-[14px] font-medium text-violet-light hover:text-white">
          mehr ›
        </button>
      )}
    </p>
  );
}
