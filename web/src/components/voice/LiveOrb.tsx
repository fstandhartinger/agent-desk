import { useEffect, useState } from 'react';
import VoiceOrb from '../../viz/VoiceOrb';
import { levels, voiceStore } from '../../lib/voice';
import { useStore } from '../../lib/store';

/** Feeds the viz VoiceOrb with mic/speaker RMS at ~30 fps; only this subtree re-renders. */
export default function LiveOrb({ size, provider }: { size: number; provider?: string }) {
  const { state } = useStore(voiceStore);
  const [lv, setLv] = useState({ mic: 0, speaker: 0 });
  useEffect(() => {
    if (state === 'idle') return;
    let raf = 0, last = 0;
    const loop = (now: number) => {
      if (now - last > 33) {
        last = now;
        setLv({ mic: levels.mic, speaker: levels.speaker });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state]);
  return <VoiceOrb state={state} micLevel={lv.mic} speakerLevel={lv.speaker} provider={provider} size={size} bare />;
}
