import type { ProviderHealth } from '../../lib/status';

const TONE = { ok: 'bg-moss', failed: 'bg-amber', unknown: 'bg-white/30', off: 'bg-white/10 ring-1 ring-white/20' } as const;

/** Green = works, amber = recent vendor failure, grey = configured but untested, hollow = no key. */
export default function HealthDot({ health, className = 'h-1.5 w-1.5' }: { health: ProviderHealth | undefined; className?: string }) {
  return <span aria-hidden className={`shrink-0 rounded-full ${TONE[health?.state ?? 'unknown']} ${className}`} />;
}
