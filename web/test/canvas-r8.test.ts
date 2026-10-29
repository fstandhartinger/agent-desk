// Round 8 (critic r7 "What still fails" 1, §7 items 2, 8, 9, 11): big diagrams viewable as a whole on desktop, a
// requested LR kept, "Groß" laid out for its own stage, "Alles zeigen" never below 6 px, the phone controls strip,
// dangling/looping edges, monospace prose, sketch text under badges. Synthetic fixtures only (invented names).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { controlsAutoHide, pickScale, wholeView, CONTROLS_IDLE_MS, FIT_MIN_PX, OVERVIEW_PX } from '../src/canvas/view.ts';
import { attachEnds, backEdges, bestLayout, isChain, layoutGraph, renderGraph, wrapEdges, type GraphLayout } from '../src/canvas/render/graph.ts';
import { codeLabel, renderPie } from '../src/canvas/render/charts.ts';
import { exportScene } from '../src/canvas/export.ts';
import { sketchTextLimits } from '../src/canvas/render/sketchFit.ts';
import { measure, type Prim, type Scene } from '../src/canvas/render/scene.ts';
import type { CanvasSpec } from '../src/canvas/types.ts';

const src = (f: string) => readFileSync(new URL(`../src/canvas/${f}`, import.meta.url), 'utf8');
const view = (L: GraphLayout, s: { width: number; height: number }) => pickScale({ w: L.w, h: L.h, minText: L.dims.label }, { w: s.width, h: s.height }, true);
const px = (L: GraphLayout, s: { width: number; height: number }) => view(L, s).scale * L.dims.label;
const touches = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }) => p.x >= b.x - 3 && p.x <= b.x + b.w + 3 && p.y >= b.y - 3 && p.y <= b.y + b.h + 3;

// Stage sizes measured in the browser on the desk (r8, mock mode): side column at 1440×900, the "Groß" overlay at
// 1440×900, the phone Live tab at 390×844 (controls strip folded away).
const NORMAL = { width: 829, height: 492 }, BIG = { width: 1390, height: 626 }, PHONE = { width: 372, height: 407 };

