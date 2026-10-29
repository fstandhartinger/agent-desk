import type { ClaudeState } from '../../lib/claude';

const MAP: Record<ClaudeState, { label: string; cls: string; pulse?: boolean }> = {
  starting: { label: 'startet', cls: 'text-amber', pulse: true },
  running: { label: 'arbeitet', cls: 'text-papaya', pulse: true },
  idle: { label: 'wartet', cls: 'text-moss' },
  stopped: { label: 'gestoppt', cls: 'text-dim' },
  error: { label: 'Fehler', cls: 'text-danger' },
};

export default function StateBadge({ state }: { state: ClaudeState | null }) {
  const m = MAP[state ?? 'starting'] ?? MAP.idle;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${m.cls}`}>
      <span className="relative flex h-1.5 w-1.5">
        {m.pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {m.label}
    </span>
  );
}
