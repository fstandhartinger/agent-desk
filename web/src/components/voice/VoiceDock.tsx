import { Check, Hand, Loader2, Mic, MicOff, PenTool, PhoneOff, RotateCcw, X } from 'lucide-react';
import { useStore } from '../../lib/store';
import { useMedia } from '../../lib/useMedia';
import { nativeHost } from '../../lib/companion';
import { optionByKey, voiceStore, type VoiceState } from '../../lib/voice';
import type { ActivityLine } from '../../lib/liveActivity';
import { dismissVoiceError, interruptVoice, startVoice, stopVoice, toggleVoiceMuted } from '../../lib/voiceController';
import LiveOrb from './LiveOrb';
import SessionBadge from './SessionBadge';
import SessionMeter from './SessionMeter';

export const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Bereit',
  connecting: 'Verbinde …',
  listening: 'Ich höre zu',
  thinking: 'Denke nach …',
  speaking: 'Spricht',
  error: 'Verbindung gestört',
};

/** The newest thing the desk does: spinner while it runs, a tick when it is done, a cross with the short reason when it failed. */
export function ActivityRow({ a }: { a: ActivityLine }) {
  const running = a.phase === 'start' || a.phase === 'thinking';
  return (
    <p className={`mt-0.5 flex items-center gap-1.5 text-[13px] leading-snug ${a.phase === 'fail' ? 'text-danger' : 'text-fg-2'}`} data-activity={a.phase}>
      {running ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet" aria-hidden /> : a.phase === 'done' ? <Check className="h-3.5 w-3.5 shrink-0 text-moss" aria-hidden /> : a.phase === 'fail' ? <X className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Mic className="h-3.5 w-3.5 shrink-0 text-dim" aria-hidden />}
      <span className="min-w-0 truncate">{a.phase === 'heard' ? `„${a.label}“` : a.label}{a.phase === 'fail' && a.reason ? ` – ${a.reason}` : ''}</span>
    </p>
  );
}

/** Live voice strip above the thread while a voice session runs. */
export default function VoiceDock() {
  const { state, active, model, error, notice, muted, serverNotice, activity } = useStore(voiceStore);
  const desktop = useMedia('(min-width: 1024px)');
  if (state === 'idle') return null;
  const opt = optionByKey(active);
  const failed = state === 'error';
  const mute = muted && !failed;
  const modelLine = `${opt.label}${model ? ` · ${model}` : ''}`;
  return (
    <div className="mx-3 mb-2 mt-3 animate-rise lg:mx-5">
      <div className={`mx-auto max-w-[760px] rounded-3xl border ${failed || mute ? 'border-danger/40 bg-gradient-to-r from-danger/[0.14] via-ink-800/80 to-ink-800/60' : 'border-violet/25 bg-gradient-to-r from-violet/[0.12] via-ink-800/80 to-ink-800/60 shadow-[0_20px_50px_-24px_rgb(139_92_246/0.6)]'}`}>
        <div className="relative flex items-center gap-3 p-3">
          <div className="absolute right-4 top-0.5 flex items-center gap-2">
            {!failed && <SessionMeter />}
            <SessionBadge />
          </div>
          <div className={`shrink-0 ${failed ? 'self-start' : ''}`}>
            <LiveOrb size={desktop ? 88 : 72} provider={opt.provider} />
          </div>
          <div className="min-w-0 flex-1" aria-live="polite">
            <p className={`text-[17px] font-semibold tracking-[-0.01em] ${failed || mute ? 'text-danger' : 'text-fg'}`}>{mute ? 'Stumm' : STATE_LABEL[state]}</p>
            {!failed && !mute && activity && <ActivityRow a={activity} />}
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
          {!failed && (
            <button type="button" onClick={() => toggleVoiceMuted('dock')} aria-pressed={muted} aria-label={muted ? 'Stummschaltung aufheben' : 'Mikrofon stummschalten'} title={muted ? 'Stumm – tippen zum Aufheben (M)' : 'Stummschalten (M)'}
              className={`flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-sm font-semibold transition-colors ${muted ? 'bg-danger text-white ring-2 ring-danger/50 hover:bg-danger/90' : 'border border-white/10 bg-white/[0.06] text-fg-2 hover:bg-white/[0.1] hover:text-fg'}`}>
              {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              <span className={muted ? '' : 'hidden'}>{muted ? 'Stumm' : 'Mikrofon'}</span>
            </button>
          )}
          {!failed && nativeHost() && (
            <button type="button" onClick={() => nativeHost()?.postMessage({ type: 'canvas-panel-toggle' })} aria-label="Zeichnung" title="Zeichnung ein-/ausblenden"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-fg-2 transition-colors hover:bg-white/[0.1] hover:text-fg">
              <PenTool className="h-4 w-4" />
            </button>
          )}
          {!failed && <button type="button" onClick={stopVoice} aria-label="Sprachsitzung beenden" title="Beenden (V)" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-danger/90 text-white transition-colors hover:bg-danger">
            <PhoneOff className="h-4 w-4" />
          </button>}
        </div>
        {mute && (
          <button type="button" onClick={() => toggleVoiceMuted('dock')} role="status" className="flex w-full items-center justify-center gap-2 border-t border-danger/30 bg-danger/20 px-4 py-2 text-[13px] font-semibold text-white">
            <MicOff className="h-4 w-4" /> Mikrofon stumm – der Agent hört nichts. Tippen zum Aufheben.
          </button>
        )}
        {!failed && (
          <div className="px-4 pb-2.5 pt-1 text-xs">
            {/* Full model label on its own row: it wraps instead of being cut, and the title carries it too. */}
            <p className="break-words text-dim" title={modelLine}>
              {modelLine} · <span className="text-mute">Unterbrechen jederzeit durch Sprechen</span>
            </p>
            {notice && <p className="mt-0.5 text-amber">{notice}</p>}
            {serverNotice && <p className="mt-0.5 text-amber" role="status">{serverNotice}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
