// Canvas forms 14 Nov: points (numbered / bullets list of core points), stat (headline numbers), the stacked bar, the
// one-colour bar and the categorical pie palette. Layout rules are checked, not taste: phone-first type sizes, nothing
// outside the stage, row keys, reserved layout for unrevealed rows. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPoints, renderStackedBar, renderStat, stackedParts } from '../src/canvas/render/forms.ts';
import { renderBar, renderPie, DONUT } from '../src/canvas/render/charts.ts';
import { renderScene } from '../src/canvas/render/index.ts';
import { CATEGORICAL_DARK, CATEGORICAL_LIGHT, REST_COLOR, PALETTE as P, contrast, measure, type Prim, type RectP, type Scene, type TextP, type CircleP, type PathP } from '../src/canvas/render/scene.ts';
import { pickScale } from '../src/canvas/view.ts';
import type { CanvasPoint, CanvasSpec } from '../src/canvas/types.ts';
import pointsFx from '../src/canvas/fixtures/points-three-reasons.json' with { type: 'json' };
import statFx from '../src/canvas/fixtures/stat-1000-alpha.json' with { type: 'json' };
import stackedFx from '../src/canvas/fixtures/bar-stacked-podium.json' with { type: 'json' };

const SIZES = [{ width: 360, height: 480 }, { width: 390, height: 640 }, { width: 1280, height: 720 }];
const src = [{ label: 'x', ref: 'Gespräch' }];
const base = { v: 2 as const, sources: src };
const sp = (s: string) => s.replace(/\s/g, ' '); // the German formats use no-break / narrow no-break spaces
const texts = (s: Scene) => s.prims.filter((p): p is TextP => p.t === 'text');
const rects = (s: Scene) => s.prims.filter((p): p is RectP => p.t === 'rect');
const circles = (s: Scene) => s.prims.filter((p): p is CircleP => p.t === 'circle');
const paths = (s: Scene) => s.prims.filter((p): p is PathP => p.t === 'path');

/** Bounding box of a primitive (text: measured width, em box around the baseline). */
function box(p: Prim): { x0: number; y0: number; x1: number; y1: number } {
  switch (p.t) {
    case 'text': {
      const w = measure(p.text, p.size, p.weight ?? 500);
      const x0 = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
      return { x0, x1: x0 + w, y0: p.y - p.size * 0.78, y1: p.y + p.size * 0.22 };
    }
    case 'rect': return { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
    case 'circle': return { x0: p.cx - p.r, y0: p.cy - p.r, x1: p.cx + p.r, y1: p.cy + p.r };
    case 'path': {
      const pts = [...p.d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      return { x0: Math.min(...pts.map((q) => q[0])), x1: Math.max(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])), y1: Math.max(...pts.map((q) => q[1])) };
    }
    default: return { x0: 0, y0: 0, x1: 0, y1: 0 };
  }
}
/** Every primitive lies inside the stage (what the viewer sees at scale 1). */
function assertInside(scene: Scene, size: { width: number; height: number }, label: string) {
  assert.ok(!scene.scroll, `${label}: scrolls (scene ${scene.h} > stage ${size.height})`);
  assert.equal(scene.w, size.width, `${label}: scene width`);
  assert.equal(scene.h, size.height, `${label}: scene height`);
  for (const p of scene.prims) {
    const b = box(p);
    assert.ok(b.x0 >= -0.5 && b.x1 <= size.width + 0.5, `${label}: ${p.key} x ${b.x0.toFixed(1)}…${b.x1.toFixed(1)} outside 0…${size.width}`);
    assert.ok(b.y0 >= -0.5 && b.y1 <= size.height + 0.5, `${label}: ${p.key} y ${b.y0.toFixed(1)}…${b.y1.toFixed(1)} outside 0…${size.height}`);
  }
}

const pts = (n: number, extra: Partial<CanvasPoint> = {}): CanvasPoint[] =>
  ['Prüfbarkeit', 'Feste Belohnung', 'Vorfahren nicht bezahlt', 'Gleiche Regeln für alle', 'Ein Konto je Bucket'].slice(0, n)
    .map((label, i) => ({ label, note: ['ein Eintrag, ein Start', 'kein Nachrechnen', 'nur wer mitarbeitet', 'jede Zahl prüfbar', 'klar getrennt'][i], ...extra }));
