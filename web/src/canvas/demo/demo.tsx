// Dev-only demo (vite dev → /canvas-demo.html; not part of the production build): every fixture in the real
// CanvasView. ?f=<fixture> picks one, ?seq=1 plays the same-id update sequence (?step=1..3), ?pending=1 shows the
// pending frame, ?by=voice&provider=gemini sets the badge. ?w=829&h=719 sizes the frame like the desk's side column
// (its enlarge button then fills the window, like "Groß"); window.__show(spec) shows any spec (screenshot scripts).
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import CanvasView from '../CanvasView';
import { applyEvent, initialCanvasState, selectCanvas, type CanvasState } from '../bus';
import { exportPng } from '../export';
import { byLabel } from '../sources';
import type { CanvasBy, CanvasSpec } from '../types';
import { FIXTURES, updateSteps } from './fixtures';

const q = new URLSearchParams(location.search);
const by = (q.get('by') as CanvasBy) || 'text';
const provider = q.get('provider') || undefined;

function build(): CanvasState {
  let s = initialCanvasState();
  const names = Object.keys(FIXTURES);
  const pick = q.get('f') ?? names[0];
  const order = [...names.filter((n) => n !== pick), pick];
  order.forEach((n, i) => {
    s = applyEvent(s, { type: 'canvas', phase: 'ready', id: FIXTURES[n].id, spec: FIXTURES[n], by: n === pick ? by : (['text', 'voice', 'claude', 'auto'] as CanvasBy[])[i % 4], provider: n === pick ? provider : 'gemini', at: 1000 + i });
  });
  s = selectCanvas(s, FIXTURES[pick].id);
  if (q.get('pending') === '1') s = applyEvent(s, { type: 'canvas', phase: 'pending', id: 'new-sketch', title: q.get('title') ?? 'Wie der Login-Link entsteht', kind: 'flow', by, provider, at: 9999 });
  if (q.get('error') === '1') s = applyEvent(s, { type: 'canvas', phase: 'error', id: 'broken', title: 'Kostenvergleich', kind: 'bar', by, at: 9999, message: 'Zeichnung fehlgeschlagen: keine Zahlen im Gespräch gefunden' });
  if (q.get('empty') === '1') s = initialCanvasState();
  return s;
}

function Seq() {
  const [step, setStep] = useState(Number(q.get('step') ?? 1));
  const [state, setState] = useState(() => initialCanvasState());
  useEffect(() => {
    const spec = updateSteps()[step - 1];
    setState((s) => applyEvent(s, { type: 'canvas', phase: 'ready', id: spec.id, spec, by: 'voice', provider: 'gemini', at: step }));
  }, [step]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'ArrowRight') setStep((x) => Math.min(3, x + 1)); if (e.key === 'ArrowLeft') setStep((x) => Math.max(1, x - 1)); };
    addEventListener('keydown', k);
    (window as unknown as { __step: (n: number) => void }).__step = (n) => setStep(n);
    return () => removeEventListener('keydown', k);
  }, []);
  return <Frame state={state} />;
}

const frameW = Number(q.get('w')) || 0, frameH = Number(q.get('h')) || 0;

function Frame({ state, onSelect }: { state: CanvasState; onSelect?: (id: string) => void }) {
  const [big, setBig] = useState(false);
  const sized = frameW && frameH && !big;
  return (
    <div className="h-full bg-ink-950 p-3 lg:p-4">
      <div className="h-full overflow-hidden rounded-2xl border border-white/[0.06] bg-ink-900" style={sized ? { width: frameW, height: frameH } : undefined}>
        <CanvasView
          state={state}
          onSelect={onSelect}
          onExpand={frameW ? () => setBig((b) => !b) : undefined}
          expanded={big}
          onExport={(spec, scene, e) => exportPng(spec, scene, { by: byLabel(e.by, e.provider), at: e.at })}
          onCopy={(spec: CanvasSpec) => navigator.clipboard?.writeText(JSON.stringify(spec, null, 2))}
        />
      </div>
    </div>
  );
}

function Demo() {
  const [state, setState] = useState(build);
  useEffect(() => {
    const w = window as unknown as { __ready: boolean; __show: (spec: CanvasSpec) => void };
    w.__show = (spec) => setState((s) => selectCanvas(applyEvent(s, { type: 'canvas', phase: 'ready', id: spec.id, spec, by, provider, at: Date.now() }), spec.id));
    w.__ready = true;
  }, []);
  return <Frame state={state} onSelect={(id) => setState((s) => selectCanvas(s, id))} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode>{q.get('seq') === '1' ? <Seq /> : <Demo />}</StrictMode>);
