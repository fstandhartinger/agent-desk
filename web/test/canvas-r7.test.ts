// Round 7 (critic r6 §7 items 9, 10, 15): phone and side-column legibility, the zoom pill's own strip, scroll mode,
// "Groß ansehen", ELK edges that wrap around the diagram, the phone column, pie/sankey/table overflow. Synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoView, pickScale, scrollMode, wantsBig, CONTROLS_H, LEGIBLE_PX, LEGIBLE_PX_PHONE, MIN_TEXT_PX, OVERVIEW_PX, type AutoView } from '../src/canvas/view.ts';
import { bestLayout, carriageReturns, columnLayout, foldEdges, layoutGraph, renderGraph, wrapEdges, type GraphLayout } from '../src/canvas/render/graph.ts';
import { renderPie, renderSankey, renderTable } from '../src/canvas/render/charts.ts';
import { measure, overlaps, type Box, type Prim, type Scene } from '../src/canvas/render/scene.ts';
import type { CanvasSpec } from '../src/canvas/types.ts';

const src = (f: string) => readFileSync(new URL(`../src/canvas/${f}`, import.meta.url), 'utf8');
type T = Extract<Prim, { t: 'text' }>;
const texts = (s: Scene) => s.prims.filter((p): p is T => p.t === 'text');
const textBox = (t: T) => {
  const w = measure(t.text, t.size, t.weight ?? 500);
  return { x: t.anchor === 'middle' ? t.x - w / 2 : t.anchor === 'end' ? t.x - w : t.x, y: t.y - t.size * 0.8, w, h: t.size * 1.05 };
};
/** The label size a layout gets on screen under the view's own rule. */
const labelPx = (L: GraphLayout, w: number, h: number) => pickScale({ w: L.w, h: L.h, minText: L.dims.label }, { w, h }, true).scale * L.dims.label;

// Desk sizes measured in the browser (stage = viewport above the controls strip): side column at 1440×900, the big
// overlay, the phone Live tab at 390×844.
const NORMAL = { width: 827, height: 471 }, BIG = { width: 1406, height: 620 }, PHONE = { width: 370, height: 361 };

