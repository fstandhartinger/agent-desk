import ArtifactContext from './ArtifactContext';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { Clapperboard, MessagesSquare, PanelLeftOpen, PanelRightOpen, PanelLeftClose, PanelRightClose, Radio, X } from 'lucide-react';
import { useStatusPolling } from '../lib/status';
import { useStore } from '../lib/store';
import { useMedia } from '../lib/useMedia';
import { refreshSessions, sessionsStore } from '../lib/claude';
import { arrange, collapse, fitLayout, kinoStore, layoutStore, OVERLAY_W, pickerStore, revealLive, setKinoChat, setPicker, type Layout } from '../lib/layout';
import { pageStore } from '../lib/page';
import Header from './Header';
import ExplainerPanel from './explainer/ExplainerPanel';
import Thread from './chat/Thread';
import Composer from './chat/Composer';
import ChatBar from './chat/ChatBar';
import History from './chat/History';
import VoiceDock from './voice/VoiceDock';
import VoiceFab from './voice/VoiceFab';
import LivePanel from './live/LivePanel';
import Toasts from './ui/Toasts';
import { useShortcuts } from './useShortcuts';
import { canvasBus } from '../canvas/bus';
import { logActivity } from '../lib/activity';

type MobileTab = 'explainer' | 'chat' | 'live';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(() => innerWidth);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export default function Desk({ onLoggedOut }: { onLoggedOut: () => void }) {
  useStatusPolling();
  const desktop = useMedia('(min-width: 1024px)');
  const [tab, setTab] = useState<MobileTab>(() => (new URLSearchParams(location.search).get('x') ? 'explainer' : 'chat'));
  const layout = useStore(layoutStore);
  const setLayout = layoutStore.set;
  const explainerOn = useStore(pageStore, (s) => !!s.slug || !!s.explainer);
  const explainerOnRef = useRef(explainerOn);
  explainerOnRef.current = explainerOn;
  const picker = useStore(pickerStore, (s) => s.open);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { kino, chat: kinoChat } = useStore(kinoStore);
  const row = useWidth<HTMLDivElement>();
  // Once an explainer is chosen in the floating picker it moves into its slot; the picker closes.
  useEffect(() => { if (explainerOn) setPicker(false); }, [explainerOn]);
  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicker(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picker]);

  // Generative canvas: one bus stream for the whole desk. A new drawing makes the Live panel visible on desktop and
  // marks the Live tab on phones (no tab switch in the middle of a conversation).
  const [canvasNew, setCanvasNew] = useState(false);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => {
    const bus = canvasBus((ev) => {
      if (ev.phase === 'ready') logActivity('system', 'Skizze auf der Canvas', ev.spec?.title ?? ev.title, 'violet');
      else if (ev.phase === 'error') logActivity('system', 'Skizze fehlgeschlagen', ev.message, 'red');
      if (ev.phase !== 'pending') return;
      if (tabRef.current !== 'live') setCanvasNew(true);
      if (!kinoStore.get().kino) setLayout((l) => revealLive(l, explainerOnRef.current));
    });
    bus.start();
    return () => bus.stop();
  }, []);
  useEffect(() => { if (tab === 'live') setCanvasNew(false); }, [tab]);

  // Header pill, history and the mobile badge need the session list on every tab, not only in the Claude tab.
  useEffect(() => {
    void refreshSessions();
    const t = setInterval(() => document.visibilityState === 'visible' && void refreshSessions(), 15000);
    return () => clearInterval(t);
  }, []);

  const focusComposer = useCallback(() => {
    if (!desktop) setTab('chat');
    if (kinoStore.get().kino) kinoStore.set((s) => ({ ...s, chat: true }));
    requestAnimationFrame(() => window.dispatchEvent(new Event('desk:focus-composer')));
  }, [desktop]);
  useShortcuts(focusComposer);

  useEffect(() => {
    const go = (e: Event) => setTab((e as CustomEvent<MobileTab>).detail);
    // Anything that opens Claude (hand-off, history) needs the Live panel visible.
    const showLive = () => {
      setTab('live');
      setHistoryOpen(false);
      kinoStore.set((s) => ({ ...s, kino: false }));
      setLayout((l) => revealLive(l, explainerOnRef.current));
    };
    window.addEventListener('desk:tab', go);
    window.addEventListener('desk:new-claude-task', showLive);
    window.addEventListener('desk:open-claude-session', showLive);
    return () => {
      window.removeEventListener('desk:tab', go);
      window.removeEventListener('desk:new-claude-task', showLive);
      window.removeEventListener('desk:open-claude-session', showLive);
    };
  }, []);

  const explainer = <ExplainerPanel onAsk={focusComposer} />;
  const chat = (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <ChatBar onHistory={() => setHistoryOpen(true)} />
      <ArtifactContext />
      <VoiceDock />
      <Thread />
      <Composer />
      <History open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  );
  const live = <LivePanel />;

  if (desktop) {
    const { big, small } = arrange(layout, explainerOn);
    const fit = fitLayout(layout, row.width, !small);
    const kinoOn = kino && big === 'explainer';
    const bigOpen = small ? true : layout.leftOpen;
    // Every pane keeps its place in the tree; only CSS order and width change, so swapping canvas and explainer
    // (or opening the floating picker) never remounts the video, the audio or the canvas stream.
    const slotOf = (p: 'explainer' | 'live') => (big === p ? 'big' : small === p ? 'small' : 'none');
    const paneProps = (p: 'explainer' | 'live') => {
      const slot = slotOf(p);
      return {
        slot,
        open: slot === 'big' ? bigOpen : slot === 'small' ? fit.rightOpen : false,
        width: slot === 'big' ? (kinoOn ? row.width : fit.left) : fit.right,
        onCollapse: () => setLayout((l) => collapse(l, slot === 'big' ? 'big' : 'small', explainerOn)),
        onExpand: () => setLayout((l) => (slot === 'big' ? { ...l, leftOpen: true } : { ...l, rightOpen: true })),
        onResize: (w: number) => setLayout((l): Layout => (slot === 'small' ? { ...l, right: w } : small ? { ...l, leftShare: w / Math.max(row.width, 1) } : { ...l, soloShare: w / Math.max(row.width, 1) })),
      } as const;
    };
    const ex = paneProps('explainer');
    const lv = paneProps('live');
    return (
      <div className="stage-glow flex h-full flex-col">
        <Header compact={false} onLoggedOut={onLoggedOut} />
        {/* One tree for both modes: switching Kino only changes sizes, so the stage, audio and streams never remount. */}
        <div ref={row.ref} className="relative flex min-h-0 flex-1 overflow-hidden" data-layout={`${big}-${small ?? 'none'}`}>
          <SidePanel {...ex} label="Erklärung" icon={<Clapperboard className="h-4 w-4" />} collapsible={!kinoOn}
            floating={ex.slot === 'none' && picker} onCloseFloating={() => setPicker(false)}>
            {explainer}
          </SidePanel>
          <main
            aria-label="Unterhaltung"
            className={kinoOn
              ? `absolute bottom-4 right-4 top-4 z-30 flex flex-col overflow-hidden rounded-3xl border border-white/[0.09] bg-ink-900/90 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.85)] backdrop-blur-xl transition-[transform,opacity] duration-300 ease-out ${kinoChat ? '' : 'pointer-events-none translate-x-[calc(100%+24px)] opacity-0'}`
              : 'flex min-w-0 flex-1 flex-col'}
            style={kinoOn ? { width: OVERLAY_W } : { order: 2 }}
            inert={kinoOn && !kinoChat}
          >
            {chat}
          </main>
          {kinoOn && !kinoChat && (
            <button type="button" onClick={() => setKinoChat(true)} aria-label="Chat einblenden"
              className="absolute bottom-6 right-6 z-30 flex h-12 animate-pop items-center gap-2 rounded-full border border-white/[0.1] bg-ink-800/90 px-4 text-[14px] font-medium text-fg shadow-[0_20px_50px_-12px_rgb(0_0_0/0.8)] backdrop-blur-xl transition-colors hover:bg-ink-700">
              <MessagesSquare className="h-4 w-4 text-moss" /> Chat
            </button>
          )}
          <SidePanel {...lv} gone={kinoOn} label="Live" icon={<Radio className="h-4 w-4" />}>
            {live}
          </SidePanel>
        </div>
        <Toasts />
      </div>
    );
  }

  return (
    <div className="stage-glow flex h-full flex-col">
      <Header compact onLoggedOut={onLoggedOut} />
      <div className="relative min-h-0 flex-1" style={{ paddingLeft: 'var(--sal)', paddingRight: 'var(--sar)' }}>
        {/* All tabs stay mounted: audio, streams and voice keep running while switching. */}
        <section hidden={tab !== 'explainer'} className="h-full" aria-label="Erklärung">{explainer}</section>
        <section hidden={tab !== 'chat'} className="h-full" aria-label="Chat">{chat}</section>
        <section hidden={tab !== 'live'} className="h-full" aria-label="Live">{live}</section>
      </div>
      <MobileTabs tab={tab} onTab={setTab} canvasNew={canvasNew} />
      <Toasts />
    </div>
  );
}

