// Round 9 (critic r8 §7 items 6 and 8): 13-node / 5-group architectures whole on the desktop side column (no scroll
// column, never < 50 % of the nodes, ≥ 9 px or the labels-only overview), group legends never ellipsised, readable
// detail on the highlighted node, the sankey total not duplicated and its source labels off the flows, a "mehr
// Spalten" hint for wide tables, the gate input's aria-label and sketches padded inside their frame.
// Synthetic fixtures only (invented names).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { pickScale, scrollEdges, wantsBig, autoView, LEGIBLE_PX } from '../src/canvas/view.ts';
import { bestLayout, joinLoneMarks, legendLines, legendW, renderGraph, visibleShare, HI_DETAIL, type GraphLayout } from '../src/canvas/render/graph.ts';
import { renderSankey, sankeyLayout, stripValue } from '../src/canvas/render/charts.ts';
import { sketchViewBox, sketchPad } from '../src/canvas/render/sketchFit.ts';
import { measure, type Prim, type TextP } from '../src/canvas/render/scene.ts';
import type { CanvasSpec } from '../src/canvas/types.ts';

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const px = (L: GraphLayout, s: { width: number; height: number }) => pickScale({ w: L.w, h: L.h, minText: L.dims.label }, { w: s.width, h: s.height }, true).scale * L.dims.label;
const texts = (prims: Prim[]) => prims.filter((p): p is TextP => p.t === 'text');

// Side column at 1440×900 with a three-line caption (critic r8 d15: 829×466), the "Groß" overlay, the phone.
const NORMAL = { width: 829, height: 466 }, BIG = { width: 1390, height: 626 };

// Shaped like the critic's d15 (GPT-Live, 13 nodes, 5 groups, requested TB, a hub with a dashed loop back from the
// last group, long labels with details, long group legends): r8 showed it as a TB column with 3 of 13 nodes visible.
const d15Like: CanvasSpec = {
  v: 2, id: 'd15-like', kind: 'architecture', title: 'Werkstatt am Markt: Laden, Stuben, Lager', direction: 'TB', highlight: 'hub',
  sources: [{ label: 'x', ref: 'Gespräch' }],
  groups: [
    { id: 'client', label: 'Kundschaft', tone: 'neutral' },
    { id: 'shop', label: 'Werkstatt — laden-am-markt im Haus A', tone: 'papaya' },
    { id: 'mills', label: 'Zulieferer der Tinte (Rezepte nur im…', tone: 'amber' },
    { id: 'store', label: 'Lager im Haus B — Lesezugriff', tone: 'moss' },
    { id: 'guild', label: 'Lehrlinge der Gilde über Verträge', tone: 'violet' },
  ],
  nodes: [
    { id: 'web', label: 'Kundschaft', detail: 'laden.example: Brief, Tafel-Bote, Sprechrohr', group: 'client', shape: 'person' },
    { id: 'door', label: 'tuer.js — Empfangstresen', detail: 'regal.js + Wege, Schutzschilder, /laden/stand, /laden/tafel', group: 'shop' },
    { id: 'gate', label: 'Pforte: ausweis.js, zaehler.js, buch.js', detail: 'Ausweis, Tagesgrenze, jede Handlung ins Buch', group: 'shop', tone: 'amber' },
    { id: 'desk', label: 'Schreiber — feder.js + kiste.js', detail: 'Tinte Nr. 4 über den Händler, Werkzeuge mit Boten', group: 'shop' },
    { id: 'voice', label: 'Sprechrohre — rohr/', detail: 'Rohre Nord, Süd und West; Tonumwandlung, Kosten', group: 'shop' },
    { id: 'board', label: 'Tafel/Zeichner', detail: 'tafel.js, zeichner.js, abkuerzung.js, bild.js, Tafelbus', group: 'shop' },
    { id: 'books', label: 'Grundbuch — wissen.js', detail: 'liest ~/werkstatt-wissen, hängt es an den Boten', group: 'shop', shape: 'cylinder' },
    { id: 'hub', label: 'botenhaus.js', detail: 'Rohrpost mit Siegel, Frage/Antwort + Aushang, Klopfen 20 s', group: 'shop', tone: 'papaya' },
    { id: 'ink', label: 'Tintenhändler', detail: 'Tinte Nr. 4 — Schreiber, Zeichner, Chronik', group: 'mills', shape: 'pill' },
    { id: 'pipes', label: 'Rohr-Anbieter', detail: 'Nord rohr-3.0, Süd rohr-1, West Live: arbeitet', group: 'mills', shape: 'pill' },
    { id: 'clerk', label: 'Lager-Verwalter', detail: 'Lesezugriff: Tafel, Akten, Aufträge, Briefe; keine Schlüssel', group: 'store' },
    { id: 'apprentice', label: 'lehrling.start / lehrling.liste', detail: 'lehrlinge.js: höchstens 3, AUFTRAG.md in ~/stube', group: 'store' },
    { id: 'guild', label: 'Gesellen über Verträge', detail: 'geselle -p, nie über Tagelohn; Tafel-Blöcke zurück', group: 'guild', shape: 'pill' },
  ],
  edges: [
    { from: 'web', to: 'door', label: 'Brief + Bote' }, { from: 'door', to: 'gate' }, { from: 'gate', to: 'desk' }, { from: 'gate', to: 'voice' },
    { from: 'desk', to: 'board', label: 'zieht Tafel' }, { from: 'desk', to: 'ink', label: 'tintenStrom' }, { from: 'board', to: 'ink', label: 'fertigSkizze' },
    { from: 'voice', to: 'pipes', label: 'Ton-Rohr' }, { from: 'desk', to: 'hub', label: 'Werkzeuge' }, { from: 'board', to: 'hub', label: 'Fakten' },
    { from: 'books', to: 'hub' }, { from: 'hub', to: 'clerk', label: 'Frage über /bote' }, { from: 'hub', to: 'apprentice', label: 'nur auf Auftrag', style: 'dashed' },
    { from: 'apprentice', to: 'guild' }, { from: 'guild', to: 'hub', label: 'Aushang Tafel', style: 'dashed' },
  ],
};

