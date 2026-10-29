import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutSpec, fitCamera, fitScale, placeEdgeLabels, edgeGeometry, textWidth, ellipsize, edgeKey,
  LABEL_FONT, EDGE_FONT, NARROW, MIN_LABEL_EDGE_PX, READABLE_SCALE,
} from '../layout.ts';

// The spec from the critic's phone screenshot (m22): a fan-out that used to overflow both edges of a 390 px phone.
const JOBS = {
  v: 1, title: 'Job-Status: was läuft gerade?', focus: 'running',
  nodes: [
    { id: 'florian', label: 'Status?', kind: 'user' },
    { id: 'agent', label: 'Agent-Desk', kind: 'agent', value: 'fragt ab' },
    { id: 'running', label: 'Laufende Jobs', kind: 'job', tone: 'papaya', value: '7 aktiv' },
    { id: 'comms', label: 'comms-overview-video', kind: 'job', tone: 'red', value: 'cut-QA FAIL' },
    { id: 'reax', label: 'reax2-next-steps', kind: 'job', tone: 'amber', value: 'Render-Queue' },
    { id: 'jev', label: 'jevbench-add-requests', kind: 'job', tone: 'amber', value: 'wartet #18430' },
    { id: 'done', label: 'Fertig', kind: 'number', tone: 'moss', value: '0' },
  ],
  edges: [
    { from: 'florian', to: 'agent', label: 'Status?' }, { from: 'agent', to: 'running', label: 'job_status' },
    { from: 'running', to: 'comms', label: 're-rendert' }, { from: 'running', to: 'reax', label: 'hinter comms' },
    { from: 'running', to: 'jev', label: 'wartet #18430' }, { from: 'running', to: 'done', label: 'noch offen' },
  ],
};

function inside(layout, cam, area) {
  for (const b of layout.boxes.values()) {
    const l = cam.tx + cam.s * (b.x - b.w / 2), r = cam.tx + cam.s * (b.x + b.w / 2);
    const t = cam.ty + cam.s * (b.y - b.h / 2), btm = cam.ty + cam.s * (b.y + b.h / 2);
    if (l < area.x - 0.5 || r > area.x + area.width + 0.5 || t < area.y - 0.5 || btm > area.y + area.height + 0.5) return `${b.id} at ${[l, t, r, btm].map(Math.round)}`;
  }
  return null;
}

// The drawing area LiveCanvas hands to fitCamera: the box, or the full readable height when the layout scrolls.
const drawArea = (l, area) => (l.scroll ? { ...area, height: l.height * l.scale } : area);

test('phone canvas: vertical layout that fits without clipping (critic D6, m22)', () => {
  for (const height of [420, 300]) {
    const area = { x: 16, y: 76, width: 358, height };
    const l = layoutSpec(JOBS, area);
    assert.equal(l.horizontal, false);
    const cam = fitCamera(l, drawArea(l, area), l.boxes.get(JOBS.focus));
    assert.equal(inside(l, cam, drawArea(l, area)), null);
    assert.ok(l.scale * l.width <= area.width + 0.5, 'never wider than the phone');
    assert.ok(cam.s >= READABLE_SCALE - 1e-9, `labels stay readable: scale ${cam.s.toFixed(2)}`);
  }
});

test('every spec fits every canvas size, focus lean included (fuzz)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const kinds = ['agent', 'job', 'file', 'number', 'idea', 'risk'];
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(rnd() * 12);
    const nodes = Array.from({ length: n }, (_, k) => ({
      id: `n${k}`, label: 'Wort '.repeat(1 + Math.floor(rnd() * 5)).trim(), kind: kinds[Math.floor(rnd() * kinds.length)],
      value: rnd() < 0.6 ? String(Math.floor(rnd() * 999)) : undefined,
    }));
    const edges = [];
    for (let k = 1; k < n; k++) if (rnd() < 0.85) edges.push({ from: `n${Math.floor(rnd() * k)}`, to: `n${k}`, label: rnd() < 0.5 ? 'liest' : undefined });
    const spec = { v: 1, title: 't', nodes, edges, focus: `n${Math.floor(rnd() * n)}` };
    const area = { x: 16, y: 80, width: 200 + Math.floor(rnd() * 1200), height: 120 + Math.floor(rnd() * 700) };
    const l = layoutSpec(spec, area);
    const cam = fitCamera(l, drawArea(l, area), l.boxes.get(spec.focus));
    const bad = inside(l, cam, drawArea(l, area));
    assert.equal(bad, null, `spec ${i} (${n} nodes) in ${area.width}×${area.height}: ${bad}`);
    if (area.width < NARROW) assert.equal(l.horizontal, false);
    // Either it fits the box, or it scrolls vertically at a readable size; it never needs sideways scrolling.
    if (l.scroll) assert.ok(cam.s >= READABLE_SCALE - 1e-9 && l.width * cam.s <= area.width + 0.5, `spec ${i}: scroll at ${cam.s}`);
  }
});

