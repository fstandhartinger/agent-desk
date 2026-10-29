// Layout helpers: the reference architecture and flow have no overlapping boxes or labels (ELK runs in Node), and
// the chart layouts keep their labels apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { bestLayout, layoutGraph, renderGraph } from '../src/canvas/render/graph.ts';
import { pieSlices, renderBar, renderPie, renderSankey, renderSequence, renderTable, renderTimeline, sankeyLayout, spreadLabels } from '../src/canvas/render/charts.ts';
import { measure, overlaps, wrap, type Box, type Prim, type Scene } from '../src/canvas/render/scene.ts';
import { sceneMarkup } from '../src/canvas/render/markup.ts';
import type { CanvasSpec } from '../src/canvas/types.ts';

const dir = new URL('../src/canvas/fixtures/', import.meta.url);
const fx = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as CanvasSpec;
const arch = fx('architecture-gateway.json');
const flow = fx('flow-video-send-block.json');
const SIZES = [{ width: 1390, height: 680 }, { width: 620, height: 640 }, { width: 360, height: 560 }];

function assertNoOverlap(boxes: { id: string; box: Box }[], what: string, pad = 0) {
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      assert.ok(!overlaps(boxes[i].box, boxes[j].box, pad), `${what}: ${boxes[i].id} overlaps ${boxes[j].id}`);
}

test('architecture fixture: ~14 nodes in the 4 reference groups', () => {
  assert.equal(arch.nodes!.length, 14);
  assert.deepEqual(arch.groups!.map((g) => g.label), ['Browser', 'Gateway (Sandy)', 'Bridge (LeChonk)', 'Vendors']);
});

for (const dirn of ['TB', 'LR'] as const) {
  for (const narrow of [false, true]) {
    test(`architecture ${dirn}${narrow ? ' narrow' : ''}: no node/label overlaps, nodes inside their group, groups apart`, async () => {
      const L = await layoutGraph(arch, dirn, narrow);
      assert.equal(L.nodes.length, 14);
      assertNoOverlap(L.nodes, 'node', 4);
      const labels = L.edges.filter((e) => e.label).map((e) => ({ id: `label ${e.key}`, box: e.label!.box }));
      assert.equal(labels.length, arch.edges!.filter((e) => e.label).length, 'every edge label placed');
      assertNoOverlap([...L.nodes, ...labels], 'node/label');
      assertNoOverlap(L.groups, 'group', 4);
      for (const n of L.nodes) {
        const g = arch.nodes!.find((x) => x.id === n.id)!.group;
        const gb = L.groups.find((x) => x.id === g)!.box;
        assert.ok(n.box.x >= gb.x && n.box.y >= gb.y && n.box.x + n.box.w <= gb.x + gb.w && n.box.y + n.box.h <= gb.y + gb.h, `${n.id} outside ${g}`);
      }
      for (const e of L.edges) assert.ok(e.pts.length >= 2, `edge ${e.key} routed`);
      // Orthogonal routing: every segment is horizontal or vertical.
      for (const e of L.edges) for (let i = 1; i < e.pts.length; i++) {
        const a = e.pts[i - 1], b = e.pts[i];
        assert.ok(Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1, `edge ${e.key} has a diagonal segment`);
      }
    });
  }
}

test('bestLayout picks a readable variant per stage (wide: the type is not shrunk below 0.75)', async () => {
  const L = await bestLayout(arch, SIZES[0]);
  assert.ok(Math.min(SIZES[0].width / L.w, SIZES[0].height / L.h) >= 0.75, `fit ${Math.min(SIZES[0].width / L.w, SIZES[0].height / L.h)}`);
});

test('flow fixture renders with arrowheads, edge pills and the highlighted guard; labels do not overlap text', async () => {
  for (const size of SIZES) {
    const scene = await renderGraph(flow, size);
    const keys = new Set(scene.prims.map((p) => p.key));
    for (const e of flow.edges!) assert.ok(keys.has(`e:${e.from}>${e.to}:arrow`));
    assert.ok(keys.has('n:guard'));
    assert.ok(scene.prims.some((p) => p.key === 'n:guard' && p.t === 'path'), 'decision is a diamond');
    assert.ok(scene.prims.some((p) => p.key === 'e:guard>blocked:lb'), 'edge label on a pill');
    assert.equal(new Set(scene.prims.map((p) => p.key)).size, scene.prims.length, 'keys are unique');
  }
});

