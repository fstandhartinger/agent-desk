import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { parseArtifactUrl } from '../lib/artifactUrl';
import { sendChat } from '../lib/chat';
import { sendVoiceText, setVoiceOption, startVoice } from '../lib/voiceController';
import { voiceStore } from '../lib/voice';

type Artifact = { id: string; title: string; summary: string; refs: { target: string; label: string }[]; stale?: boolean };
type Context = { items: Artifact[]; unknown: string[] };
let boot: Promise<{ context: Context; notice: string }> | null = null;
let launched = false;
let stopQuestion: (() => void) | null = null;
/** A new login must resolve into its new server-side sid, including without a full page reload. */
export function resetArtifactEntry() { boot = null; launched = false; stopQuestion?.(); stopQuestion = null; }
function loadEntry() {
  return boot ??= (async () => {
    const entry = parseArtifactUrl(location.href);
    let context: Context = { items: [], unknown: [] };
    let notice = entry.invalid.length ? 'Ungültige Artefakt-IDs wurden ignoriert.' : '';
    if (entry.ids.length) {
      try {
        context = await api<Context>(`/api/artifacts/resolve?ids=${entry.ids.join(',')}`);
        if (context.unknown.length) notice += ' Einige Artefakte wurden nicht gefunden.';
      } catch (err) { return { context, notice: errorMessage(err) }; }
    }
    return { context, notice };
  })();
}
function launchEntry() {
  if (launched) return;
  launched = true;
  const { voice, question } = parseArtifactUrl(location.href);
  if (voice) {
    setVoiceOption(voice);
    if (question) {
      // Send exactly once, after the common voice protocol reports ready (also across an automatic fallback).
      const off = voiceStore.subscribe(() => {
        if (voiceStore.get().state !== 'listening') return;
        off();
        stopQuestion = null;
        sendVoiceText(question);
      });
      stopQuestion = off;
    }
    startVoice();
  } else if (question) void sendChat(question);
}
export default function ArtifactContext() {
  const [state, setState] = useState<{ context: Context; notice: string } | null>(null);
  useEffect(() => {
    let live = true;
    void loadEntry().then(value => { if (live) { setState(value); launchEntry(); } });
    return () => { live = false; };
  }, []);
  if (!state || (!state.context.items.length && !state.notice)) return null;
  return <section aria-label="Artefakt-Kontext" className="max-h-60 shrink-0 overflow-auto border-b border-white/[0.06] px-4 py-3 text-sm">
    {state.notice && <p role="status" className="text-mute">{state.notice}</p>}
    {state.context.items.length > 0 && <p className="mb-2 text-xs text-mute">Artefakt-Kontext</p>}
    {state.context.items.map(item => <article key={item.id} className="mb-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
      <p><span className="mr-2 text-mute">a#{item.id}</span><span>{item.title}</span></p>
      <p className="mt-2 text-dim">{item.summary}</p>
      {item.stale && <p className="mt-1 text-mute">Referenzen möglicherweise veraltet.</p>}
      <details className="mt-2 text-xs text-mute">
        <summary className="cursor-pointer">Referenzen ({item.refs.length})</summary>
        <ul className="mt-2 space-y-1">{item.refs.map((ref, i) => <li key={i} className="break-all">{i + 1}. {ref.label || 'Referenz'} · {ref.target}</li>)}</ul>
      </details>
    </article>)}
  </section>;
}