const points = (n: number, over: Partial<CanvasSpec> = {}): CanvasSpec => ({ ...base, id: `pts-${n}`, kind: 'points', title: 'Kernpunkte', points: pts(n), ...over });

// ---------------------------------------------------------------- palette
test('categorical palette: six fixed slots, dark and light (validator output is in RESULT.md)', () => {
  assert.deepEqual([...CATEGORICAL_DARK], ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9']);
  assert.deepEqual([...CATEGORICAL_LIGHT], ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6']);
  assert.equal(REST_COLOR, '#8d8ca3');
  for (const c of CATEGORICAL_DARK) assert.ok(contrast(c, '#15151c') >= 3, `${c} vs the canvas surface`);
  assert.deepEqual(DONUT.slice(0, 6), [...CATEGORICAL_DARK], 'pie slices start with the categorical slots');
});

// ---------------------------------------------------------------- points
test('points: phone-first type — labels ≥ 22 px (phone) / ≥ 28 px (desktop), every text ≥ 15 px, nothing outside the stage', () => {
  for (const n of [2, 3, 4, 5]) {
    for (const size of SIZES) {
      for (const style of ['numbered', 'bullets'] as const) {
        const scene = renderPoints(points(n, { style }), size);
        const label = `${n} points ${style} ${size.width}x${size.height}`;
        assertInside(scene, size, label);
        assert.ok((scene.minText ?? 0) >= 15, `${label}: minText ${scene.minText}`);
        for (const t of texts(scene)) assert.ok(t.size >= 15, `${label}: ${t.key} ${t.size} px`);
        const labels = texts(scene).filter((t) => /^pt-\d+-l\d$/.test(t.key));
        const min = size.width >= 720 ? 28 : 22;
        for (const t of labels) assert.ok(t.size >= min, `${label}: label ${t.key} ${t.size} px < ${min}`);
      }
    }
  }
});

test('points: a view fit keeps the type — pickScale shows the scene whole at scale 1 on every size', () => {
  for (const size of SIZES) {
    const scene = renderPoints(points(5), size);
    const v = pickScale({ w: scene.w, h: scene.h, minText: scene.minText, scroll: scene.scroll }, { w: size.width, h: size.height }, false);
    assert.equal(v.pan, 'none');
    assert.equal(v.scale, 1);
  }
});

test('points: numbered rows = accent disc + numeral (papaya for the highlight, violet otherwise); label P.fg weight 650, note P.dim weight 450', () => {
  const spec = points(3, { highlight: 'Feste Belohnung' });
  const scene = renderPoints(spec, SIZES[1]);
  const disc = (i: number) => scene.prims.find((p) => p.key === `pt-${i}-disc`) as CircleP;
  assert.equal(disc(0).fill, P.violet);
  assert.equal(disc(1).fill, P.papaya);
  assert.equal(disc(1).glow, true);
  assert.equal(disc(2).fill, P.violet);
  assert.deepEqual(texts(scene).filter((t) => /-num$/.test(t.key)).map((t) => t.text), ['1', '2', '3']);
  for (const t of texts(scene).filter((x) => /-l\d$/.test(x.key))) { assert.equal(t.fill, P.fg); assert.equal(t.weight, 650); }
  for (const t of texts(scene).filter((x) => /-n\d$/.test(x.key))) { assert.equal(t.fill, P.dim); assert.equal(t.weight, 450); assert.ok(t.size < texts(scene).find((x) => x.key === 'pt-0-l0')!.size); }
  // text is never in the accent colour; numerals contrast with the disc
  for (const t of texts(scene).filter((x) => /-num$/.test(x.key))) assert.ok(contrast(t.fill, (disc(Number(t.key.split('-')[1])) as CircleP).fill) >= 3.5, t.key);
  // an explicit tone colours the disc
  const toned = renderPoints(points(2, {}), SIZES[1]);
  assert.equal((toned.prims.find((p) => p.key === 'pt-1-disc') as CircleP).fill, P.violet);
  const withTone = renderPoints({ ...points(2), points: [{ label: 'Eins', tone: 'moss' }, { label: 'Zwei' }] }, SIZES[1]);
  assert.equal((withTone.prims.find((p) => p.key === 'pt-0-disc') as CircleP).fill, P.moss);
});

test('points: bullets style uses an 8 px dot instead of the numeral', () => {
  const scene = renderPoints(points(4, { style: 'bullets' }), SIZES[1]);
  const dots = circles(scene).filter((c) => /-dot$/.test(c.key));
  assert.equal(dots.length, 4);
  for (const d of dots) assert.equal(d.r * 2, 8);
  assert.equal(scene.prims.filter((p) => /-(disc|num)$/.test(p.key)).length, 0);
  // the dot sits left of its label, on the first line
  const l0 = texts(scene).find((t) => t.key === 'pt-0-l0')!;
  assert.ok(dots[0].cx < l0.x - 8);
  assert.ok(Math.abs(dots[0].cy - (l0.y - l0.size * 0.35)) < 3);
});

test('points: row prims share the key prefix pt-<i>- (the animator fades each row on its own)', () => {
  for (const style of ['numbered', 'bullets'] as const) {
    const scene = renderPoints(points(5, { style }), SIZES[0]);
    assert.ok(scene.prims.every((p) => /^pt-[0-4]-/.test(p.key)), scene.prims.map((p) => p.key).join());
    for (let i = 0; i < 5; i++) assert.ok(scene.prims.some((p) => p.key.startsWith(`pt-${i}-`)), `row ${i}`);
  }
  assert.equal(new Set(renderPoints(points(5), SIZES[0]).prims.map((p) => p.key)).size, renderPoints(points(5), SIZES[0]).prims.length, 'keys are unique');
});

test('points: rows at or after `revealed` keep their place at opacity 0 (no reflow when they appear); default = all', () => {
  const spec = points(4, { highlight: 'Vorfahren nicht bezahlt' });
  const all = renderPoints(spec, SIZES[2]);
  assert.ok(all.prims.every((p) => p.opacity === undefined), 'default: everything visible');
  for (const revealed of [0, 1, 2, 3, 4]) {
    const part = renderPoints(spec, SIZES[2], { revealed });
    assert.equal(part.prims.length, all.prims.length);
    part.prims.forEach((p, k) => {
      const row = Number(p.key.split('-')[1]);
      assert.equal(p.opacity, row < revealed ? undefined : 0, `${p.key} @${revealed}`);
      // geometry identical to the full scene
      assert.deepEqual({ ...p, opacity: undefined, glow: undefined }, { ...all.prims[k], opacity: undefined, glow: undefined }, p.key);
    });
  }
  // a hidden highlighted row has no glow halo (the halo would ignore the row's opacity)
  const hidden = renderPoints(spec, SIZES[2], { revealed: 1 });
  assert.ok(!(hidden.prims.find((p) => p.key === 'pt-2-disc') as CircleP).glow);
  assert.ok((renderPoints(spec, SIZES[2], { revealed: 3 }).prims.find((p) => p.key === 'pt-2-disc') as CircleP).glow);
});

test('points: rows enter 120 ms apart (text chat / no voice)', () => {
  const scene = renderPoints(points(4), SIZES[1]);
  for (const p of scene.prims) assert.equal(p.delay, Number(p.key.split('-')[1]) * 120, p.key);
});

test('points: the block is centred vertically and 2-5 rows fill the stage', () => {
  for (const size of SIZES) for (const n of [2, 3, 4, 5]) {
    const scene = renderPoints(points(n), size);
    const bs = scene.prims.map(box);
    const top = Math.min(...bs.map((b) => b.y0)), bottom = Math.max(...bs.map((b) => b.y1));
    assert.ok(Math.abs(top - (size.height - bottom)) <= 22, `${n}@${size.width}: top ${top.toFixed(0)} bottom gap ${(size.height - bottom).toFixed(0)}`);
    assert.ok((bottom - top) / size.height >= (n >= 4 ? 0.6 : n === 3 ? 0.35 : 0.26), `${n}@${size.width}: fills ${(((bottom - top) / size.height) * 100).toFixed(0)} %`);
  }
});

test('points: a long label wraps to at most two lines, a note stays under its label; wide stages centre the block, phones use the full width', () => {
  const long = pts(3).map((p, i) => (i === 1 ? { ...p, label: 'Gleiche Regeln für wirklich alle', note: 'auch für neue Mitglieder im Team' } : p));
  for (const size of SIZES) {
    const scene = renderPoints({ ...points(3), points: long }, size);
    assertInside(scene, size, `long ${size.width}`);
    const lines = texts(scene).filter((t) => /^pt-1-l\d$/.test(t.key));
    assert.ok(lines.length >= 1 && lines.length <= 2, `${lines.length} label lines`);
    const note = texts(scene).find((t) => t.key === 'pt-1-n0')!;
    assert.ok(note.y > lines[lines.length - 1].y, 'the note sits below the label');
    assert.doesNotMatch(lines.map((l) => l.text).join(' '), /…/, 'this label fits in two lines');
  }
  const phone = renderPoints(points(3), SIZES[0]);
  assert.ok(Math.min(...phone.prims.map((p) => box(p).x0)) <= 24, 'phone: left aligned with the page padding');
  const desktop = renderPoints(points(3), SIZES[2]);
  assert.ok(Math.min(...desktop.prims.map((p) => box(p).x0)) > 150, 'desktop: the block is centred');
});

test('points: eight points (detail view) stay inside the scene; the type floor drops by 4 px instead of scrolling when it can', () => {
  const eight = ['Eins', 'Zwei', 'Drei', 'Vier', 'Fünf', 'Sechs', 'Sieben', 'Acht'].map((label) => ({ label, note: 'kurze Notiz' }));
  for (const size of SIZES) {
    const scene = renderPoints({ ...points(5), points: eight }, size);
    for (const p of scene.prims) { const b = box(p); assert.ok(b.y0 >= -0.5 && b.y1 <= scene.h + 0.5 && b.x0 >= -0.5 && b.x1 <= scene.w + 0.5, `${size.width}: ${p.key}`); }
    assert.ok((scene.minText ?? 0) >= 15);
    for (const t of texts(scene).filter((x) => /-l\d$/.test(x.key))) assert.ok(t.size >= (size.width >= 720 ? 24 : 18), `${size.width}: ${t.size}`);
  }
});

test('points: empty list and bad rows do not crash', () => {
  assert.equal(renderPoints({ ...points(2), points: [] }, SIZES[0]).prims.length, 1);
  const odd = renderPoints({ ...points(2), points: [{ label: '  ' }, { label: 'Nur eins' }] }, SIZES[0]);
  assert.equal(odd.prims.filter((p) => /-l0$/.test(p.key)).length, 1);
});

// ---------------------------------------------------------------- stat
const stat = (over: Partial<CanvasSpec> = {}): CanvasSpec => ({ ...base, id: 'stat', kind: 'stat', title: 'Zahl', stats: [{ value: 1000, unit: 'Alpha', label: 'gleich geteilt' }], ...over });

test('stat: one hero figure ≥ 48 px, centred, unit next to it, label under it, German thousands separator, nothing outside the stage', () => {
  for (const size of SIZES) {
    const scene = renderStat(stat(), size);
    assertInside(scene, size, `stat ${size.width}`);
    const v = texts(scene).find((t) => t.key === 'st-0-v')!;
    const u = texts(scene).find((t) => t.key === 'st-0-u')!;
    const l = texts(scene).find((t) => t.key === 'st-0-l0')!;
    assert.equal(v.text, '1.000');
    assert.ok(v.size >= 48, `${size.width}: value ${v.size} px`);
    assert.ok(u.size < v.size && u.size >= 15);
    assert.ok(l.y > v.y, 'label under the number');
    assert.ok((scene.minText ?? 0) >= 15, `minText ${scene.minText}`);
    // number + unit are centred as a pair
    const bs = [box(v), box(u)];
    assert.ok(Math.abs((Math.min(...bs.map((b) => b.x0)) + Math.max(...bs.map((b) => b.x1))) / 2 - size.width / 2) < 4, `${size.width}: pair centred`);
    assert.ok(Math.abs(l.x - size.width / 2) < 1 && l.anchor === 'middle');
    assert.equal(v.fill, P.fg);
    assert.ok(v.num && v.num.value === 1000, 'counts up on enter');
    assert.equal(v.num.format(1000), '1.000');
  }
});

test('stat: the hero is vertically centred and does not use a serif / tabular face (same sans FONT)', () => {
  const size = SIZES[2];
  const scene = renderStat(stat(), size);
  const bs = scene.prims.map(box);
  const top = Math.min(...bs.map((b) => b.y0)), bottom = Math.max(...bs.map((b) => b.y1));
  assert.ok(Math.abs(top - (size.height - bottom)) < 24, `${top} / ${size.height - bottom}`);
  for (const t of texts(scene)) assert.ok(!t.mono && !t.italic, t.key);
});

test('stat: a KPI row is side by side on desktop and stacked on phones (< 480 px)', () => {
  const two = stat({ stats: [{ value: 1000, unit: 'Alpha', label: 'gleich geteilt' }, { value: 0, label: 'für Vorfahren' }] });
  const three = stat({ stats: [{ value: 12.5, unit: 'Std', label: 'pro Woche' }, { value: '70 %', label: 'Anteil Champion' }, { value: 3, label: 'Bereiche' }] });
  for (const spec of [two, three]) {
    const n = spec.stats!.length;
    for (const size of SIZES) {
      const scene = renderStat(spec, size);
      assertInside(scene, size, `${n} stats ${size.width}`);
      const vs = texts(scene).filter((t) => /^st-\d-v$/.test(t.key));
      assert.equal(vs.length, n);
      for (const v of vs) assert.ok(v.size >= 48, `${n} stats ${size.width}: ${v.size} px`);
      assert.ok((scene.minText ?? 0) >= 15, `${n} stats ${size.width}: minText ${scene.minText}`);
      const ys = vs.map((v) => v.y), xs = vs.map((v) => v.x);
      if (size.width < 480) {
        assert.ok(ys.every((y, i) => i === 0 || y > ys[i - 1] + 40), 'stacked: each value below the last');
        assert.ok(Math.max(...xs) - Math.min(...xs) < 120, 'stacked: one column');
      } else {
        assert.ok(Math.max(...ys) - Math.min(...ys) < 2, 'side by side: one row');
        assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1] + 150), 'side by side: distinct columns');
      }
    }
  }
  // number formatting: decimals German, strings as is
  const scene = renderStat(three, SIZES[2]);
  assert.deepEqual(texts(scene).filter((t) => /^st-\d-v$/.test(t.key)).map((t) => t.text), ['12,5', '70 %', '3']);
  assert.ok(!texts(scene).find((t) => t.key === 'st-1-v')!.num, 'a string value has no count-up');
});

