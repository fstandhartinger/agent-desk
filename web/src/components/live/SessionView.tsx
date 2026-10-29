import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowUp, Brain, ChevronDown, ChevronRight, CircleAlert, CircleCheck, FilePen, FileText, Flag, Loader2, Map as MapIcon, Search, Square, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react';
import { followSession, noteSessionState, sendToSession, stopSession, type StreamState } from '../../lib/claude';
import { foldClaude, type Block } from '../../lib/claudeView';
import { logActivity } from '../../lib/activity';
import { errorMessage } from '../../lib/api';
import { toast } from '../../lib/toast';
import { fmtDuration, fmtUsd, plural } from '../../lib/format';
import type { ClaudeEvent } from '../../lib/types';
import { useMedia } from '../../lib/useMedia';
import { useAutoScroll } from '../ui/useAutoScroll';
import Markdown from '../chat/Markdown';
import WorkMap from '../../viz/WorkMap';
import StateBadge from './StateBadge';

const MAX_EVENTS = 4000;

export default function SessionView({ sid, title, onBack }: { sid: string; title: string; onBack: () => void }) {
  const [events, setEvents] = useState<ClaudeEvent[]>([]);
  const [conn, setConn] = useState<StreamState>('connecting');
  const desktop = useMedia('(min-width: 1024px)');
  // On phones the work map would take half the screen: it starts collapsed to a one-line summary.
  const [showMap, setShowMap] = useState(desktop);

  useEffect(() => {
    setEvents([]);
    let pending: ClaudeEvent[] = [];
    let raf = 0;
    // Batch bursts (replays deliver hundreds of events at once) into one render per frame.
    const flush = () => {
      raf = 0;
      const batch = pending;
      pending = [];
      setEvents((e) => [...e, ...batch].slice(-MAX_EVENTS));
    };
    const stop = followSession(
      sid,
      (ev) => {
        pending.push(ev);
        if (ev.kind === 'tool_use') logActivity('claude', `Claude: ${ev.name}`, ev.path ?? ev.command ?? ev.input, 'papaya');
        else if (ev.kind === 'status') {
          logActivity('claude', `Claude ${ev.state}`, sid, ev.state === 'error' ? 'red' : 'amber');
          noteSessionState(sid, ev.state);
        }
        if (!raf) raf = requestAnimationFrame(flush);
      },
      setConn,
    );
    return () => {
      stop();
      cancelAnimationFrame(raf);
    };
  }, [sid]);

  const view = useMemo(() => foldClaude(events), [events]);
  const busy = view.state === 'running' || view.state === 'starting';
  const last = view.blocks[view.blocks.length - 1];
  const { ref } = useAutoScroll<HTMLDivElement>(`${view.blocks.length}:${last?.kind === 'text' ? last.text.length : 0}`);
  const done = view.todos.filter((t) => t.status === 'completed').length;
  const cost = view.blocks.reduce((sum, b) => sum + (b.kind === 'result' ? b.costUsd ?? 0 : 0), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-white/[0.05] px-3 py-2.5">
        <button type="button" onClick={onBack} aria-label="Zurück zur Liste" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-dim hover:bg-white/[0.06] hover:text-fg">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-fg">{title}</p>
          <p className="flex items-center gap-2 text-xs text-mute">
            <StateBadge state={view.state} />
            {view.model && <span className="capitalize">{view.model}</span>}
            {view.account && <span>Konto {view.account}</span>}
            {conn !== 'live' && <span className="text-amber">{conn === 'connecting' ? 'verbinde …' : 'verbinde neu …'}</span>}
          </p>
        </div>
        <button type="button" onClick={() => setShowMap((s) => !s)} aria-pressed={showMap} aria-label="Arbeitskarte ein/aus" title="Arbeitskarte" className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${showMap ? 'bg-white/[0.07] text-fg' : 'text-dim hover:bg-white/[0.06]'}`}>
          <MapIcon className="h-4 w-4" />
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => stopSession(sid).catch((e) => toast(`Stopp fehlgeschlagen: ${errorMessage(e)}`, 'error', undefined, { label: 'Erneut versuchen', run: () => void stopSession(sid).catch(() => {}) }))}
            className="flex h-9 items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-3 text-[13px] font-medium text-red-200 transition-colors hover:bg-danger/20"
          >
            <Square className="h-3 w-3" fill="currentColor" /> Stopp
          </button>
        )}
      </div>

      {/* The work map shows the todo bar itself; with the map off, phones get one summary line and larger screens the list. */}
      {!showMap && !desktop && (
        <button type="button" onClick={() => setShowMap(true)} aria-label="Arbeitskarte öffnen" className="flex items-center gap-2 border-b border-white/[0.05] px-4 py-2 text-left text-xs text-dim">
          {view.todos.length > 0 && <span className="font-medium tabular text-fg-2">{done}/{view.todos.length}</span>}
          <span className="min-w-0 flex-1 truncate">{view.todos.find((t) => t.status === 'in_progress')?.content ?? `${plural(view.toolCount, 'Werkzeugaufruf', 'Werkzeugaufrufe')}`}</span>
          {cost > 0 && <span className="whitespace-nowrap text-mute">≈ {fmtUsd(cost)} API-Wert (Abo)</span>}
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
      )}
      {!showMap && desktop && view.todos.length > 0 && (
        <div className="border-b border-white/[0.05] px-4 py-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-fg-2">Aufgaben</span>
            <span className="text-mute tabular">{done}/{view.todos.length}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-gradient-to-r from-moss to-moss-light transition-[width] duration-500" style={{ width: `${(done / view.todos.length) * 100}%` }} />
          </div>
          <ul className="mt-2 space-y-0.5">
            {view.todos.slice(0, 6).map((t, i) => (
              <li key={i} className={`flex items-center gap-2 text-[12.5px] ${t.status === 'completed' ? 'text-mute line-through' : t.status === 'in_progress' ? 'text-fg' : 'text-dim'}`}>
                {t.status === 'completed' ? <CircleCheck className="h-3.5 w-3.5 shrink-0 text-moss" /> : t.status === 'in_progress' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-papaya" /> : <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full border border-white/25" />}
                <span className="truncate">{t.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Normal flow with a height cap: the map scrolls inside itself and never draws over the thread (critic D5). */}
      {showMap && (
        <div data-testid="workmap" className="scroll-y max-h-[42%] shrink-0 border-b border-white/[0.05]">
          <WorkMap events={events} />
        </div>
      )}

      <div ref={ref} className="scroll-y min-h-0 flex-1 space-y-2.5 px-4 py-3">
        {view.blocks.length === 0 && (
          <div className="flex items-center gap-2 py-6 text-sm text-dim">
            <Loader2 className="h-4 w-4 animate-spin" /> Warte auf die ersten Ereignisse …
          </div>
        )}
        {view.blocks.map((b) => <BlockView key={b.key} b={b} live={busy} />)}
      </div>

      <FollowUp sid={sid} busy={busy} />
    </div>
  );
}

const TOOL_ICON: Record<string, LucideIcon> = { Read: FileText, Edit: FilePen, Write: FilePen, MultiEdit: FilePen, Bash: SquareTerminal, Grep: Search, Glob: Search };

function BlockView({ b, live }: { b: Block; live: boolean }) {
  switch (b.kind) {
    case 'user':
      return <div className="ml-auto w-fit max-w-[90%] animate-rise rounded-2xl rounded-br-md border border-white/[0.08] bg-white/[0.06] px-3.5 py-2 text-[14px] text-fg">{b.text}</div>;
    case 'text':
      return (
        <div className="animate-fade text-[14px]">
          <Markdown text={b.text} />
          {b.live && <span className="caret" aria-hidden />}
        </div>
      );
    case 'thinking':
      return <Collapsible icon={Brain} label="Gedanken" tone="text-mute"><p className="whitespace-pre-wrap text-[12.5px] italic leading-relaxed text-mute">{b.text}</p></Collapsible>;
    case 'tool':
      return <ToolRow b={b} live={live} />;
    case 'result':
      if (b.stopped) {
        return (
          <div className="flex animate-fade items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12.5px] text-dim">
            <Square className="h-3 w-3" fill="currentColor" />
            <span className="font-medium">Gestoppt</span>
          </div>
        );
      }
      return (
        <div className="flex animate-fade flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl border border-moss/20 bg-moss/[0.06] px-3 py-2 text-[12.5px] text-moss">
          <Flag className="h-3.5 w-3.5" />
          <span className="whitespace-nowrap font-medium">Runde fertig</span>
          <span className="whitespace-nowrap text-moss/70">{[b.durationMs != null && fmtDuration(b.durationMs), b.turns != null && plural(b.turns, 'Zug', 'Züge')].filter(Boolean).join(' · ')}</span>
          {/* Claude runs on the subscription: the figure is what the same work would cost via the API, not real spend. */}
          {b.costUsd != null && b.costUsd > 0 && <span className="ml-auto whitespace-nowrap text-moss/60" title="Claude läuft im Abo – das ist der geschätzte API-Gegenwert, keine echte Ausgabe.">≈ {fmtUsd(b.costUsd)} API-Wert (Abo)</span>}
        </div>
      );
    case 'error':
      return (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger/20 bg-danger/[0.06] px-3 py-2 text-[13px] text-red-200">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> {b.message}
        </div>
      );
  }
}

function ToolRow({ b, live }: { b: Extract<Block, { kind: 'tool' }>; live: boolean }) {
  const Icon = TOOL_ICON[b.name] ?? Wrench;
  const target = b.path ?? b.command ?? b.input ?? '';
  const pending = !b.result && live; // a tool without a result in a stopped session is no longer running
  const edit = /Edit|Write/.test(b.name);
  return (
    <Collapsible
      icon={Icon}
      tone={pending ? 'text-papaya' : b.result?.ok === false ? 'text-danger' : edit ? 'text-papaya' : 'text-dim'}
      label={b.name}
      detail={target}
      status={!b.result && !live ? <Square className="h-3 w-3 text-mute" /> : pending ? <Loader2 className="h-3.5 w-3.5 animate-spin text-papaya" /> : b.result?.ok === false ? <CircleAlert className="h-3.5 w-3.5 text-danger" /> : <CircleCheck className="h-3.5 w-3.5 text-moss/80" />}
    >
      {b.command && <pre className="whitespace-pre-wrap break-all font-mono text-[12px] text-fg-2">$ {b.command}</pre>}
      {b.input && !b.command && <pre className="whitespace-pre-wrap break-all font-mono text-[12px] text-dim">{b.input}</pre>}
      {b.result?.preview && <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-ink-950 p-2.5 font-mono text-[11.5px] leading-relaxed text-mute">{b.result.preview}</pre>}
    </Collapsible>
  );
}

function Collapsible({ icon: Icon, label, detail, status, tone, children }: { icon: LucideIcon; label: string; detail?: string; status?: React.ReactNode; tone: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="animate-fade rounded-xl border border-white/[0.06] bg-white/[0.02]">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-mute" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-mute" />}
        <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
        <span className="shrink-0 text-[12.5px] font-medium text-fg-2">{label}</span>
        {detail && <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute">{detail}</span>}
        {!detail && <span className="flex-1" />}
        {status}
      </button>
      {open && <div className="border-t border-white/[0.05] px-3 py-2.5">{children}</div>}
    </div>
  );
}

export function FollowUp({ sid, busy }: { sid: string; busy: boolean }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await sendToSession(sid, t);
      setText('');
    } catch (e) {
      toast(`Nachricht nicht zugestellt: ${errorMessage(e)}`, 'error', undefined, { label: 'Erneut senden', run: () => void send() });
    } finally {
      setSending(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  return (
    <div className="border-t border-white/[0.05] p-3">
      <div className="flex items-end gap-2 rounded-2xl border border-white/[0.08] bg-ink-800 py-1.5 pl-3.5 pr-1.5 focus-within:border-white/[0.16]">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          aria-label="Nachricht an Claude"
          placeholder={busy ? 'Wird nach diesem Schritt zugestellt …' : 'Nachfrage an Claude …'}
          className="max-h-32 min-h-[36px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-6 text-fg outline-none placeholder:text-mute"
        />
        <button type="button" onClick={() => void send()} disabled={!text.trim() || sending} aria-label="An Claude senden" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${text.trim() ? 'bg-papaya text-white hover:bg-[#ff7a3d]' : 'bg-white/[0.06] text-mute'}`}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" strokeWidth={2.4} />}
        </button>
      </div>
    </div>
  );
}
