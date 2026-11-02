import { copyText } from '../../lib/clipboard';
import { useStore } from '../../lib/store';
import { voiceStore } from '../../lib/voice';

/** Small, muted a#id of the current (or last) voice session, top right by the id convention; click copies it. */
export default function SessionBadge({ className = '' }: { className?: string }) {
  const aid = useStore(voiceStore, (s) => s.aid);
  if (!aid) return null;
  return (
    <button type="button" onClick={() => void copyText(`a#${aid}`)} title="Sitzungs-ID kopieren" aria-label={`Sitzungs-ID a#${aid} kopieren`}
      className={`font-mono text-[11px] lowercase leading-none text-mute/80 transition-colors hover:text-fg-2 ${className}`}>
      a#{aid}
    </button>
  );
}