test('stat: the highlighted stat gets the papaya accent; no stats = the empty frame', () => {
  const scene = renderStat(stat({ stats: [{ value: 5, label: 'Eins' }, { value: 6, label: 'Zwei' }], highlight: 'Zwei' }), SIZES[2]);
  assert.equal((scene.prims.find((p) => p.key === 'st-1-bar') as RectP).fill, P.papaya);
  assert.equal((scene.prims.find((p) => p.key === 'st-0-bar') as RectP).fill, P.violet);
  assert.equal(renderStat(stat({ stats: [] }), SIZES[0]).prims[0].key, 'empty');
});

test('stat: a long number + unit moves the unit under the figure instead of shrinking it below 48 px', () => {
  const scene = renderStat(stat({ stats: [{ value: '12,5 Mio.', unit: 'Alpha pro Jahr', label: 'Gesamtmenge' }] }), SIZES[0]);
  assertInside(scene, SIZES[0], 'long stat');
  const v = texts(scene).find((t) => t.key === 'st-0-v')!;
  const u = texts(scene).find((t) => t.key === 'st-0-u')!;
  assert.ok(v.size >= 48, `${v.size}`);
  assert.ok(u.y > v.y, 'unit below');
});

// ---------------------------------------------------------------- stacked bar
const stacked = (over: Partial<CanvasSpec> = {}): CanvasSpec => ({ ...base, id: 'stk', kind: 'bar', layout: 'stacked', unit: '%', title: 'Aufteilung', items: [
  { label: 'Champion', value: 70 }, { label: 'Ehemaliger', value: 10 }, { label: 'Weiterer', value: 5 }, { label: 'Rest', value: 15 },
], ...over });
const segment = (scene: Scene, i: number) => paths(scene).find((p) => p.key === `sb-${i}-seg`);

