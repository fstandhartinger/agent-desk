// Upgrades 28 Oct (docs/UPGRADES-1028.md §5): a CanvasSpec is the SIMPLE view; its optional `detail` is the detailed
// version of the same diagram (same kind, shared node ids). Pure helpers: which variant is on screen, and that variant
// as a complete spec. The same canvas id for both variants -> Stage animates the switch in place.
import type { CanvasSpec } from './types';

export const hasDetail = (spec: CanvasSpec | undefined): boolean => !!spec?.detail && typeof spec.detail === 'object' && spec.detail.kind === spec.kind;

const cache = new WeakMap<CanvasSpec, CanvasSpec>();

/** The spec to draw: the simple top level, or (detailed && a detail exists) the detail merged over it. Stable identity. */
export function variantSpec(spec: CanvasSpec, detailed: boolean): CanvasSpec {
  if (!detailed || !hasDetail(spec)) return spec;
  const hit = cache.get(spec);
  if (hit) return hit;
  const { detail, ...top } = spec;
  const out = { ...top, highlight: detail!.highlight ?? top.highlight, caption: detail!.caption ?? top.caption, ...detail, kind: top.kind, id: top.id, sources: top.sources } as CanvasSpec;
  delete (out as Partial<CanvasSpec>).detail;
  cache.set(spec, out);
  return out;
}

/** Toggle label: what a press switches TO ("Details" while the simple view shows, "Einfach" while the details show). */
export const detailLabel = (detailed: boolean): string => (detailed ? 'Einfach' : 'Details');
