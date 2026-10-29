import { History as HistoryIcon, PanelRightClose, SquarePen } from 'lucide-react';
import { useStore } from '../../lib/store';
import { convStore, newConversation, textOf } from '../../lib/conversation';
import { stopChat } from '../../lib/chat';
import { kinoStore, setKinoChat } from '../../lib/layout';

/** Slim bar above the thread: history, current conversation title, new conversation (and hide in Kino). */
export default function ChatBar({ onHistory }: { onHistory: () => void }) {
  const title = useStore(convStore, (c) => {
    const first = c.messages.find((m) => m.role === 'user');
    return first ? textOf(first).replace(/\s+/g, ' ').trim() : '';
  });
  const empty = useStore(convStore, (c) => c.messages.length === 0);
  const kino = useStore(kinoStore, (s) => s.kino);
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-white/[0.04] px-2 lg:px-3">
      <button type="button" onClick={onHistory} aria-label="Verlauf öffnen" title="Verlauf"
        className="flex h-11 items-center gap-2 rounded-full px-3 text-[13px] font-medium text-dim transition-colors hover:bg-white/[0.06] hover:text-fg lg:h-9">
        <HistoryIcon className="h-4 w-4" />
        <span>Verlauf</span>
      </button>
      <p className="min-w-0 flex-1 truncate px-1 text-center text-[13px] text-mute" title={title || undefined}>{title || 'Neues Gespräch'}</p>
      <button type="button" disabled={empty} onClick={() => { stopChat(); newConversation(); }} aria-label="Neues Gespräch" title="Neues Gespräch"
        className="flex h-11 w-11 items-center justify-center rounded-full text-dim transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent lg:h-9 lg:w-9">
        <SquarePen className="h-4 w-4" />
      </button>
      {kino && (
        <button type="button" onClick={() => setKinoChat(false)} aria-label="Chat ausblenden" title="Chat ausblenden"
          className="flex h-9 w-9 items-center justify-center rounded-full text-dim transition-colors hover:bg-white/[0.06] hover:text-fg">
          <PanelRightClose className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
