// CanvasSpec v2 wire types (docs/CANVAS.md). The gateway's normalizeCanvas is the validator; the web only renders.
export type CanvasKind = 'flow' | 'architecture' | 'sequence' | 'pie' | 'bar' | 'line' | 'table' | 'timeline' | 'sankey' | 'custom_svg';
export type CanvasTone = 'moss' | 'papaya' | 'violet' | 'amber' | 'red' | 'neutral';
export type CanvasBy = 'text' | 'voice' | 'claude' | 'auto';

export interface CanvasSource { label: string; ref: string }
export interface CanvasGroup { id: string; label: string; tone?: CanvasTone }
export interface CanvasNode { id: string; label: string; detail?: string; group?: string; tone?: CanvasTone; shape?: 'box' | 'pill' | 'diamond' | 'cylinder' | 'person' }
export interface CanvasEdge { from: string; to: string; label?: string; style?: 'solid' | 'dashed' | 'pulse' }
export interface CanvasActor { id: string; label: string; tone?: CanvasTone }
export interface CanvasMessage { from: string; to: string; label: string; style?: 'sync' | 'reply' | 'async'; note?: string }
export interface CanvasItem { label: string; value: number; tone?: CanvasTone; detail?: string }
export interface CanvasSeries { name: string; tone?: CanvasTone; points: { x: string | number; y: number }[] }
export interface CanvasEvent_ { date: string; label: string; detail?: string; tone?: CanvasTone }
export interface CanvasLink { from: string; to: string; value: number }

export interface CanvasSpec {
  v: 2;
  id: string;
  kind: CanvasKind;
  title: string;
  caption?: string;
  highlight?: string;
  sources: CanvasSource[];
  unsourced?: boolean;
  direction?: 'LR' | 'TB';
  groups?: CanvasGroup[];
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
  actors?: CanvasActor[];
  messages?: CanvasMessage[];
  items?: CanvasItem[];
  unit?: string;
  series?: CanvasSeries[];
  columns?: string[];
  rows?: (string | number)[][];
  events?: CanvasEvent_[];
  links?: CanvasLink[];
  svg?: string;
  /** Upgrades 28 Oct (§5): the detailed version of the same diagram (same kind, shared ids). The top level is the simple view. */
  detail?: CanvasDetail;
}

/** The body of the detailed version; title / caption / highlight only when they differ from the simple view. */
export type CanvasDetail = Omit<Partial<CanvasSpec>, 'v' | 'id' | 'sources' | 'unsourced' | 'detail'> & { kind: CanvasKind };

/** One bus event (`GET /api/canvas/events`, also mirrored on chat SSE / voice WS). */
export interface CanvasBusEvent {
  type: 'canvas';
  phase: 'pending' | 'ready' | 'error' | 'dropped';
  id: string;
  kind?: CanvasKind;
  title?: string;
  spec?: CanvasSpec;
  by: CanvasBy;
  provider?: string;
  at: string | number;
  message?: string;
}

export const KINDS: CanvasKind[] = ['flow', 'architecture', 'sequence', 'pie', 'bar', 'line', 'table', 'timeline', 'sankey', 'custom_svg'];

export const KIND_LABEL: Record<CanvasKind, string> = {
  flow: 'Ablauf', architecture: 'Architektur', sequence: 'Sequenz', pie: 'Anteile', bar: 'Balken', line: 'Verlauf',
  table: 'Tabelle', timeline: 'Zeitleiste', sankey: 'Flüsse', custom_svg: 'Skizze',
};
