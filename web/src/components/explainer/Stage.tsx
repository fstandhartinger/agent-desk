import { forwardRef, useEffect, useRef, useState } from 'react';
import { Loader2, MousePointerClick, Play } from 'lucide-react';
import { assetUrl } from '../../lib/explainer';

interface Props { slug: string; showBigPlay: boolean; onPlay: () => void; onLoad: () => void }

/** Same-origin 1920×1080 stage iframe, scaled to fit a 16:9 box. */
const Stage = forwardRef<HTMLIFrameElement, Props>(function Stage({ slug, showBigPlay, onPlay, onLoad }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / 1920));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => setReady(false), [slug]);

  // "Elemente anklickbar" is a one-time hint: shown when playback first starts, gone after 3 s (critic D13).
  const [hint, setHint] = useState<'pending' | 'shown' | 'done'>('pending');
  useEffect(() => setHint('pending'), [slug]);
  useEffect(() => {
    if (!ready || showBigPlay || hint !== 'pending') return;
    setHint('shown');
  }, [ready, showBigPlay, hint]);
  useEffect(() => {
    if (hint !== 'shown') return;
    const t = setTimeout(() => setHint('done'), 3000);
    return () => clearTimeout(t);
  }, [hint]);

  return (
    <div ref={box} className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/[0.07] bg-ink-900 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.9)]">
      <iframe
        ref={ref}
        key={slug}
        src={`${assetUrl(slug, 'stage.html')}?interactive=1`}
        title="Erklär-Animation"
        scrolling="no"
        onLoad={(e) => {
          const win = e.currentTarget.contentWindow as (Window & { __ready?: boolean }) | null;
          const started = performance.now();
          const wait = () => (win?.__ready || performance.now() - started > 4000 ? (setReady(true), onLoad()) : setTimeout(wait, 50));
          wait();
        }}
        className="absolute left-0 top-0 origin-top-left border-0"
        style={{ width: 1920, height: 1080, transform: `scale(${scale})`, opacity: ready ? 1 : 0, transition: 'opacity 300ms ease' }}
      />
      {!ready && (
        <div className="skeleton absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-mute" />
        </div>
      )}
      {ready && showBigPlay && (
        <button type="button" onClick={onPlay} aria-label="Abspielen" className="group absolute inset-0 flex animate-fade items-center justify-center bg-ink-900/20">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-violet text-white shadow-[0_0_0_10px_rgb(139_92_246/0.18),0_20px_40px_-10px_rgb(139_92_246/0.6)] transition-transform duration-200 group-hover:scale-105 lg:h-20 lg:w-20">
            <Play className="ml-1 h-7 w-7 lg:h-8 lg:w-8" fill="currentColor" />
          </span>
        </button>
      )}
      {hint !== 'pending' && (
        <span
          data-testid="click-hint"
          aria-hidden={hint === 'done'}
          className={`pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-ink-900/80 px-3 py-1.5 text-[12px] font-medium text-fg-2 shadow-lg backdrop-blur transition-opacity duration-500 ${hint === 'shown' ? 'animate-fade opacity-100' : 'opacity-0'}`}
        >
          <MousePointerClick className="h-3.5 w-3.5 text-violet-light" /> Elemente anklickbar – tippe auf eine Karte
        </span>
      )}
    </div>
  );
});

export default Stage;
