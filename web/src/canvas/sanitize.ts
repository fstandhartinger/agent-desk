// custom_svg sanitiser (docs/CANVAS.md). The input is never inserted as-is: a small tolerant XML tokenizer builds a
// tree, and only allowlisted elements/attributes are serialised again by us, with every text and attribute value
// escaped. Anything unknown (script, style, foreignObject, image, use, a, animate, on* handlers, external href or
// url(), CSS escapes) is dropped together with its subtree. Ids are prefixed so a sketch cannot clash with the app.
const ELEMENTS = ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs',
  'linearGradient', 'radialGradient', 'stop', 'marker', 'title'] as const;
const ELEMENT_BY_LOWER = new Map(ELEMENTS.map((e) => [e.toLowerCase(), e]));
const TEXT_PARENTS = new Set(['text', 'tspan', 'title']);

const ATTRS = ['id', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'd',
  'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-miterlimit', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'transform', 'font-size',
  'font-family', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'letter-spacing',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'markerWidth',
  'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'marker-start', 'marker-mid', 'marker-end', 'dx', 'dy',
  'rotate', 'textLength', 'preserveAspectRatio', 'paint-order', 'vector-effect', 'visibility', 'display', 'href'] as const;
const ATTR_BY_LOWER = new Map(ATTRS.map((a) => [a.toLowerCase(), a]));
const STYLE_PROPS = new Set(ATTRS.filter((a) => /^(fill|stroke|opacity|font|text-anchor|dominant|letter|stop|paint|visibility|display|marker)/.test(a)));

const MAX_INPUT = 40_000;
const MAX_ELEMENTS = 3000;

