// PNG export: title, caption, the visual (static final state) and the source footnotes composed into one SVG with
// the Inter font embedded, rasterised at 2× and downloaded as <id>.png.
import type { CanvasSpec } from './types';
import { sceneMarkup, escXml } from './render/markup';
import { renderScene } from './render/index';
import { measure, wrap, PALETTE as P, type Scene } from './render/scene';
import { footnote } from './sources';
import { FONT } from '../viz/theme';

let fontCss: Promise<string> | null = null;
function embeddedFont(): Promise<string> {
  fontCss ??= fetch('/fonts/InterVariable-latin.woff2')
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('font'))))
    .then((buf) => {
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `@font-face{font-family:"Inter";src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2");font-weight:100 900;}`;
    })
    .catch(() => '');
  return fontCss;
}

export const EXPORT_W = 1200;
/** Stage a diagram is laid out for in the export (the big view's size at 1440×900). */
export const EXPORT_GRAPH_STAGE = { width: 1390, height: 900 };
const PAD = 56;

/** The visual as it should appear in the export: charts are laid out again for the export frame (the chart fills it,
 *  ticks are counted for that width); diagrams are laid out again for a big stage (like "Groß": full details, never the
 *  side column's dense overview) and scaled to fill the frame width. */
export async function exportScene(spec: CanvasSpec, onScreen: Scene): Promise<{ scene: Scene; scale: number }> {
  const inner = EXPORT_W - PAD * 2;
  if (spec.kind === 'flow' || spec.kind === 'architecture') {
    const scene = await renderScene(spec, EXPORT_GRAPH_STAGE).catch(() => onScreen);
    const scale = Math.max(0.5, Math.min(1.5, inner / Math.max(1, scene.w), 1100 / Math.max(1, scene.h)));
    return { scene, scale };
  }
  return { scene: await renderScene(spec, { width: inner, height: 660 }), scale: 1 };
}

/** The export composition as an SVG string (also used by tests): width ≥ EXPORT_W, visual at `scale`. */
export function exportSvg(spec: CanvasSpec, scene: Scene, meta: { by: string; at: number }, css = '', scale = 1): { svg: string; w: number; h: number } {
  const pad = PAD;
  const sw = scene.w * scale, sh = scene.h * scale;
  const W = Math.max(EXPORT_W, Math.ceil(sw) + pad * 2);
  const inner = W - pad * 2;
  let y = pad + 30;
  let out = `<rect width="${W}" height="__H__" fill="${P.bg}"/>`;
  const title = wrap(spec.title, 32, 700, inner, 2);
  for (const l of title) { out += `<text x="${pad}" y="${y}" font-size="32" font-weight="700" fill="${P.fg}" font-family="${escXml(FONT)}" letter-spacing="-0.4">${escXml(l)}</text>`; y += 40; }
  if (spec.caption) {
    y += 2;
    for (const l of wrap(spec.caption, 18, 400, inner, 3)) { out += `<text x="${pad}" y="${y}" font-size="18" fill="${P.dim}" font-family="${escXml(FONT)}">${escXml(l)}</text>`; y += 26; }
  }
  y += 22;
  const vx = pad + (inner - sw) / 2;
  out += `<g transform="translate(${vx} ${y})${scale !== 1 ? ` scale(${Math.round(scale * 1000) / 1000})` : ''}">${sceneMarkup(scene)}</g>`;
  y += sh + 28;
  out += `<line x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}" stroke="${P.line}" stroke-width="1"/>`;
  y += 26;
  out += `<text x="${pad}" y="${y}" font-size="12" font-weight="700" fill="${P.faint}" letter-spacing="1.2" font-family="${escXml(FONT)}">QUELLEN</text>`;
  let x = pad + measure('QUELLEN', 12, 700) * 1.1 + 16;
  spec.sources.forEach((s, i) => {
    const t = `${i + 1} ${footnote(s).text}`;
    const w = measure(t, 13, 500);
    if (x + w > W - pad) { x = pad; y += 20; }
    out += `<text x="${x}" y="${y}" font-size="13" font-weight="500" fill="${P.dim}" font-family="${escXml(FONT)}">${escXml(t)}</text>`;
    x += w + 22;
  });
  if (spec.unsourced) { out += `<text x="${x}" y="${y}" font-size="13" font-weight="600" fill="${P.amber}" font-family="${escXml(FONT)}">ohne Quelle</text>`; }
  y += 26;
  const when = new Date(meta.at > 1e11 ? meta.at : Date.now()).toLocaleString('de-DE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  out += `<text x="${pad}" y="${y}" font-size="12" fill="${P.faint}" font-family="${escXml(FONT)}">Agent Desk · ${escXml(meta.by)} · ${escXml(when)}</text>`;
  const H = Math.ceil(y + pad - 16);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><style>${css}</style></defs>${out.replace('__H__', String(H))}</svg>`;
  return { svg, w: W, h: H };
}

export async function exportPng(spec: CanvasSpec, onScreen: Scene, meta: { by: string; at: number }): Promise<void> {
  const [{ scene, scale }, css] = await Promise.all([exportScene(spec, onScreen), embeddedFont()]);
  const { svg, w, h } = exportSvg(spec, scene, meta, css, scale);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('PNG konnte nicht erzeugt werden');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${spec.id || 'canvas'}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
