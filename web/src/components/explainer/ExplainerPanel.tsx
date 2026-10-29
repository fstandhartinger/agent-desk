import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Copy, Expand, Gauge, ListVideo, Maximize2, Minimize2, Pause, Play, RotateCcw, RotateCw, Shrink, X } from 'lucide-react';
import { assetUrl, endFrameAt, slideTextAt, loadExplainer, posterTime, rememberExplainer, sceneAt, titleOf, type Explainer } from '../../lib/explainer';
import { getPlayer, pageStore, registerPlayer, selectPoint } from '../../lib/page';
import { useStore } from '../../lib/store';
import { kinoStore, OVERLAY_W, toggleKino } from '../../lib/layout';
import { logActivity } from '../../lib/activity';
import { clamp, fmtTime } from '../../lib/format';
import { errorMessage } from '../../lib/api';
import { useFullscreen } from '../../lib/fullscreen';
import { copyPng, copyText } from '../../lib/clipboard';
import { toast, toastStore } from '../../lib/toast';
import CardChip from '../ui/CardChip';
import IconButton from '../ui/IconButton';
import Popover from '../ui/Popover';
import SlugPicker from './SlugPicker';
import Stage from './Stage';
import Scrubber, { type ScrubberHandle } from './Scrubber';
import Caption from './Caption';
import PointCard from './PointCard';
import Chapters from './Chapters';

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
type StageWindow = Window & { seekTo?: (t: number) => void };

function readUrl() {
  const q = new URLSearchParams(location.search);
  return { slug: q.get('x'), t: Number(q.get('t')) || 0, p: q.get('p') };
}

function writeSlug(slug: string | null) {
  const q = new URLSearchParams(location.search);
  if (slug) q.set('x', slug);
  else q.delete('x');
  ['t', 'p'].forEach((k) => q.delete(k));
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
}