// Shaped like the critic's q2 architecture (17 nodes, 6 groups, a hub that fans out to 7 slices, a dashed back edge
// from the drawing group to the client): r7 showed it as a narrow scrolling column (¼ visible) and 3 px at "Alles zeigen".
const bigArch: CanvasSpec = {
  v: 2, id: 'big-arch', kind: 'architecture', title: 'Werkstatt: Aufbau der Stuben', direction: 'TB', sources: [{ label: 'x', ref: 'Gespräch' }],
  groups: [
    { id: 'client', label: 'Kundschaft (Laden am Markt)', tone: 'neutral' }, { id: 'door', label: 'Eingangstür', tone: 'moss' },
    { id: 'core', label: 'Werkbänke', tone: 'violet' }, { id: 'draw', label: 'Zeichnen', tone: 'papaya' },
    { id: 'voice', label: 'Sprechzimmer (Funk-Relais)', tone: 'amber' }, { id: 'out', label: 'Zulieferer + Lager', tone: 'red' },
  ],
  nodes: [
    { id: 'web', label: 'Brief / Diktat / Anruf', detail: 'Schalter + Tafel', group: 'client', shape: 'person' },
    { id: 'shelf', label: 'regal.js', detail: 'Auslage der Waren', group: 'door' },
    { id: 'pass', label: 'ausweis.js (210 Z.)', detail: 'Karte, Code, Protokoll', group: 'door' },
    { id: 'meter', label: 'zaehler.js (120 Z.)', detail: 'Mengen- und Kostenbremse', group: 'door' },
    { id: 'hub', label: 'pforte.js (180 Z.)', detail: 'verteilt an die Stuben', group: 'door' },
    { id: 'desk', label: 'schreibstube.js (170 Z.)', detail: 'Antworten mit Werkzeug', group: 'core' },
    { id: 'artist', label: 'zeichner.js (690 Z.)', detail: 'Skizzen, schneller Weg', group: 'core' },
    { id: 'model', label: 'feder.js + tinte.js', detail: 'Federwahl, Zustand', group: 'core' },
    { id: 'notes', label: 'merkzettel.js + wissen.js', detail: 'Rolle + Nachschlagewerk', group: 'core' },
    { id: 'tools', label: 'werkzeug.js (380 Z.)', detail: 'Werkzeugkiste', group: 'core' },
    { id: 'helper', label: 'gehilfe/gehilfenstube.js', detail: 'Lehrlinge starten', group: 'core' },
    { id: 'board', label: 'tafel.js + tafelbus.js', detail: 'Tafelprüfung, Bus', group: 'draw' },
    { id: 'books', label: 'kassenbuch.js + bild.js', detail: 'feste Zahlenbilder', group: 'draw' },
    { id: 'radio', label: 'funk/index.js + sitzung.js', detail: 'Relais zum Kunden', group: 'voice' },
    { id: 'lines', label: 'nord / süd / west', detail: 'Leitungen + Tarife', group: 'voice' },
    { id: 'store', label: 'Lager (Haus B)', detail: 'nur lesen, Lehrlinge', group: 'out' },
    { id: 'mill', label: 'Papiermühle Fein', detail: 'liefert Papier', group: 'out' },
  ],
  edges: [
    { from: 'web', to: 'hub', label: 'Post / Funk' }, { from: 'hub', to: 'pass' }, { from: 'hub', to: 'meter' }, { from: 'hub', to: 'shelf' },
    { from: 'hub', to: 'desk' }, { from: 'hub', to: 'artist' }, { from: 'hub', to: 'radio' }, { from: 'hub', to: 'helper' },
    { from: 'desk', to: 'notes' }, { from: 'desk', to: 'model' }, { from: 'desk', to: 'tools' }, { from: 'desk', to: 'board' },
    { from: 'artist', to: 'board' }, { from: 'artist', to: 'books' }, { from: 'tools', to: 'store', label: 'Werkzeug-Aufträge' },
    { from: 'helper', to: 'store', label: 'Lehrling -p' }, { from: 'model', to: 'mill', label: 'Papier' }, { from: 'radio', to: 'lines' },
    { from: 'board', to: 'web', label: 'Bus → Tafel', style: 'dashed' },
  ],
};

// Shaped like the critic's 9-node tax flow (d14): requested LR, one split into two branches, a dashed receipt edge.
const taxLike: CanvasSpec = {
  v: 2, id: 'tax-like', kind: 'flow', title: 'Ernte bis Abgabe', direction: 'LR', sources: [{ label: 'x', ref: 'Gespräch' }],
  nodes: [
    { id: 'field', label: 'Feld Nord', detail: 'Besitz: Hof Linde, Pacht 3.1', shape: 'cylinder' },
    { id: 'barn', label: 'Scheune "Ost" 7QxW…', detail: 'Sammelstelle, wöchentlich' },
    { id: 'split', label: 'Aufteilung', detail: '~Hälfte eingelagert, ~Hälfte verkauft', shape: 'diamond' },
    { id: 'keep', label: 'Eingelagert', detail: 'bleibt im Silo (≈ 50 %)' },
    { id: 'batch', label: '300 kg Charge', detail: 'Mo + Do, 08:00, max 2 je Tag' },
    { id: 'cart', label: 'Karren 4AB…', detail: 'eigener Wagen → Markt' },
    { id: 'market', label: 'Markt', detail: 'Verkauf, Auszahlung' },
    { id: 'tax', label: 'Abgabe ~40 %', detail: 'Rücklage nötig; Rest für Saatgut' },
    { id: 'ledger', label: 'Kassenbuch + Belege', detail: 'jede Bewegung als Zeile' },
  ],
  edges: [
    { from: 'field', to: 'barn', label: 'Wochenernte' }, { from: 'barn', to: 'split' }, { from: 'split', to: 'keep', label: '~50 %' },
    { from: 'split', to: 'batch', label: '~50 %' }, { from: 'batch', to: 'cart', label: 'aufladen + fahren' }, { from: 'cart', to: 'market', label: 'Ware' },
    { from: 'market', to: 'tax', label: 'Geld' }, { from: 'market', to: 'ledger', label: 'Beleg', style: 'dashed' },
  ],
};

