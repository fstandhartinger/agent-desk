// Round 6 (critic r5 §7 items 7–9, 15, 18): fit-to-view + zoom maths, canvas-first desk layout, sankey label
// collisions, export layout + tick spacing, no red for normal items, wrapped long chains. Synthetic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoView, canPan, clampView, pickScale, wholeView, zoomAt, CONTROLS_H, MIN_TEXT_PX } from '../src/canvas/view.ts';
import { axisTicks, dataTone, DONUT, foldSankey, renderBar, renderSankey, sankeyLayout } from '../src/canvas/render/charts.ts';
import { bestLayout } from '../src/canvas/render/graph.ts';
import { measure, PALETTE, type Prim, type Scene } from '../src/canvas/render/scene.ts';
import { exportScene, exportSvg, EXPORT_W } from '../src/canvas/export.ts';
import { arrange, collapse, defaultLayout, fitLayout, revealLive, CHAT_MIN } from '../src/lib/layout.ts';
import { fmtNumber } from '../src/canvas/format.ts';
import type { CanvasSpec } from '../src/canvas/types.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../src/canvas/fixtures/${name}`, import.meta.url), 'utf8')) as CanvasSpec;
type T = Extract<Prim, { t: 'text' }>;
const texts = (s: Scene) => s.prims.filter((p): p is T => p.t === 'text');
function textBox(t: T) {
  const w = measure(t.text, t.size, t.weight ?? 500);
  const x = t.anchor === 'middle' ? t.x - w / 2 : t.anchor === 'end' ? t.x - w : t.x;
  return { x, y: t.y - t.size * 0.8, w, h: t.size * 1.05 };
}
/** The critic's DOM check: text boxes overlapping by more than 3 px in both axes. */
function textOverlaps(s: Scene): string[] {
  const b = texts(s).map((t) => ({ k: t.key, ...textBox(t) }));
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
    const A = b[i], B = b[j];
    if (Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) > 3 && Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y) > 3) out.push(`${A.k}~${B.k}`);
  }
  return out;
}
const scene = (w: number, h: number, extra: Partial<Scene> = {}): Scene => ({ w, h, prims: [], ...extra });

// ---------------------------------------------------------------- viewport
test('auto view fits the whole scene, centred, and never grows charts', () => {
  const v = autoView(scene(1600, 400), { w: 800, h: 600 }, true);
  assert.ok(Math.abs(v.scale - 760 / 1600) < 1e-9, `scale ${v.scale}`);
  assert.equal(v.pan, 'none');
  assert.ok(!canPan(v.vb, scene(1600, 400)), 'whole scene visible');
  assert.equal(autoView(scene(400, 300), { w: 800, h: 600 }, false).scale, 1);
  assert.equal(autoView(scene(400, 300), { w: 800, h: 600 }, true).scale, 1.3);
});

test('long lists fit the width and pan vertically once the whole fit would be unreadable; tables pan sideways', () => {
  const list = scene(360, 1600, { scroll: true, minText: 13 });
  const v = autoView(list, { w: 360, h: 500 }, false);
  assert.equal(v.pan, 'y');
  assert.ok(v.scale * 13 >= MIN_TEXT_PX - 1e-9, 'labels at least 11 px');
  assert.ok(v.vb[1] < 0, 'starts at the top');
  // 9 px when fitted whole: a list already pans (readability rule), a diagram of that size would not.
  assert.equal(pickScale({ w: 360, h: 700, minText: 13, scroll: true }, { w: 360, h: 500 }, false).pan, 'y');
  assert.equal(pickScale({ w: 360, h: 700, minText: 13 }, { w: 360, h: 500 }, false).pan, 'none');
  const table = autoView(scene(1000, 500, { scroll: true, scrollX: true, minText: 14 }), { w: 360, h: 500 }, false);
  assert.equal(table.pan, 'x');
  // A diagram only pans when the whole fit is illegible (< 8 px) and fitting the width is clearly larger.
  assert.equal(pickScale({ w: 900, h: 600, minText: 16 }, { w: 800, h: 600 }, true).pan, 'none');
  assert.equal(pickScale({ w: 340, h: 1700, minText: 15 }, { w: 372, h: 407 }, true).pan, 'y');
});

