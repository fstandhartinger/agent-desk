// The Canvas tab: the generative canvas from the bus, an enlarge overlay, and the slim (collapsible) activity strip.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Expand, Shrink } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useStore } from '../lib/store';
import { liveStore } from '../lib/activity';
import { toast } from '../lib/toast';
import { errorMessage } from '../lib/api';
import { nativeFullscreenElement, useFullscreen } from '../lib/fullscreen';
import ActivityRail from '../viz/ActivityRail';
import CanvasView from './CanvasView';
import { canvasBus, type CanvasEntry } from './bus';
import { exportPng } from './export';
import { byLabel } from './sources';
import type { Scene } from './render/scene';
import type { CanvasSpec } from './types';

const RAIL_KEY = 'desk.canvas.rail';

async function doExport(spec: CanvasSpec, scene: Scene, entry: CanvasEntry) {
  try {
    await exportPng(spec, scene, { by: byLabel(entry.by, entry.provider), at: entry.at });
  } catch (e) {
    toast(`PNG-Export fehlgeschlagen: ${errorMessage(e)}`, 'error');
  }
}

async function doCopy(spec: CanvasSpec) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(spec, null, 2));
    toast('Spezifikation kopiert', 'success', 1800);
  } catch {
    toast('Kopieren nicht möglich – der Browser erlaubt keinen Zugriff auf die Zwischenablage.', 'error');
  }
}

export default function LiveCanvasPanel() {
  const bus = canvasBus();
  const state = useStore(bus.store);
  const tools = useStore(liveStore, (s) => s.tools);
  const [expanded, setExpanded] = useState(false);
  const overlay = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(overlay);
  // The drawing needs every pixel: the tool strip starts collapsed (its header still shows how many tools run).
  const [rail, setRail] = useState(() => localStorage.getItem(RAIL_KEY) === '1');
  const leaveFs = fs.exit;
  useEffect(() => { if (!expanded) leaveFs(); }, [expanded, leaveFs]);
  useEffect(() => {
    if (!expanded) return;
    // Esc leaves native fullscreen first (the browser eats that key); in the large-view fallback it closes both.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !nativeFullscreenElement()) setExpanded(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);
  const toggleRail = () => setRail((r) => { localStorage.setItem(RAIL_KEY, r ? '0' : '1'); return !r; });
  const running = tools.filter((t) => t.status === 'start').length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2 lg:p-4">
      <div className="relative min-h-[260px] flex-1 overflow-hidden rounded-2xl border border-white/[0.06] bg-ink-900">
        {!expanded && <CanvasView state={state} onSelect={bus.select} onExport={doExport} onCopy={doCopy} onExpand={() => setExpanded(true)} onToggleDetail={bus.toggleDetail} />}
      </div>
      <div className="shrink-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-ink-850/60">
        <button type="button" onClick={toggleRail} aria-expanded={rail} className="flex h-9 w-full items-center gap-2 px-3 text-[12px] font-medium text-dim transition-colors hover:text-fg max-lg:top-[92px] max-lg:h-11">
          <span className={`h-1.5 w-1.5 rounded-full ${running ? 'animate-breathe bg-papaya' : 'bg-white/25'}`} />
          Werkzeuge{running ? ` · ${running} läuft` : tools.length ? ` · ${tools.length}` : ''}
          <span className="flex-1" />
          {rail ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
        {rail && <ActivityRail events={tools} className="h-[78px] overflow-hidden" />}
      </div>
      {expanded && createPortal(
        <div ref={overlay} className="fixed inset-0 z-50 flex animate-fade bg-ink-950/80 p-0 backdrop-blur-md lg:p-6" role="dialog" aria-modal="true" aria-label="Canvas groß" onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false); }}>
          <div className="relative min-h-0 flex-1 overflow-hidden border-white/[0.08] bg-ink-900 shadow-[0_40px_120px_-30px_rgb(0_0_0/0.9)] lg:rounded-3xl lg:border">
            <CanvasView state={state} onSelect={bus.select} onExport={doExport} onCopy={doCopy} onExpand={() => setExpanded(false)} onToggleDetail={bus.toggleDetail} expanded />
            <button type="button" onClick={fs.toggle} aria-pressed={fs.active} aria-label={fs.active ? 'Vollbild beenden' : 'Vollbild'} title={fs.active ? 'Vollbild beenden (Esc)' : 'Vollbild'}
              className="absolute right-3 top-[76px] z-10 flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-ink-800/90 px-3 text-[13px] font-medium text-fg-2 shadow-lg backdrop-blur transition-colors hover:bg-ink-750 hover:text-fg max-lg:top-[92px] max-lg:h-11">
              {fs.active ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
              {fs.active ? 'Beenden' : 'Vollbild'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
