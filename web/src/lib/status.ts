import { useEffect } from 'react';
import { createStore, useStore } from './store';
import { availabilityOf, type Availability } from './providerAvailability';

export type ProviderId = 'xai' | 'openai' | 'gemini';
/** ok: last real use worked; failed: recent vendor failure (reason); unknown: configured, not yet used; off: no key. */
export type HealthState = 'ok' | 'failed' | 'unknown' | 'off';
export interface ProviderHealth { state: HealthState; reason?: string }
export interface DeskStatus {
  loaded: boolean;
  reachable: boolean;
  bridges: { host: string; connected: boolean; running?: number; max?: number }[];
  spendToday: number | null;
  capUsd: number | null;
  providers: Partial<Record<ProviderId, ProviderHealth>>;
  providerHealth: Partial<Record<ProviderId, Availability>>;
}

export const statusStore = createStore<DeskStatus>({ loaded: false, reachable: true, bridges: [], spendToday: null, capUsd: null, providers: {}, providerHealth: {} });

const num = (...vals: unknown[]) => {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
};
// Accepts the providerHealth snapshot ({configured, ok, reason}) and the older boolean "configured" flag.
export function healthOf(v: unknown): ProviderHealth | undefined {
  if (typeof v === 'boolean') return { state: v ? 'unknown' : 'off' };
  if (!v || typeof v !== 'object') return undefined;
  const h = v as { configured?: boolean; ok?: boolean | null; reason?: string };
  if (h.configured === false) return { state: 'off' };
  if (h.ok === true) return { state: 'ok' };
  if (h.ok === false) return { state: 'failed', reason: typeof h.reason === 'string' && h.reason ? h.reason : undefined };
  return { state: 'unknown' };
}

const HEALTH_TEXT: Record<HealthState, string> = { ok: 'funktioniert', failed: 'gerade gestört', unknown: 'eingerichtet, noch nicht genutzt', off: 'nicht eingerichtet' };
export const healthText = (h: ProviderHealth | undefined) => (h ? (h.state === 'failed' && h.reason ? h.reason : HEALTH_TEXT[h.state]) : 'Status unbekannt');

// `/api/status` is owned by gateway-core; this parser accepts the plausible shapes instead of one exact one.
export function normalizeStatus(raw: Record<string, any>): DeskStatus {
  const bridges = (Array.isArray(raw.bridges) ? raw.bridges : []).map((b: any) => ({
    host: String(b.host ?? 'bridge'),
    connected: b.connected !== false,
    running: num(b.claude?.running) ?? undefined,
    max: num(b.claude?.max) ?? undefined,
  }));
  const prov = raw.providers ?? raw.configured ?? raw.voice ?? {};
  const providers: DeskStatus['providers'] = {};
  const providerHealth: DeskStatus['providerHealth'] = {};
  for (const id of ['xai', 'openai', 'gemini'] as const) {
    const entry = prov[id] ?? (id === 'gemini' ? prov.google : undefined);
    const h = healthOf(entry);
    if (h) {
      providers[id] = h;
      providerHealth[id] = availabilityOf(entry);
    }
  }
  return {
    loaded: true,
    reachable: true,
    bridges,
    spendToday: num(raw.spendToday, raw.costToday, raw.spend?.today, raw.spend?.usd, raw.limits?.costToday),
    capUsd: num(raw.capUsd, raw.dailyCapUsd, raw.spend?.cap, raw.limits?.dailyUsdCap, raw.limits?.capUsd),
    providers,
    providerHealth,
  };
}

async function poll() {
  try {
    const res = await fetch('/api/status', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    statusStore.set(normalizeStatus(await res.json()));
  } catch {
    statusStore.set((s) => ({ ...s, loaded: true, reachable: false }));
  }
}

export function useStatusPolling(intervalMs = 15000) {
  useEffect(() => {
    void poll();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void poll(), intervalMs);
    const onVis = () => document.visibilityState === 'visible' && void poll();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [intervalMs]);
}

export const useStatus = () => useStore(statusStore);
export const bridgeOnline = (s: DeskStatus) => s.reachable && s.bridges.some((b) => b.connected);
