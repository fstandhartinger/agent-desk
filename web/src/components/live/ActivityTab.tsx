import { useState } from 'react';
import { Activity as ActivityIcon, AudioLines, Bot, Clapperboard, MessageSquare, Settings2 } from 'lucide-react';
import { useStore } from '../../lib/store';
import { activityStore, liveStore, toolLabel, type Source } from '../../lib/activity';
import LiveCanvas from '../../viz/LiveCanvas';
import { activityRow } from '../../viz/describe';
import { fmtClock } from '../../lib/format';
import { useAutoScroll } from '../ui/useAutoScroll';
import Segmented from '../ui/Segmented';
import Empty from '../ui/Empty';

const ICON: Record<Source, typeof Bot> = { chat: MessageSquare, voice: AudioLines, claude: Bot, explainer: Clapperboard, system: Settings2 };
const TONE: Record<string, string> = { moss: 'bg-moss', papaya: 'bg-papaya', violet: 'bg-violet', amber: 'bg-amber', red: 'bg-danger', neutral: 'bg-white/30' };
type Filter = 'all' | 'chat' | 'voice' | 'claude';


export default function ActivityTab() {
  const all = useStore(activityStore);
  const [filter, setFilter] = useState<Filter>('all');
  const items = filter === 'all' ? all : all.filter((a) => a.source === filter);
  const { ref } = useAutoScroll<HTMLDivElement>(items.length);
  // The deterministic activity map (only when the gateway runs with DESK_ACTIVITY_VIZ=1) lives here now; the main
  // canvas belongs to the generative canvas.
  const live = useStore(liveStore);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {live.spec && (
        <div className="relative mx-3 mt-3 h-[220px] shrink-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-ink-900 lg:mx-4">
          <LiveCanvas spec={live.spec} activity={live.tools.slice(-8).map((t) => ({ name: t.name, status: t.status }))} className="absolute inset-0" />
        </div>
      )}
      {/* Phones: 44 px tap targets for the filter chips. */}
      <div className="px-3 pb-2 pt-3 lg:px-4 max-lg:[&_button]:min-h-11 max-lg:[&_button]:px-4">
        <Segmented
          label="Filter"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Alle' },
            { value: 'chat', label: 'Chat' },
            { value: 'voice', label: 'Stimme' },
            { value: 'claude', label: 'Claude' },
          ]}
        />
      </div>
      <div ref={ref} className="scroll-y min-h-0 flex-1 px-3 pb-4 lg:px-4">
        {items.length === 0 ? (
          <Empty icon={<ActivityIcon className="h-5 w-5" />} title="Noch keine Aktivität">
            Werkzeugaufrufe, Sprachsitzungen und Claude-Ereignisse erscheinen hier in zeitlicher Reihenfolge.
          </Empty>
        ) : (
          <ol className="relative space-y-0.5 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-white/[0.06]">
            {items.map((a) => {
              const Icon = ICON[a.source];
              const { label, detail } = activityRow(a, toolLabel);
              return (
                <li key={a.id} className="relative flex animate-fade gap-3 rounded-xl py-1.5 pl-1 pr-2 hover:bg-white/[0.025]">
                  <span className="relative z-10 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-ink-800 text-dim">
                    <Icon className="h-3 w-3" />
                    <span className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-ink-900 ${TONE[a.tone]}`} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg-2">{label}</span>
                      <span className="shrink-0 text-[11px] text-mute tabular">{fmtClock(a.ts)}</span>
                    </div>
                    {detail && <p className="truncate text-[12px] text-mute">{detail}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