test('stacked bar: shares sum to 1, slot colours in item order, one segment per non-zero part', () => {
  const { parts, total } = stackedParts(stacked());
  assert.equal(total, 100);
  assert.ok(Math.abs(parts.reduce((a, p) => a + p.share, 0) - 1) < 1e-12);
  assert.deepEqual(parts.map((p) => p.color), CATEGORICAL_DARK.slice(0, 4));
  assert.deepEqual(parts.map((p) => p.label), ['Champion', 'Ehemaliger', 'Weiterer', 'Rest'], 'item order as given');
  const scene = renderStackedBar(stacked(), SIZES[1]);
  assert.deepEqual([0, 1, 2, 3].map((i) => segment(scene, i)!.fill), CATEGORICAL_DARK.slice(0, 4));
  // fixture
  const fx = stackedParts(stackedFx as unknown as CanvasSpec);
  assert.ok(Math.abs(fx.parts.reduce((a, p) => a + p.share, 0) - 1) < 1e-12);
});

test('stacked bar: one bar 56-72 px tall across the width, 2 px gaps, 4 px rounded outer ends only', () => {
  for (const size of SIZES) {
    const scene = renderStackedBar(stacked(), size);
    assertInside(scene, size, `stacked ${size.width}`);
    const segs = [0, 1, 2, 3].map((i) => box(segment(scene, i)!));
    const h = segs[0].y1 - segs[0].y0;
    assert.ok(h >= 56 && h <= 72, `${size.width}: bar ${h} px tall`);
    for (const s of segs) { assert.equal(s.y0, segs[0].y0); assert.equal(s.y1, segs[0].y1); }
    for (let i = 1; i < 4; i++) assert.ok(Math.abs(segs[i].x0 - segs[i - 1].x1 - 2) < 0.15, `${size.width}: gap ${segs[i].x0 - segs[i - 1].x1}`);
    // widths are proportional (70 : 10 : 5 : 15)
    const total = segs.reduce((a, b) => a + (b.x1 - b.x0), 0);
    [0.7, 0.1, 0.05, 0.15].forEach((share, i) => assert.ok(Math.abs((segs[i].x1 - segs[i].x0) / total - share) < 0.004, `${size.width}: segment ${i}`));
    // the bar spans most of the stage on phones
    if (size.width < 480) assert.ok(segs[3].x1 - segs[0].x0 >= size.width - 48);
  }
  const scene = renderStackedBar(stacked(), SIZES[1]);
  const radii = (i: number) => [...segment(scene, i)!.d.matchAll(/A(\S+) (\S+) 0 0 1/g)].map((m) => Number(m[1]));
  // path order: top-right, bottom-right, bottom-left, top-left
  assert.deepEqual(radii(0), [0, 0, 4, 4], 'first: left corners rounded');
  assert.deepEqual(radii(1), [0, 0, 0, 0]);
  assert.deepEqual(radii(2), [0, 0, 0, 0]);
  assert.deepEqual(radii(3), [4, 4, 0, 0], 'last: right corners rounded');
});