// An architecture shaped like the critic's d16: the "loops" group is fed by the gateway's last node and feeds back
// into the gateway's hub, so a left-to-right layout puts it behind and routes those edges around everything.
const archLoops: CanvasSpec = {
  v: 2, id: 'arch-loops', kind: 'architecture', title: 'Werkstatt-Architektur', direction: 'LR', sources: [{ label: 'x', ref: 'Gespräch' }],
  groups: [{ id: 'client', label: 'Kunde' }, { id: 'gate', label: 'Pforte (Haus A)' }, { id: 'loops', label: 'Schleifen' }, { id: 'ext', label: 'Externe Dienste' }, { id: 'far', label: 'Außenstelle (Haus B)' }],
  nodes: [
    { id: 'web', label: 'Webseite', detail: 'Formular und Liste', group: 'client' },
    { id: 'mic', label: 'Sprechfunk', detail: 'Mikrofon und Lautsprecher', group: 'client' },
    { id: 'door', label: 'Empfang', detail: 'nimmt alles an', group: 'gate' },
    { id: 'check', label: 'Ausweis prüfen', detail: 'Karte und Code', group: 'gate' },
    { id: 'limit', label: 'Mengen-Bremse', detail: 'zählt und protokolliert', group: 'gate' },
    { id: 'hub', label: 'Verteiler', detail: 'ein Kabel je Haus', group: 'gate' },
    { id: 'text', label: 'Schreibstube', detail: 'antwortet schriftlich', group: 'loops' },
    { id: 'voice', label: 'Funkstube', detail: 'antwortet mündlich', group: 'loops' },
    { id: 'draw', label: 'Zeichenstube', detail: 'malt die Skizzen', group: 'loops' },
    { id: 'a1', label: 'Lexikon-Dienst', detail: 'Nachschlagen', group: 'ext' },
    { id: 'a2', label: 'Sprach-Dienst', detail: 'Hören und Sprechen', group: 'ext' },
    { id: 'b', label: 'Lager in Haus B', detail: 'nur lesen', group: 'far' },
  ],
  edges: [
    { from: 'web', to: 'door', label: 'Post' }, { from: 'mic', to: 'door', label: 'Funk' }, { from: 'door', to: 'check', label: 'prüfen' },
    { from: 'check', to: 'limit', label: 'durch' }, { from: 'limit', to: 'text', label: 'Brief' }, { from: 'limit', to: 'voice', label: 'Ruf' },
    { from: 'text', to: 'a1', label: 'nachschlagen' }, { from: 'voice', to: 'a2', label: 'live' }, { from: 'text', to: 'hub', label: 'Werkzeug' },
    { from: 'draw', to: 'hub', label: 'Abruf' }, { from: 'hub', to: 'b', label: 'Leitung 7' },
  ],
};
// Shaped like the critic's d40: a five-step flow with one real back edge ("erneut").
const flowBack: CanvasSpec = {
  v: 2, id: 'flow-back', kind: 'flow', title: 'Paketannahme', direction: 'LR', sources: [{ label: 'x', ref: 'Gespräch' }],
  nodes: [
    { id: 'a', label: 'Bote', detail: 'bringt ein Paket' }, { id: 'g', label: 'Etikett-Prüfung', detail: 'steht die Adresse drauf?' },
    { id: 'x', label: 'Zurückgewiesen', detail: 'Code 75, nicht angenommen' }, { id: 'f', label: 'Etikett drucken', detail: 'Adresse ergänzen, neu abgeben' },
    { id: 't', label: 'Lager', detail: 'Paket angenommen' },
  ],
  edges: [{ from: 'a', to: 'g', label: 'Paket' }, { from: 'g', to: 'x', label: 'ohne Adresse' }, { from: 'x', to: 'f', label: 'beheben' }, { from: 'f', to: 'g', label: 'erneut' }, { from: 'g', to: 't', label: 'mit Adresse' }],
};
const chain = (n: number): CanvasSpec => ({
  v: 2, id: 'chain', kind: 'flow', title: 'Kette', direction: 'TB', sources: [{ label: 'x', ref: 'Gespräch' }],
  nodes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: `Schritt ${i + 1} mit Namen`, detail: 'eine kurze Erklärung dazu' })),
  edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}`, label: 'weiter' })),
});

// ---------------------------------------------------------------- item 10: side column fit + "Groß ansehen"
test('a diagram whose whole fit drops below LEGIBLE_PX fits its width and scrolls (desktop 9 px, phone 10 px)', () => {
  // 8.6 px as a whole on the side column: before r7 it stayed tiny (only < 8 px and ≥ 1.3× counted).
  const v = pickScale({ w: 760, h: 900, minText: 16 }, { w: 827, h: 471 }, true);
  assert.equal(v.pan, 'y');
  assert.ok(v.scale * 16 >= LEGIBLE_PX, `labels ${(v.scale * 16).toFixed(1)} px`);
  assert.ok(v.scale * 16 <= 15 + 1e-9, 'fitted to the width but not blown up beyond 15 px labels');
  // Legible as a whole: stays whole.
  assert.equal(pickScale({ w: 1300, h: 600, minText: 16 }, { w: 827, h: 471 }, true).pan, 'none');
  // Phone: a tall flow at 5.5 px as a whole fits the width instead.
  const p = pickScale({ w: 300, h: 900, minText: 15 }, { w: 370, h: 361 }, true);
  assert.equal(p.pan, 'y');
  assert.ok(p.scale * 15 >= LEGIBLE_PX_PHONE);
});

test('"Groß ansehen" is offered exactly when the drawing scrolls or its type is below the legible size', () => {
  const whole: AutoView = { vb: [0, 0, 827, 471], scale: 0.7, pan: 'none' };
  assert.equal(wantsBig(whole, { minText: 16 }, { w: 827, h: 471 }), false, '11.2 px whole');
  assert.equal(wantsBig({ ...whole, scale: 0.5 }, { minText: 16 }, { w: 827, h: 471 }), true, '8 px whole');
  assert.equal(wantsBig({ ...whole, pan: 'y', scale: 0.9 }, { minText: 16 }, { w: 827, h: 471 }), true, 'scrolls');
  assert.equal(wantsBig({ ...whole, scale: 1 }, { minText: 13 }, { w: 370, h: 361 }), false, 'a chart at its design size on a phone');
  // The button is wired to onExpand, lives in the controls strip and is hidden in the big view.
  const view = src('CanvasView.tsx');
  assert.match(view, /onExpand && !expanded && view\.cramped[\s\S]{0,120}className="cv-big-hint" onClick=\{onExpand\}/);
  assert.match(view, /Groß ansehen/);
});

test('the side-column architecture never renders 6 px labels: whole at ≥ 8 px (round 8: overview) or ≥ 9 px', async () => {
  for (const size of [NORMAL, BIG]) {
    const L = await bestLayout(archLoops, size);
    const v = pickScale({ w: L.w, h: L.h, minText: L.dims.label }, { w: size.width, h: size.height }, true);
    assert.equal(v.pan, 'none', `${size.width}: whole on screen`);
    assert.ok(labelPx(L, size.width, size.height) >= (size === BIG ? LEGIBLE_PX : OVERVIEW_PX), `${size.width}: ${labelPx(L, size.width, size.height).toFixed(1)} px`);
  }
});

// ---------------------------------------------------------------- item 9: phone
test('phone: the grouped architecture switches to the single column with full-size labels, no overlaps', async () => {
  const L = await bestLayout(archLoops, PHONE);
  const px = labelPx(L, PHONE.width, PHONE.height);
  assert.ok(px >= 13, `labels ${px.toFixed(1)} px (r6: ~5 px)`);
  assert.equal(L.nodes.length, archLoops.nodes!.length);
  const pills = L.edges.filter((e) => e.label).map((e) => ({ id: `pill ${e.key}`, box: e.label!.box }));
  const all: { id: string; box: Box }[] = [...L.nodes, ...pills];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
    assert.ok(!overlaps(all[i].box, all[j].box), `${all[i].id} overlaps ${all[j].id}`);
  for (const n of L.nodes) {
    const g = archLoops.nodes!.find((m) => m.id === n.id)!.group;
    const gb = L.groups.find((x) => x.id === g)!.box;
    assert.ok(n.box.x >= gb.x && n.box.y >= gb.y && n.box.x + n.box.w <= gb.x + gb.w && n.box.y + n.box.h <= gb.y + gb.h, `${n.id} outside its group`);
  }
  for (const e of L.edges) for (const p of e.pts) assert.ok(p.x >= 0 && p.x <= L.w + 0.5, `${e.key} leaves the column`);
  for (const e of L.edges) for (let i = 1; i < e.pts.length; i++) assert.ok(Math.abs(e.pts[i].x - e.pts[i - 1].x) < 0.5 || Math.abs(e.pts[i].y - e.pts[i - 1].y) < 0.5, `${e.key} diagonal`);
  assert.ok(L.w <= PHONE.width, 'fits the phone width');
});

test('phone column: groups in flow order, a step to the next node is a short arrow, every edge is drawn once', () => {
  const L = columnLayout(archLoops, 330);
  const top = (g: string) => L.groups.find((x) => x.id === g)!.box.y;
  assert.ok(top('client') < top('gate') && top('gate') < top('loops') && top('loops') < top('ext'), 'block order follows the edges');
  const e = L.edges.find((x) => x.key === 'door>check')!;
  assert.equal(e.pts.length, 2, 'direct arrow');
  assert.equal(L.edges.length, archLoops.edges!.length);
});

test('phone: tall flows scroll at ≥ 10 px labels instead of shrinking to fit (r6: cut off / panned)', async () => {
  const L = await bestLayout(chain(9), PHONE);
  assert.ok(labelPx(L, PHONE.width, PHONE.height) >= LEGIBLE_PX_PHONE, `${labelPx(L, PHONE.width, PHONE.height).toFixed(1)} px`);
});

test('scroll mode: a panning auto view becomes a full-size svg in a native scroller (no clipped bottom)', () => {
  const sc: Scene = { w: 340, h: 1500, prims: [], minText: 15 };
  const box = { w: 370, h: 361 };
  const auto = autoView(sc, box, true);
  assert.equal(auto.pan, 'y');
  const m = scrollMode(auto, sc, box)!;
  assert.equal(m.axis, 'y');
  assert.equal(m.box.w, box.w);
  assert.ok(m.box.h >= (sc.h - auto.vb[1]) * auto.scale, 'the svg is as tall as the whole drawing');
  assert.ok(Math.abs(m.vb[2] / m.box.w - m.vb[3] / m.box.h) < 1e-9, 'uniform scale');
  assert.equal(scrollMode({ ...auto, pan: 'none' }, sc, box), null);
  const both = scrollMode({ vb: [-8, -12, 370, 361], scale: 1, pan: 'xy' }, { w: 900, h: 700, prims: [] }, box)!;
  assert.ok(both.box.w > box.w && both.box.h > box.h, 'a big table scrolls both ways');
});

test('the zoom pill has its own strip under the drawing (never over it), sized for 36 px touch targets', () => {
  const view = src('CanvasView.tsx');
  const vp = view.indexOf('className={`cv-viewport'), strip = view.indexOf('className="cv-controls"'), pill = view.indexOf('className="cv-zoom"');
  assert.ok(vp > 0 && strip > vp && pill > strip, 'viewport, then the controls strip, the pill inside it');
  // The viewport closes before the strip opens: the pill is not a child of the drawing area.
  assert.match(view.slice(vp, strip), /<\/div>\s*\{more\.y && /, 'strip is a sibling of the viewport');
  const css = src('canvas.css');
  const rule = (sel: string) => css.match(new RegExp(`\\${sel} \\{([^}]*)\\}`))?.[1] ?? '';
  assert.doesNotMatch(rule('.cv-zoom'), /position:\s*absolute/);
  assert.match(rule('.cv-controls'), new RegExp(`height: ${CONTROLS_H}px`));
  // Phone: 36 px buttons + 2 px padding + 1 px border on each side fit the strip.
  assert.match(css, /\.cv-zbtn \{ height: 36px; min-width: 36px; \}/);
  assert.ok(36 + 2 * 2 + 2 * 1 <= CONTROLS_H);
});

