import { useEffect, useRef, useState } from 'react';
import { Check, Play, Square } from 'lucide-react';
import { ensureVoiceCatalog, selectedVoiceName, setVoiceName, voiceNamesStore } from '../../lib/voiceNames';
import { useStore } from '../../lib/store';

export default function VoiceNamePicker({ provider, running }: { provider: string; running: boolean }) {
  const { catalog, active } = useStore(voiceNamesStore);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [playError, setPlayError] = useState(false);
  const [changed, setChanged] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const attempt = useRef(0);
  const group = catalog?.providers[provider];
  const chosen = selectedVoiceName(provider);
  const stop = () => { attempt.current++; audio.current?.pause(); setPlaying(null); };
  useEffect(() => { let live = true; void ensureVoiceCatalog().catch(() => { if (live) setError(true); }); return () => { live = false; }; }, []);
  useEffect(() => { const player = audio.current; stop(); setPlayError(false); return () => { attempt.current++; player?.pause(); }; }, [provider]);
  const play = async (id: string, sample: string) => {
    const wasPlaying = playing === id;
    stop(); setPlayError(false);
    if (wasPlaying || !audio.current) return;
    const token = attempt.current;
    audio.current.src = sample;
    try { await audio.current.play(); if (token === attempt.current) setPlaying(id); }
    catch { if (token === attempt.current) setPlayError(true); }
  };
  return (
    <div className="mt-2 border-t border-white/10 pt-2">
      <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">Stimme</p>
      {running && (changed || (active?.provider === provider && active.id !== chosen)) && <p role="status" className="px-3 pb-2 text-xs text-amber">gilt ab der nächsten Sitzung</p>}
      {error && <p role="status" className="px-3 py-2 text-xs text-dim">Stimmen konnten nicht geladen werden. <button type="button" className="underline" onClick={() => { setError(false); void ensureVoiceCatalog().catch(() => setError(true)); }}>Erneut laden</button></p>}
      {!group && !error && <p className="px-3 py-2 text-xs text-dim">Stimmen werden geladen …</p>}
      {group && [...group.voices].sort((a, b) => Number(b.id === group.default) - Number(a.id === group.default)).map((v) => (
        <div key={v.id} className={`flex items-center gap-1 rounded-xl ${chosen === v.id ? 'bg-violet/12' : 'hover:bg-white/[0.05]'}`}>
          <button type="button" role="menuitemradio" aria-checked={chosen === v.id} aria-label={`Stimme ${v.label}`} onClick={() => { if (setVoiceName(provider, v.id)) setChanged(true); }} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left">
            <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-fg">{v.label}{v.id === group.default && <span className="ml-2 text-[10px] font-normal text-dim">Standard</span>}</span><span className="block text-xs text-dim">{v.note}</span></span>
            {chosen === v.id && <Check className="h-4 w-4 shrink-0 text-violet-light" />}
          </button>
          {v.sample && <button type="button" aria-label={`${v.label} ${playing === v.id ? 'stoppen' : 'anhören'}`} aria-pressed={playing === v.id} onClick={() => void play(v.id, v.sample!)} className="mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-dim hover:bg-white/10 hover:text-fg">{playing === v.id ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>}
        </div>
      ))}
      {playError && <p role="status" className="px-3 py-2 text-xs text-amber">Hörprobe konnte nicht abgespielt werden.</p>}
      <audio ref={audio} preload="none" onEnded={stop} onError={() => { stop(); setPlayError(true); }} />
    </div>
  );
}