test('stacked bar: the share is printed ON a segment when it fits, with a contrasting text colour', () => {
  const scene = renderStackedBar(stacked(), SIZES[0]);
  const pct = (i: number) => texts(scene).find((t) => t.key === `sb-${i}-pct`);
  assert.equal(sp(pct(0)!.text), '70 %');
  assert.equal(pct(2), undefined, '5 % of a phone width is too narrow for text');
  for (const t of texts(scene).filter((x) => /-pct$/.test(x.key))) {
    const color = (segment(scene, Number(t.key.split('-')[1])) as PathP).fill!;
    assert.ok(t.fill === '#ffffff' || t.fill === '#0e0e12', t.fill);
    assert.ok(contrast(t.fill, color) >= 4, `${t.key}: ${contrast(t.fill, color).toFixed(2)}`);
    assert.ok(contrast(t.fill, color) >= contrast(t.fill === '#ffffff' ? '#0e0e12' : '#ffffff', color), 'the better of the two');
  }
  const wide = renderStackedBar(stacked(), SIZES[2]);
  assert.equal(texts(wide).filter((t) => /-pct$/.test(t.key)).length, 3, '70, 10 and 15 % fit on desktop; 5 % does not');
  // every printed share is inside its segment
  for (const t of texts(wide).filter((x) => /-pct$/.test(x.key))) {
    const s = box(segment(wide, Number(t.key.split('-')[1]))!), b = box(t);
    assert.ok(b.x0 >= s.x0 && b.x1 <= s.x1, t.key);
  }
});

