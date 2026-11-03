// Live activity of the voice session (gateway event `activity`): what the desk does right now. Pure helpers: the newest line for the
// dock and the exact message the native host receives. Labels are German text from the gateway, already redacted there.
import type { ActivityEvent } from './types';

export interface ActivityLine { id: string; phase: ActivityEvent['phase']; label: string; ms?: number; reason?: string; at: number }

const PHASES = new Set(['thinking', 'heard', 'start', 'done', 'fail']);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** True for a well-formed gateway activity message. */
export function isActivity(m: unknown): m is ActivityEvent {
  const e = m as Partial<ActivityEvent> | null;
  return Boolean(e && e.type === 'activity' && typeof e.id === 'string' && e.id && PHASES.has(String(e.phase)) && typeof e.label === 'string');
}

/**
 * The line the dock shows after `e`: the newest event wins, except that the end of an older tool call never replaces a newer one that
 * is still running (it only updates its own line).
 */
export function nextActivity(prev: ActivityLine | null, e: ActivityEvent, now: number = Date.now()): ActivityLine | null {
  if ((e.phase === 'done' || e.phase === 'fail') && prev && prev.id !== e.id && prev.phase === 'start') return prev;
  return { id: e.id, phase: e.phase, label: text(e.label, 120), ...(typeof e.ms === 'number' ? { ms: e.ms } : {}), ...(e.reason ? { reason: text(e.reason, 120) } : {}), at: now };
}

/** How long a finished line stays in the dock. */
export const ACTIVITY_LINGER_MS = 6000;
