import { api } from './api';
import { load, save } from './storage';
import { createStore } from './store';

export interface NamedVoice { id: string; label: string; note: string; sample: string | null }
export interface VoiceCatalog { providers: Record<string, { default: string; voices: NamedVoice[] }> }
export const VOICE_NAMES_KEY = 'desk.voiceNames.v1';
export const voiceProvider = (provider: string) => provider === 'gemini-fast' ? 'gemini' : provider;
export const voiceNamesStore = createStore<{ catalog: VoiceCatalog | null; names: Record<string, string>; active?: { provider: string; id: string | undefined } }>({ catalog: null, names: {} });
let loading: Promise<VoiceCatalog> | null = null;
let entryApplied = false;

/** Only catalogued choices survive storage or a companion URL. Both Gemini variants share one preference. */
export function installVoiceCatalog(catalog: VoiceCatalog) {
  const raw = load<unknown>(VOICE_NAMES_KEY, {});
  const names: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [p, group] of Object.entries(catalog.providers)) {
      const id = (raw as Record<string, unknown>)[p];
      if (group.voices.some((v) => v.id === id)) names[p] = id as string;
    }
  }
  voiceNamesStore.set((s) => ({ ...s, catalog, names }));
  if (!entryApplied) {
    entryApplied = true;
    applyVoiceNameEntry(globalThis.location?.search ?? '');
  }
}

export function applyVoiceNameEntry(search: string): boolean {
  const q = new URLSearchParams(search);
  const provider = q.get('voice');
  const id = q.get('voiceName');
  return q.get('companion') === '1' && !!provider && !!id && setVoiceName(provider, id);
}

export function ensureVoiceCatalog(): Promise<VoiceCatalog> {
  const catalog = voiceNamesStore.get().catalog;
  if (catalog) return Promise.resolve(catalog);
  if (!loading) loading = api<VoiceCatalog>('/api/voices', { signal: AbortSignal.timeout(8000) }).then((c) => { installVoiceCatalog(c); return c; }).finally(() => { loading = null; });
  return loading;
}

export function selectedVoiceName(provider: string): string | undefined {
  const p = voiceProvider(provider);
  const { catalog, names } = voiceNamesStore.get();
  if (!catalog || !Object.hasOwn(catalog.providers, p)) return undefined;
  return names[p] ?? catalog?.providers[p]?.default;
}

export async function voiceNameForStart(provider: string): Promise<string | undefined> {
  await ensureVoiceCatalog().catch(() => undefined); // a catalog outage still permits the gateway's validated default
  const id = selectedVoiceName(provider);
  voiceNamesStore.set((s) => ({ ...s, active: { provider: voiceProvider(provider), id } }));
  return id;
}

export function setVoiceName(provider: string, id: string): boolean {
  const p = voiceProvider(provider);
  const { catalog, names } = voiceNamesStore.get();
  if (!catalog || !Object.hasOwn(catalog.providers, p) || !catalog.providers[p].voices.some((v) => v.id === id)) return false;
  const next = { ...names, [p]: id };
  save(VOICE_NAMES_KEY, next);
  voiceNamesStore.set((s) => ({ ...s, catalog, names: next }));
  return true;
}