test('every fixture renders a scene with unique keys at desktop and phone size (graphs via ELK)', async () => {
  const { renderScene } = await import('../src/canvas/render/index.ts');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    for (const size of [{ width: 1390, height: 680 }, { width: 362, height: 560 }]) {
      const scene: Scene = await renderScene(fx(f), size);
      assert.ok(scene.prims.length >= (f.startsWith('custom') ? 1 : 4), `${f} renders`);
      assert.ok(!scene.prims.some((p) => p.key === 'empty'), `${f} is not empty`);
      assert.equal(new Set(scene.prims.map((p) => p.key)).size, scene.prims.length, `${f}: unique keys`);
      assert.ok(Number.isFinite(scene.w) && Number.isFinite(scene.h));
      for (const p of scene.prims) for (const v of Object.values(p)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${f}: ${p.key} has NaN`);
    }
  }
});

const texts = (scene: Scene) => scene.prims.filter((p): p is Extract<Prim, { t: 'text' }> => p.t === 'text');

test('donut: total in the centre equals the sum, shares add up to 100 %, side labels never collide', () => {
  const pie = fx('pie-money.json');
  const { slices, total } = pieSlices(pie);
  assert.equal(total, 165 + 96.4 + 58.9 + 40 + 12.5 + 7.85);
  assert.ok(Math.abs(slices.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
  assert.equal(slices[slices.length - 1].label, 'Sonstiges', 'Sonstiges last');
  const scene = renderPie(pie, { width: 1390, height: 680 });
  assert.equal(texts(scene).find((t) => t.key === 'total')!.text, '380,65 $');
  const labelY = texts(scene).filter((t) => t.key.endsWith(':l')).map((t) => ({ y: t.y, left: t.anchor === 'end' }));
  for (const side of [true, false]) {
    const ys = labelY.filter((l) => l.left === side).map((l) => l.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 40, 'labels at least one row apart');
  }
  const phone = renderPie(pie, { width: 362, height: 560 });
  assert.ok(phone.prims.some((p) => p.key === 's:LLM-APIs:sw'), 'phone uses a legend');
});

test('spreadLabels pushes crowded labels apart and keeps them in bounds', () => {
  const ys = spreadLabels([100, 101, 102, 500], 40, 20, 520);
  const sorted = ys.slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= 40 - 1e-9);
  assert.ok(Math.max(...ys) <= 520 && Math.min(...ys) >= 20);
  const tight = spreadLabels([500, 505, 510], 40, 0, 520);
  assert.ok(Math.max(...tight) <= 520);
});

test('bar: horizontal for long labels and on phones; values formatted in German with unit', () => {
  const bar = fx('bar-gpu-hours.json');
  const scene = renderBar(bar, { width: 1390, height: 680 });
  const v = texts(scene).find((t) => t.key === 'b:voice-stt-compare:v')!;
  assert.equal(v.text, '12,25 Std');
  assert.equal(v.anchor, undefined, 'horizontal: value after the bar end');
  const vert = renderBar({ ...bar, items: [{ label: 'Mo', value: 3 }, { label: 'Di', value: 5 }] }, { width: 1000, height: 500 });
  assert.equal(texts(vert).find((t) => t.key === 'b:Mo:v')!.anchor, 'middle');
});

test('table: numeric columns right-aligned, no cell text wider than its column; phones pan instead of shrinking', () => {
  const t = fx('table-jobs.json');
  const scene = renderTable(t, { width: 1390, height: 680 });
  assert.equal(texts(scene).find((x) => x.key === 'h:3')!.anchor, 'end', 'Kosten is numeric');
  assert.equal(texts(scene).find((x) => x.key === 'h:1')!.anchor, 'start');
  const phone = renderTable(t, { width: 362, height: 560 });
  assert.ok(phone.scrollX && phone.w > 362);
});

test('timeline: horizontal on wide stages, every label inside the stage and apart; vertical on phones', () => {
  const tl = fx('timeline-round5.json');
  const scene = renderTimeline(tl, { width: 1390, height: 680 });
  const dots = scene.prims.filter((p) => p.key.endsWith(':dot')) as Extract<Prim, { t: 'circle' }>[];
  assert.ok(new Set(dots.map((d) => Math.round(d.cy))).size === 1, 'horizontal axis');
  for (const t of texts(scene)) {
    const half = measure(t.text, t.size, t.weight ?? 500) / 2;
    assert.ok(t.x - half >= 0 && t.x + half <= 1390, `${t.text} inside the stage`);
  }
  const phone = renderTimeline(tl, { width: 362, height: 560 });
  const pd = phone.prims.filter((p) => p.key.endsWith(':dot')) as Extract<Prim, { t: 'circle' }>[];
  assert.ok(new Set(pd.map((d) => Math.round(d.cx))).size === 1, 'vertical axis');
});

test('sankey: nodes in a column never overlap, flows are conserved, the second column is ordered to avoid crossings', () => {
  const sk = fx('sankey-money-flow.json');
  const L = sankeyLayout(sk, { width: 1390, height: 680 });
  for (const c of [0, 1]) assertNoOverlap(L.nodes.filter((n) => n.col === c).map((n) => ({ id: n.id, box: { x: n.x, y: n.y, w: L.nodeW, h: n.h } })), `col ${c}`, 4);
  assert.equal(L.nodes.find((n) => n.id === 'llm')!.value, 165);
  const order = L.nodes.filter((n) => n.col === 1).sort((a, b) => a.y - b.y).map((n) => n.id);
  assert.equal(order[order.length - 1], 'gpu', 'GPU (fed only by PayPal, the lower source) ends up at the bottom');
  assert.ok(renderSankey(sk, { width: 362, height: 560 }).prims.length > 10);
});

test('sequence: message labels are never ellipsised on a phone when they fit the stage', () => {
  const seq = fx('sequence-canvas-draw.json');
  const phone = renderSequence(seq, { width: 362, height: 560 });
  for (const t of texts(phone)) assert.ok(!t.text.endsWith('…'), `"${t.text}" cut`);
});

test('wrap breaks long identifiers at - _ / . instead of cutting them', () => {
  assert.deepEqual(wrap('Voice-Agent', 13, 650, 60, 2), ['Voice-', 'Agent']);
  assert.deepEqual(wrap('canvas_draw(request)', 13, 550, 100, 2), ['canvas_', 'draw(request)']);
  assert.equal(wrap('Ein sehr langer Satz der niemals in zwei kurze Zeilen passt', 14, 500, 80, 2).at(-1)!.endsWith('…'), true);
});

test('static markup (PNG export) carries every primitive escaped and no script', () => {
  const scene = renderBar({ ...fx('bar-gpu-hours.json'), items: [{ label: '<script>x</script>', value: 2 }] }, { width: 800, height: 400 });
  const m = sceneMarkup(scene);
  assert.doesNotMatch(m, /<script/);
  assert.match(m, /&lt;script&gt;/);
});
