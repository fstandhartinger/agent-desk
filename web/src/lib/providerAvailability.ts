// What the voice picker shows per provider. `/api/status` `providers[id]` is `{configured, ok, reason?, checkedAt?}`
// (gateway/src/providerHealth.js); a bare boolean (key configured) is accepted as the legacy shape.
export interface Availability {
  level: 'ok' | 'down' | 'unknown' | 'missing';
  label: string;
  reason?: string;
}

const NEEDS_CREDIT = /guthaben|quota|zugriff verweigert|billing/i;

export function availabilityOf(raw: unknown): Availability {
  if (raw === false) return { level: 'missing', label: 'Nicht konfiguriert' };
  if (raw === true || raw == null || typeof raw !== 'object') return { level: 'unknown', label: 'Status unbekannt' };
  const { configured, ok, reason } = raw as { configured?: boolean; ok?: boolean | null; reason?: string };
  if (configured === false) return { level: 'missing', label: 'Nicht konfiguriert' };
  if (ok === true) return { level: 'ok', label: 'Verfügbar' };
  if (ok === false) return { level: 'down', label: reason && NEEDS_CREDIT.test(reason) ? 'Braucht Guthaben' : 'Gerade gestört', reason };
  return { level: 'unknown', label: 'Status unbekannt' };
}