test('stacked bar: legend = swatch + name + value/unit, one row per item, zero items keep their row', () => {
  const spec = stacked({ items: [{ label: 'Champion', value: 90 }, { label: 'Ehemaliger', value: 10 }, { label: 'Vorfahren', value: 0 }] });
  for (const size of SIZES) {
    const scene = renderStackedBar(spec, size);
    assertInside(scene, size, `legend ${size.width}`);
    for (let i = 0; i < 3; i++) {
      assert.ok(rects(scene).some((r) => r.key === `sb-${i}-sw` && r.fill === CATEGORICAL_DARK[i]), `swatch ${i}`);
      assert.ok(texts(scene).some((t) => t.key === `sb-${i}-l`), `name ${i}`);
    }
    assert.equal(texts(scene).find((t) => t.key === 'sb-2-l')!.text, 'Vorfahren');
    assert.equal(sp(texts(scene).find((t) => t.key === 'sb-2-v')!.text), '0 %');
    assert.equal(segment(scene, 2), undefined, 'a zero part takes no width');
    assert.equal(sp(texts(scene).find((t) => t.key === 'sb-0-v')!.text), '90 %');
    // rows are evenly spaced below the bar, values right aligned in one column
    const ys = [0, 1, 2].map((i) => texts(scene).find((t) => t.key === `sb-${i}-l`)!.y);
    assert.ok(ys[1] - ys[0] === ys[2] - ys[1] && ys[1] - ys[0] >= 34);
    const xs = [0, 1, 2].map((i) => texts(scene).find((t) => t.key === `sb-${i}-v`)!.x);
    assert.ok(xs.every((x) => x === xs[0]) && texts(scene).find((t) => t.key === 'sb-0-v')!.anchor === 'end');
    assert.ok(ys[0] > box(segment(scene, 0)!).y1 + 10, 'legend below the bar');
  }
  // other units / money: value with its unit
  const money = renderStackedBar(stacked({ unit: 'EUR', items: [{ label: 'A', value: 1200 }, { label: 'B', value: 300 }] }), SIZES[1]);
  assert.equal(texts(money).find((t) => t.key === 'sb-0-v')!.text, '1.200 €');
});

