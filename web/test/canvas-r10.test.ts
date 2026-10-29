// Round 10 (critic r9 §8 item 9): long flows fold into a snake instead of shrinking their details below 8 px, detail
// lines wrap instead of ending in "…", sequence actor and message labels wrap instead of truncating.
// Synthetic fixtures only (invented names).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickScale } from '../src/canvas/view.ts';
import { bestLayout, renderGraph, wrapDetail, DETAIL_MIN_PX } from '../src/canvas/render/graph.ts';
import { renderSequence } from '../src/canvas/render/charts.ts';
import type { Prim, TextP } from '../src/canvas/render/scene.ts';
import type { CanvasSpec } from '../src/canvas/types.ts';

const NORMAL = { width: 829, height: 466 };
const texts = (prims: Prim[]) => prims.filter((p): p is TextP => p.t === 'text');
const src = [{ label: 'x', ref: 'Gespräch' }];

// Eight stations in a row, each with a two-clause detail: the shape of the critic's tax flow (r9: LR at 7.9–8.2 px).
const chain: CanvasSpec = {
  v: 2, id: 'chain-r10', kind: 'flow', title: 'Von der Wiese zum Markt', direction: 'LR', highlight: 'mark', sources: src,
  nodes: [
    { id: 'wiese', label: 'Wiese hinter dem Hof', detail: 'Schafe: Hirtin Anna, Weide Nr. 3, wöchentlich', shape: 'cylinder' },
    { id: 'kamm', label: 'Wolle kämmen (Handarbeit)', detail: 'Kardätsche, Kammstuhl, ein Korb je Schaf' },
    { id: 'schur', label: 'Schur im Frühling', detail: 'Schermeister, höchstens 4 pro Tag' },
    { id: 'wasch', label: 'Wolle waschen', detail: 'Bachwasser, Seifenkraut, zwei Durchgänge' },
    { id: 'spinn', label: 'Garn spinnen', detail: 'Spinnrad im Haus B, Faden Stärke 12' },
    { id: 'faerb', label: 'Färben mit Pflanzen', detail: 'Krapp, Reseda und Waid in Holzbottichen' },
    { id: 'webe', label: 'Stoff weben', detail: 'Webstuhl der Gilde, eine Bahn pro Woche' },
    { id: 'mark', label: 'Verkauf auf dem Markt', detail: 'Stand 14 am Brunnen, Preis pro Elle' },
  ],
  edges: [['wiese', 'kamm'], ['kamm', 'schur'], ['schur', 'wasch'], ['wasch', 'spinn'], ['spinn', 'faerb'], ['faerb', 'webe'], ['webe', 'mark']].map(([from, to], i) => ({ from, to, label: ['Paragraf 5.2, alle 7 Tage', 'Kamm-Plan', 'Frühjahrsschur', 'Tauchbad', 'Spinnplan', 'Farbsud', 'Webplan'][i] })),
};

test('a long flow with details is folded (snake / column) so details stay ≥ 8 px instead of one 7.7 px row', async () => {
  const size = { width: 700, height: 420 };
  const L = await bestLayout(chain, size);
  const v = pickScale({ w: L.w, h: L.h, minText: L.dims.label }, { w: size.width, h: size.height }, true);
  assert.ok(v.scale * L.dims.detail >= DETAIL_MIN_PX - 0.05, `detail ${(v.scale * L.dims.detail).toFixed(2)} px`);
  assert.ok(L.h > L.nodes[0].box.h * 1.8, 'more than one row');
});

test('node details wrap to as many lines as they need instead of ending in "…"', async () => {
  const spec: CanvasSpec = { ...chain, id: 'detail-r10', direction: 'TB', nodes: [
    { id: 'a', label: 'Anfang', detail: 'Schreibtisch mit Mikrofon, zwei Bildschirmen, einer Lampe und einer sehr langen Kabelschlange' },
    { id: 'b', label: 'Ende', detail: 'kurz' },
  ], edges: [{ from: 'a', to: 'b' }], highlight: 'a' };
  const scene = await renderGraph(spec, { width: 1390, height: 626 });
  for (const t of texts(scene.prims).filter((p) => /^n:/.test(p.key))) assert.doesNotMatch(t.text, /…/, t.text);
  // The helper alone: two lines when the widened node holds it, a third line otherwise, "…" only past that.
  const T = { label: 16, labelW: 600, detail: 12.5, edge: 12.5, group: 12, maxText: 168, line: 20, dline: 16, nodeNode: 30, layers: 58 };
  const text = 'Operator-Wallet, wöchentlich ausgezahlt über den Vertrag mit festem Plan';
  const lines = wrapDetail(text, T);
  assert.ok(lines.length <= 3 && !lines.some((l) => l.endsWith('…')), lines.join(' | '));
  assert.equal(lines.join(' ').replace(/\s+/g, ' '), text);
  assert.ok(wrapDetail('wort '.repeat(80), T).at(-1)!.endsWith('…'), 'a text far beyond four lines is still cut');
});

test('sequence actors and messages wrap instead of truncating (r9 "Voice-Provider (Gemini / Grok /…")', () => {
  const spec: CanvasSpec = { v: 2, id: 'seq-r10', kind: 'sequence', title: 'Ablauf', sources: src,
    actors: [{ id: 'a', label: 'Browser' }, { id: 'b', label: 'Sprach-Anbieter (Nord, Süd, West)' }, { id: 'c', label: 'Archiv' }],
    messages: [
      { from: 'a', to: 'b', label: 'Verbindung aufbauen mit Schlüssel, Anweisungen, Werkzeugliste und Stimme, danach Ton', note: 'der Schlüssel bleibt im Prozess und wird nie gespeichert oder weitergereicht' },
      { from: 'b', to: 'c', label: 'ablegen' },
    ] };
  for (const size of [NORMAL, { width: 390, height: 600 }]) {
    const scene = renderSequence(spec, size);
    for (const t of texts(scene.prims)) assert.doesNotMatch(t.text, /…/, `${size.width}: ${t.text}`);
    const rect = scene.prims.find((p) => p.key === 'act:b') as { h: number };
    const actorLines = texts(scene.prims).filter((p) => p.key.startsWith('act:b:l'));
    assert.ok(actorLines.length >= (size.width < 500 ? 2 : 1) && rect.h >= actorLines.length * 16, 'header grows with the wrapped label');
  }
});
