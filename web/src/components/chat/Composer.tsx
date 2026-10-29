import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, AudioLines, Check, ChevronDown, Clock, Loader2, MapPin, Mic, Square, X } from 'lucide-react';
import { useStore } from '../../lib/store';
import { chatState, sendChat, stopChat } from '../../lib/chat';
import { pageStore, selectedPoint, getPlayer } from '../../lib/page';
import { startRecording, type Recording } from '../../lib/dictation';
import { transcribe, errorMessage } from '../../lib/api';
import { toast } from '../../lib/toast';
import { logActivity } from '../../lib/activity';
import { VOICE_OPTIONS, optionByKey, voiceStore } from '../../lib/voice';
import { sendVoiceText, setVoiceOption, toggleVoice } from '../../lib/voiceController';
import { healthText, statusStore } from '../../lib/status';
import { chooseVoice, voiceUnavailableNotice } from '../../lib/voiceChoice';
import HealthDot from '../ui/HealthDot';
import { fmtTime } from '../../lib/format';
import Popover from '../ui/Popover';

type Dictation = { phase: 'idle' } | { phase: 'recording'; since: number } | { phase: 'transcribing' };

export default function Composer() {
  const [text, setText] = useState('');
  const [dict, setDict] = useState<Dictation>({ phase: 'idle' });
  const [pickerOpen, setPickerOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const rec = useRef<Recording | null>(null);
  const dictatedRef = useRef(false);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const { streamingId } = useStore(chatState);
  const voice = useStore(voiceStore);
  const voiceOn = voice.state !== 'idle' && voice.state !== 'error';

  const resize = useCallback(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    const focus = () => area.current?.focus();
    window.addEventListener('desk:focus-composer', focus);
    return () => window.removeEventListener('desk:focus-composer', focus);
  }, []);

  useEffect(resize, [text, resize]);

  const send = () => {
    const t = text.trim();
    if (!t || streamingId) return;
    setText('');
    if (voiceOn && sendVoiceText(t)) return;
    void sendChat(t, dictatedRef.current ? 'dictation' : 'text');
    dictatedRef.current = false;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') area.current?.blur();
  };

  // Dictation: record → /api/transcribe → text into the composer (not sent automatically).
  const transcribeBlob = useCallback(async (blob: Blob): Promise<void> => {
    setDict({ phase: 'transcribing' });
    try {
      const said = await transcribe(blob);
      if (said) {
        setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said));
        dictatedRef.current = true;
        logActivity('chat', 'Diktat erkannt', said.slice(0, 120), 'moss');
      } else toast('Nichts verstanden – bitte noch einmal.', 'info');
    } catch (e) {
      // The recording is kept, so a retry does not mean speaking again.
      toast(`Diktat nicht erkannt: ${errorMessage(e)}`, 'error', undefined, { label: 'Erneut versuchen', run: () => void transcribeBlob(blob) });
    } finally {
      setDict({ phase: 'idle' });
      requestAnimationFrame(() => area.current?.focus());
    }
  }, []);

  const stopDictation = useCallback(async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setDict({ phase: 'transcribing' });
    try {
      await transcribeBlob(await r.stop());
    } catch {
      setDict({ phase: 'idle' });
      toast('Die Aufnahme konnte nicht beendet werden – bitte noch einmal diktieren.', 'error');
    }
  }, [transcribeBlob]);

  const startDictation = async () => {
    try {
      rec.current = await startRecording(() => void stopDictation());
      setDict({ phase: 'recording', since: Date.now() });
    } catch {
      toast('Kein Mikrofonzugriff – bitte im Browser erlauben.', 'error');
    }
  };

  const cancelDictation = () => {
    rec.current?.cancel();
    rec.current = null;
    setDict({ phase: 'idle' });
  };

  useEffect(() => () => rec.current?.cancel(), []);

  // Level meter while recording, straight to the DOM.
  useEffect(() => {
    if (dict.phase !== 'recording') return;
    let raf = 0;
    const loop = () => {
      const lvl = rec.current?.level() ?? 0;
      bars.current.forEach((b, i) => {
        if (b) b.style.transform = `scaleY(${Math.max(0.12, Math.min(1, lvl * (0.6 + 0.4 * Math.sin(performance.now() / 120 + i * 1.3) ** 2)))})`;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [dict.phase]);

  const canSend = text.trim().length > 0 && !streamingId && dict.phase === 'idle';
  const providers = useStore(statusStore, (s) => s.providers);
  const opt = voiceOn ? optionByKey(voice.active) : chooseVoice(optionByKey(voice.option), providers).run;

  return (
    <div className="px-3 pb-3 pt-1 lg:px-5 lg:pb-4">
      <div className="mx-auto max-w-[760px]">
        <ContextChips />
        <div
          className={`relative rounded-[26px] border bg-ink-800 shadow-[0_10px_40px_-16px_rgb(0_0_0/0.8)] transition-[border-color,box-shadow] duration-200 ${
            voiceOn ? 'border-violet/40 shadow-[0_0_0_4px_rgb(139_92_246/0.08)]' : dict.phase === 'recording' ? 'border-papaya/40 shadow-[0_0_0_4px_rgb(250_93_25/0.07)]' : 'border-white/[0.09] focus-within:border-white/[0.18] hover:border-white/[0.13]'
          }`}
        >
          {dict.phase === 'recording' ? (
            <div className="flex h-[52px] items-center gap-3 px-4" aria-live="polite">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-papaya opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-papaya" />
              </span>
              <span className="text-sm font-medium text-fg-2">Diktat läuft</span>
              <div className="flex h-6 flex-1 items-center gap-[3px]" aria-hidden>
                {Array.from({ length: 28 }, (_, i) => (
                  <span key={i} ref={(el) => void (bars.current[i] = el)} className="h-full w-[3px] origin-center rounded-full bg-papaya/80 transition-transform duration-75" style={{ transform: 'scaleY(0.12)' }} />
                ))}
              </div>
              <RecTimer since={dict.since} />
            </div>
          ) : (
            <textarea
              ref={area}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              disabled={dict.phase === 'transcribing'}
              placeholder={dict.phase === 'transcribing' ? 'Wird transkribiert …' : voiceOn ? 'Live – Text geht an die Stimme …' : 'Frag den Desk …'}
              aria-label="Nachricht"
              className="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-[15px] text-base leading-6 text-fg outline-none placeholder:text-mute disabled:opacity-60"
            />
          )}

          <div className="flex items-center gap-1 px-2 pb-2">
            {dict.phase === 'recording' ? (
              <>
                <ToolbarButton label="Diktat verwerfen" onClick={cancelDictation}>
                  <X className="h-[18px] w-[18px]" />
                </ToolbarButton>
                <div className="flex-1" />
                <button type="button" onClick={() => void stopDictation()} className="flex h-11 items-center gap-1.5 rounded-full bg-papaya px-3.5 text-sm font-semibold text-white lg:h-9 transition-colors hover:bg-[#ff7a3d]">
                  <Check className="h-4 w-4" /> Fertig
                </button>
              </>
            ) : (
              <>
                <ToolbarButton label="Diktieren" onClick={() => void startDictation()} disabled={dict.phase === 'transcribing' || voiceOn}>
                  {dict.phase === 'transcribing' ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <Mic className="h-[18px] w-[18px]" />}
                </ToolbarButton>
                <div className="relative flex items-center">
                  <button
                    type="button"
                    onClick={toggleVoice}
                    aria-pressed={voiceOn}
                    aria-label={voiceOn ? 'Sprachsitzung beenden (V)' : `Live sprechen mit ${opt.label} (V)`}
                    title={voiceOn ? 'Sprachsitzung beenden (V)' : `Live sprechen (V)`}
                    className={`flex h-11 items-center gap-1.5 rounded-l-full pl-3 pr-2 lg:h-9 text-[13px] font-medium transition-colors ${voiceOn ? 'bg-violet text-white' : 'text-dim hover:bg-white/[0.06] hover:text-fg'}`}
                  >
                    <AudioLines className="h-[18px] w-[18px]" />
                    <span className="hidden sm:inline">{voiceOn ? 'Live' : opt.label}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPickerOpen((o) => !o)}
                    aria-label="Sprachmodell wählen"
                    aria-haspopup="menu"
                    aria-expanded={pickerOpen}
                    className={`flex h-11 w-8 items-center justify-center rounded-r-full lg:h-9 lg:w-7 transition-colors ${voiceOn ? 'bg-violet text-white/80 hover:text-white' : 'text-mute hover:bg-white/[0.06] hover:text-fg'}`}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <ProviderMenu open={pickerOpen} onClose={() => setPickerOpen(false)} />
                </div>
                <div className="flex-1" />
                {streamingId ? (
                  <button type="button" onClick={stopChat} aria-label="Antwort stoppen" className="flex h-11 w-11 lg:h-9 lg:w-9 items-center justify-center rounded-full bg-white/[0.12] text-fg transition-colors hover:bg-white/[0.18]">
                    <Square className="h-3.5 w-3.5" fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={send}
                    disabled={!canSend}
                    aria-label="Senden"
                    className={`flex h-11 w-11 items-center justify-center rounded-full transition-[background-color,transform] active:scale-95 lg:h-9 lg:w-9 ${canSend ? 'bg-moss text-ink-900 hover:bg-moss-light' : 'bg-white/[0.07] text-mute'}`}
                  >
                    <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.4} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({ label, children, ...rest }: { label: string; children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} className="flex h-11 w-11 items-center justify-center rounded-full text-dim transition-colors hover:bg-white/[0.06] lg:h-9 lg:w-9 hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent" {...rest}>
      {children}
    </button>
  );
}

function RecTimer({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  return <span className="text-xs text-dim tabular">{fmtTime((Date.now() - since) / 1000)}</span>;
}

export function ProviderMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { option } = useStore(voiceStore);
  const providers = useStore(statusStore, (s) => s.providers);
  const effective = chooseVoice(optionByKey(option), providers);
  return (
    <Popover open={open} onClose={onClose} side="top" align="left" className="w-72">
      <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">Stimme</p>
      <p className="px-3 pb-2 text-xs text-dim">Startet mit {effective.run.label}{effective.picked ? ` · ${voiceUnavailableNotice(effective.picked, effective.run)}` : ''}</p>
      {VOICE_OPTIONS.map((o) => {
        const health = providers[o.provider];
        const hint = health?.state === 'failed' ? `Nicht verfügbar · ${healthText(health)}` : health?.state === 'off' ? 'Nicht eingerichtet' : o.hint;
        return (
          <button
            key={o.key}
            type="button"
            role="menuitemradio"
            aria-checked={o.key === option}
            onClick={() => {
              setVoiceOption(o.key);
              onClose();
            }}
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${o.key === option ? 'bg-violet/12' : 'hover:bg-white/[0.05]'}`}
          >
            <span title={healthText(health)} className="flex"><HealthDot health={health} className="h-2 w-2" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-fg">{o.label}</span>
              <span className={`block text-xs ${health?.state === 'failed' ? 'text-amber/90' : 'text-dim'}`}>{hint}</span>
            </span>
            {o.key === option && <Check className="h-4 w-4 shrink-0 text-violet-light" />}
          </button>
        );
      })}
    </Popover>
  );
}

function ContextChips() {
  const { explainer, attached, pointId, sceneId } = useStore(pageStore);
  const point = attached && pointId ? selectedPoint() : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!explainer || point) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [explainer, point]);
  if (!explainer) return null;
  const scene = sceneId ? explainer.points.points[sceneId]?.title : null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
      {point ? (
        <span className="inline-flex max-w-full animate-pop items-center gap-1.5 rounded-full border border-violet/30 bg-violet/10 py-1 pl-2.5 pr-1 text-[13px] text-violet-light">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium">{point.title}</span>
          <button type="button" aria-label="Punkt aus der Frage entfernen" onClick={() => pageStore.set((s) => ({ ...s, attached: false }))} className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-violet/20">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ) : (
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-2.5 py-1 text-xs text-dim" title="Wird als Kontext mitgeschickt">
          <Clock className="h-3 w-3 shrink-0" />
          <span className="tabular">{fmtTime(getPlayer()?.time() ?? 0)}</span>
          <span className="truncate">{scene ? `· ${scene}` : ''}</span>
        </span>
      )}
    </div>
  );
}