// The same shape with fewer groups' worth of nodes (like the critic's d11, 13 nodes / 4 groups): r8 showed 23 %.
const d11Like: CanvasSpec = { ...d15Like, id: 'd11-like', groups: d15Like.groups!.slice(0, 4), nodes: d15Like.nodes!.map((n) => (n.group === 'guild' ? { ...n, group: 'store' } : n)) };

test('a 13-node / 5-group architecture is whole on the desktop side column at ≥ 9 px (r8 d15: a column, 3 of 13 nodes)', async () => {
  for (const spec of [d15Like, d11Like]) {
    const L = await bestLayout(spec, NORMAL);
    const v = pickScale({ w: L.w, h: L.h, minText: L.dims.label }, { w: NORMAL.width, h: NORMAL.height }, true);
    assert.equal(v.pan, 'none', `${spec.id}: whole, no scroll column`);
    assert.equal(visibleShare(L, { w: NORMAL.width, h: NORMAL.height }), 1, spec.id);
    assert.ok(px(L, NORMAL) >= LEGIBLE_PX - 0.05, `${spec.id}: labels ${px(L, NORMAL).toFixed(2)} px`);
    // It is an overview: the side column offers "Groß ansehen", and Groß lays it out in full again.
    const scene = await renderGraph(spec, NORMAL, L);
    assert.ok(wantsBig(autoView(scene, { w: NORMAL.width, h: NORMAL.height }, true), scene, { w: NORMAL.width, h: NORMAL.height }), `${spec.id}: Groß offered`);
  }
});

test('the labels-only overview never cuts a word of a node label and keeps edge labels as tooltips', async () => {
  const L = await bestLayout(d15Like, NORMAL);
  const scene = await renderGraph(d15Like, NORMAL, L);
  const nodeTexts = texts(scene.prims).filter((t) => /^n:/.test(t.key));
  assert.ok(nodeTexts.length >= 13);
  for (const t of nodeTexts) assert.doesNotMatch(t.text, /…/, `node text "${t.text}"`);
  // A connector never stands alone on a line ("Grundbuch / — / wissen.js").
  for (const t of nodeTexts) assert.doesNotMatch(t.text, /^[—–\-/+]$/, `lone "${t.text}"`);
  assert.deepEqual(joinLoneMarks(['Grundbuch', '—', 'wissen.js']), ['Grundbuch —', 'wissen.js']);
  assert.deepEqual(joinLoneMarks(['/', 'x']), ['/', 'x']);
  if (!L.edges.some((e) => e.label)) {
    const titled = scene.prims.filter((p) => p.t === 'path' && /^e:[^:]+$/.test(p.key) && 'title' in p && p.title);
    assert.ok(titled.length >= 10, 'edge labels as line tooltips');
  }
});

test('desktop never shows less than half of the nodes in the first view', async () => {
  for (const spec of [d15Like, d11Like]) for (const size of [NORMAL, { width: 700, height: 420 }, BIG]) {
    const L = await bestLayout(spec, size);
    assert.ok(visibleShare(L, { w: size.width, h: size.height }) >= 0.5, `${spec.id} at ${size.width}×${size.height}`);
  }
});