export default function ExplainerPanel({ onAsk }: { onAsk: () => void }) {
  const initial = useRef(readUrl());
  const [slug, setSlug] = useState<string | null>(initial.current.slug);
  const [x, setX] = useState<Explainer | null>(null);
  const [error, setError] = useState<{ text: string; slug: string } | null>(null);
  const [paused, setPaused] = useState(true);
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  startedRef.current = started;
  const [rate, setRate] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [wordIdx, setWordIdx] = useState(-1);
  const [duration, setDuration] = useState(0);
  const { sceneId, pointId } = useStore(pageStore);
  const { kino, chat: kinoChat } = useStore(kinoStore);
  const copyNotice = useStore(toastStore).at(-1);

  const audio = useRef<HTMLAudioElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const scrub = useRef<ScrubberHandle>(null);
  const timeText = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLDivElement>(null);
  // Stage + controls + caption go fullscreen together; F toggles it (not while typing).
  const fs = useFullscreen(player, { key: true });

  // Load timeline + points for the slug.
  useEffect(() => {
    if (!slug) {
      pageStore.set((s) => ({ ...s, explainer: null, sceneId: null, pointId: null, attached: false, slug: null }));
      return;
    }
    pageStore.set((s) => ({ ...s, slug }));
    let live = true;
    setX(null);
    setError(null);
    loadExplainer(slug)
      .then((ex) => {
        if (!live) return;
        setX(ex);
        setDuration(ex.timeline.duration);
        pageStore.set((s) => ({ ...s, explainer: ex, sceneId: ex.timeline.scenes[0]?.id ?? null, pointId: null, attached: false }));
        rememberExplainer(slug, titleOf(ex), ex.cardId);
        logActivity('explainer', 'Erklärung geladen', titleOf(ex), 'violet');
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError({ text: errorMessage(e), slug });
        setSlug(null);
        writeSlug(null);
      });
    return () => {
      live = false;
    };
  }, [slug]);

  const stageWin = () => frame.current?.contentWindow as StageWindow | null | undefined;
  const post = (msg: unknown) => stageWin()?.postMessage(msg, location.origin);

  const seek = useCallback((t: number) => {
    const a = audio.current;
    if (!a) return;
    const d = (Number.isFinite(a.duration) && a.duration) || duration;
    a.currentTime = clamp(t, 0, Math.max(0, d - 0.05));
    setStarted(true);
  }, [duration]);

  const openPoint = useCallback((id: string) => {
    const ex = pageStore.get().explainer;
    if (!ex?.points.points[id]) return;
    audio.current?.pause();
    selectPoint(id);
    logActivity('explainer', 'Punkt angeklickt', ex.points.points[id].title, 'violet');
  }, []);

  const copyFinalFrame = useCallback(() => {
    if (!x) return;
    const endFrame = endFrameAt(x, audio.current?.currentTime ?? 0);
    if (!endFrame) { toast('Endbild noch nicht verfügbar. Bitte später erneut versuchen.', 'info'); return; }
    void copyPng(assetUrl(x.slug, endFrame.endFrame), `${x.slug}-${endFrame.endFrame.split('/').pop()}`);
  }, [x]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'c') return;
      const target = document.activeElement as HTMLElement | null;
      if (target?.isContentEditable || target?.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (!x || window.getSelection()?.toString()) return;
      e.preventDefault();
      copyFinalFrame();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [x, copyFinalFrame]);

  const closePoint = useCallback(() => selectPoint(null), []);

  // Mirror the selected point into the stage outline (also covers Esc and deep links).
  useEffect(() => post({ type: 'highlight', id: pointId }), [pointId]);

  // A newly opened point card scrolls fully into view, clear of the raised voice button on phones (scroll-mb-14).
  useEffect(() => {
    if (pointId) card.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [pointId, x]);

  // Player handle for keyboard shortcuts, chat context and voice.
  useEffect(() => {
    if (!x) return;
    const a = audio.current!;
    registerPlayer({
      time: () => a.currentTime,
      play: () => void a.play().catch(() => {}),
      pause: () => a.pause(),
      toggle: () => (a.paused ? void a.play().catch(() => {}) : a.pause()),
      seek,
      paused: () => a.paused,
    });
    return () => registerPlayer(null);
  }, [x, seek]);

  // Clicks inside the stage arrive via postMessage (explainer-core.js contract).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.type !== 'explainer-point') return;
      openPoint(String(e.data.id));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [openPoint]);

  // Audio clock drives the stage. Between coarse currentTime updates we extrapolate for smooth 60 fps.
  useEffect(() => {
    if (!x) return;
    const a = audio.current!;
    const words = x.timeline.words;
    let raf = 0, lastAudio = -1, lastPerf = 0, lastDrawn = -1, lastWord = -2, lastScene = '';
    const tick = (now: number) => {
      const at = a.currentTime;
      if (at !== lastAudio) {
        lastAudio = at;
        lastPerf = now;
      }
      const t = a.paused ? at : Math.min(at + ((now - lastPerf) / 1000) * a.playbackRate, at + 0.25);
      if (t !== lastDrawn) {
        lastDrawn = t;
        try {
          // Before the first play the stage shows the poster frame instead of a black t=0.
          stageWin()?.seekTo?.(t === 0 && !startedRef.current ? posterTime(x) : t);
        } catch {
          /* stage not ready yet */
        }
        const d = (Number.isFinite(a.duration) && a.duration) || x.timeline.duration;
        scrub.current?.update(t, d);
        if (timeText.current) timeText.current.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
        let lo = 0, hi = words.length - 1, wi = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (words[mid].s <= t) (wi = mid), (lo = mid + 1);
          else hi = mid - 1;
        }
        if (wi !== lastWord) setWordIdx((lastWord = wi));
        const sc = sceneAt(x, t)?.id ?? '';
        if (sc !== lastScene) {
          lastScene = sc;
          pageStore.set((s) => ({ ...s, sceneId: sc }));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [x]);

  // Deep link: ?t= seeks, ?p= opens a point once the stage is ready.
  const onStageLoad = useCallback(() => {
    const ex = pageStore.get().explainer;
    if (!ex) return;
    post({ type: 'explainer-points', ids: Object.keys(ex.points.points) });
    // The tick below only redraws when the time changes, so the poster frame is drawn here once the stage can take it.
    if (!startedRef.current && !initial.current.t) stageWin()?.seekTo?.(posterTime(ex));
    const { t, p } = initial.current;
    if (t && audio.current) {
      audio.current.currentTime = t;
      setStarted(true);
    }
    if (p) openPoint(p);
    initial.current = { slug: null, t: 0, p: null };
    post({ type: 'highlight', id: pageStore.get().pointId });
  }, [openPoint]);

  const pick = (s: string | null) => {
    writeSlug(s);
    setStarted(false);
    setPaused(true);
    setSlug(s);
  };

  if (!slug) return <SlugPicker onPick={pick} error={error?.text} onRetry={error ? () => pick(error.slug) : undefined} />;

  const point = x && pointId ? x.points.points[pointId] : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex items-start gap-2 px-4 pb-3 pt-4 transition-[padding] duration-300 lg:pl-5 ${kino ? 'lg:pr-5' : 'lg:pr-12'}`} style={kino && kinoChat ? { paddingRight: OVERLAY_W + 40 } : undefined}>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-mute">Erklärung</p>
          {x ? (
            <h2 className="mt-0.5 truncate text-[17px] font-semibold tracking-[-0.01em] text-fg" title={titleOf(x)}>{titleOf(x)}</h2>
          ) : (
            <div className="skeleton mt-1.5 h-5 w-2/3 rounded-md" />
          )}
        </div>
        <CardChip cardId={x?.cardId} />
        <button type="button" onClick={toggleKino} aria-pressed={kino} title={kino ? 'Kino verlassen (K)' : 'Kino: Bühne groß, Chat schwebt darüber (K)'}
          className={`hidden h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors lg:flex ${kino ? 'bg-violet/15 text-violet-light hover:bg-violet/25' : 'text-dim hover:bg-white/[0.06] hover:text-fg'}`}>
          {kino ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          Kino
        </button>
        <button type="button" onClick={fs.toggle} aria-pressed={fs.active} aria-label="Vollbild" title="Vollbild: Bühne, Untertitel und Zeitleiste (F)"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-dim transition-colors hover:bg-white/[0.06] hover:text-fg max-lg:hidden">
          <Expand className="h-3.5 w-3.5" />
          Vollbild
        </button>
        <IconButton label="Andere Erklärung wählen" size="sm" onClick={() => pick(null)}>
          <ListVideo className="h-4 w-4" />
        </IconButton>
      </div>

      {/* Mobile: extra bottom room so the raised voice button never covers the last chapter. */}
      <div className="scroll-y min-h-0 flex-1 px-4 pb-14 transition-[padding] duration-300 lg:px-5 lg:pb-6" style={kino && kinoChat ? { paddingRight: OVERLAY_W + 40 } : undefined}>
        <div className="mx-auto" style={kino ? { maxWidth: 'calc((100dvh - 250px) * 16 / 9)' } : undefined}>
          <div ref={player} data-fullscreen={fs.active ? (fs.large ? 'large' : 'native') : undefined} className={fs.active ? (fs.rotated ? 'fs-root fs-rot' : 'fs-root') : undefined}>
          {fs.rotated && (
            <button type="button" onClick={fs.exit} aria-label="Vollbild beenden" title="Vollbild beenden" data-testid="fs-x" className="fs-x">
              <X className="h-5 w-5" />
            </button>
          )}
          <div className={fs.active ? 'fs-stage' : undefined}>
          <Stage
            ref={frame}
            slug={slug}
            showBigPlay={paused && !started}
            onPlay={() => void audio.current?.play()}
            onLoad={onStageLoad}
          />
          </div>

          {x && (
            <>
              <div className="mt-3 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => getPlayer()?.toggle()}
                  aria-label={paused ? 'Abspielen' : 'Pausieren'}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fg text-ink-900 transition-transform hover:bg-white active:scale-95"
                >
                  {paused ? <Play className="ml-0.5 h-[18px] w-[18px]" fill="currentColor" /> : <Pause className="h-[18px] w-[18px]" fill="currentColor" />}
                </button>
                <IconButton label="5 Sekunden zurück" size="sm" className="max-sm:hidden" onClick={() => seek((audio.current?.currentTime ?? 0) - 5)}>
                  <RotateCcw className="h-4 w-4" />
                </IconButton>
                <IconButton label="5 Sekunden vor" size="sm" className="max-sm:hidden" onClick={() => seek((audio.current?.currentTime ?? 0) + 5)}>
                  <RotateCw className="h-4 w-4" />
                </IconButton>
                <div className="mx-1.5 flex min-w-0 flex-1">
                  <Scrubber ref={scrub} explainer={x} duration={duration || x.timeline.duration} onSeek={seek} />
                </div>
                <span ref={timeText} className="shrink-0 text-[11px] text-dim tabular sm:text-xs" aria-label="Abspielzeit">0:00 / {fmtTime(duration)}</span>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setSpeedOpen((o) => !o)}
                    aria-label={`Geschwindigkeit ${rate}×`}
                    aria-haspopup="menu"
                    aria-expanded={speedOpen}
                    className="flex h-8 items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.03] px-2.5 text-xs font-semibold text-fg-2 tabular transition-colors hover:bg-white/[0.07]"
                  >
                    <Gauge className="h-3.5 w-3.5 text-dim" />
                    {String(rate).replace('.', ',')}×
                  </button>
                  <Popover open={speedOpen} onClose={() => setSpeedOpen(false)} side="top" className="w-28">
                    {SPEEDS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="menuitemradio"
                        aria-checked={s === rate}
                        onClick={() => {
                          setRate(s);
                          if (audio.current) audio.current.playbackRate = s;
                          setSpeedOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm tabular ${s === rate ? 'bg-violet/15 text-fg' : 'text-fg-2 hover:bg-white/[0.05]'}`}
                      >
                        {String(s).replace('.', ',')}×{s === rate && <span className="h-1.5 w-1.5 rounded-full bg-violet" />}
                      </button>
                    ))}
                  </Popover>
                </div>
                <IconButton label={fs.active ? 'Vollbild beenden' : 'Vollbild'} title={fs.active ? 'Vollbild beenden (Esc)' : 'Vollbild (F)'} size="sm" onClick={fs.toggle} className="lg:hidden" data-testid="fs-toggle-mobile">
                  {fs.active ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
                </IconButton>
                {fs.active && (
                  <IconButton label="Vollbild beenden (Esc)" size="sm" onClick={fs.exit} className="max-lg:hidden" data-testid="fs-exit">
                    <Shrink className="h-4 w-4" />
                  </IconButton>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Folie kopieren">
                <IconButton label="Endbild der aktuellen Folie kopieren" title="Endbild der aktuellen Folie kopieren (C)" size="sm" onClick={copyFinalFrame} data-testid="copy-final-frame">
                  <Camera className="h-4 w-4" />
                </IconButton>
                <IconButton label="Folientext kopieren" title="Folientext kopieren" size="sm" onClick={() => void copyText(slideTextAt(x, audio.current?.currentTime ?? 0))} data-testid="copy-slide-text">
                  <Copy className="h-4 w-4" />
                </IconButton>
                <span className="text-[11px] text-mute">Endbild <kbd>C</kbd> · Folientext</span>
                {fs.active && <CardChip cardId={x.cardId} className="ml-auto" />}
                {fs.active && copyNotice && <span role="status" className="text-xs text-fg-2">{copyNotice.text}</span>}
              </div>

              <div className="mt-4 rounded-2xl border border-white/[0.06] bg-ink-850/70 px-4 py-3.5 fs-caption">
                <Caption explainer={x} wordIdx={wordIdx} onSeek={seek} onMore={openPoint} />
              </div>

            </>
          )}
          </div>

          {x && (
            <>
              {point && pointId && (
                <div ref={card} className="mt-4 scroll-mb-14 lg:scroll-mb-4">
                  <PointCard
                    point={{ ...point, id: pointId }}
                    onAsk={onAsk}
                    onClose={closePoint}
                    onResume={() => {
                      closePoint();
                      void audio.current?.play();
                    }}
                  />
                </div>
              )}

              <div className="mt-5">
                <Chapters explainer={x} sceneId={sceneId} onSeek={seek} />
              </div>
            </>
          )}
        </div>
      </div>

      <audio
        ref={audio}
        src={assetUrl(slug, 'audio.mp3')}
        preload="auto"
        onPlay={() => {
          setPaused(false);
          setStarted(true);
        }}
        onPause={() => setPaused(true)}
        onEnded={() => setPaused(true)}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
        onError={() => logActivity('explainer', 'Audio konnte nicht geladen werden', slug, 'red')}
      />
    </div>
  );
}