const lrChain = (n: number): CanvasSpec => ({
  v: 2, id: 'lr-chain', kind: 'flow', title: 'Kette', direction: 'LR', sources: [{ label: 'x', ref: 'Gespräch' }],
  nodes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: `Schritt ${i + 1} mit Namen`, detail: 'eine kurze Erklärung dazu' })),
  edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}`, label: 'weiter' })),
});

// Shaped like the critic's d19: a decision with a dashed shortcut into the last node across a row break.
const gateFlow: CanvasSpec = {
  v: 2, id: 'gate-flow', kind: 'flow', title: 'Paketschranke', direction: 'TB', sources: [{ label: 'x', ref: 'Gespräch' }],
  nodes: [
    { id: 'agent', label: 'Bote fertig mit Paket', detail: 'Etikett + Inhalt verpackt' }, { id: 'build', label: 'packen.sh', detail: 'Direktversand an den Laden entfernt' },
    { id: 'notify', label: 'melden --paket', detail: 'prüft das Etikett' }, { id: 'gate', label: 'Etikett trägt /p/-Nummer?', shape: 'diamond' },
    { id: 'yes', label: 'Laden-Versand', detail: 'Etikett mit Nummer' }, { id: 'no', label: 'Code 75 · NICHT GESENDET', detail: 'Paket ohne Nummer' },
    { id: 'flag', label: '--ohne-nummer "<Grund>"?', shape: 'diamond' }, { id: 'reason', label: 'Versand + Grund im Buch', detail: 'nur für Sonderpakete' },
  ],
  edges: [
    { from: 'agent', to: 'build' }, { from: 'build', to: 'notify', label: 'Pflichtweg' }, { from: 'notify', to: 'gate' }, { from: 'gate', to: 'yes', label: 'ja' },
    { from: 'gate', to: 'no', label: 'nein' }, { from: 'no', to: 'flag' }, { from: 'flag', to: 'reason', label: 'ja' },
    { from: 'gate', to: 'reason', label: 'ja (mit Flag)', style: 'dashed' },
  ],
};

// ---------------------------------------------------------------- item 1: whole on desktop
test('q2-shaped architecture: whole on the 1440×900 side column with labels ≥ 8 px (r7: narrow scrolling column)', async () => {
  const L = await bestLayout(bigArch, NORMAL);
  assert.equal(view(L, NORMAL).pan, 'none', 'the whole diagram is on screen');
  assert.ok(px(L, NORMAL) >= OVERVIEW_PX, `${px(L, NORMAL).toFixed(1)} px`);
  assert.deepEqual(wrapEdges(L), [], 'no edge around the diagram');
  assert.equal(L.nodes.length, 17);
});

test('"Groß" lays the q2-shaped architecture out again for its stage: whole, labels ≥ 11 px, with details', async () => {
  const L = await bestLayout(bigArch, BIG);
  assert.equal(view(L, BIG).pan, 'none');
  assert.ok(px(L, BIG) >= 11, `${px(L, BIG).toFixed(1)} px`);
  assert.ok(L.nodes.some((n) => n.detail.length), 'the big view keeps the node details (no overview cut)');
  // The view re-renders the scene for its own stage size (the big overlay is its own CanvasView with its own size).
  assert.match(src('CanvasView.tsx'), /useScene\(spec, Math\.floor\(width\), Math\.floor\(height\)\)/);
});

test('phone: the q2-shaped architecture is readable (≥ 10 px) and scrolls vertically only', async () => {
  const L = await bestLayout(bigArch, PHONE);
  const v = view(L, PHONE);
  assert.equal(v.pan, 'y');
  assert.ok(px(L, PHONE) >= 10, `${px(L, PHONE).toFixed(1)} px`);
});

test('tax-shaped LR flow: stays LR on the side column, whole, labels ≥ 8 px (r7: vertical chain, 2 nodes visible)', async () => {
  const L = await bestLayout(taxLike, NORMAL);
  assert.equal(L.dir, 'LR');
  assert.equal(view(L, NORMAL).pan, 'none');
  assert.ok(px(L, NORMAL) >= OVERVIEW_PX, `${px(L, NORMAL).toFixed(1)} px`);
  const B = await bestLayout(taxLike, BIG);
  assert.equal(B.dir, 'LR');
  assert.ok(px(B, BIG) >= 11, `big ${px(B, BIG).toFixed(1)} px`);
  const P = await bestLayout(taxLike, PHONE);
  assert.ok(px(P, PHONE) >= 10 && view(P, PHONE).pan !== 'x' && view(P, PHONE).pan !== 'xy', 'phone: readable, vertical scroll only');
});

test('a plain LR chain is never turned vertical on a wide stage; isChain recognises chains only', async () => {
  assert.equal(isChain(lrChain(9)), true);
  assert.equal(isChain(taxLike), false);
  assert.equal(isChain(bigArch), false);
  for (const size of [NORMAL, { width: 700, height: 700 }, { width: 620, height: 900 }]) {
    const L = await bestLayout(lrChain(9), size);
    assert.equal(L.dir, 'LR', `${size.width}×${size.height}`);
  }
});

test('desktop: a diagram whole at ≥ 8 px stays whole (overview) instead of fitting the width and scrolling', () => {
  // 8.2 px as a whole on the side column, height-bound (fitting the width would be larger): r7 switched to the
  // scrolling column below 9 px.
  const v = pickScale({ w: 1000, h: 900, minText: 16 }, { w: 829, h: 492 }, true);
  assert.equal(v.pan, 'none');
  assert.ok(v.scale * 16 >= OVERVIEW_PX);
  // Phones keep their 10 px rule.
  assert.equal(pickScale({ w: 500, h: 900, minText: 15 }, { w: 372, h: 407 }, true).pan, 'y');
});

test('the dense overview keeps what it drops in tooltips (details on the node, the full edge label)', async () => {
  const L = await layoutGraph(bigArch, 'LR', 'dense');
  assert.ok(L.nodes.every((n) => n.detail.length === 0), 'labels only');
  const scene = await renderGraph(bigArch, NORMAL, L);
  const rect = scene.prims.find((p) => p.key === 'n:tools') as Extract<Prim, { t: 'rect' }>;
  assert.equal(rect.title, 'werkzeug.js (380 Z.) — Werkzeugkiste');
  const lt = scene.prims.find((p) => p.key === 'e:tools>store:lt') as Extract<Prim, { t: 'text' }>;
  assert.equal(lt.title, 'Werkzeug-Aufträge');
});

// ---------------------------------------------------------------- back edges, wrapping, dangling ends
test('back edges are reversed for ELK and drawn in their own direction: no loop around, arrowhead at the target', async () => {
  const nodes = bigArch.nodes!;
  const back = backEdges(nodes, bigArch.edges!);
  assert.deepEqual([...back].map((i) => `${bigArch.edges![i].from}>${bigArch.edges![i].to}`), ['board>web']);
  for (const dir of ['LR', 'TB'] as const) {
    const L = await layoutGraph(bigArch, dir, false);
    assert.deepEqual(wrapEdges(L), [], dir);
    const e = L.edges.find((x) => x.from === 'board' && x.to === 'web')!;
    assert.ok(touches(e.pts[e.pts.length - 1], L.nodes.find((n) => n.id === 'web')!.box), `${dir}: ends at web`);
    assert.ok(touches(e.pts[0], L.nodes.find((n) => n.id === 'board')!.box), `${dir}: starts at board`);
  }
});

test('d19-shaped flow: every edge of every folded layout ends at its target (r7: "ja (mit Flag)" pointed at nothing)', async () => {
  for (const asp of ['1.30', '1.50', '1.71', '2.00']) for (const dir of ['LR', 'TB'] as const) {
    const L = await layoutGraph(gateFlow, dir, false, { 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': asp });
    for (const e of L.edges) {
      const t = L.nodes.find((n) => n.id === e.to)!.box, s = L.nodes.find((n) => n.id === e.from)!.box;
      assert.ok(touches(e.pts[e.pts.length - 1], t), `${dir} ${asp} ${e.key} ends at ${e.to}`);
      assert.ok(touches(e.pts[0], s), `${dir} ${asp} ${e.key} starts at ${e.from}`);
    }
  }
});

test('attachEnds completes a route that stops in the gap between rows: along the gap, then into the target', () => {
  const L = {
    dims: {} as GraphLayout['dims'], w: 1200, h: 640, dir: 'LR' as const, groups: [],
    nodes: [
      { id: 'a', box: { x: 100, y: 300, w: 200, h: 100 }, lines: [], detail: [], shape: 'box' as const },
      { id: 'b', box: { x: 360, y: 520, w: 180, h: 100 }, lines: [], detail: [], shape: 'box' as const },
    ],
    edges: [{ key: 'a>b', from: 'a', to: 'b', style: 'dashed', label: { text: 'ja (mit Flag)', box: { x: 850, y: 438, w: 100, h: 24 } }, pts: [{ x: 300, y: 350 }, { x: 320, y: 350 }, { x: 320, y: 450 }, { x: 1150, y: 450 }] }],
  };
  const e = attachEnds(L).edges[0];
  const out = e.pts;
  assert.deepEqual(out.slice(-2), [{ x: 450, y: 450 }, { x: 450, y: 520 }]);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].x === out[i - 1].x || out[i].y === out[i - 1].y, 'orthogonal');
  // The label sat on the cut-off stretch (x 850–950); it moves onto the completed route.
  const c = { x: e.label!.box.x + e.label!.box.w / 2, y: e.label!.box.y + e.label!.box.h / 2 };
  assert.ok(out.slice(1).some((q, i) => (q.y === out[i].y && Math.abs(c.y - q.y) < 1 && c.x >= Math.min(q.x, out[i].x) && c.x <= Math.max(q.x, out[i].x)) || (q.x === out[i].x && Math.abs(c.x - q.x) < 1 && c.y >= Math.min(q.y, out[i].y) && c.y <= Math.max(q.y, out[i].y))), `label centre ${c.x},${c.y} on the route`);
});

// ---------------------------------------------------------------- item 3: "Alles zeigen"
test('"Alles zeigen" never goes below 6 px: a huge scene shows the best overview at 6 px for its smallest text', () => {
  const scene: Pick<Scene, 'w' | 'h' | 'minText' | 'prims'> = { w: 1100, h: 2200, minText: 16, prims: [
    { t: 'text', key: 'a', x: 0, y: 0, text: 'Label', size: 16 }, { t: 'text', key: 'b', x: 0, y: 0, text: 'Detail', size: 12 },
  ] };
  const box = { w: 829, h: 492 };
  const vb = wholeView(scene, box, true);
  const s = box.w / vb[2];
  assert.equal(vb.clamped, true);
  assert.ok(s * 12 >= FIT_MIN_PX - 1e-9, `smallest text ${(s * 12).toFixed(2)} px (r7: 3 px)`);
  assert.ok(vb[1] < 0 && vb[1] > -40, 'starts at the top');
  // A scene that fits legibly: unchanged, centred, not clamped.
  const small = wholeView({ w: 700, h: 300, minText: 16, prims: [] }, box, true);
  assert.equal(small.clamped, undefined);
  assert.ok(Math.abs(small[0] + small[2] / 2 - 350) < 1e-6 && Math.abs(small[1] + small[3] / 2 - 150) < 1e-6);
  // The view says so (and a second press returns to the auto view).
  const cv = src('CanvasView.tsx');
  assert.match(cv, /view\.clamped && \(\s*<span className="cv-fit-note"/);
  assert.match(cv, /!clamped && canPan\(v, sc\)/);
});

// ---------------------------------------------------------------- item 4: phone controls strip
test('phone: the controls strip folds away after 2 s idle (never while zoomed); a tap brings it back', () => {
  assert.equal(CONTROLS_IDLE_MS, 2000);
  assert.equal(controlsAutoHide(372, false), true);
  assert.equal(controlsAutoHide(372, true), false, 'a zoomed view would be reset by the stage resize');
  assert.equal(controlsAutoHide(829, false), false, 'desktop keeps the strip');
  const cv = src('CanvasView.tsx');
  assert.match(cv, /controlsAutoHide\(Math\.floor\(width\), view\.custom\)/);
  assert.match(cv, /onPointerDownCapture=\{poke\}/);
  assert.match(cv, /controlsHidden && <div className="cv-controls cv-controls-hidden"/);
  assert.match(src('canvas.css'), /\.cv-controls-hidden \{ height: 0;/);
});

test('phone pie (legend mode): donut + legend fit the stage; the total keeps ≥ 11 px (r7 m17: legend row cut)', () => {
  const spec: CanvasSpec = {
    v: 2, id: 'pie-phone', kind: 'pie', title: 'Ausgaben', unit: '€ (ca.)', sources: [{ label: 'x', ref: 'Gespräch' }],
    items: [
      { label: 'Werkzeug', value: 6100.5, detail: 'u. a. Schmiede Nord / Hammerwerk' }, { label: 'Löhne', value: 4200, detail: 'u. a. drei Gesellen' },
      { label: 'Papier', value: 310.2, detail: 'Mühle Fein, Mühle Grob' }, { label: 'Porto', value: 15.4, detail: 'Botendienst' },
    ],
  };
  for (const h of [407, 451]) {
    const sc = renderPie(spec, { width: 372, height: h });
    assert.ok(sc.h <= h, `scene ${sc.h} ≤ stage ${h}`);
    const total = sc.prims.find((p) => p.key === 'total') as Extract<Prim, { t: 'text' }>;
    assert.ok(total.size >= 11, `total ${total.size.toFixed(1)} px`);
    const sub = sc.prims.find((p) => p.key === 'total:l') as Extract<Prim, { t: 'text' }>;
    // The hole's width at the label's baseline (the label sits below the centre).
    const arc = sc.prims.find((p) => p.t === 'arc') as Extract<Prim, { t: 'arc' }>;
    const chord = 2 * Math.sqrt(arc.r0 ** 2 - (sub.y - arc.cy) ** 2);
    assert.ok(measure(sub.text, sub.size, 500) <= chord - 6 || sub.size === 11, `"${sub.text}" ${measure(sub.text, sub.size, 500).toFixed(0)} fits the hole ${chord.toFixed(0)} at its baseline`);
  }
});

// ---------------------------------------------------------------- item 5: style
test('sequence labels: monospace only for a single code token, never for German prose with hyphens (r7 d01x)', () => {
  for (const s of ['Telegram-Nachricht mit Link', 'weitere Requests / WebSocket', 'Pflicht-Weg', 'Zugang erlaubt']) assert.equal(codeLabel(s), false, s);
  for (const s of ['notify.loginLink', '/api/canvas', 'canvas_draw', 'readSession()']) assert.equal(codeLabel(s), true, s);
});

test('sketch text that runs under a badge drawn after it is fitted before the badge (r7 d03)', () => {
  // Row background (painted first, wide), reason text, badge rect painted after the text.
  const texts = [{ i: 0, order: 2, x: 545, y0: 152, y1: 165, right: 715 }, { i: 1, order: 6, x: 545, y0: 196, y1: 209, right: 660 }];
  const rects = [{ order: 1, x: 40, y0: 140, y1: 174, w: 720 }, { order: 3, x: 676, y0: 146, y1: 168, w: 68 }, { order: 7, x: 676, y0: 190, y1: 212, w: 68 }];
  const lim = sketchTextLimits(texts, rects);
  assert.equal(lim.get(0), 676 - 6 - 545, 'the long reason ends before its badge');
  assert.equal(lim.has(1), false, 'a short reason is left alone');
  // A rect painted before the text (a background) never limits it.
  assert.equal(sketchTextLimits([{ i: 0, order: 5, x: 545, y0: 152, y1: 165, right: 715 }], [{ order: 3, x: 676, y0: 146, y1: 168, w: 68 }]).size, 0);
  assert.match(src('Stage.tsx'), /fitSketchText\(el\)/);
});

test('PNG export of a diagram uses the big layout with details, not the side column\'s dense overview', async () => {
  const dense = await renderGraph(bigArch, NORMAL, await layoutGraph(bigArch, 'LR', 'dense'));
  assert.ok(!dense.prims.some((p) => p.key === 'n:tools:d0'), 'the overview has no details');
  const { scene } = await exportScene(bigArch, dense);
  assert.ok(scene.prims.some((p) => p.key === 'n:tools:d0'), 'the export shows the node details again');
});