function SidePanel({ slot, open, gone, width, label, icon, collapsible = true, floating = false, onCollapse, onExpand, onResize, onCloseFloating, children }: {
  slot: 'big' | 'small' | 'none'; open: boolean; gone?: boolean; width: number; label: string; icon: ReactNode; collapsible?: boolean;
  floating?: boolean; onCollapse: () => void; onExpand: () => void; onResize: (w: number) => void; onCloseFloating?: () => void; children: ReactNode;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const left = slot === 'big';
  const onDown = (e: RPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
    setDragging(true);
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    onResize(Math.round(drag.current.w + (left ? dx : -dx)));
  };
  const onUp = () => {
    drag.current = null;
    setDragging(false);
  };
  // Flex order: big slot 0, its handle 1, chat 2, small handle 3, small slot 4.
  const order = left ? 0 : 4;
  const Close = left ? PanelLeftClose : PanelRightClose;
  const Open = left ? PanelLeftOpen : PanelRightOpen;
  const border = left ? 'border-r' : 'border-l';
  const placed = slot !== 'none';
  const handle = placed && open && !gone && collapsible && <Handle order={left ? 1 : 3} onDown={onDown} onMove={onMove} onUp={onUp} />;

  if (!placed) {
    // No slot (no explainer loaded): stays mounted but hidden, or floats as a small card over the canvas column.
    return (
      <aside aria-label={label} hidden={!floating}
        className="absolute left-4 top-4 z-40 h-[min(340px,calc(100%-32px))] w-[min(460px,calc(100%-32px))] animate-pop overflow-hidden rounded-3xl border border-white/[0.1] bg-ink-900/95 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.85)] backdrop-blur-xl">
        <button type="button" onClick={onCloseFloating} aria-label="Erklärung schließen" title="Schließen (Esc)"
          className="absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full text-mute transition-colors hover:bg-white/[0.06] hover:text-fg">
          <X className="h-4 w-4" />
        </button>
        {children}
      </aside>
    );
  }
  return (
    <>
      {handle}
      {/* Collapsed panels stay mounted (hidden) so audio and live streams continue. */}
      <aside aria-label={label} data-slot={slot} hidden={!open || gone} className={`relative min-h-0 shrink-0 ${border} border-white/[0.05] bg-ink-900/40 ${dragging ? '' : 'transition-[width] duration-300 ease-out'}`} style={{ width, order }}>
        {collapsible && (
          <button type="button" onClick={onCollapse} aria-label={`${label} einklappen`} title={`${label} einklappen`}
            className="absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full text-mute transition-colors hover:bg-white/[0.06] hover:text-fg">
            <Close className="h-4 w-4" />
          </button>
        )}
        {children}
      </aside>
      {!open && !gone && (
        <div className={`flex w-12 shrink-0 flex-col items-center gap-2 ${border} border-white/[0.05] pt-3`} style={{ order }}>
          <button type="button" onClick={onExpand} aria-label={`${label} ausklappen`} title={`${label} ausklappen`} className="flex h-9 w-9 items-center justify-center rounded-full text-dim transition-colors hover:bg-white/[0.06] hover:text-fg">
            <Open className="h-4 w-4" />
          </button>
          <span className="text-mute">{icon}</span>
          <span className="whitespace-nowrap text-[11px] font-medium tracking-wide text-mute [writing-mode:vertical-rl]">{label}</span>
        </div>
      )}
    </>
  );
}

function Handle({ order, onDown, onMove, onUp }: { order: number; onDown: (e: RPointerEvent) => void; onMove: (e: RPointerEvent) => void; onUp: () => void }) {
  return (
    <div
      style={{ order }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Breite ändern"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      className="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-violet/60 group-active:bg-violet" />
    </div>
  );
}

function MobileTabs({ tab, onTab, canvasNew = false }: { tab: MobileTab; onTab: (t: MobileTab) => void; canvasNew?: boolean }) {
  const running = useStore(sessionsStore, (s) => s.list.some((x) => x.state === 'running' || x.state === 'starting'));
  const items: { id: MobileTab; label: string; icon: typeof Radio }[] = [
    { id: 'explainer', label: 'Erklärung', icon: Clapperboard },
    { id: 'chat', label: 'Chat', icon: MessagesSquare },
    { id: 'live', label: 'Live', icon: Radio },
  ];
  return (
    <nav aria-label="Bereiche" className="relative z-30 flex shrink-0 border-t border-white/[0.06] bg-ink-900/90 backdrop-blur-xl" style={{ paddingBottom: 'var(--sab)' }}>
      {items.map(({ id, label, icon: Icon }) => [
        id === 'live' && <VoiceFab key="voice" showState={tab === 'explainer'} />,
        <button key={id} type="button" onClick={() => onTab(id)} aria-current={tab === id ? 'page' : undefined}
          className={`relative flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${tab === id ? 'text-fg' : 'text-mute'}`}>
          <span className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${tab === id ? 'bg-white/[0.09]' : ''}`}>
            <Icon className="h-[18px] w-[18px]" />
          </span>
          {label}
          {id === 'live' && (running || canvasNew) && <span className={`absolute right-[calc(50%-20px)] top-3 h-2 w-2 rounded-full ring-2 ring-ink-900 ${canvasNew ? 'animate-breathe bg-violet' : 'bg-papaya'}`} aria-label={canvasNew ? 'Neue Skizze' : undefined} />}
        </button>,
      ])}
    </nav>
  );
}
