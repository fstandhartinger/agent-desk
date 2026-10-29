// Upgrades 28 Oct (§5): simple view by default, "Details" switches one canvas id to its detailed version. Pure helpers,
// the per-id toggle state in the bus (history keeps both), and shared node keys so the switch animates in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailLabel, hasDetail, variantSpec } from '../src/canvas/detail.ts';
import { applyEvent, initialCanvasState, selectCanvas, toggleDetail, HISTORY } from '../src/canvas/bus.ts';
import { bestLayout, renderGraph, SIMPLE_MIN_PX } from '../src/canvas/render/graph.ts';
import { pickScale } from '../src/canvas/view.ts';
import type { CanvasSpec } from '../src/canvas/types.ts';

const node = (id: string, label: string) => ({ id, label });
const SIMPLE: CanvasSpec = {
  v: 2, id: 'auszahlung', kind: 'flow', title: 'Wie eine Auszahlung läuft', caption: 'Kurz.', highlight: 'check', sources: [{ label: 'Gespräch', ref: 'Gespräch' }],
  nodes: [node('antrag', 'Antrag'), node('check', 'Freigabe?'), node('bank', 'Überweisung'), node('fertig', 'Erledigt')],
  edges: [{ from: 'antrag', to: 'check' }, { from: 'check', to: 'bank', label: 'ja' }, { from: 'bank', to: 'fertig' }],
  detail: {
    kind: 'flow', caption: 'Mit Rückfrage, Buchung und Beleg.',
    nodes: [node('antrag', 'Antrag'), node('pruefung', 'Belege prüfen'), node('check', 'Freigabe?'), node('rueckfrage', 'Rückfrage'), node('bank', 'Überweisung'), node('buchung', 'Buchung'), node('beleg', 'Beleg ablegen'), node('fertig', 'Erledigt')],
    edges: [{ from: 'antrag', to: 'pruefung' }, { from: 'pruefung', to: 'check' }, { from: 'check', to: 'bank', label: 'ja' }, { from: 'check', to: 'rueckfrage', label: 'nein' }, { from: 'rueckfrage', to: 'pruefung' }, { from: 'bank', to: 'buchung' }, { from: 'buchung', to: 'beleg' }, { from: 'beleg', to: 'fertig' }],
  },
};
const ready = (spec: CanvasSpec, at: number) => ({ type: 'canvas' as const, phase: 'ready' as const, id: spec.id, spec, by: 'voice' as const, at });

test('variantSpec: simple by default, the detail merged over the simple view (same id, sources, title), stable identity', () => {
  assert.equal(hasDetail(SIMPLE), true);
  assert.equal(variantSpec(SIMPLE, false), SIMPLE);
  const d = variantSpec(SIMPLE, true);
  assert.equal(d.id, 'auszahlung');
  assert.equal(d.title, SIMPLE.title);
  assert.equal(d.caption, 'Mit Rückfrage, Buchung und Beleg.');
  assert.equal(d.highlight, 'check');
  assert.deepEqual(d.sources, SIMPLE.sources);
  assert.equal(d.nodes!.length, 8);
  assert.equal(d.detail, undefined);
  assert.equal(variantSpec(SIMPLE, true), d, 'memoised: the stage does not re-layout on every render');
  const { detail: _d, ...plain } = SIMPLE;
  assert.equal(hasDetail(plain as CanvasSpec), false);
  assert.equal(variantSpec(plain as CanvasSpec, true), plain);
  assert.equal(hasDetail({ ...SIMPLE, detail: { ...SIMPLE.detail!, kind: 'pie' } }), false, 'another kind is no detail');
});

test('toggle label and state: "Details" / "Einfach", per canvas id, default simple', () => {
  assert.equal(detailLabel(false), 'Details');
  assert.equal(detailLabel(true), 'Einfach');
  let s = applyEvent(initialCanvasState(), ready(SIMPLE, 1));
  const other: CanvasSpec = { ...SIMPLE, id: 'deploy', title: 'Deployment' };
  s = applyEvent(s, ready(other, 2));
  assert.equal(s.details?.auszahlung, undefined);
  s = toggleDetail(s, 'auszahlung');
  assert.equal(s.details?.auszahlung, true);
  assert.equal(s.details?.deploy, undefined, 'per visual id');
  // history: selecting another canvas and coming back keeps the choice; both variants stay in the entry
  s = selectCanvas(s, 'deploy');
  s = selectCanvas(s, 'auszahlung');
  assert.equal(s.details?.auszahlung, true);
  assert.equal(s.entries.auszahlung.spec!.detail!.nodes!.length, 8);
  assert.equal(s.entries.auszahlung.spec!.nodes!.length, 4);
  s = toggleDetail(s, 'auszahlung');
  assert.equal(s.details?.auszahlung, undefined);
  assert.equal(toggleDetail(s, 'unknown'), s);
});

test('an update with details keeps the choice; an update without details falls back to simple; history eviction forgets it', () => {
  let s = toggleDetail(applyEvent(initialCanvasState(), ready(SIMPLE, 1)), 'auszahlung');
  s = applyEvent(s, ready({ ...SIMPLE, caption: 'neu' }, 2));
  assert.equal(s.details?.auszahlung, true);
  const { detail: _d, ...plain } = SIMPLE;
  s = applyEvent(s, ready(plain as CanvasSpec, 3));
  assert.equal(s.details?.auszahlung, undefined);
  s = toggleDetail(applyEvent(s, ready(SIMPLE, 4)), 'auszahlung');
  for (let i = 0; i < HISTORY; i++) s = applyEvent(s, ready({ ...SIMPLE, id: `x${i}` }, 10 + i));
  assert.equal(s.entries.auszahlung, undefined);
  assert.equal(s.details?.auszahlung, undefined);
});

test('both variants share the node keys of the same things: the switch tweens them in place', async () => {
  const size = { width: 1100, height: 640 };
  const a = await renderGraph(variantSpec(SIMPLE, false), size);
  const b = await renderGraph(variantSpec(SIMPLE, true), size);
  const keys = (s: typeof a) => new Set(s.prims.filter((p) => p.key.startsWith('n:') && !p.key.includes(':', 2)).map((p) => p.key));
  const simple = keys(a);
  const full = keys(b);
  for (const id of ['antrag', 'check', 'bank', 'fertig']) { assert.ok(simple.has(`n:${id}`)); assert.ok(full.has(`n:${id}`)); }
  assert.ok(full.has('n:rueckfrage') && !simple.has('n:rueckfrage'));
});

test('a simple view in the desk\'s side column (829 px) gets the big type: node labels >= 16 px on screen', async () => {
  for (const spec of [variantSpec(SIMPLE, false), { ...variantSpec(SIMPLE, false), kind: 'architecture' as const, direction: 'TB' as const }]) {
    const box = { width: 829, height: 580 };
    const L = await bestLayout(spec, box);
    const v = pickScale({ w: L.w, h: L.h, minText: L.dims.label }, { w: box.width, h: box.height }, true);
    assert.equal(v.pan, 'none');
    assert.ok(v.scale * L.dims.label >= SIMPLE_MIN_PX, `${spec.kind}: ${v.scale * L.dims.label} px`);
  }
});
