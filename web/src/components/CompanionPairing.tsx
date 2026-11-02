import { useEffect, useState } from 'react';
import { nativeHost } from '../lib/companion';
import Logo from './Logo';

/** This page runs in the app's separate WebView profile. Sign-in happens in the system browser. */
export default function CompanionPairing() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    const host = nativeHost();
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.type !== 'pairing-status') return;
      if (data.state === 'pending') { setPending(true); setError(''); setStatus(typeof data.text === 'string' ? data.text : ''); }
      if (data.state === 'error') {
        setPending(false);
        setError(typeof data.text === 'string' ? data.text : 'Die Verbindung hat nicht geklappt. Bitte erneut versuchen.');
      }
    };
    host?.addEventListener('message', onMessage);
    return () => host?.removeEventListener('message', onMessage);
  }, []);
  function start() {
    const host = nativeHost();
    if (!host) { setError('Öffne diese Seite über „Desk öffnen“ im Screen-Agent-Tray.'); return; }
    setPending(true); setError(''); setStatus('');
    host.postMessage({ type: 'pairing-start' });
  }
  return <main className="stage-glow flex min-h-full items-center justify-center px-6 py-10">
    <section className="w-full max-w-md space-y-5 rounded-3xl border border-white/10 bg-ink-800/80 p-6 text-center">
      <div className="flex justify-center"><Logo size={48} /></div>
      <h1 className="text-2xl font-semibold">Screen Agent mit Desk verbinden</h1>
      <p className="text-dim">Ein Klick öffnet deinen normalen Browser. Bestätige dort „Dieses Gerät verbinden“. Desk öffnet sich danach automatisch hier in der App.</p>
      <button className="min-h-12 w-full rounded-xl bg-moss px-4 py-3 font-semibold text-ink-900 disabled:opacity-50" disabled={pending} onClick={start}>
        {pending ? 'Warte auf Bestätigung im Browser …' : 'Im Browser verbinden'}
      </button>
      {pending && <p role="status" className="text-sm text-dim">Falls du noch nicht angemeldet bist, öffne den Login-Link aus Telegram auf diesem Computer. Du musst keinen Code kopieren.</p>}
      {pending && status && <p role="status" className="text-sm text-dim">{status}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </section>
  </main>;
}