test('stacked bar: the highlight keeps its slot colour and gets a 2 px fg outline (painted last)', () => {
  const scene = renderStackedBar(stacked({ highlight: 'Ehemaliger' }), SIZES[1]);
  const hi = segment(scene, 1)!;
  assert.equal(hi.fill, CATEGORICAL_DARK[1]);
  assert.equal(hi.stroke, P.fg);
  assert.equal(hi.sw, 2);
  for (const i of [0, 2, 3]) assert.equal(segment(scene, i)!.stroke, undefined);
  const order = scene.prims.filter((p) => /-seg$/.test(p.key)).map((p) => p.key);
  assert.equal(order[order.length - 1], 'sb-1-seg');
});

test('stacked bar: more than six parts fold the smallest into a neutral "Sonstige"; the total is kept', () => {
  const items = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((label, i) => ({ label, value: [30, 25, 20, 8, 7, 4, 3, 3][i] }));
  const { parts, total } = stackedParts(stacked({ items }));
  assert.equal(parts.length, 6);
  assert.equal(total, 100);
  assert.deepEqual(parts.map((p) => p.label), ['A', 'B', 'C', 'D', 'E', 'Sonstige']);
  assert.equal(parts[5].value, 10);
  assert.equal(parts[5].color, REST_COLOR);
  assert.deepEqual(parts.slice(0, 5).map((p) => p.color), CATEGORICAL_DARK.slice(0, 5));
  assert.ok(Math.abs(parts.reduce((a, p) => a + p.share, 0) - 1) < 1e-12);
  assertInside(renderStackedBar(stacked({ items }), SIZES[0]), SIZES[0], 'six rows at 360x480');
});

