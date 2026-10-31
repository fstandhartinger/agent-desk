import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { nativeHost } from '../lib/companion';
type DeviceRecord = { deviceId: string; expiresAt: number; scopes: string[] };
export default function Device() {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [terms, setTerms] = useState<{ term: string }[]>([]);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const [d, t] = await Promise.all([api<{ devices: DeviceRecord[] }>('/api/device/list'), api<{ items: { term: string }[] }>('/api/device/learned')]);
    setDevices(d.devices); setTerms(t.items);
  };
  useEffect(() => { void refresh().catch(e => setError(errorMessage(e))); }, []);
  async function pair() {
    setBusy(true); setError(''); setToken('');
    try {
      const result = await api<{ token: string; deviceId: string; expiresAt: number }>('/api/device/pair', { method: 'POST', json: {} });
      const host = nativeHost();
      if (host) host.postMessage({ type: 'device-token', ...result });
      else setToken(result.token);
      await refresh();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setError('');
    try { await api(`/api/device/revoke/${encodeURIComponent(id)}`, { method: 'DELETE' }); setToken(''); await refresh(); }
    catch (e) { setError(errorMessage(e)); }
  }
  async function deleteTerm(term: string) {
    try { await api(`/api/device/learned/${encodeURIComponent(term)}`, { method: 'DELETE' }); await refresh(); }
    catch (e) { setError(errorMessage(e)); }
  }
  return <main className="mx-auto max-w-xl space-y-5 p-6">
    <a href="/">← Agent Desk</a><h1 className="text-2xl">Screen Agent verbinden</h1>
    <p>Verbinde den Screen Agent mit Agent Desk. Der Zugang gilt 90 Tage und kann hier widerrufen werden.</p>
    <button disabled={busy} onClick={() => void pair()}>Dieses Gerät verbinden</button>
    {token && <section><p>Gerätezugang – wird nur einmal angezeigt:</p><code className="break-all">{token}</code><button onClick={() => setToken('')}>Ausblenden</button></section>}
    {error && <p role="alert">{error}</p>}
    <h2>Verbundene Geräte</h2>
    <ul>{devices.map(d => <li key={d.deviceId} className="my-3 break-all">{d.deviceId} · bis {new Date(d.expiresAt).toLocaleDateString('de-DE')} <button onClick={() => void revoke(d.deviceId)}>Zugang löschen</button></li>)}</ul>
    <h2>Gelernte Wörter</h2>
    <ul>{terms.map(t => <li key={t.term}>{t.term} <button onClick={() => void deleteTerm(t.term)}>Wort löschen</button></li>)}</ul>
    <p>Markierte Bilder verarbeitet Google. Diktat-Audio verarbeitet Groq, OpenAI und Google, soweit eingerichtet. Bilder und Audio werden im Desk nicht gespeichert.</p>
  </main>;
}
