import { Hand, PhoneOff, RotateCcw, X } from 'lucide-react';
import { useStore } from '../../lib/store';
import { useMedia } from '../../lib/useMedia';
import { optionByKey, voiceStore, type VoiceState } from '../../lib/voice';
import { dismissVoiceError, interruptVoice, startVoice, stopVoice } from '../../lib/voiceController';
import LiveOrb from './LiveOrb';

export const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Bereit',
  connecting: 'Verbinde …',
  listening: 'Ich höre zu',
  thinking: 'Denke nach …',
  speaking: 'Spricht',
  error: 'Verbindung gestört',
};

/** Live voice strip above the thread while a voice session runs. */
export default function VoiceDock() {
  const { state, active, model, error, notice } = useStore(voiceStore);
  const desktop = useMedia('(min-width: 1024px)');
  if (state === 'idle') return null;
  const opt = optionByKey(active);
  const failed = state === 'error';
  const modelLine = `${opt.label}${model ? ` · ${model}` : ''}`;
  return (
    <div className="mx-3 mb-2 mt-3 animate-rise lg:mx-5">
      <div className={`mx-auto max-w-[760px] rounded-3xl border ${failed ? 'border-danger/40 bg-gradient-to-r from-danger/[0.14] via-ink-800/80 to-ink-800/60' : 'border-violet/25 bg-gradient-to-r from-violet/[0.12] via-ink-800/80 to-ink-800/60 shadow-[0_20px_50px_-24px_rgb(139_92_246/0.6)]'}`}>
        <div className="flex items-center gap-3 p-3">
          <div className={`shrink-0 ${failed ? 'self-start' : ''}`}>
            <LiveOrb size={desktop ? 112 : 72} provider={opt.provider} />
          </div>
          <div className="min-w-0 flex-1" aria-live="polite">
            <p className={`text-[17px] font-semibold tracking-[-0.01em] ${failed ? 'text-danger' : 'text-fg'}`}>{STATE_LABEL[state]}</p>
            {failed && (
              <>
                <p role="alert" className="mt-0.5 text-xs leading-snug text-fg-2">{error}</p>
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" onClick={() => startVoice()} className="flex h-10 items-center gap-1.5 rounded-full bg-violet px-3.5 text-sm font-semibold text-white transition-colors hover:bg-violet/90">
                    <RotateCcw className="h-4 w-4" /> Erneut versuchen
                  </button>
                  <button type="button" onClick={dismissVoiceError} className="flex h-10 items-center gap-1.5 rounded-full px-3 text-sm text-dim transition-colors hover:bg-white/[0.08] hover:text-fg">
                    <X className="h-4 w-4" /> Schließen
                  </button>
                </div>
              </>
            )}
          </div>
          {state === 'speaking' && (
            <button type="button" onClick={interruptVoice} aria-label="Unterbrechen" title="Unterbrechen" className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3 text-sm font-medium text-fg-2 transition-colors hover:bg-white/[0.1] hover:text-fg">
              <Hand className="h-4 w-4" /> <span className="hidden sm:inline">Unterbrechen</span>
            </button>
          )}
          {!failed && <button type="button" onClick={stopVoice} aria-label="Sprachsitzung beenden" title="Beenden (V)" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-danger/90 text-white transition-colors hover:bg-danger">
            <PhoneOff className="h-4 w-4" />
          </button>}
        </div>
        {!failed && (
          <div className="px-4 pb-2.5 text-xs">
            {/* Full model label on its own row: it wraps instead of being cut, and the title carries it too. */}
            <p className="break-words text-dim" title={modelLine}>
              {modelLine} · <span className="text-mute">Unterbrechen jederzeit durch Sprechen</span>
            </p>
            {notice && <p className="mt-0.5 text-amber">{notice}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
