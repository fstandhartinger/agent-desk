import { useEffect, useState } from 'react';
import { Bot, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { useStore } from '../../lib/store';
import { refreshSessions, sessionsStore, type ClaudeSession } from '../../lib/claude';
import { fmtAgo } from '../../lib/format';
import type { ClaudeDraft } from '../../lib/handoff';
import Empty from '../ui/Empty';
import NewTaskForm from './NewTaskForm';
import SessionView from './SessionView';
import StateBadge from './StateBadge';

type View = { kind: 'list' } | { kind: 'new'; draft?: ClaudeDraft } | { kind: 'session'; sid: string };

export default function ClaudeTab({ active }: { active: boolean }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const { loaded, error, list } = useStore(sessionsStore);

  useEffect(() => {
    const draft = (e: Event) => setView({ kind: 'new', draft: (e as CustomEvent<ClaudeDraft | undefined>).detail });
    const open = (e: Event) => setView({ kind: 'session', sid: (e as CustomEvent<string>).detail });
    window.addEventListener('desk:new-claude-task', draft);
    window.addEventListener('desk:open-claude-session', open);
    return () => {
      window.removeEventListener('desk:new-claude-task', draft);
      window.removeEventListener('desk:open-claude-session', open);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    void refreshSessions();
    const t = setInterval(() => void refreshSessions(), 10000);
    return () => clearInterval(t);
  }, [active]);

  if (view.kind === 'new') return <NewTaskForm key={view.draft?.prompt ?? ''} draft={view.draft} onCancel={() => setView({ kind: 'list' })} onStarted={(sid) => setView({ kind: 'session', sid })} />;
  if (view.kind === 'session') {
    const s = list.find((x) => x.sid === view.sid);
    return <SessionView sid={view.sid} title={s?.title ?? view.sid} onBack={() => setView({ kind: 'list' })} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-mute">Sitzungen</p>
        <button type="button" onClick={() => setView({ kind: 'new' })} className="flex h-9 items-center gap-1.5 rounded-full bg-papaya px-3.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-10px_rgb(250_93_25/0.8)] transition-colors hover:bg-[#ff7a3d]">
          <Plus className="h-4 w-4" /> Neue Aufgabe
        </button>
      </div>
      <div className="scroll-y min-h-0 flex-1 px-3 pb-4">
        {error && (
          <div role="alert" className="mx-1 mb-2 flex items-center gap-3 rounded-xl border border-danger/20 bg-danger/[0.05] px-3 py-2 text-sm text-red-200">
            <span className="min-w-0 flex-1">{error}</span>
            <button type="button" onClick={() => void refreshSessions()} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-red-200 hover:bg-danger/15">
              <RefreshCw className="h-3.5 w-3.5" /> Erneut versuchen
            </button>
          </div>
        )}
        {!loaded ? (
          <div className="space-y-2 px-1 pt-1">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-[68px] rounded-2xl" />)}
          </div>
        ) : list.length === 0 ? (
          <Empty icon={<Bot className="h-5 w-5" />} title="Noch keine Claude-Sitzung">
            Gib eine Aufgabe an Claude Code – der Kontext der Seite wird mitgeschickt, die Ausgabe erscheint hier live.
          </Empty>
        ) : (
          <ul className="space-y-1.5">
            {list.map((s) => <SessionRow key={s.sid} s={s} onOpen={() => setView({ kind: 'session', sid: s.sid })} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function SessionRow({ s, onOpen }: { s: ClaudeSession; onOpen: () => void }) {
  const ts = s.updatedAt ?? s.createdAt;
  return (
    <li>
      <button type="button" onClick={onOpen} className="group flex w-full items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.045]">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${s.state === 'running' || s.state === 'starting' ? 'bg-papaya/15 text-papaya' : 'bg-white/[0.05] text-dim'}`}>
          <Bot className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-fg">{s.title}</span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-mute">
            <StateBadge state={s.state} />
            {s.model && <span className="capitalize">{s.model}</span>}
            {ts && <span>{fmtAgo(ts)}</span>}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-mute transition-transform group-hover:translate-x-0.5" />
      </button>
    </li>
  );
}