test('labels are ellipsised to the card, never wider than it', () => {
  const spec = { v: 1, title: 't', nodes: [{ id: 'a', label: 'Ein sehr langer Knotenname!!', kind: 'file', value: 'sehr langer Wert' }, { id: 'b', label: 'B', kind: 'idea' }], edges: [{ from: 'a', to: 'b' }] };
  for (const width of [320, 900]) {
    const l = layoutSpec(spec, { width, height: 400 });
    const a = l.boxes.get('a');
    assert.ok(textWidth(a.text, LABEL_FONT) <= a.w - 50, `${a.text} in ${a.w}`);
    assert.ok(a.text.endsWith('…') || a.text === spec.nodes[0].label);
  }
  assert.equal(ellipsize('kurz', LABEL_FONT, 500), 'kurz');
  assert.ok(ellipsize('abcdefghijklmnop', LABEL_FONT, 60).endsWith('…'));
});

test('a typical 6-node story fits desktop panels at readable size without scrolling', () => {
  const spec = { ...JOBS, nodes: JOBS.nodes.slice(0, 6), edges: JOBS.edges.slice(0, 5) };
  for (const area of [{ width: 340, height: 500 }, { width: 640, height: 420 }, { width: 900, height: 330 }, { width: 1000, height: 520 }]) {
    const l = layoutSpec(spec, area);
    assert.ok(!l.scroll && l.scale >= READABLE_SCALE, `${area.width}×${area.height}: scale ${l.scale.toFixed(2)} scroll ${l.scroll}`);
  }
});

test('edges that would cross another card enter their target from the side', () => {
  // a fans out to b and c stacked in one column of the next band: a→c would run through b.
  const area = { width: 900, height: 330 };
  const l = layoutSpec(JOBS, area);
  for (const e of JOBS.edges) {
    const a = l.boxes.get(e.from), b = l.boxes.get(e.to);
    const g = edgeGeometry(a, b, l.horizontal, l.side.has(edgeKey(e)));
    const others = [...l.boxes.values()].filter((x) => x !== a && x !== b);
    for (let i = 1; i < 16; i++) {
      const t = i / 16, u = 1 - t, c = g.c;
      const x = u ** 3 * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t ** 3 * c[3].x;
      const y = u ** 3 * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t ** 3 * c[3].y;
      const hit = others.find((o) => Math.abs(x - o.x) < o.w / 2 && Math.abs(y - o.y) < o.h / 2);
      if (hit && !l.side.has(edgeKey(e))) assert.fail(`${edgeKey(e)} crosses ${hit.id} without being re-routed`);
    }
  }
});

test('edge labels: dropped on short edges and on collisions, never on a card, shortened to the edge', () => {
  const area = { width: 900, height: 420 };
  const l = layoutSpec(JOBS, area);
  const s = l.scale;
  const labels = placeEdgeLabels(JOBS.edges, l, s);
  assert.ok(labels.size >= 2);
  const rects = [];
  for (const e of JOBS.edges) {
    const text = labels.get(edgeKey(e));
    if (!text) continue;
    const g = edgeGeometry(l.boxes.get(e.from), l.boxes.get(e.to), l.horizontal, l.side.has(edgeKey(e)));
    assert.ok(Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) * s >= MIN_LABEL_EDGE_PX);
    const r = { x: g.mid.x, y: g.mid.y, w: textWidth(text, EDGE_FONT) + 16, h: 22 };
    for (const b of l.boxes.values()) assert.ok(!(Math.abs(r.x - b.x) * 2 < r.w + b.w && Math.abs(r.y - b.y) * 2 < r.h + b.h), `${text} on ${b.id}`);
    for (const o of rects) assert.ok(!(Math.abs(r.x - o.x) * 2 < r.w + o.w && Math.abs(r.y - o.y) * 2 < r.h + o.h), `${text} on another label`);
    rects.push(r);
  }
  // Zoomed far out every edge is shorter than 40 px on screen: no labels at all.
  assert.equal(placeEdgeLabels(JOBS.edges, l, 0.05).size, 0);
});

test('fitCamera leans towards the focus only within the free space', () => {
  const spec = { v: 1, title: 't', nodes: [{ id: 'a', label: 'A', kind: 'idea' }, { id: 'b', label: 'B', kind: 'idea' }], edges: [{ from: 'a', to: 'b' }] };
  const area = { x: 0, y: 0, width: 1200, height: 600 };
  const l = layoutSpec(spec, area);
  const centred = fitCamera(l, area);
  const leaning = fitCamera(l, area, l.boxes.get('b'));
  assert.ok(leaning.tx < centred.tx, 'moves the right-hand focus towards the centre');
  const tight = { x: 0, y: 0, width: l.width, height: l.height };
  assert.equal(inside(l, fitCamera(l, tight, l.boxes.get('b')), tight), null);
});
