import { useEffect, useState } from 'react';
import { useStore } from '../../lib/store';
import { meterText } from '../../lib/sessionMeter';
import { voiceStore } from '../../lib/voice';

/** Small and muted next to the session id (top right of the dock). The cost follows the gateway's 10 s ticks, the timer runs every second. */
export default function SessionMeter() {
  const readyAt = useStore(voiceStore, (s) => s.readyAt);
  const usage = useStore(voiceStore, (s) => s.usage);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (readyAt === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [readyAt]);
  if (readyAt === null) return null;
  const text = meterText(Math.max(0, (now - readyAt) / 1000), usage);
  return (
    <span data-testid="session-meter" title="Sitzungsdauer · Kosten dieser Sitzung (USD) · Kosten des Desks heute (USD)" className="whitespace-nowrap text-[11px] leading-none tabular-nums text-mute/90">
      {text}
    </span>
  );
}
