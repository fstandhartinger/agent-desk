// The reveal count of a speech-synced points canvas, as React state. Subscribes to the speech cursor ONLY while such a canvas
// is on the stage during a voice session; never decreases for one spec; `undefined` = show every row (text chat, history,
// the detailed version, the PNG export), rows then enter with a 120 ms stagger (renderPoints).
import { useEffect, useState } from 'react';
import { speechCursor, specTurnOf } from '../lib/speechCursor';
import { useStore } from '../lib/store';
import type { CanvasSpec } from './types';
import { revealCount } from './reveal';

export const isSyncSpec = (spec: CanvasSpec | undefined): spec is CanvasSpec => !!spec && spec.kind === 'points' && spec.sync === 'speech' && (spec.points?.length ?? 0) > 0;

const CHECK_MS = 250;

export function useRevealCount(spec: CanvasSpec | undefined, enabled: boolean): number | undefined {
  const voiceOn = useStore(speechCursor, (s) => s.active);
  const live = enabled && voiceOn && isSyncSpec(spec);
  const [seen, setSeen] = useState<{ spec: CanvasSpec | undefined; n: number }>({ spec: undefined, n: 0 });
  // Computed during render (not in an effect): the first frame of a sync canvas must already hide the later rows.
  const initial = live ? revealCount(spec, speechCursor.get(), 0, specTurnOf(spec.id)) : 0;
  useEffect(() => {
    if (!live || !spec) return;
    const total = spec.points?.length ?? 0;
    const specTurn = specTurnOf(spec.id);
    let lastSpeaking = Date.now();
    const check = () => {
      const c = speechCursor.get();
      const now = Date.now();
      if (c.speaking) lastSpeaking = now;
      const k = revealCount(spec, c, now - lastSpeaking, specTurn);
      setSeen((s) => (s.spec === spec && s.n >= k ? s : { spec, n: Math.max(k, s.spec === spec ? s.n : 0) }));
      return k >= total;
    };
    if (check()) return;
    const off = speechCursor.subscribe(() => { if (check()) { off(); window.clearInterval(timer); } });
    // the "no speech for 1.5 s" rule fires without any store change
    const timer = window.setInterval(() => { if (check()) { off(); window.clearInterval(timer); } }, CHECK_MS);
    return () => { off(); window.clearInterval(timer); };
  }, [live, spec]);
  if (!live) return undefined;
  return seen.spec === spec ? Math.max(seen.n, initial) : initial;
}
