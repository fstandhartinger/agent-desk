import { AudioLines, PhoneOff } from 'lucide-react';
import { useStore } from '../../lib/store';
import { optionByKey, voiceStore } from '../../lib/voice';
import { toggleVoice } from '../../lib/voiceController';
import { STATE_LABEL } from './VoiceDock';
import LiveOrb from './LiveOrb';

/** Mobile: raised voice button in the centre of the tab bar — one thumb away on every tab, never covering content. */
export default function VoiceFab({ showState = false }: { showState?: boolean }) {
  const { state, active } = useStore(voiceStore);
  const on = state !== 'idle' && state !== 'error';
  return (
    <div className="relative flex flex-1 items-start justify-center">
      {showState && state !== 'idle' && <div role="status" className="pointer-events-none absolute bottom-[calc(100%+28px)] left-1/2 w-max max-w-[220px] -translate-x-1/2 rounded-full border border-violet/30 bg-ink-900 px-3 py-2 text-xs text-fg shadow-lg">{STATE_LABEL[state]}</div>}
      <button
        type="button"
        onClick={toggleVoice}
        aria-pressed={on}
        aria-label={on ? 'Sprachsitzung beenden' : 'Live sprechen'}
        className={`-mt-5 flex h-14 w-14 items-center justify-center overflow-hidden rounded-full shadow-[0_12px_30px_-8px_rgb(139_92_246/0.7)] ring-4 ring-ink-900 transition-[background-color,transform] active:scale-95 ${on ? 'bg-ink-800' : 'bg-violet text-white'}`}
      >
        {on ? (
          <span className="relative flex h-14 w-14 items-center justify-center">
            <span className="absolute inset-0 flex items-center justify-center">
              <LiveOrb size={56} provider={optionByKey(active).provider} />
            </span>
            <PhoneOff className="relative h-4 w-4 text-white drop-shadow" />
          </span>
        ) : (
          <AudioLines className="h-6 w-6" />
        )}
      </button>
    </div>
  );
}