test('group legends are never ellipsised: they wrap, and the frame is wide and tall enough for the pill (r8 "BROW…", "BRIDGE AUF")', async () => {
  for (const size of [NORMAL, BIG]) {
    const L = await bestLayout(d15Like, size);
    const scene = await renderGraph(d15Like, size, L);
    for (const g of L.groups) {
      const label = d15Like.groups!.find((x) => x.id === g.id)!.label;
      const lines = texts(scene.prims).filter((t) => t.key === `g:${g.id}:l` || t.key.startsWith(`g:${g.id}:l`)).map((t) => t.text);
      // Every word of the legend is drawn (a model's own "…" inside the label stays as written).
      assert.equal(lines.join(' '), label.toUpperCase(), `${size.width}: legend of ${g.id}`);
      const pill = scene.prims.find((p) => p.key === `g:${g.id}:lb`) as { w: number; h: number };
      const textW = Math.max(...lines.map((l) => measure(l, L.dims.group, 700)));
      assert.ok(pill.w >= textW + 20, `${g.id}: pill holds the text`);
      assert.ok(g.box.w >= pill.w + 16, `${g.id}: frame ${g.box.w.toFixed(0)} holds the pill ${pill.w.toFixed(0)}`);
      assert.equal(pill.h, 24 + (lines.length - 1) * 15);
    }
  }
  // The one-node "Kundschaft" frame: a single word is never cut.
  assert.deepEqual(legendLines('Browser', { label: 16, labelW: 600, detail: 12.5, edge: 12.5, group: 12, maxText: 124, line: 19, dline: 16, nodeNode: 12, layers: 20 }), ['BROWSER']);
  assert.ok(legendW(['BROWSER'], { group: 12 } as never) > measure('BROWSER', 12, 700));
});

