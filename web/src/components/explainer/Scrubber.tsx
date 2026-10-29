import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Explainer } from '../../lib/explainer';
import { fmtTime, clamp } from '../../lib/format';
import { trackFraction } from '../../lib/fullscreen';

export interface ScrubberHandle { update(t: number, dur: number): void }

interface Props { explainer: Explainer; duration: number; onSeek: (t: number) => void }

/** Timeline with scene ticks and hover tooltip. Position is written imperatively at 60 fps (no re-render). */
const Scrubber = forwardRef<ScrubberHandle, Props>(function Scrubber({ explainer, duration, onSeek }, ref) {
  const track = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const tNow = useRef(0);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const { scenes } = explainer.timeline;
  const points = explainer.points.points;

  useImperativeHandle(ref, () => ({
    update(t, dur) {
      tNow.current = t;
      const p = `${clamp(t / (dur || 1), 0, 1) * 100}%`;
      if (fill.current) fill.current.style.width = p;
      if (knob.current) knob.current.style.left = p;
      track.current?.setAttribute('aria-valuenow', String(Math.round(t)));
      track.current?.setAttribute('aria-valuetext', `${fmtTime(t)} von ${fmtTime(dur)}`);
    },
  }));

  const timeAt = (e: PointerEvent) => {
    const el = track.current!;
    const f = trackFraction(el.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, e.clientX, e.clientY);
    return { x: f * el.offsetWidth, t: f * duration };
  };
  const sceneTitle = (t: number) => {
    const s = scenes.find((x) => t >= x.start && t < x.end);
    return s && points[s.id]?.title;
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 5;
    if (e.key === 'ArrowLeft') onSeek(tNow.current - step);
    else if (e.key === 'ArrowRight') onSeek(tNow.current + step);
    else if (e.key === 'Home') onSeek(0);
    else if (e.key === 'End') onSeek(duration - 0.1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Zeitleiste"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(true);
        onSeek(timeAt(e).t);
      }}
      onPointerMove={(e) => {
        const h = timeAt(e);
        setHover(h);
        if (drag) onSeek(h.t);
      }}
      onPointerUp={() => setDrag(false)}
      onPointerLeave={() => !drag && setHover(null)}
      className="group relative h-8 flex-1 cursor-pointer touch-none select-none"
    >
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/[0.08] transition-[height] group-hover:h-2">
        <div ref={fill} className="h-full rounded-full bg-gradient-to-r from-violet to-violet-light" style={{ width: 0 }} />
      </div>
      {scenes.slice(1).map((s) => (
        <span
          key={s.id}
          aria-hidden
          className="absolute top-1/2 h-1.5 w-[2px] -translate-x-1/2 -translate-y-1/2 bg-ink-900"
          style={{ left: `${(s.start / duration) * 100}%` }}
        />
      ))}
      <div
        ref={knob}
        aria-hidden
        className={`absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgb(139_92_246/0.3),0_2px_8px_rgb(0_0_0/0.5)] transition-transform ${drag ? 'scale-110' : 'scale-0 group-hover:scale-100 group-focus-visible:scale-100'}`}
        style={{ left: 0 }}
      />
      {hover && (
        <div
          className="pointer-events-none absolute bottom-full mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg border border-white/10 bg-ink-750 px-2 py-1 text-xs text-fg shadow-lg"
          style={{ left: hover.x }}
        >
          <span className="tabular text-dim">{fmtTime(hover.t)}</span>
          {sceneTitle(hover.t) && <span className="ml-1.5">{sceneTitle(hover.t)}</span>}
        </div>
      )}
    </div>
  );
});

export default Scrubber;
