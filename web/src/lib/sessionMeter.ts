import { fmtTime, fmtUsd } from './format';

/** "3:12 · $0.16 · heute $1.57": session timer, this session's cost and today's Desk total. $ = USD, what the providers bill. Unknown parts are left out. */
export function meterText(elapsedS: number, usage: { costUsd: number; dayUsd?: number } | null): string {
  return [fmtTime(elapsedS), usage ? fmtUsd(usage.costUsd) : '', usage?.dayUsd != null ? `heute ${fmtUsd(usage.dayUsd)}` : ''].filter(Boolean).join(' · ');
}