// ---------------------------------------------------------------- item 15: edges around the diagram
test('wrapEdges flags an edge routed around the outside of the diagram', () => {
  const box = (x: number, y: number): Box => ({ x, y, w: 100, h: 50 });
  const base = { w: 1000, h: 400, groups: [], nodes: [{ id: 'a', box: box(800, 300) }, { id: 'b', box: box(50, 100) }, { id: 'c', box: box(400, 200) }] } as unknown as GraphLayout;
  const around = { ...base, edges: [{ key: 'a>b', from: 'a', to: 'b', style: 'solid', pts: [{ x: 900, y: 325 }, { x: 960, y: 325 }, { x: 960, y: 40 }, { x: 20, y: 40 }, { x: 20, y: 125 }, { x: 50, y: 125 }] }] };
  const inside = { ...base, edges: [{ key: 'a>c', from: 'a', to: 'c', style: 'solid', pts: [{ x: 800, y: 325 }, { x: 650, y: 325 }, { x: 650, y: 225 }, { x: 500, y: 225 }] }] };
  assert.deepEqual(wrapEdges(around), ['a>b']);
  assert.deepEqual(wrapEdges(inside), []);
});

test('the d16-shaped architecture: no edge around the diagram, not even in plain LR (round 8: group back edges)', async () => {
  // The fixture's loop: the "loops" group feeds back into an earlier group. Round 8 reverses such edges for ELK, so
  // already the plain layered layout has none (r7 only avoided it by choosing other variants).
  const plain = await layoutGraph(archLoops, 'LR', false);
  assert.deepEqual(wrapEdges(plain), [], 'plain LR');
  const hub = plain.edges.find((e) => e.from === 'text' && e.to === 'hub')!;
  const box = plain.nodes.find((n) => n.id === 'hub')!.box;
  const tip = hub.pts[hub.pts.length - 1];
  assert.ok(tip.x >= box.x - 3 && tip.x <= box.x + box.w + 3 && tip.y >= box.y - 3 && tip.y <= box.y + box.h + 3, 'drawn in its own direction: the arrowhead sits at the hub');
  // (Phones get the single column, whose lanes run beside the frames by design; tested above.)
  for (const size of [NORMAL, BIG]) {
    const L = await bestLayout(archLoops, size);
    assert.deepEqual(wrapEdges(L), [], `${size.width}×${size.height}`);
  }
});

