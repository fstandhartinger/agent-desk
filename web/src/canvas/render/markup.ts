// Static SVG markup of a scene (final state, no animation): used for the PNG export. Every value is escaped; the only
// unescaped content is custom_svg's `inner`, which comes out of sanitizeSvg (our own serialisation).
import { arcPath, PALETTE, type Prim, type Scene } from './scene';
import { FONT, MONO } from '../../viz/theme';

export const escXml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const a = (name: string, v: string | number | undefined) => (v === undefined || v === '' ? '' : ` ${name}="${escXml(String(v))}"`);

/** A glow halo drawn behind highlighted shapes (no filters: renders the same everywhere, also inside <img>). */
export function glowOf(p: Prim): Prim | null {
  if (!('glow' in p) || !p.glow) return null;
  const halo = { stroke: PALETTE.papaya, sw: 6, opacity: 0.55, fill: PALETTE.papaya, glow: false, blur: true, delay: p.delay, key: `${p.key}:glow` };
  if (p.t === 'rect' || p.t === 'circle' || p.t === 'arc') return { ...p, ...halo };
  return null;
}

export const GLOW_FILTER_ID = 'cv-glow-f';
export const GLOW_FILTER = `<filter id="${GLOW_FILTER_ID}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>`;

export function primMarkup(p: Prim): string {
  const common = a('opacity', p.opacity) + (p.blur ? ` filter="url(#${GLOW_FILTER_ID})"` : '');
  switch (p.t) {
    case 'rect':
      return `<rect${a('x', p.x)}${a('y', p.y)}${a('width', Math.max(0, p.w))}${a('height', Math.max(0, p.h))}${a('rx', p.rx)}${a('fill', p.fill)}${a('stroke', p.stroke)}${a('stroke-width', p.sw)}${a('stroke-dasharray', p.dash)}${common}/>`;
    case 'circle':
      return `<circle${a('cx', p.cx)}${a('cy', p.cy)}${a('r', p.r)}${a('fill', p.fill)}${a('stroke', p.stroke)}${a('stroke-width', p.sw)}${common}/>`;
    case 'arc':
      return `<path${a('d', arcPath(p.cx, p.cy, p.r0, p.r1, p.a0, p.a1))}${a('fill', p.fill)}${a('stroke', p.stroke)}${a('stroke-width', p.sw)}${common}/>`;
    case 'path':
      return `<path${a('d', p.d)}${a('fill', p.fill ?? 'none')}${a('stroke', p.stroke)}${a('stroke-width', p.sw)}${a('stroke-dasharray', p.dash)}${a('stroke-linecap', p.cap)} stroke-linejoin="round"${common}/>`;
    case 'text':
      return `<text${a('x', p.x)}${a('y', p.y)}${a('font-size', p.size)}${a('font-weight', p.weight ?? 500)}${a('fill', p.fill)}${a('text-anchor', p.anchor)}${a('font-family', p.mono ? MONO : FONT)}${a('font-style', p.italic ? 'italic' : undefined)}${common}>${escXml(p.text)}</text>`;
    case 'svg':
      return `<svg${a('x', p.x)}${a('y', p.y)}${a('width', p.w)}${a('height', p.h)}${a('viewBox', p.viewBox)} preserveAspectRatio="xMidYMid meet">${p.inner}</svg>`;
  }
}

export function sceneMarkup(scene: Scene): string {
  return `<defs>${GLOW_FILTER}</defs>` + scene.prims.map((p) => { const g = glowOf(p); return (g ? primMarkup(g) : '') + primMarkup(p); }).join('');
}
