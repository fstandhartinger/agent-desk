import { useEffect, useState } from 'react';
import { voiceStore } from '../lib/voice';
import { startVoice, stopVoice, setVoiceOption, setVoiceMuted } from '../lib/voiceController';
import { auth } from '../lib/api';
import { nativeHost, setCompanionMuted, handleNativeMessage, voiceAck } from '../lib/companion';
export default function Companion() {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const host = nativeHost();
    if (!host || new URLSearchParams(location.search).get('companion') !== '1') return;
    let live = true;
    const session = () => { if (live) void auth.me().catch(() => /* ignored */ {}); };
    session();
    const timer = setInterval(session, 30000);
    const message = (event: MessageEvent) => {
      const m = event.data as { type?: unknown; on?: unknown } | null;
      if (m?.type === 'mute' && typeof m.on === 'boolean') setVoiceMuted(m.on, 'hotkey'); // Screen Agent's global hotkey: same switch as the dock
      handleNativeMessage(event.data, host, setIds, { start(provider) { if (provider) setVoiceOption(provider); if (['idle', 'error'].includes(voiceStore.get().state)) startVoice(); }, stop: stopVoice, state: () => voiceStore.get().state });
    };
    const unsubscribe = voiceStore.subscribe(() => voiceAck(host, voiceStore.get().state));
    let lastMuted = voiceStore.get().muted;
    const unsubscribeMute = voiceStore.subscribe(() => { const on = voiceStore.get().muted; if (on !== lastMuted) { lastMuted = on; host.postMessage({ type: 'mute-state', on }); } });
    host.addEventListener('message', message);
    window.addEventListener('focus', session);
    return () => { live = false; unsubscribe(); unsubscribeMute(); clearInterval(timer); host.removeEventListener('message', message); window.removeEventListener('focus', session); setCompanionMuted(false); };
  }, []);
  return ids.length ? <div className="flex flex-wrap gap-2 p-2" aria-label="Auf dem Bildschirm"><span>Auf dem Bildschirm</span>{ids.map(id => <span key={id} className="rounded border px-2">a#{id}</span>)}</div> : null;
}