test('the d40-shaped flow: its back edge stays inside the diagram on every stage, labels legible', async () => {
  for (const size of [NORMAL, BIG]) {
    const L = await bestLayout(flowBack, size);
    assert.deepEqual(wrapEdges(L), [], `${size.width}×${size.height}`);
    assert.ok(labelPx(L, size.width, size.height) >= LEGIBLE_PX);
  }
});

test('a folded long chain: row breaks are carriage returns (into the next row from above), not loops', async () => {
  const size = { width: 900, height: 600 };
  const L = await bestLayout(chain(10), size);
  assert.equal(pickScale({ w: L.w, h: L.h, minText: L.dims.label }, { w: size.width, h: size.height }, true).pan, 'none', 'whole chain visible');
  assert.deepEqual(wrapEdges(L), []);
  const raw = await layoutGraph(chain(10), 'LR', false, { 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': '1.50' });
  const fixed = carriageReturns(raw);
  const breaks = fixed.edges.filter((e) => e.pts.length === 5);
  assert.ok(breaks.length >= 2, 'row breaks re-routed');
  for (const e of breaks) {
    const t = fixed.nodes.find((n) => n.id === e.to)!.box;
    const end = e.pts[e.pts.length - 1];
    assert.ok(Math.abs(end.y - t.y) < 0.5 && end.x > t.x && end.x < t.x + t.w, `${e.key} enters its target from the top`);
  }
});

test('a pure response edge (B→A next to A→B) is folded into one double-headed edge', async () => {
  const ids = new Set(['a', 'b', 'c']);
  const f = foldEdges([{ from: 'a', to: 'b', label: 'Frage' }, { from: 'b', to: 'a', label: 'Antwort' }, { from: 'b', to: 'c' }], ids);
  assert.equal(f.length, 2);
  assert.deepEqual({ ...f[0] }, { from: 'a', to: 'b', label: 'Frage / Antwort', both: true });
  const spec: CanvasSpec = { ...flowBack, id: 'pair', edges: [{ from: 'a', to: 'g' }, { from: 'g', to: 'a', label: 'Antwort' }, { from: 'g', to: 't' }] };
  const scene = await renderGraph(spec, NORMAL);
  assert.ok(scene.prims.some((p) => p.key === 'e:a>g:arrow0'), 'arrowhead at the start too');
  assert.ok(!scene.prims.some((p) => p.key.startsWith('e:g>a')), 'no separate back edge');
});

// ---------------------------------------------------------------- charts that overflowed the stage
test('pie with many small slices: labels never leave the scene at the top (r6: 7 labels cut off)', () => {
  const spec: CanvasSpec = {
    v: 2, id: 'pie-many', kind: 'pie', title: 'Viele Posten', unit: '€', sources: [{ label: 'x', ref: 'Gespräch' }],
    items: [6000, 3400, 750, 630, 500, 260, 185, 180, 150, 145, 20, 18].map((value, i) => ({ label: `Posten ${String.fromCharCode(65 + i)}`, value, detail: i > 3 ? 'Kategorie: Kleinkram' : undefined })),
  };
  const s = renderPie(spec, NORMAL);
  for (const t of texts(s)) {
    const b = textBox(t);
    assert.ok(b.y >= 0 && b.y + b.h <= s.h, `${t.key} at y ${b.y.toFixed(0)} of ${s.h}`);
  }
  const v = autoView(s, { w: NORMAL.width, h: NORMAL.height }, false);
  assert.ok(v.scale * 13 >= MIN_TEXT_PX - 1e-9, 'scaled or scrolled, still readable');
});

test('a long sankey chain grows wider than the stage and scrolls sideways instead of being cut off', () => {
  const ids = ['q', 'r', 's', 't', 'u', 'v', 'w', 'x'];
  const spec: CanvasSpec = {
    v: 2, id: 'sk-chain', kind: 'sankey', title: 'Lange Kette', unit: 'α', sources: [{ label: 'x', ref: 'Gespräch' }],
    nodes: ids.map((id, i) => ({ id, label: `Station ${i + 1} mit langem Namen` })),
    links: ids.slice(1).map((id, i) => ({ from: ids[i], to: id, value: 100 - i })),
  };
  const s = renderSankey(spec, NORMAL);
  for (const t of texts(s)) { const b = textBox(t); assert.ok(b.x + b.w <= s.w + 0.5, `${t.key} ends at ${(b.x + b.w).toFixed(0)} > ${s.w}`); }
  for (const p of s.prims) if (p.t === 'rect') assert.ok(p.x + p.w <= s.w + 0.5, `${p.key} beyond the scene`);
  assert.equal(s.scrollX, s.w > NORMAL.width);
});

test('phone: a table too wide and too tall keeps readable type and scrolls both ways (r6: 7 px)', () => {
  const spec: CanvasSpec = {
    v: 2, id: 'tbl', kind: 'table', title: 'Regeln', sources: [{ label: 'x', ref: 'Gespräch' }],
    columns: ['Werkzeug', 'Stufe', 'Grenze', 'Hinweis'],
    rows: Array.from({ length: 13 }, (_, i) => [`Werkzeug ${i + 1}`, 'mittel', `${(i + 1) * 5} % pro Woche`, 'nur für einfache Aufgaben']),
  };
  const s = renderTable(spec, PHONE);
  const v = autoView(s, { w: PHONE.width, h: PHONE.height }, false);
  assert.equal(v.pan, 'xy');
  assert.ok(v.scale * 14 >= MIN_TEXT_PX, `cells ${(v.scale * 14).toFixed(1)} px`);
});

test('button names stay unique in the big view: "Klein anzeigen" (frame) vs "Verkleinern" (zoom out)', () => {
  const view = src('CanvasView.tsx');
  assert.match(view, /aria-label=\{expanded \? 'Klein anzeigen' : 'Groß anzeigen'\}/);
  assert.equal((view.match(/aria-label="Verkleinern"/g) ?? []).length, 1);
});

test('phone: a sequence with more actors than fit keeps readable labels and scrolls (r5 spec: 8 px)', async () => {
  const { renderSequence } = await import('../src/canvas/render/charts.ts');
  const actors = ['Kunde', 'Empfang', 'Verteiler', 'Außenstelle', 'Lager'].map((label, i) => ({ id: `a${i}`, label }));
  const spec: CanvasSpec = {
    v: 2, id: 'seq', kind: 'sequence', title: 'Ablauf', sources: [{ label: 'x', ref: 'Gespräch' }], actors,
    messages: Array.from({ length: 10 }, (_, i) => ({ from: `a${i % 4}`, to: `a${(i % 4) + 1}`, label: `Schritt ${i + 1}: etwas weitergeben` })),
  };
  const s = renderSequence(spec, PHONE);
  assert.ok(s.w > PHONE.width && s.scrollX);
  const v = autoView(s, { w: PHONE.width, h: PHONE.height }, false);
  assert.ok(v.scale * (s.minText ?? 13) >= MIN_TEXT_PX - 1e-9, `${(v.scale * (s.minText ?? 13)).toFixed(1)} px`);
});
