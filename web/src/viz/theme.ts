// Explainer visual language shared by all viz components (see explainer-video-webpage stage.html).
import type { Tone, VizNodeKind } from '../lib/types';
import {
  Bot, Briefcase, FileText, Hash, Lightbulb, MessagesSquare, Scale, Sparkles, TriangleAlert, User, Wrench,
  type LucideIcon,
} from 'lucide-react';

export const C = {
  bg: '#0e0e12',
  card: '#17171f',
  cardHi: '#1d1d27',
  line: '#2a2a36',
  fg: '#ecebf3',
  dim: '#8d8ca3',
  faint: '#5b5a6e',
  moss: '#63D297',
  papaya: '#FA5D19',
  violet: '#8B5CF6',
  amber: '#F59E0B',
  red: '#ef4444',
} as const;

export const FONT = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';
export const MONO = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';

export const toneColor = (tone: Tone | undefined): string =>
  tone && tone !== 'neutral' ? C[tone] : '#a5a4bb';

export const KIND_ICON: Record<VizNodeKind, LucideIcon> = {
  agent: Bot, user: User, claude: Sparkles, tool: Wrench, file: FileText, job: Briefcase, board: MessagesSquare,
  idea: Lightbulb, number: Hash, risk: TriangleAlert, decision: Scale,
};

// Default tone when a node comes without one: agents violet, problems red, the rest neutral.
export const kindTone = (kind: VizNodeKind): Tone =>
  kind === 'agent' || kind === 'claude' ? 'violet' : kind === 'risk' ? 'red' : 'neutral';

/** `#rrggbb` + alpha (0..1) → `rgba()`. */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
