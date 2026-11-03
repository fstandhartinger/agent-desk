// `/?panel=canvas`: the small drawing window of the Windows app. Only the live canvas from the bus: no header, chat,
// voice or tool strip. Never mounts the Desk, so it cannot open a second voice socket.
import { useEffect } from 'react';
import { useStore } from '../lib/store';
import { toast } from '../lib/toast';
import { errorMessage } from '../lib/api';
import { copyText } from '../lib/clipboard';
import Toasts from '../components/ui/Toasts';
import CanvasView from './CanvasView';
import { canvasBus, type CanvasEntry } from './bus';
import { exportPng } from './export';
import { byLabel } from './sources';
import type { Scene } from './render/scene';
import type { CanvasSpec } from './types';

async function doExport(spec: CanvasSpec, scene: Scene, entry: CanvasEntry) {
  try {
    await exportPng(spec, scene, { by: byLabel(entry.by, entry.provider), at: entry.at });
  } catch (e) {
    toast(`PNG-Export fehlgeschlagen: ${errorMessage(e)}`, 'error');
  }
}

export default function CanvasPanelPage() {
  const bus = canvasBus();
  const state = useStore(bus.store);
  useEffect(() => {
    bus.start();
    return () => bus.stop();
  }, [bus]);
  return (
    <div className="cv-panel h-full min-h-0 overflow-hidden bg-ink-900">
      {state.current
        ? <CanvasView state={state} onSelect={bus.select} onExport={doExport} onCopy={(spec) => copyText(JSON.stringify(spec, null, 2))} onToggleDetail={bus.toggleDetail} />
        : <p className="flex h-full items-center justify-center px-4 text-center text-[14px] text-dim" role="status">Noch keine Zeichnung</p>}
      <Toasts />
    </div>
  );
}