test('zoom keeps the point under the pointer, is clamped, and "Alles zeigen" shows the whole scene', () => {
  const sc = scene(1000, 800);
  const box = { w: 500, h: 400 };
  const a = autoView(sc, box, false);
  const z = zoomAt(a.vb, 2, 100, 80, box, sc, a.scale);
  const before = [a.vb[0] + (100 / box.w) * a.vb[2], a.vb[1] + (80 / box.h) * a.vb[3]];
  const after = [z[0] + (100 / box.w) * z[2], z[1] + (80 / box.h) * z[3]];
  assert.ok(Math.abs(before[0] - after[0]) < 1e-6 && Math.abs(before[1] - after[1]) < 1e-6);
  assert.ok(canPan(z, sc));
  const far = zoomAt(a.vb, 1000, 250, 200, box, sc, a.scale);
  assert.ok(box.w / far[2] <= Math.max(a.scale * 4, 2) + 1e-9, 'max zoom');
  const lost = clampView([5000, 5000, a.vb[2], a.vb[3]], sc, box, a.scale);
  assert.ok(lost[0] + lost[2] / 2 <= sc.w && lost[1] + lost[3] / 2 <= sc.h, 'view centre stays over the scene');
  assert.ok(!canPan(wholeView(sc, box, false), sc));
});

test('the zoom controls strip stays free: the view covers exactly the viewport, the strip lies outside it (r7)', () => {
  // r6 reserved CONTROLS_H inside the stage, but the phone pill (54 px with its offset) still covered nodes (critic r6
  // m13). Since r7 the strip is its own row under the viewport (canvas-r7.test.ts), so the view fills the viewport.
  const sc = scene(400, 600);
  const box = { w: 400, h: 600 - CONTROLS_H };
  for (const vb of [autoView(sc, box, false).vb, wholeView(sc, box, false)]) {
    const s = box.w / vb[2];
    assert.ok((sc.h - vb[1]) * s <= box.h + 0.5, 'scene ends inside the viewport');
    assert.ok(Math.abs(vb[3] * s - box.h) < 0.5, 'view box covers the whole viewport');
  }
});

// ---------------------------------------------------------------- desk layout
test('canvas first: without an explainer the canvas takes the big slot (~60 %), the chat keeps its minimum', () => {
  const l = defaultLayout(1440);
  assert.deepEqual(arrange(l, false), { big: 'live', small: null });
  assert.deepEqual(arrange(l, true), { big: 'explainer', small: 'live' });
  assert.deepEqual(arrange({ ...l, canvasBig: true }, true), { big: 'live', small: 'explainer' });
  for (const vw of [1024, 1440, 1920]) {
    const f = fitLayout(l, vw, true);
    assert.ok(vw - f.left - 16 >= CHAT_MIN - 1, `${vw}: chat squeezed`);
    if (vw >= 1440) assert.ok(f.left >= 0.58 * vw, `${vw}: canvas ${f.left}`);
  }
});

test('collapsing the explainer hands the big slot to the canvas; a new drawing reveals a collapsed canvas', () => {
  const l = defaultLayout(1440);
  const c = collapse(l, 'big', true);
  assert.deepEqual(arrange(c, true), { big: 'live', small: 'explainer' });
  assert.equal(c.rightOpen, false, 'explainer becomes the small rail');
  const hidden = collapse(l, 'small', true);
  assert.equal(revealLive(hidden, true).rightOpen, true);
  const solo = collapse(l, 'big', false);
  assert.equal(solo.leftOpen, false);
  assert.equal(revealLive(solo, false).leftOpen, true);
});

// ---------------------------------------------------------------- sankey
test('sankey: small leaf flows fold into "Sonstige (n)", totals are kept', () => {
  const sk = fx('sankey-many-leaves.json');
  const { nodes, links } = foldSankey(sk);
  const sonst = nodes.filter((n) => n.label.startsWith('Sonstige'));
  assert.ok(sonst.length >= 2, sonst.map((n) => n.label).join());
  const sum = (ls: typeof links) => ls.reduce((s, l) => s + l.value, 0);
  assert.equal(sum(links.filter((l) => l.from === 'rechen')), 7100);
  assert.ok(!links.some((l) => l.to === 'a5'), 'tiny Epsilon flow folded');
  assert.ok(links.some((l) => l.to === 't1'), 'a lone small flow stays');
});

test('sankey: 0 overlapping labels at desktop, side column and phone sizes; flows stay visible', () => {
  const sk = fx('sankey-many-leaves.json');
  for (const size of [{ width: 1390, height: 800 }, { width: 829, height: 508 }, { width: 325, height: 536 }, { width: 372, height: 407 }]) {
    const sc = renderSankey(sk, size);
    assert.deepEqual(textOverlaps(sc), [], `${size.width}x${size.height}`);
    const L = sankeyLayout(sk, size);
    const big = Math.max(...L.nodes.map((n) => n.h));
    assert.ok(big >= (size.height - 40) * 0.39, `${size.width}: largest node ${big.toFixed(0)} px, ribbons collapsed`);
    for (const t of texts(sc)) { const b = textBox(t); assert.ok(b.x >= 0 && b.x + b.w <= sc.w + 1, `${t.text} outside at ${size.width}`); }
  }
});

