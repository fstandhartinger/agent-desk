// spec + size → Scene for every kind. Only flow/architecture is async (elkjs lazy chunk).
import type { CanvasSpec } from '../types';
import type { Scene, Size } from './scene';
import { renderBar, renderCustomSvg, renderLine, renderPie, renderSankey, renderSequence, renderTable, renderTimeline } from './charts';

export async function renderScene(spec: CanvasSpec, size: Size): Promise<Scene> {
  switch (spec.kind) {
    case 'flow':
    case 'architecture':
      return (await import('./graph')).renderGraph(spec, size);
    case 'pie': return renderPie(spec, size);
    case 'bar': return renderBar(spec, size);
    case 'line': return renderLine(spec, size);
    case 'table': return renderTable(spec, size);
    case 'timeline': return renderTimeline(spec, size);
    case 'sankey': return renderSankey(spec, size);
    case 'sequence': return renderSequence(spec, size);
    case 'custom_svg': return renderCustomSvg(spec, size);
    default: return renderPie({ ...spec, items: [] }, size);
  }
}