test('the highlighted node keeps a readable detail (r8 d12x: red on orange)', async () => {
  const L = await bestLayout(d15Like, BIG);
  const scene = await renderGraph(d15Like, BIG, L);
  const hiDetail = texts(scene.prims).filter((t) => t.key.startsWith('n:hub:d'));
  if (L.nodes.find((n) => n.id === 'hub')!.detail.length) {
    assert.ok(hiDetail.length > 0);
    for (const t of hiDetail) assert.equal(t.fill, HI_DETAIL);
  }
  // In a layout with details (a 6-node flow at the big size), the highlighted node's detail is the light colour too.
  const small: CanvasSpec = { v: 2, id: 'small', kind: 'flow', title: 'Ablauf', highlight: 'b', sources: [{ label: 'x', ref: 'Gespräch' }],
    nodes: [{ id: 'a', label: 'Anfang', detail: 'erster Schritt' }, { id: 'b', label: 'Prüfung', detail: 'Pforte prüft den Ausweis' }, { id: 'c', label: 'Ende', detail: 'fertig' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] };
  const s2 = await renderGraph(small, BIG);
  const d = texts(s2.prims).filter((t) => t.key.startsWith('n:b:d'));
  assert.ok(d.length > 0);
  for (const t of d) assert.equal(t.fill, HI_DETAIL);
  // Contrast of the light detail on the papaya-tinted fill over the dark panel: ≥ 4.5.
  const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const bg = '#3a2a24'; // ≈ papaya at 13 % over the #15151c panel
  assert.ok((lum(HI_DETAIL) + 0.05) / (lum(bg) + 0.05) >= 4.5);
});

// ---------------------------------------------------------------- sankey
const sankeyLike: CanvasSpec = {
  v: 2, id: 'sk', kind: 'sankey', title: 'Wohin das Korn geht', unit: '€ (ca.)', sources: [{ label: 'x', ref: 'Gespräch' }],
  nodes: [{ id: 'all', label: 'Gesamt 1.234,56' }, { id: 'a', label: 'Mühle' }, { id: 'b', label: 'Bäckerei' }, { id: 'a1', label: 'Mühle Nord' }, { id: 'a2', label: 'Mühle Süd' }, { id: 'b1', label: 'Brotladen' }],
  links: [{ from: 'all', to: 'a', value: 800.5 }, { from: 'all', to: 'b', value: 434.06 }, { from: 'a', to: 'a1', value: 500 }, { from: 'a', to: 'a2', value: 300.5 }, { from: 'b', to: 'b1', value: 434.06 }],
};

test('a sankey node label that already carries its value loses the number (r8 d03: the total twice)', () => {
  assert.equal(stripValue('Gesamt 1.234,56', 1234.56), 'Gesamt');
  assert.equal(stripValue('Gesamt: 1.235 €', 1234.56), 'Gesamt');
  assert.equal(stripValue('Summe 1,234.56 EUR (ca.)', 1234.56), 'Summe');
  assert.equal(stripValue('Mühle 2026', 800.5), 'Mühle 2026', 'other numbers stay');
  assert.equal(stripValue('SN7-Auszahlungen', 7), 'SN7-Auszahlungen', 'digits inside a word stay');
  assert.equal(stripValue('1.234,56', 1234.56), '1.234,56', 'never an empty label');
  const scene = renderSankey(sankeyLike, NORMAL);
  const all = texts(scene.prims).filter((t) => t.key.startsWith('sn:all:'));
  assert.equal(all.filter((t) => /1[.,]?23[45]/.test(t.text)).length, 1, all.map((t) => t.text).join(' | '));
});

test('the source column of a sankey is labelled left of its node, never on the outgoing flows', () => {
  for (const size of [NORMAL, { width: 372, height: 407 }]) {
    const { nodes } = sankeyLayout(sankeyLike, size);
    const scene = renderSankey(sankeyLike, size);
    const root = nodes.find((n) => n.id === 'all')!;
    for (const t of texts(scene.prims).filter((x) => x.key.startsWith('sn:all:'))) {
      assert.equal(t.anchor, 'end');
      assert.ok(t.x <= root.x - 4, `label ends left of the node (${t.x} vs ${root.x})`);
      assert.ok(t.x - measure(t.text, t.size, 600) >= -1, 'and stays inside the scene');
    }
    assert.ok(!scene.prims.some((p) => p.key === 'sn:all:bg'), 'no backdrop box over the flows');
  }
});

// ---------------------------------------------------------------- phone tables, gate, sketch
test('wide content shows where it continues: both edges for xy, and a "mehr Spalten" hint for tables', () => {
  const m = { scrollLeft: 0, clientWidth: 372, scrollWidth: 640, scrollTop: 0, clientHeight: 400, scrollHeight: 400 };
  assert.deepEqual(scrollEdges(m, 'x'), { x: true, y: false });
  assert.deepEqual(scrollEdges({ ...m, scrollLeft: 268 }, 'x'), { x: false, y: false });
  assert.deepEqual(scrollEdges({ ...m, scrollHeight: 900 }, 'xy'), { x: true, y: true });
  assert.deepEqual(scrollEdges({ ...m, scrollHeight: 900 }, 'y'), { x: false, y: true });
  assert.deepEqual(scrollEdges(m, null), { x: false, y: false });
  const view = src('canvas/CanvasView.tsx');
  assert.match(view, /className=\{`cv-more-hint/);
  assert.match(view, /'Weitere Spalten anzeigen'/);
  assert.match(view, /scrollBy\(\{ left:/);
  assert.match(src('canvas/canvas.css'), /\.cv-more-hint \{/);
});

test('the gate code input has an aria-label', async () => {
  if (!('location' in globalThis)) Object.assign(globalThis, { location: new URL('http://localhost/'), history: { replaceState() {} } });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
  try {
    const { default: Gate } = await vite.ssrLoadModule('/src/components/Gate.tsx');
    const html = renderToStaticMarkup(createElement(Gate, { onUnlocked() {} }));
    assert.match(html, /<input[^>]*aria-label="Zugangscode"/);
  } finally { await vite.close(); }
});

test('sketch content keeps a margin to its own frame; full-bleed backgrounds do not count (r8 d01)', () => {
  const vb: [number, number, number, number] = [0, 0, 420, 280];
  const pad = sketchPad(vb);
  assert.equal(pad, 12.6);
  // Background, horizon line, and content well inside: unchanged.
  const inside = [{ x: 0, y: 0, w: 420, h: 280 }, { x: 0, y: 195, w: 420, h: 2 }, { x: 40, y: 40, w: 200, h: 120 }];
  assert.equal(sketchViewBox(vb, inside), vb);
  // A microphone base 8 units from the right edge and a label past the top: the box grows symmetrically.
  const out = sketchViewBox(vb, [...inside, { x: 360, y: 180, w: 52, h: 10 }, { x: 150, y: -4, w: 80, h: 14 }]);
  assert.ok(out[0] < 0 && out[1] < 0);
  assert.ok(Math.abs(out[0] + out[2] - 420 + out[0]) < 1e-9 && Math.abs(out[1] + out[3] - 280 + out[1]) < 1e-9, 'centred');
  assert.ok(412 + pad <= out[0] + out[2] + 1e-9 && -4 - pad >= out[1] - 1e-9);
  const stage = src('canvas/Stage.tsx');
  assert.match(stage, /padSketch\(el\)/);
});