test('sankey: an unbreakable long label never runs into the next column', () => {
  const sk = fx('sankey-many-leaves.json');
  const long: CanvasSpec = { ...sk, nodes: sk.nodes!.map((n) => (n.id === 'konto' ? { ...n, label: 'Geldbewegungsübersicht KG' } : n)) };
  for (const size of [{ width: 300, height: 520 }, { width: 325, height: 536 }]) {
    const L = sankeyLayout(long, size);
    const root = L.nodes.find((n) => n.id === 'konto')!;
    const next = Math.min(...L.nodes.filter((n) => n.col === 1).map((n) => n.x));
    for (const l of root.lines) assert.ok(root.label_.x + measure(l, L.LS, 600) <= next - 4, `"${l}" reaches column 2 at ${size.width}`);
  }
});

// ---------------------------------------------------------------- bar, ticks, red, export
const bar: CanvasSpec = {
  v: 2, id: 'bar-synth', kind: 'bar', title: 'Synthetische Ausgaben', unit: 'EUR', sources: [{ label: 'Test', ref: 'Gespräch' }],
  items: [
    { label: 'Rechenzentrum Alpha GmbH', value: 6000, tone: 'red' }, { label: 'Person Eins', value: 3450, tone: 'amber' },
    { label: 'Anbieter Beta', value: 520, tone: 'moss' }, { label: 'Modellhaus Eins', value: 184 }, { label: 'Telefonanbieter', value: 18 },
  ],
};

test('ticks never overlap: the count follows the pixel width (phone side column and export)', () => {
  for (const width of [300, 325, 640, 1088]) {
    const sc = renderBar(bar, { width, height: 500 });
    const ticks = texts(sc).filter((t) => t.key.startsWith('tick:')).map(textBox).sort((a, b) => a.x - b.x);
    assert.ok(ticks.length >= 2, `${width}: ${ticks.length} ticks`);
    for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x >= ticks[i - 1].x + ticks[i - 1].w + 8, `${width}: ticks ${i - 1}/${i} collide`);
  }
  const t = axisTicks(6000, 80, (v) => measure(fmtNumber(v), 11.5, 400));
  assert.ok(t.length <= 3, `80 px only has room for ${t.length} ticks`);
});

test('red only for problems: a normal item painted red falls back to the palette; auto palette has no red/pink', () => {
  const sc = renderBar(bar, { width: 900, height: 500 });
  const first = sc.prims.find((p) => p.key === 'b:Rechenzentrum Alpha GmbH') as Extract<Prim, { t: 'rect' }>;
  assert.notEqual(first.fill.toLowerCase(), PALETTE.red.toLowerCase());
  assert.equal(dataTone('red', 'Zahlung fehlgeschlagen'), 'red');
  assert.equal(dataTone('red', 'GPU Server'), undefined);
  for (const c of DONUT) {
    const n = parseInt(c.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    assert.ok(!(r > 200 && g < 140), `${c} is red/pink`);
  }
});

test('PNG export lays charts out at the export width (the chart fills the frame)', async () => {
  const small = renderBar(bar, { width: 325, height: 500 });
  const { scene: ex, scale } = await exportScene(bar, small);
  assert.equal(scale, 1);
  assert.ok(ex.w >= EXPORT_W - 120, `export chart ${ex.w} px wide`);
  const rects = ex.prims.filter((p) => p.t === 'rect' && p.key.startsWith('b:')) as Extract<Prim, { t: 'rect' }>[];
  assert.ok(Math.max(...rects.map((r) => r.w)) > 0.55 * ex.w, 'largest bar spans most of the frame');
  const { w } = exportSvg(bar, ex, { by: 'Text', at: Date.UTC(2026, 9, 24) });
  assert.equal(w, EXPORT_W);
});

// ---------------------------------------------------------------- graphs
test('a 10-step chain on a wide stage is wrapped instead of shrunk to an unreadable strip', async () => {
  const n = 10;
  const chain: CanvasSpec = {
    v: 2, id: 'chain', kind: 'flow', title: 'Kette', direction: 'TB', sources: [{ label: 'x', ref: 'Gespräch' }],
    nodes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: `Schritt ${i + 1} mit Namen`, detail: 'eine kurze Erklärung dazu' })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}`, label: 'weiter' })),
  };
  const size = { width: 900, height: 600 };
  const L = await bestLayout(chain, size);
  const v = pickScale({ w: L.w, h: L.h, minText: L.dims.label }, { w: size.width, h: size.height }, true);
  assert.ok(v.scale * L.dims.label >= 10, `labels ${(v.scale * L.dims.label).toFixed(1)} px`);
  assert.equal(v.pan, 'none', 'whole chain visible');
});
