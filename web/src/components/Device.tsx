import { reportClientError } from '../lib/clientError';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { pairingId, pairingCallback } from '../lib/deviceEntry';
type DeviceRecord = { deviceId: string; expiresAt: number; scopes: string[] };
export default function Device() {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [terms, setTerms] = useState<{ term: string }[]>([]);
  const [pairId] = useState(() => pairingId(location));
  const [invalidPair] = useState(() => new URLSearchParams(location.search).has('pair') && !pairingId(location));
  const [connected, setConnected] = useState(false);
  const [error, setErrorText] = useState('');
  const setError = (text: string) => { setErrorText(text); if (text) reportClientError('device', text); };
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const [d, t] = await Promise.all([api<{ devices: DeviceRecord[] }>('/api/device/list'), api<{ items: { term: string }[] }>('/api/device/learned')]);
    setDevices(d.devices); setTerms(t.items);
  };
  useEffect(() => { void refresh().catch(e => setError(errorMessage(e))); }, []);
  async function pair() {
    if (!pairId || busy || connected) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ ok: boolean; callbackUrl: string }>('/api/device/pairing/confirm', { method: 'POST', json: { pairId } });
      const callback = pairingCallback(result.callbackUrl);
      if (!result.ok || !callback) throw new Error('Die App-Bestätigung ist ungültig. Bitte starte die Verbindung in Screen Agent erneut.');
      setConnected(true);
      // The one-use nonce has served its purpose; keep no credential in browser history or the page.
      history.replaceState(null, '', '/device');
      // Top-level navigation reaches the same machine; fetch would be subject to CORS/private-network restrictions.
      window.location.replace(callback);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setError('');
    try { await api(`/api/device/revoke/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refresh(); }
    catch (e) { setError(errorMessage(e)); }
  }
  async function deleteTerm(term: string) {
    try { await api(`/api/device/learned/${encodeURIComponent(term)}`, { method: 'DELETE' }); await refresh(); }
    catch (e) { setError(errorMessage(e)); }
  }
  return <main className="mx-auto max-w-xl space-y-5 p-6">
    <a href="/">← Agent Desk</a><h1 className="text-2xl">Screen Agent verbinden</h1>
    {pairId && !connected && <section className="space-y-4 rounded-2xl border border-violet/30 p-5">
      <p>Bestätige nur, wenn du gerade auf diesem Computer in Screen Agent auf „Im Browser verbinden“ geklickt hast. Die App erhält ihren Zugang automatisch. Er gilt 90 Tage und kann hier widerrufen werden.</p>
      <button className="min-h-12 rounded-xl bg-moss px-5 py-3 font-semibold text-ink-900 disabled:opacity-50" disabled={busy} onClick={() => void pair()}>{busy ? 'Wird verbunden …' : 'Dieses Gerät verbinden'}</button>
    </section>}
    {connected && <p role="status" className="rounded-2xl border border-moss/30 p-5 text-moss">Die Bestätigung wird an Screen Agent auf diesem Computer übergeben …</p>}
    {invalidPair && <p role="alert">Dieser Verbindungslink ist ungültig. Starte die Verbindung in Screen Agent erneut.</p>}
    {!pairId && !invalidPair && !connected && <p>Zum Verbinden öffne im Screen-Agent-Tray „Desk öffnen“ und klicke auf „Im Browser verbinden“. Du musst keinen Gerätezugang kopieren.</p>}
    {error && <p role="alert">{error}</p>}
    <h2>Verbundene Geräte</h2>
    <ul>{devices.map(d => <li key={d.deviceId} className="my-3 break-all">{d.deviceId} · bis {new Date(d.expiresAt).toLocaleDateString('de-DE')} <button onClick={() => void revoke(d.deviceId)}>Zugang löschen</button></li>)}</ul>
    <h2>Gelernte Wörter</h2>
    <ul>{terms.map(t => <li key={t.term}>{t.term} <button onClick={() => void deleteTerm(t.term)}>Wort löschen</button></li>)}</ul>
    <p>Markierte Bilder verarbeitet Google. Diktat-Audio verarbeitet Groq, OpenAI und Google, soweit eingerichtet. Bilder und Audio werden im Desk nicht gespeichert.</p>
  </main>;
}
