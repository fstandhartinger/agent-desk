import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, MessageSquare, Plus, Search, Trash2, X } from 'lucide-react';
import { useStore } from '../../lib/store';
import { convStore, dayGroup, deleteConversation, libraryStore, newConversation, openConversation, searchConversations, type ConversationMeta, type DayGroup } from '../../lib/conversation';
import { stopChat } from '../../lib/chat';
import { sessionsStore } from '../../lib/claude';
import { fmtAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import StateBadge from '../live/StateBadge';

const GROUPS: DayGroup[] = ['Heute', 'Gestern', 'Letzte 7 Tage', 'Älter'];

export const openClaudeSession = (sid: string) => window.dispatchEvent(new CustomEvent('desk:open-claude-session', { detail: sid }));

/** Conversation memory: past chats (localStorage) plus Claude Code sessions, with search and delete. */
export default function History({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [armed, setArmed] = useState<string | null>(null);
  const library = useStore(libraryStore);
  const currentId = useStore(convStore, (c) => c.id);
  const sessions = useStore(sessionsStore, (s) => s.list);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => input.current?.focus());
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // `library` is a dependency on purpose: a changed list re-runs the search.
  const hits = useMemo(() => searchConversations(query), [query, library]);
  const q = query.trim().toLowerCase();
  const claude = sessions.filter((s) => !q || s.title.toLowerCase().includes(q)).slice(0, 8);
  const grouped = GROUPS.map((g) => ({ g, items: hits.filter((m) => dayGroup(m.updatedAt) === g) })).filter((x) => x.items.length);

  const pick = (id: string) => {
    if (id !== currentId) stopChat();
    openConversation(id);
    onClose();
  };
  const remove = (m: ConversationMeta) => {
    if (armed !== m.id) return setArmed(m.id);
    if (m.id === currentId) stopChat();
    deleteConversation(m.id);
    setArmed(null);
    toast(`„${m.title}“ gelöscht.`, 'success');
  };

  return (
    <div className={`absolute inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} inert={!open}>
      <div onClick={onClose} className={`absolute inset-0 bg-ink-950/60 backdrop-blur-[2px] transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Verlauf"
        className={`absolute inset-y-0 left-0 flex w-full max-w-[340px] flex-col border-r border-white/[0.07] bg-ink-850 shadow-[20px_0_60px_-20px_rgb(0_0_0/0.8)] transition-transform duration-300 ease-out ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          <p className="flex-1 pl-1 text-[15px] font-semibold text-fg">Verlauf</p>
          <button type="button" onClick={onClose} aria-label="Verlauf schließen" className="flex h-11 w-11 items-center justify-center rounded-full text-dim hover:bg-white/[0.06] hover:text-fg lg:h-9 lg:w-9">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-2 px-3 pb-3">
          <button type="button" onClick={() => { stopChat(); newConversation(); onClose(); }}
            className="flex h-11 w-full items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 text-[14px] font-medium text-fg transition-colors hover:bg-white/[0.08]">
            <Plus className="h-4 w-4 text-moss" /> Neues Gespräch
          </button>
          <label className="flex h-11 items-center gap-2 rounded-xl border border-white/[0.06] bg-ink-900 px-3 focus-within:border-white/[0.16]">
            <Search className="h-4 w-4 shrink-0 text-mute" />
            <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Gespräche durchsuchen …" aria-label="Gespräche durchsuchen"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-mute" />
          </label>
        </div>

        <div className="scroll-y min-h-0 flex-1 px-2 pb-4">
          {grouped.length === 0 && claude.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-dim">{q ? `Nichts gefunden für „${query.trim()}“.` : 'Noch keine früheren Gespräche. Alles, was du fragst, landet hier.'}</p>
          )}
          {grouped.map(({ g, items }) => (
            <section key={g} className="mb-3">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">{g}</p>
              <ul>
                {items.map((m) => (
                  <li key={m.id} className="group relative">
                    <button type="button" onClick={() => pick(m.id)} aria-current={m.id === currentId ? 'true' : undefined}
                      className={`flex w-full items-start gap-2.5 rounded-xl py-2.5 pl-3 pr-12 text-left transition-colors ${m.id === currentId ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}>
                      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-mute" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-fg">{m.title}</span>
                        <span className="block truncate text-xs text-mute">{fmtAgo(m.updatedAt)}{m.preview ? ` · ${m.preview}` : ''}</span>
                      </span>
                    </button>
                    <button type="button" onClick={() => remove(m)} onBlur={() => setArmed((a) => (a === m.id ? null : a))}
                      aria-label={armed === m.id ? `„${m.title}“ wirklich löschen` : `„${m.title}“ löschen`} title={armed === m.id ? 'Nochmal tippen zum Löschen' : 'Löschen'}
                      className={`absolute right-1 top-1/2 flex h-11 -translate-y-1/2 items-center justify-center rounded-lg transition-[opacity,background-color] lg:h-9 ${armed === m.id ? 'w-auto bg-danger/15 px-2.5 text-[12px] font-medium text-red-200 opacity-100' : 'w-11 text-mute opacity-100 hover:bg-white/[0.06] hover:text-red-200 lg:w-9 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100'}`}>
                      {armed === m.id ? 'Löschen?' : <Trash2 className="h-4 w-4" />}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {claude.length > 0 && (
            <section className="mb-3">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">Claude-Sitzungen</p>
              <ul>
                {claude.map((s) => (
                  <li key={s.sid}>
                    <button type="button" onClick={() => { openClaudeSession(s.sid); onClose(); }}
                      className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]">
                      <Bot className={`mt-0.5 h-4 w-4 shrink-0 ${s.state === 'running' || s.state === 'starting' ? 'text-papaya' : 'text-mute'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] text-fg">{s.title}</span>
                        <span className="flex items-center gap-2 text-xs text-mute">
                          <StateBadge state={s.state} />
                          {(s.updatedAt ?? s.createdAt) && <span>{fmtAgo((s.updatedAt ?? s.createdAt)!)}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
