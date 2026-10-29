// Owned by the viz slice. Instant (model-free) visual of tool calls from chat/voice: chips fly agent -> target.
// `events` is the raw tool event stream (start/done/error share an id); the rail folds it into one chip per call.
// It always shows all five lanes: with room as lanes with chips, in a short box (< FULL_MIN_H) as a lane strip plus the
// latest calls, so no lane is ever cut off.
import { memo, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { Bot, Briefcase, Check, FolderOpen, MessagesSquare, Search, Sparkles, X, type LucideIcon } from 'lucide-react';
import type { ToolEvent } from '../lib/types';
import { alpha, C, MONO } from './theme';
import { callDetail, callTarget, toolLabel } from './describe';
import { useSize } from './hooks';
import './viz.css';

export interface ActivityRailProps { events: ToolEvent[]; className?: string; /** chips kept per lane (default 2) */ perLane?: number }

type LaneId = 'files' | 'jobs' | 'board' | 'chats' | 'claude';
const LANES: { id: LaneId; label: string; icon: LucideIcon; color: string }[] = [
  { id: 'files', label: 'Dateien', icon: FolderOpen, color: C.moss },
  { id: 'jobs', label: 'Jobs', icon: Briefcase, color: C.amber },
  { id: 'board', label: 'Board', icon: MessagesSquare, color: C.papaya },
  { id: 'chats', label: 'Chats', icon: Search, color: '#60a5fa' },
  { id: 'claude', label: 'Claude', icon: Sparkles, color: C.violet },
];

export function laneOf(tool: string): LaneId {
  if (tool.startsWith('board_')) return 'board';
  if (tool.startsWith('claude_')) return 'claude';
  if (tool === 'list_jobs' || tool === 'job_status') return 'jobs';
  if (tool === 'search_chats') return 'chats';
  return 'files'; // read_core_doc, search_files, read_file, explainer_point, anything new
}


interface Call { id: string; name: string; lane: LaneId; status: ToolEvent['status']; target: string; summary?: string; ms?: number; order: number }

/** Below this height the five lanes would not fit; the rail switches to its compact strip. */
export const FULL_MIN_H = 250;

function ActivityRail({ events, className, perLane = 2 }: ActivityRailProps) {
  const calls = useMemo(() => {
    const byId = new Map<string, Call>();
    events.forEach((e, i) => {
      const prev = byId.get(e.id);
      byId.set(e.id, {
        id: e.id, name: e.name, lane: laneOf(e.name), status: e.status,
        target: callTarget(e.name, e.args) || prev?.target || '', summary: e.summary ?? prev?.summary, ms: e.ms ?? prev?.ms,
        order: prev?.order ?? i,
      });
    });
    return [...byId.values()].sort((a, b) => b.order - a.order);
  }, [events]);

  const rootRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(rootRef);
  const busy = calls.some((c) => c.status === 'start');
  const total = calls.length;
  const compact = height > 0 && height < FULL_MIN_H;

  if (compact) {
    return (
      <div ref={rootRef} className={`vz-root ${className ?? ''}`} aria-label="Werkzeug-Aktivität"
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, background: C.bg, padding: '10px 12px', minHeight: 0, overflow: 'hidden' }}>
        <AgentBadge ref={agentRef} busy={busy} size={40} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: 1 }}>
          <div role="list" aria-label="Bereiche" style={{ display: 'flex', gap: 6, minWidth: 0 }}>
            {LANES.map((lane) => {
              const mine = calls.filter((c) => c.lane === lane.id);
              const running = mine.some((c) => c.status === 'start');
              const Icon = lane.icon;
              return (
                <span key={lane.id} role="listitem" title={lane.label} aria-label={`${lane.label}: ${mine.length} Aufrufe${running ? ', läuft' : ''}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px', borderRadius: 12, fontSize: 12, fontWeight: 600, flex: '0 1 auto', minWidth: 0,
                    color: mine.length ? C.fg : C.faint, background: running ? alpha(lane.color, 0.18) : mine.length ? alpha(lane.color, 0.08) : 'transparent',
                    border: `1px solid ${running ? alpha(lane.color, 0.7) : mine.length ? alpha(lane.color, 0.3) : C.line}`, transition: 'background 300ms, border-color 300ms, color 300ms' }}>
                  <Icon size={13} color={lane.color} strokeWidth={2.2} style={{ flex: 'none', opacity: mine.length ? 1 : 0.5 }} />
                  {width >= 520 && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.label}</span>}
                  {mine.length > 0 && <span style={{ color: C.dim, fontWeight: 500 }}>{mine.length}</span>}
                </span>
              );
            })}
          </div>
          <div aria-label="Letzte Aufrufe" style={{ display: 'flex', gap: 8, minWidth: 0, minHeight: 38 }}>
            {calls.length === 0 && <span style={{ alignSelf: 'center', fontSize: 12.5, color: C.dim }}>Noch keine Werkzeuge benutzt.</span>}
            {calls.slice(0, width >= 420 ? 2 : 1).map((c, i) => (
              <Chip key={c.id} call={c} color={LANES.find((l) => l.id === c.lane)!.color} agent={agentRef} older={i > 0} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`vz-root ${className ?? ''}`} aria-label="Werkzeug-Aktivität" role="list"
      style={{ position: 'relative', display: 'grid', gridTemplateColumns: '76px 34px 1fr', background: C.bg, borderRadius: 18, padding: '14px 14px 14px 10px', minHeight: 0, overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <AgentBadge ref={agentRef} busy={busy} size={52} />
        <div style={{ fontSize: 12, fontWeight: 600, color: C.fg }}>Agent</div>
        <div style={{ fontSize: 11, color: C.dim }}>{total ? `${total} Aufrufe` : 'wartet'}</div>
      </div>
      <Connectors active={LANES.map((l) => calls.some((c) => c.lane === l.id && c.status === 'start'))} />
      <div style={{ display: 'grid', gridTemplateRows: `repeat(${LANES.length}, minmax(40px, 1fr))`, gap: 6, minWidth: 0 }}>
        {LANES.map((lane) => {
          const mine = calls.filter((c) => c.lane === lane.id).slice(0, perLane);
          const running = mine.some((c) => c.status === 'start');
          const Icon = lane.icon;
          return (
            <div key={lane.id} role="listitem" aria-label={lane.label}
              style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, padding: '6px 8px', borderRadius: 12, background: running ? alpha(lane.color, 0.07) : 'transparent', transition: 'background 300ms' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, width: 84, flex: 'none', color: running || mine.length ? C.fg : C.dim, fontSize: 13, fontWeight: 600, transition: 'color 300ms' }}>
                <Icon size={16} color={lane.color} strokeWidth={2} style={{ opacity: running || mine.length ? 1 : 0.55, transition: 'opacity 300ms' }} />
                {lane.label}
              </div>
              <div style={{ display: 'flex', gap: 8, minWidth: 0, flex: 1, overflow: 'hidden' }}>
                {mine.length === 0 && <span style={{ alignSelf: 'center', height: 1, flex: 1, background: `repeating-linear-gradient(90deg, ${C.line} 0 4px, transparent 4px 9px)` }} />}
                {mine.map((c, i) => <Chip key={c.id} call={c} color={lane.color} agent={agentRef} older={i > 0} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentBadge({ ref, busy, size }: { ref: RefObject<HTMLDivElement | null>; busy: boolean; size: number }) {
  return (
    <div ref={ref} style={{ position: 'relative', flex: 'none', width: size, height: size, borderRadius: size, display: 'grid', placeItems: 'center', background: alpha(C.violet, 0.16), border: `1.5px solid ${alpha(C.violet, busy ? 0.95 : 0.5)}`, transition: 'border-color 300ms', boxShadow: busy ? `0 0 22px ${alpha(C.violet, 0.45)}` : 'none' }}>
      {busy && <span className="vz-ring" style={{ position: 'absolute', inset: -2, borderRadius: size + 8, border: `1.5px solid ${C.violet}` }} />}
      <Bot size={Math.round(size * 0.46)} color={C.violet} strokeWidth={2} />
    </div>
  );
}

function Connectors({ active }: { active: boolean[] }) {
  // Curves from the agent (left middle) to each lane (right, evenly spaced); flow dots while a lane is busy.
  const n = active.length;
  return (
    <svg viewBox="0 0 34 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }} aria-hidden>
      {active.map((on, i) => {
        const y = ((i + 0.5) / n) * 100;
        const d = `M0,50 C20,50 14,${y} 34,${y}`;
        const color = LANES[i].color;
        return (
          <g key={LANES[i].id}>
            <path d={d} fill="none" stroke={on ? alpha(color, 0.6) : C.line} strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ transition: 'stroke 300ms' }} />
            {on && <path d={d} fill="none" stroke={color} strokeWidth={3} vectorEffect="non-scaling-stroke" className="vz-flow" />}
          </g>
        );
      })}
    </svg>
  );
}

function Chip({ call, color, agent, older }: { call: Call; color: string; agent: RefObject<HTMLDivElement | null>; older: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Fly in from the agent node once, on mount (one layout read per chip; the animation itself is WAAPI transform).
  useLayoutEffect(() => {
    const el = ref.current, a = agent.current;
    if (!el || !a || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const from = a.getBoundingClientRect(), to = el.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + 24), dy = from.top + from.height / 2 - (to.top + to.height / 2);
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 }, { transform: `translate(${dx * 0.35}px, ${dy * 0.15}px) scale(0.85)`, opacity: 1, offset: 0.55 }, { transform: 'none', opacity: 1 }],
      { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [agent]);

  const tone = call.status === 'error' ? C.red : call.status === 'done' ? color : C.amber;
  const label = toolLabel(call.name);
  const detail = callDetail(call);
  return (
    <div ref={ref} className={call.status === 'start' ? 'vz-shimmer' : undefined} title={[label, call.target, detail !== call.target && detail].filter(Boolean).join(' · ')}
      style={{ minWidth: 0, flex: older ? '0 1 auto' : '1 1 auto', maxWidth: older ? '38%' : '100%', opacity: older ? 0.55 : 1, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px 6px 8px', borderRadius: 10, background: call.status === 'error' ? alpha(C.red, 0.12) : C.card, border: `1px solid ${alpha(tone, call.status === 'start' ? 0.7 : 0.4)}`, transition: 'border-color 300ms, background 300ms, opacity 300ms' }}>
      <span style={{ flex: 'none', width: 18, height: 18, borderRadius: 18, display: 'grid', placeItems: 'center', background: alpha(call.status === 'done' ? C.moss : tone, 0.18) }}>
        {call.status === 'start' ? (
          <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden><path d="M6 1.5 A4.5 4.5 0 0 1 10.5 6" fill="none" stroke={tone} strokeWidth={2} strokeLinecap="round" className="vz-spin" /></svg>
        ) : call.status === 'error' ? <X size={12} color={C.red} strokeWidth={3} /> : <Check size={12} color={C.moss} strokeWidth={3} />}
      </span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: C.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}{call.ms != null && call.status !== 'start' && <span style={{ fontWeight: 500, color: C.dim }}> · {call.ms < 1000 ? `${call.ms} ms` : `${(call.ms / 1000).toFixed(1)} s`}</span>}
        </span>
        {detail && <span key={call.status} className="vz-fade" style={{ fontSize: 11.5, color: call.status === 'error' ? '#fca5a5' : C.dim, fontFamily: call.status === 'start' ? MONO : undefined, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{detail}</span>}
      </span>
    </div>
  );
}

// Parents re-render often (voice levels at 30 Hz, streaming text); skip work when the inputs are unchanged.
export default memo(ActivityRail);