interface El { name: string; attrs: [string, string][]; children: (El | string)[] }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parse(src: string): El | null {
  const root: El = { name: '#root', attrs: [], children: [] };
  const stack: El[] = [root];
  let i = 0;
  let count = 0;
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { top().children.push(decode(src.slice(i))); break; }
    if (lt > i) top().children.push(decode(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      top().children.push(src.slice(lt + 9, e < 0 ? src.length : e));
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      // DOCTYPE (possibly with an internal subset of entity declarations) or a processing instruction: skipped whole.
      const sub = src.indexOf('[', lt);
      const gt = src.indexOf('>', lt);
      const end = sub >= 0 && gt >= 0 && sub < gt ? src.indexOf(']>', sub) : gt;
      i = end < 0 ? src.length : end + (sub >= 0 && sub < gt ? 2 : 1);
      continue;
    }
    if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt);
      const name = src.slice(lt + 2, gt < 0 ? src.length : gt).trim();
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
      i = gt < 0 ? src.length : gt + 1;
      continue;
    }
    const m = /^<([A-Za-z_][\w:.-]*)/.exec(src.slice(lt, lt + 64));
    if (!m) { top().children.push('<'); i = lt + 1; continue; }
    // Attributes: name="v" | name='v' | name=v | name
    let j = lt + m[0].length;
    const attrs: [string, string][] = [];
    const re = /\s*([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/y;
    for (;;) {
      re.lastIndex = j;
      const a = re.exec(src);
      if (!a || a[0].length === 0) break;
      attrs.push([a[1], decode(a[2] ?? a[3] ?? a[4] ?? '')]);
      j = re.lastIndex;
    }
    while (j < src.length && /\s/.test(src[j])) j++;
    const selfClose = src[j] === '/';
    const gt = src.indexOf('>', j);
    i = gt < 0 ? src.length : gt + 1;
    if (++count > MAX_ELEMENTS) return null;
    const el: El = { name: m[1], attrs, children: [] };
    top().children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root;
}

/** A value is safe when it cannot reach outside the sketch: url() only to local ids, no schemes, no CSS escapes. */
function safeValue(v: string): boolean {
  if (/[\\<>]|javascript:|vbscript:|data:|expression\s*\(|@import|behavior\s*:/i.test(v)) return false;
  const urls = v.match(/url\s*\(/gi) ?? [];
  const local = v.match(/url\(\s*#[A-Za-z_][\w.-]*\s*\)/g) ?? [];
  return urls.length === local.length;
}

export interface SanitizedSvg { viewBox: [number, number, number, number]; inner: string; dropped: number }

/** Sanitises a model-written `<svg>`; null when there is no usable svg root. `prefix` namespaces its ids. */
export function sanitizeSvg(src: string, prefix = 'cs-'): SanitizedSvg | null {
  if (typeof src !== 'string' || src.length > MAX_INPUT) return null;
  const tree = parse(src);
  if (!tree) return null;
  const svg = tree.children.find((c): c is El => typeof c !== 'string' && c.name.toLowerCase() === 'svg');
  if (!svg) return null;
  let dropped = 0;
  const pid = (id: string) => `${prefix}${id}`;
  const rewrite = (v: string) => v.replace(/url\(\s*#([A-Za-z_][\w.-]*)\s*\)/g, (_, id) => `url(#${pid(id)})`);

  function attrsOf(el: El): string {
    let out = '';
    for (const [rawName, rawValue] of el.attrs) {
      const lname = rawName.toLowerCase();
      const name = lname === 'xlink:href' ? 'href' : ATTR_BY_LOWER.get(lname);
      const value = rawValue.trim();
      if (!name || name === 'viewBox' && el === svg) { if (!name) dropped++; continue; }
      if (name === 'href') {
        if (!/^#[A-Za-z_][\w.-]*$/.test(value)) { dropped++; continue; }
        out += ` href="${esc(`#${pid(value.slice(1))}`)}"`;
        continue;
      }
      if (name === 'id') {
        if (!/^[A-Za-z_][\w.-]*$/.test(value)) { dropped++; continue; }
        out += ` id="${esc(pid(value))}"`;
        continue;
      }
      if (!safeValue(value)) { dropped++; continue; }
      out += ` ${name}="${esc(rewrite(value))}"`;
    }
    const style = el.attrs.find(([n]) => n.toLowerCase() === 'style')?.[1];
    if (style !== undefined) {
      const decls = style.split(';').map((d) => d.split(':')).filter((d) => d.length === 2)
        .map(([p, v]) => [p.trim().toLowerCase(), v.trim()] as const)
        .filter(([p, v]) => STYLE_PROPS.has(p as never) && safeValue(v));
      if (decls.length) out += ` style="${esc(decls.map(([p, v]) => `${p}:${rewrite(v)}`).join(';'))}"`;
      else dropped++;
    }
    return out;
  }

  function emit(el: El): string {
    let out = '';
    for (const c of el.children) {
      if (typeof c === 'string') {
        if (TEXT_PARENTS.has(el.name)) out += esc(c);
        continue;
      }
      const name = ELEMENT_BY_LOWER.get(c.name.toLowerCase());
      if (!name || name === 'svg') { dropped++; continue; }
      const canonical: El = { ...c, name };
      out += `<${name}${attrsOf(canonical)}>${emit(canonical)}</${name}>`;
    }
    return out;
  }

  const vbRaw = svg.attrs.find(([n]) => n.toLowerCase() === 'viewbox')?.[1];
  let vb = vbRaw?.trim().split(/[\s,]+/).map(Number);
  if (!vb || vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2] <= 0 || vb[3] <= 0) {
    const w = parseFloat(svg.attrs.find(([n]) => n === 'width')?.[1] ?? '');
    const h = parseFloat(svg.attrs.find(([n]) => n === 'height')?.[1] ?? '');
    vb = [0, 0, w > 0 ? w : 400, h > 0 ? h : 300];
  }
  // Root presentation attributes (fill, font-family, …) are kept on a wrapping group; width/height/viewBox are ours.
  const rootAttrs = attrsOf({ ...svg, attrs: svg.attrs.filter(([n]) => !/^(width|height|viewbox|x|y|id)$/i.test(n)), children: [] });
  const body = emit(svg);
  return { viewBox: vb as [number, number, number, number], inner: rootAttrs ? `<g${rootAttrs}>${body}</g>` : body, dropped };
}
