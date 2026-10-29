import { useState } from 'react';
import { History as Keyboard, LogOut, MoreHorizontal, SquarePen, Wallet } from 'lucide-react';
import { useStore } from '../lib/store';
import { bridgeOnline, healthText, useStatus, type ProviderId } from '../lib/status';
import { runningCount, sessionsStore } from '../lib/claude';
import { stopChat } from '../lib/chat';
import { pageStore } from '../lib/page';
import { titleOf } from '../lib/explainer';
import { newConversation } from '../lib/conversation';
import { fmtUsd } from '../lib/format';
import { auth } from '../lib/api';
import CardChip from './ui/CardChip';
import Logo from './Logo';
import Popover from './ui/Popover';
import Kbd from './ui/Kbd';
import HealthDot from './ui/HealthDot';

const PROVIDER_LABEL: Record<ProviderId, string> = { xai: 'Grok', openai: 'GPT-Live', gemini: 'Gemini' };

export default function Header({ compact, onLoggedOut }: { compact: boolean; onLoggedOut: () => void }) {
  const status = useStatus();
  const explainer = useStore(pageStore, (s) => s.explainer);
  const [menu, setMenu] = useState(false);
  const [keys, setKeys] = useState(false);
  const online = bridgeOnline(status);
  // Claude sessions run on the bridge that has them (LeChonk); Sandy's bridge serves reads only (max 0).
  const bridge = status.bridges.find((b) => b.connected && (b.max ?? 0) > 0) ?? status.bridges.find((b) => b.connected) ?? status.bridges[0];
  const HOST_LABEL: Record<string, string> = { sandy: 'Sandy', lechonk: 'LeChonk' };
  const hosts = status.bridges.filter((b) => b.connected).map((b) => HOST_LABEL[b.host] ?? b.host).join(' + ');
  // The session list updates the moment a session starts or stops; the bridge figure only every status poll.
  const sessions = useStore(sessionsStore);
  const running = sessions.loaded && !sessions.error ? runningCount(sessions.list) : bridge?.running;
  const spendPct = status.spendToday != null && status.capUsd ? Math.min(1, status.spendToday / status.capUsd) : null;

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.05] bg-ink-900/80 px-3 backdrop-blur-xl lg:px-4" style={{ paddingTop: 'var(--sat)', height: 'calc(56px + var(--sat))' }}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Logo size={28} />
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-fg">Agent Desk</span>
        {!compact && explainer && (
          <>
            <span className="text-mute">/</span>
            <span className="truncate text-sm text-dim">{titleOf(explainer)}</span>
            <CardChip cardId={explainer.cardId} />
          </>
        )}
      </div>
      <div className="flex-1" />

      <div
        className={`flex h-8 items-center gap-2 rounded-full border px-2.5 text-xs font-medium ${online ? 'border-moss/20 bg-moss/[0.07] text-moss' : 'border-white/[0.08] bg-white/[0.03] text-dim'}`}
        title={status.bridges.map((b) => `${b.host}: ${b.connected ? 'verbunden' : 'getrennt'}`).join('\n') || 'Keine Bridge gemeldet'}
        role="status"
        aria-label={online ? `Bridge ${hosts} online` : 'Bridge offline'}
      >
        <span className="relative flex h-2 w-2">
          {online && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-moss opacity-50" />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${online ? 'bg-moss' : status.loaded ? 'bg-danger' : 'bg-mute'}`} />
        </span>
        <span>{!status.loaded ? 'prüfe …' : online ? (compact ? 'online' : `${hosts || 'Bridge'} online`) : 'offline'}</span>
        {!compact && online && running != null && <span className="text-moss/70 tabular" aria-label={`${running} von ${bridge?.max ?? 3} Claude-Sitzungen laufen`}>· {running}/{bridge?.max ?? 3} Claude</span>}
      </div>

      {!compact && status.spendToday != null && (
        <div className="flex h-8 items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.03] px-2.5 text-xs text-fg-2" title="Geschätzte Ausgaben heute (Stimme, Text, Visualisierung)">
          <Wallet className="h-3.5 w-3.5 text-dim" />
          <span className="tabular">{fmtUsd(status.spendToday)}</span>
          {status.capUsd != null && (
            <>
              <span className="h-1 w-10 overflow-hidden rounded-full bg-white/[0.08]">
                <span className={`block h-full rounded-full ${spendPct! > 0.85 ? 'bg-danger' : spendPct! > 0.6 ? 'bg-amber' : 'bg-moss'}`} style={{ width: `${spendPct! * 100}%` }} />
              </span>
              <span className="text-mute tabular">{fmtUsd(status.capUsd)}</span>
            </>
          )}
        </div>
      )}

      {!compact && Object.keys(status.providers).length > 0 && (
        <div className="flex h-8 items-center gap-2.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 text-xs text-dim" aria-label="Sprachanbieter">
          {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((p) => (
            <span key={p} className="flex items-center gap-1.5 whitespace-nowrap" title={`${PROVIDER_LABEL[p]}: ${healthText(status.providers[p])}`} data-health={status.providers[p]?.state ?? 'unknown'}>
              <HealthDot health={status.providers[p]} />
              {PROVIDER_LABEL[p]}
            </span>
          ))}
        </div>
      )}

      {!compact && (
        <div className="relative">
          <button type="button" onClick={() => setKeys((k) => !k)} aria-label="Tastenkürzel" title="Tastenkürzel" aria-expanded={keys} className="flex h-9 w-9 items-center justify-center rounded-full text-dim transition-colors hover:bg-white/[0.06] hover:text-fg">
            <Keyboard className="h-4 w-4" />
          </button>
          <Popover open={keys} onClose={() => setKeys(false)} className="w-64 p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">Tastenkürzel</p>
            {[
              ['Leertaste', 'Abspielen / Pause'],
              ['/', 'Eingabe fokussieren'],
              ['V', 'Live-Sprache an/aus'],
              ['K', 'Kino-Modus'],
              ['C', 'Folien-Endbild kopieren'],
              ['Esc', 'Punkt schließen'],
              ['←  →', 'Zeitleiste ±5 s'],
            ].map(([k, l]) => (
              <div key={k} className="flex items-center justify-between py-1 text-sm text-fg-2">
                <span>{l}</span>
                <Kbd>{k}</Kbd>
              </div>
            ))}
          </Popover>
        </div>
      )}

      <div className="relative">
        <button type="button" onClick={() => setMenu((m) => !m)} aria-label="Menü" aria-expanded={menu} className="flex h-11 w-11 items-center lg:h-9 lg:w-9 justify-center rounded-full text-dim transition-colors hover:bg-white/[0.06] hover:text-fg">
          <MoreHorizontal className="h-4 w-4" />
        </button>
        <Popover open={menu} onClose={() => setMenu(false)} className="w-60">
          {compact && status.spendToday != null && (
            <div className="flex items-center justify-between px-3 py-2 text-sm text-dim">
              <span>Heute ausgegeben</span>
              <span className="text-fg-2 tabular">{fmtUsd(status.spendToday)}{status.capUsd != null ? ` / ${fmtUsd(status.capUsd)}` : ''}</span>
            </div>
          )}
          <MenuItem icon={SquarePen} label="Neues Gespräch" onClick={() => { stopChat(); newConversation(); setMenu(false); }} />
          <MenuItem icon={LogOut} label="Abmelden" onClick={() => void auth.logout().finally(onLoggedOut)} />
        </Popover>
      </div>
    </header>
  );
}

function MenuItem({ icon: Icon, label, onClick }: { icon: typeof SquarePen; label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-fg-2 transition-colors hover:bg-white/[0.05] hover:text-fg">
      <Icon className="h-4 w-4 text-dim" /> {label}
    </button>
  );
}
