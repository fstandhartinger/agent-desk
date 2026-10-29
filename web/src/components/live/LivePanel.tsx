import { useEffect, useState } from 'react';
import { Activity, Bot, Clapperboard, Maximize2, Minimize2, Shapes } from 'lucide-react';
import { useStore } from '../../lib/store';
import { sessionsStore } from '../../lib/claude';
import { useMedia } from '../../lib/useMedia';
import { layoutStore, pickerStore, setPicker, toggleCanvasBig } from '../../lib/layout';
import { pageStore } from '../../lib/page';
import CanvasTab from './CanvasTab';
import ClaudeTab from './ClaudeTab';
import ActivityTab from './ActivityTab';

type Tab = 'canvas' | 'claude' | 'activity';
const TABS: { id: Tab; label: string; icon: typeof Shapes }[] = [
  { id: 'canvas', label: 'Canvas', icon: Shapes },
  { id: 'claude', label: 'Claude', icon: Bot },
  { id: 'activity', label: 'Aktivität', icon: Activity },
];

export default function LivePanel({ initialTab = 'canvas' }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => {
    const toClaude = () => setTab('claude');
    window.addEventListener('desk:new-claude-task', toClaude);
    window.addEventListener('desk:open-claude-session', toClaude);
    return () => {
      window.removeEventListener('desk:new-claude-task', toClaude);
      window.removeEventListener('desk:open-claude-session', toClaude);
    };
  }, []);
  const running = useStore(sessionsStore, (s) => s.list.filter((x) => x.state === 'running' || x.state === 'starting').length);
  const desktop = useMedia('(min-width: 1024px)');
  const explainerOn = useStore(pageStore, (s) => !!s.slug || !!s.explainer);
  const canvasBig = useStore(layoutStore, (s) => !!s.canvasBig);
  const picker = useStore(pickerStore, (s) => s.open);
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Live-Ansichten" className="flex shrink-0 gap-1 overflow-x-auto px-3 pt-3 lg:pl-4 lg:pr-12">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            id={`live-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`live-panel-${id}`}
            onClick={() => setTab(id)}
            title={label}
            className={`relative flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors lg:h-9 lg:px-3 lg:@max-[460px]:px-2.5 ${tab === id ? 'bg-white/[0.08] text-fg' : 'text-dim hover:bg-white/[0.04] hover:text-fg-2'}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {id === 'claude' && running > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-papaya px-1 text-[10px] font-bold text-white tabular">{running}</span>
            )}
          </button>
        ))}
        {desktop && (
          <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
            {explainerOn ? (
              <button type="button" onClick={toggleCanvasBig} aria-pressed={canvasBig}
                title={canvasBig ? 'Canvas wieder klein, Erklärung groß' : 'Canvas groß, Erklärung klein (Video läuft weiter)'}
                className={`flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium transition-colors @max-[460px]:px-2.5 ${canvasBig ? 'bg-violet/15 text-violet-light hover:bg-violet/25' : 'text-dim hover:bg-white/[0.06] hover:text-fg'}`}>
                {canvasBig ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                <span className="@max-[460px]:sr-only">{canvasBig ? 'Klein' : 'Groß'}</span>
              </button>
            ) : (
              <button type="button" onClick={() => setPicker(!picker)} aria-expanded={picker}
                title="Eine Erklärseite neben der Canvas öffnen"
                className={`flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium transition-colors ${picker ? 'bg-white/[0.08] text-fg' : 'text-dim hover:bg-white/[0.06] hover:text-fg'}`}>
                <Clapperboard className="h-3.5 w-3.5" />
                Erklärung laden
              </button>
            )}
          </div>
        )}
      </div>
      {TABS.map(({ id }) => (
        <div key={id} role="tabpanel" id={`live-panel-${id}`} aria-labelledby={`live-tab-${id}`} hidden={tab !== id} className="min-h-0 flex-1">
          {id === 'canvas' && <CanvasTab />}
          {id === 'claude' && <ClaudeTab active={tab === 'claude'} />}
          {id === 'activity' && <ActivityTab />}
        </div>
      ))}
    </div>
  );
}