test('stacked bar: renderScene routes bar + layout stacked, points and stat; a plain bar stays a bar', async () => {
  const sizes = SIZES[1];
  assert.ok((await renderScene(stacked(), sizes)).prims.some((p) => p.key === 'sb-0-seg'));
  assert.ok((await renderScene({ ...stacked(), layout: undefined }, sizes)).prims.some((p) => p.key.startsWith('b:')));
  assert.ok((await renderScene(points(3), sizes)).prims.some((p) => p.key === 'pt-0-l0'));
  assert.equal((await renderScene(points(3), sizes, { revealed: 1 })).prims.find((p) => p.key === 'pt-2-l0')!.opacity, 0);
  assert.ok((await renderScene(stat(), sizes)).prims.some((p) => p.key === 'st-0-v'));
  assert.equal((await renderScene(stacked({ items: [] }), sizes)).prims[0].key, 'empty');
});

test('fixtures: the three demo fixtures render without overflow at the target sizes', () => {
  for (const size of SIZES) {
    assertInside(renderPoints(pointsFx as unknown as CanvasSpec, size), size, `points fixture ${size.width}`);
    assertInside(renderStat(statFx as unknown as CanvasSpec, size), size, `stat fixture ${size.width}`);
    assertInside(renderStackedBar(stackedFx as unknown as CanvasSpec, size), size, `stacked fixture ${size.width}`);
  }
});

// ---------------------------------------------------------------- bar / pie palette (dataviz anti-pattern: a value ramp on one series)
test('bar: ONE series = ONE colour (slot 1) for every bar; the highlight is papaya; an explicit tone is kept', () => {
  const items = [{ label: 'Eins', value: 40 }, { label: 'Zwei', value: 30 }, { label: 'Drei', value: 20 }, { label: 'Vier', value: 10 }];
  for (const size of [{ width: 900, height: 500 }, { width: 360, height: 480 }]) {
    const scene = renderBar({ ...base, id: 'b', kind: 'bar', title: 'Balken', unit: 'EUR', items }, size);
    const fills = rects(scene).filter((r) => r.key.startsWith('b:')).map((r) => r.fill);
    assert.equal(fills.length, 4);
    assert.ok(fills.every((f) => f === CATEGORICAL_DARK[0]), fills.join());
  }
  const scene = renderBar({ ...base, id: 'b', kind: 'bar', title: 'Balken', unit: 'EUR', highlight: 'Zwei', items: [...items.slice(0, 3), { label: 'Vier', value: 10, tone: 'moss' }] }, { width: 900, height: 500 });
  const fill = (k: string) => (scene.prims.find((p) => p.key === `b:${k}`) as RectP).fill;
  assert.equal(fill('Zwei'), P.papaya);
  assert.equal(fill('Vier'), P.moss);
  assert.equal(fill('Eins'), CATEGORICAL_DARK[0]);
  assert.equal(fill('Drei'), CATEGORICAL_DARK[0]);
});

test('pie: slices take the categorical slots in order (largest first); an explicit tone is kept', () => {
  const spec: CanvasSpec = { ...base, id: 'p', kind: 'pie', title: 'Anteile', unit: '%', items: [{ label: 'A', value: 50 }, { label: 'B', value: 25 }, { label: 'C', value: 15 }, { label: 'D', value: 10 }] };
  const arcs = renderPie(spec, { width: 900, height: 500 }).prims.filter((p) => p.t === 'arc') as { fill: string }[];
  assert.deepEqual(arcs.map((a) => a.fill), CATEGORICAL_DARK.slice(0, 4));
  const toned = renderPie({ ...spec, items: spec.items!.map((it, i) => (i === 1 ? { ...it, tone: 'moss' as const } : it)) }, { width: 900, height: 500 }).prims.filter((p) => p.t === 'arc') as { fill: string }[];
  assert.equal(toned[1].fill, P.moss);
  assert.equal(toned[0].fill, CATEGORICAL_DARK[0]);
});
