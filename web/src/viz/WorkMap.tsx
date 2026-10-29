// Owned by the viz slice. Renders a live map of what a Claude Code session is doing from its normalised events.
// The event list only grows, so it is folded incrementally (O(new events) per update, also for long sessions).
import { memo, useMemo, useRef } from 'react';
import { CircleDollarSign, FilePen, FileText, Folder, Sparkles, Terminal, Timer } from 'lucide-react';
import { fmtUsd, plural } from '../lib/format';
import { plainText } from '../lib/plainText';
import type { ClaudeEvent } from '../lib/types';
import { alpha, C, MONO } from './theme';
import { useElapsed } from './hooks';
import './viz.css';

export interface WorkMapProps { events: ClaudeEvent[]; className?: string }

const READ = new Set(['Read', 'NotebookRead']);
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_CMDS = 4;
const MAX_FILES_PER_DIR = 10;

interface Tile { path: string; dir: string; name: string; reads: number; edits: number; touch: number; last: 'read' | 'edit'; order: number }
interface Cmd { id: string; command: string; state: 'running' | 'ok' | 'error' }
type Now = { kind: 'text' | 'thinking' | 'tool' | 'user'; text: string } | null;
interface Work {
  state?: Extract<ClaudeEvent, { kind: 'status' }>['state']; model?: string; account?: string;
  start?: number; end?: number; files: Map<string, Tile>; cmds: Cmd[]; todos: { content: string; status: string }[];
  now: Now; cost?: number; turns?: number; error?: string; tools: Map<string, string>; touches: number; seen: number; firstSeq?: number;
}

const fresh = (): Work => ({ files: new Map(), cmds: [], todos: [], now: null, tools: new Map(), touches: 0, seen: 0 });

function fold(w: Work, e: ClaudeEvent) {
  const ts = Date.parse(e.ts) || Date.now();
  switch (e.kind) {
    case 'status':
      w.state = e.state; w.model = e.model ?? w.model; w.account = e.account ?? w.account;
      if (e.state === 'starting' || e.state === 'running') { w.start ??= ts; w.end = undefined; w.error = undefined; }
      if (e.state === 'idle' || e.state === 'stopped' || e.state === 'error') w.end ??= ts;
      break;
    case 'user': w.now = { kind: 'user', text: e.text }; break;
    case 'text_delta':
      w.now = { kind: 'text', text: ((w.now?.kind === 'text' ? w.now.text : '') + e.text).slice(-600) }; break;
    case 'text': w.now = { kind: 'text', text: e.text }; break;
    case 'thinking': w.now = { kind: 'thinking', text: e.text }; break;
    case 'tool_use': {
      w.tools.set(e.id, e.name);
      w.now = { kind: 'tool', text: `${e.name} ${e.path ?? e.command ?? e.input ?? ''}`.trim() };
      if (e.path && (READ.has(e.name) || EDIT.has(e.name))) {
        const edit = EDIT.has(e.name);
        const slash = e.path.lastIndexOf('/');
        const t = w.files.get(e.path) ?? { path: e.path, dir: slash > 0 ? e.path.slice(0, slash) : '.', name: e.path.slice(slash + 1), reads: 0, edits: 0, touch: 0, last: 'read' as const, order: w.files.size };
        w.files.set(e.path, { ...t, reads: t.reads + (edit ? 0 : 1), edits: t.edits + (edit ? 1 : 0), touch: ++w.touches, last: edit ? 'edit' : 'read' });
      }
      if (e.name === 'Bash') w.cmds = [...w.cmds, { id: e.id, command: e.command ?? e.input ?? '', state: 'running' as const }].slice(-MAX_CMDS);
      break;
    }
    case 'tool_result':
      if (w.tools.get(e.id) === 'Bash') w.cmds = w.cmds.map((c) => (c.id === e.id ? { ...c, state: e.ok ? 'ok' : 'error' } : c));
      w.tools.delete(e.id);
      break;
    case 'todo': w.todos = e.items; break;
    case 'result':
      w.end = ts; w.turns = e.turns;
      if (e.costUsd != null) w.cost = (w.cost ?? 0) + e.costUsd;
      if (e.durationMs && w.start == null) w.start = ts - e.durationMs;
      break;
    case 'error': w.error = e.message; break;
  }
}

/** Strip the directory prefix all files share so the groups show the interesting part. */
function shortDirs(dirs: string[]): Map<string, string> {
  const parts = dirs.map((d) => d.split('/'));
  let common = 0;
  while (parts.length > 1 && parts.every((p) => p.length > common + 1 && p[common] === parts[0][common])) common++;
  return new Map(dirs.map((d, i) => {
    const rest = parts[i].slice(common).join('/');
    return [d, parts.length === 1 ? parts[i].slice(-2).join('/') : rest || d];
  }));
}

