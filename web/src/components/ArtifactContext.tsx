import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { parseArtifactUrl } from '../lib/artifactUrl';
import { sendVoiceText, setVoiceOption, startVoice } from '../lib/voiceController';
import { optionByKey } from '../lib/voice';

type Artifact = { id: string; title: string; summary: string; refs: { target: string; label: string }[]; stale?: boolean; status?: string; superseded_by?: string | null };
type Context = { items: Artifact[]; unknown: string[] };
let boot: Promise<{ context: Context; notice: string }> | null = null;
let launched = false;

/** A new login must resolve into its new server-side sid, including without a full page reload. */
export function resetArtifactEntry() { boot = null; launched = false; }
function loadEntry() {
  return boot ??= (async () => {
    const entry = parseArtifactUrl(globalThis.location?.href ?? '/');
    let context: Context = { items: [], unknown: [] };
    let notice = entry.invalid.length ? 'Ungültige Artefakt-IDs wurden ignoriert.' : '';
    if (entry.ids.length || new URL(location.href).searchParams.has('a') || location.pathname.startsWith('/a/')) {
      try {
        context = await api<Context>(`/api/artifacts/resolve?ids=${entry.ids.join(',')}`);
        if (context.unknown.length) notice += ' Einige Artefakte wurden nicht gefunden.';
      } catch (err) { return { context, notice: errorMessage(err) }; }
    }
    return { context, notice };
  })();
}
function launchEntry(allowAutoStart: boolean) {
  if (launched || !allowAutoStart) return;
  launched = true;
  const { voice } = parseArtifactUrl(globalThis.location?.href ?? '/');
  if (voice) { setVoiceOption(voice); void startVoice(); }
}
export default function ArtifactContext() {
  const [suggestion, setSuggestion] = useState(() => parseArtifactUrl(globalThis.location?.href ?? '/').question);
  const [trusted, setTrusted] = useState(false);
  const entry = parseArtifactUrl(globalThis.location?.href ?? '/');
  const [state, setState] = useState<{ context: Context; notice: string } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([loadEntry(), api<{ origins: string[] }>('/api/artifacts/launch-config').catch(() => ({ origins: [] as string[] }))]).then(([value, config]) => {
      if (!live) return;
      let allowed = false;
      try { allowed = config.origins.includes(new URL(document.referrer).origin); } catch { /* direct/untrusted entry needs a tap */ }
      setTrusted(allowed); setState(value);
      if (!value.notice || value.context.items.length) launchEntry(allowed);
    });
    return () => { live = false; };
  }, []);
  if (!state || (!state.context.items.length && !state.notice && !entry.voice)) return null;
  return <section aria-label="Artefakt-Kontext" className="max-h-60 shrink-0 overflow-auto border-b border-white/[0.06] px-4 py-3 text-sm">
    {entry.voice && !trusted && <button className="mb-3 rounded-xl bg-white/15 px-4 py-3 font-semibold" onClick={() => { if (entry.voice) { setVoiceOption(entry.voice); void startVoice(); } }}>Sprachsitzung starten ({optionByKey(entry.voice).label})</button>}
    {entry.voice && suggestion && <button className="mb-3 block rounded-xl border border-white/20 px-3 py-2 text-left" onClick={() => { if (sendVoiceText(suggestion)) setSuggestion(''); }}>Vorgeschlagene Frage: {suggestion}</button>}
    {state.notice && <p role="status" className="text-mute">{state.notice}</p>}
    {state.context.items.length > 0 && <p className="mb-2 text-xs text-mute">Artefakt-Kontext</p>}
    {state.context.items.map(item => <article key={item.id} className="mb-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
      <p><span className="mr-2 text-mute">a#{item.id}</span><span>{item.title}</span></p>
      <p className="mt-2 text-dim">{item.summary}</p>
      {item.superseded_by ? <p className="mt-1 text-amber-300">abgelöst durch a#{item.superseded_by}</p> : item.status === 'retired' && <p className="mt-1 text-amber-300">zurückgezogen</p>}
      {item.stale && <p className="mt-1 text-mute">Referenzen möglicherweise veraltet.</p>}
      <details className="mt-2 text-xs text-mute">
        <summary className="cursor-pointer">Referenzen ({item.refs.length})</summary>
        <ul className="mt-2 space-y-1">{item.refs.map((ref, i) => <li key={i} className="break-all">{i + 1}. {ref.label || 'Referenz'} · {ref.target}</li>)}</ul>
      </details>
    </article>)}
  </section>;
}
