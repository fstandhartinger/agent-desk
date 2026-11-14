// spec + size → Scene for every kind. flow/architecture (elkjs) and the points / stat / stacked-bar forms are lazy chunks, which
// keeps the initial JS under its budget (scripts/check-build.mjs).
import type { CanvasSpec } from '../types';
import type { Scene, Size } from './scene';
import { renderBar, renderCustomSvg, renderLine, renderPie, renderSankey, renderSequence, renderTable, renderTimeline } from './charts';
import type { PointsOpts } from './forms';

/** `opts.revealed`: points only: how many leading rows are visible (speech-synced reveal, see ../reveal.ts). */
export async function renderScene(spec: CanvasSpec, size: Size, opts: PointsOpts = {}): Promise<Scene> {
  switch (spec.kind) {
    case 'flow':
    case 'architecture':
      return (await import('./graph')).renderGraph(spec, size);
    case 'pie': return renderPie(spec, size);
    case 'bar': return spec.layout === 'stacked' ? (await import('./forms')).renderStackedBar(spec, size) : renderBar(spec, size);
    case 'line': return renderLine(spec, size);
    case 'table': return renderTable(spec, size);
    case 'timeline': return renderTimeline(spec, size);
    case 'sankey': return renderSankey(spec, size);
    case 'sequence': return renderSequence(spec, size);
    case 'custom_svg': return renderCustomSvg(spec, size);
    case 'points': return (await import('./forms')).renderPoints(spec, size, opts);
    case 'stat': return (await import('./forms')).renderStat(spec, size);
    default: return renderPie({ ...spec, items: [] }, size);
  }
}
