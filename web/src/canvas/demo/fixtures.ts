// Fixture index for the demo, tests and the dev mock (never imported by production code).
import type { CanvasSpec } from '../types';
import flow from '../fixtures/flow-video-send-block.json';
import architecture from '../fixtures/architecture-gateway.json';
import pie from '../fixtures/pie-money.json';
import sequence from '../fixtures/sequence-canvas-draw.json';
import bar from '../fixtures/bar-gpu-hours.json';
import line from '../fixtures/line-daily-spend.json';
import table from '../fixtures/table-jobs.json';
import timeline from '../fixtures/timeline-round5.json';
import sankey from '../fixtures/sankey-money-flow.json';
import custom from '../fixtures/custom-svg-orb.json';

export const FIXTURES: Record<string, CanvasSpec> = {
  flow, architecture, pie, sequence, bar, line, table, timeline, sankey, custom_svg: custom,
} as unknown as Record<string, CanvasSpec>;

/** The same canvas id drawn in three steps (agent explains step by step): 3 → 4 → 6 nodes. */
export function updateSteps(): CanvasSpec[] {
  const full = FIXTURES.flow;
  const pick = (ids: string[], caption: string): CanvasSpec => ({
    ...full,
    caption,
    highlight: ids[ids.length - 1],
    nodes: full.nodes!.filter((n) => ids.includes(n.id)),
    edges: full.edges!.filter((e) => ids.includes(e.from) && ids.includes(e.to)),
  });
  return [
    pick(['agent', 'notify', 'guard'], 'Schritt 1: Jedes Video läuft durch notify und die Link-Prüfung.'),
    pick(['agent', 'notify', 'guard', 'blocked'], 'Schritt 2: Ohne Seitenlink endet es mit Exit 75 – nichts geht raus.'),
    { ...full, caption: 'Schritt 3: Mit Link geht das Video an Telegram, Florian öffnet die Seite.', highlight: 'telegram' },
  ];
}