function WorkMap({ events, className }: WorkMapProps) {
  const acc = useRef<Work>(fresh());
  const work = useMemo(() => {
    let w = acc.current;
    if (events.length < w.seen || (events.length && events[0].seq !== w.firstSeq)) w = acc.current = fresh();
    w.firstSeq = events[0]?.seq;
    for (let i = w.seen; i < events.length; i++) fold(w, events[i]);
    w.seen = events.length;
    return { ...w, files: [...w.files.values()] };
  }, [events]);

  const running = work.state === 'starting' || work.state === 'running';
  const elapsed = useElapsed(work.start ?? null, running ? null : work.end ?? null, running);
  const groups = useMemo(() => {
    const by = new Map<string, Tile[]>();
    for (const f of work.files) by.set(f.dir, [...(by.get(f.dir) ?? []), f]);
    const names = shortDirs([...by.keys()]);
    return [...by.entries()].map(([dir, files]) => ({ dir, label: names.get(dir)!, files }));
  }, [work.files]);

  if (!events.length) {
    return (
      <div className={`vz-root ${className ?? ''}`} style={{ background: C.bg, borderRadius: 18, padding: 24, display: 'grid', placeItems: 'center', minHeight: 200, color: C.dim, textAlign: 'center' }}>
        <div>
          <Sparkles size={28} color={C.violet} className="vz-breathe" style={{ display: 'block', margin: '0 auto 10px' }} />
          <div style={{ color: C.fg, fontWeight: 600, fontSize: 15 }}>Noch keine Claude-Code-Session</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Gib eine Aufgabe ab – hier siehst du live, woran Claude arbeitet.</div>
        </div>
      </div>
    );
  }

  const latest = Math.max(0, ...work.files.map((f) => f.touch));
  return (
    <div className={`vz-root ${className ?? ''}`} aria-label="Claude-Code-Arbeitskarte"
      style={{ background: C.bg, borderRadius: 18, padding: 18, display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <Header work={work} elapsed={elapsed} />
      <NowLine now={work.now} error={work.error} running={running} />
      {work.todos.length > 0 && <Todos todos={work.todos} />}
      {groups.length > 0 && (
        <section aria-label="Dateien" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {groups.map((g) => (
            <div key={g.dir} className="vz-rise">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C.dim, fontFamily: MONO, marginBottom: 6 }}>
                <Folder size={13} color={C.faint} /> {g.label}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {g.files.slice(-MAX_FILES_PER_DIR).map((f) => <FileTile key={f.path} f={f} latest={f.touch === latest} />)}
                {g.files.length > MAX_FILES_PER_DIR && <span style={{ alignSelf: 'center', fontSize: 12, color: C.dim }}>+{g.files.length - MAX_FILES_PER_DIR}</span>}
              </div>
            </div>
          ))}
        </section>
      )}
      {work.cmds.length > 0 && <Commands cmds={work.cmds} />}
    </div>
  );
}

const STATE: Record<string, { label: string; color: string }> = {
  starting: { label: 'Startet', color: C.violet }, running: { label: 'Arbeitet', color: C.papaya }, idle: { label: 'Wartet auf dich', color: C.moss },
  stopped: { label: 'Gestoppt', color: C.dim }, error: { label: 'Fehler', color: C.red },
};
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function Header({ work, elapsed }: { work: Omit<Work, 'files'>; elapsed: number }) {
  const st = STATE[work.state ?? 'starting'];
  const live = work.state === 'running' || work.state === 'starting';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 11px 4px 9px', borderRadius: 99, background: alpha(st.color, 0.13), color: st.color, fontWeight: 650, transition: 'background 300ms, color 300ms' }}>
        <span style={{ position: 'relative', width: 8, height: 8, borderRadius: 8, background: st.color }}>
          {live && <span className="vz-ring" style={{ position: 'absolute', inset: 0, borderRadius: 8, background: st.color }} />}
        </span>
        {st.label}
      </span>
      {(work.model || work.account) && <span style={{ color: C.dim }}>{[work.model, work.account && `Konto ${work.account}`].filter(Boolean).join(' · ')}</span>}
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 14, color: C.fg, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Timer size={14} color={C.dim} />{clock(elapsed)}</span>
        {work.cost != null && (
          <span key={work.cost} className="vz-pop" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span title="Abo – kein echter Verbrauch, nur der Gegenwert zu API-Preisen" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><CircleDollarSign size={14} color={C.moss} />≈ {fmtUsd(work.cost)} <span style={{ color: C.dim }}>API-Wert (Abo)</span></span>
            {work.turns != null && <span style={{ color: C.dim }}>· {plural(work.turns, 'Zug', 'Züge')}</span>}
          </span>
        )}
      </span>
    </div>
  );
}

function NowLine({ now, error, running }: { now: Now; error?: string; running: boolean }) {
  if (error) return <div className="vz-fade" style={{ padding: '10px 12px', borderRadius: 12, background: alpha(C.red, 0.1), color: '#fca5a5', fontSize: 14 }}>{error}</div>;
  if (!now) return null;
  const flat = now.kind === 'tool' ? now.text : plainText(now.text);
  const text = flat.length > 220 ? `…${flat.slice(-220)}` : flat;
  const color = now.kind === 'thinking' ? '#b9a5f7' : now.kind === 'tool' ? C.amber : now.kind === 'user' ? C.moss : C.fg;
  const tag = running ? { thinking: 'denkt', tool: 'macht', user: 'Auftrag', text: 'schreibt' }[now.kind] : 'zuletzt';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 12, background: C.card, borderLeft: `3px solid ${color}`, transition: 'border-color 300ms' }}>
      <span style={{ flex: 'none', fontSize: 10.5, letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 700, color, paddingTop: 3 }}>{tag}</span>
      <span style={{ fontSize: 14, lineHeight: 1.45, color: now.kind === 'thinking' ? '#cfc8ea' : C.fg, fontStyle: now.kind === 'thinking' ? 'italic' : undefined, fontFamily: now.kind === 'tool' ? MONO : undefined, wordBreak: 'break-word', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {text}{running && <span className="vz-caret" style={{ color }}>▍</span>}
      </span>
    </div>
  );
}

function Todos({ todos }: { todos: { content: string; status: string }[] }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress');
  return (
    <section aria-label={`Aufgaben ${done} von ${todos.length}`}>
      <div style={{ display: 'flex', gap: 4 }}>
        {todos.map((t, i) => (
          <span key={i} className={t.status === 'in_progress' ? 'vz-shimmer' : undefined}
            style={{ flex: 1, height: 8, borderRadius: 8, background: t.status === 'completed' ? C.moss : t.status === 'in_progress' ? C.papaya : C.line, transition: 'background 400ms' }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 7, fontSize: 13, color: C.dim, minWidth: 0 }}>
        <span style={{ color: C.fg, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{done}/{todos.length}</span>
        {active && <span key={active.content} className="vz-fade" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{active.content}</span>}
        {!active && done === todos.length && <span style={{ color: C.moss }}>alle erledigt</span>}
      </div>
    </section>
  );
}

function FileTile({ f, latest }: { f: Tile; latest: boolean }) {
  const edited = f.edits > 0;
  const tone = edited ? C.papaya : C.moss;
  const Icon = edited ? FilePen : FileText;
  return (
    <span className="vz-pop" title={`${f.path}\n${f.reads}× gelesen · ${f.edits}× geändert`}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 9, fontFamily: MONO, fontSize: 12.5,
        background: edited ? alpha(C.papaya, 0.12) : C.card, color: edited ? '#ffd9c8' : C.fg,
        border: `1px solid ${edited ? alpha(C.papaya, 0.6) : latest ? alpha(C.moss, 0.55) : C.line}`,
        boxShadow: edited ? `0 0 ${latest ? 18 : 10}px ${alpha(C.papaya, latest ? 0.45 : 0.22)}` : 'none',
        transition: 'background 400ms, border-color 400ms, box-shadow 400ms, color 400ms' }}>
      <span key={f.touch} className="vz-tile-pulse" style={{ position: 'absolute', inset: -1, borderRadius: 9, border: `1.5px solid ${tone}` }} />
      <Icon size={13} color={edited ? C.papaya : C.dim} />
      {f.name}
      {(f.reads > 1 || f.edits > 0) && <span style={{ fontSize: 11, color: edited ? C.papaya : C.dim }}>{edited ? `✎${f.edits}` : `${f.reads}×`}</span>}
    </span>
  );
}

function Commands({ cmds }: { cmds: Cmd[] }) {
  return (
    <section aria-label="Befehle" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 10, borderRadius: 12, background: '#0a0a0e', border: `1px solid ${C.line}` }}>
      {cmds.map((c, i) => {
        const color = c.state === 'running' ? C.amber : c.state === 'ok' ? C.moss : C.red;
        return (
          <div key={c.id} className="vz-rise" style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 12.5, opacity: i === cmds.length - 1 ? 1 : 0.6, minWidth: 0, transition: 'opacity 300ms' }}>
            {c.state === 'running' ? (
              <svg width={13} height={13} viewBox="0 0 12 12" style={{ flex: 'none' }} aria-label="läuft"><circle cx={6} cy={6} r={4.5} fill="none" stroke={alpha(color, 0.25)} strokeWidth={2} /><path d="M6 1.5 A4.5 4.5 0 0 1 10.5 6" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" className="vz-spin" /></svg>
            ) : <Terminal size={13} color={color} style={{ flex: 'none' }} aria-label={c.state === 'ok' ? 'ok' : 'Fehler'} />}
            <span style={{ color: C.faint }}>$</span>
            <span style={{ color: c.state === 'error' ? '#fca5a5' : C.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.command}</span>
          </div>
        );
      })}
    </section>
  );
}

// Parents re-render often (voice levels at 30 Hz, streaming text); skip work when the inputs are unchanged.
export default memo(WorkMap);
