// Fix 28 Oct (live: a flow detail with 3 boxes without any arrow, drawn as a loose column): a flow / architecture with >= 2
// boxes is always connected. Illustrator: loose boxes fail the quality gate -> the one repair round, then the deterministic
// fallback. canvas_render / Claude canvases: the deterministic splice / drop. Synthetic data only.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_EARLY: '0', DESK_CANVAS_TIMEOUT_MS: '800' });
const { normalizeCanvas, isolatedNodes, connectCanvas, ensureSimple } = await import('../src/canvas.js');
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator } = await import('../src/illustrator.js');

const src = [{ label: 'Gespräch', ref: 'Gespräch' }];
const node = (id, label = id.toUpperCase(), extra = {}) => ({ id, label, ...extra });
const chain = (n, extra = {}) => ({ kind: 'flow', title: 'Ablauf', sources: src, nodes: Array.from({ length: n }, (_, i) => node(`n${i}`, `Schritt ${i + 1}`)), edges: Array.from({ length: Math.max(0, n - 1) }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })), ...extra });
const ok = (spec) => { const r = normalizeCanvas(spec); assert.equal(r.ok, true, r.error); return r.spec; };
const loose = (spec) => isolatedNodes(spec).length;

/** Undirected connectivity of the drawn boxes. */
function connected(spec) {
  const ids = spec.nodes.map((n) => n.id);
  if (ids.length <= 1) return true;
  const seen = new Set([ids[0]]);
  const queue = [ids[0]];
  while (queue.length) {
    const at = queue.shift();
    for (const e of spec.edges) {
      const other = e.from === at ? e.to : e.to === at ? e.from : null;
      if (other && !seen.has(other)) { seen.add(other); queue.push(other); }
    }
  }
  return ids.every((id) => seen.has(id));
}

// The live shape, synthetic labels: an 11-step "idea to delivery" flow; steps 2, 5 and 6 (array order) have no arrow, the
// chain jumps over them (idee -> plan, skript -> render, ...).
const STEPS = ['idee', 'quellen', 'plan', 'skript', 'sprechtext', 'animation', 'render', 'pruefung', 'seite', 'versand', 'fertig'];
const LOOSE = new Set(['quellen', 'sprechtext', 'animation']);
const VIDEO_DETAIL = (() => {
  const nodes = STEPS.map((id) => node(id, `Schritt ${id}`));
  const kept = STEPS.filter((id) => !LOOSE.has(id));
  const edges = kept.slice(1).map((id, i) => ({ from: kept[i], to: id, ...(id === 'render' ? { label: 'fertig geplant' } : {}) }));
  return { kind: 'flow', nodes, edges };
})();
const VIDEO = { kind: 'flow', id: 'erklaervideo', title: 'Wie ein Erklärvideo entsteht', sources: src, nodes: [node('idee', 'Idee'), node('skript', 'Skript'), node('render', 'Rendern'), node('versand', 'Versand')], edges: [{ from: 'idee', to: 'skript' }, { from: 'skript', to: 'render' }, { from: 'render', to: 'versand' }], detail: VIDEO_DETAIL };

describe('loose boxes are found and fail the quality gate', () => {
  it('isolatedNodes: boxes no arrow touches; self-loops do not connect; other kinds and single boxes have none', () => {
    assert.deepEqual(isolatedNodes(ok({ ...VIDEO_DETAIL, title: 'x', sources: src })), ['quellen', 'sprechtext', 'animation']);
    assert.deepEqual(isolatedNodes(ok({ ...chain(3), edges: [{ from: 'n0', to: 'n1' }, { from: 'n2', to: 'n2' }] })), ['n2']);
    assert.deepEqual(isolatedNodes(ok(chain(4))), []);
    assert.deepEqual(isolatedNodes({ kind: 'flow', nodes: [node('a')], edges: [] }), []);
    assert.deepEqual(isolatedNodes({ kind: 'sequence', nodes: [node('a'), node('b')], edges: [] }), []);
  });

  it('the gate names the loose boxes, for the simple view and for the detail', () => {
    const top = normalizeCanvas({ ...chain(4), edges: [{ from: 'n0', to: 'n1' }, { from: 'n1', to: 'n2' }] }, { gate: true });
    assert.equal(top.ok, false);
    assert.match(top.error, /boxes without any arrow \("Schritt 4"\)/);
    const det = normalizeCanvas(VIDEO, { gate: true });
    assert.equal(det.ok, false);
    assert.match(det.error, /^detail: flow has boxes without any arrow \("Schritt quellen", "Schritt sprechtext", "Schritt animation"\)/);
    assert.equal(normalizeCanvas(chain(4), { gate: true }).ok, true);
  });
});

describe('connectCanvas: the deterministic repair', () => {
  it('a mostly linear chain: each loose run is spliced in at its array position, replacing the jumped-over arrow', () => {
    const spec = ok(VIDEO);
    const r = connectCanvas(spec);
    assert.equal(r.changed, true);
    assert.deepEqual(r.spliced, ['quellen', 'sprechtext', 'animation']);
    assert.deepEqual(r.dropped, []);
    const d = r.spec.detail;
    assert.equal(d.nodes.length, 11);
    assert.equal(loose({ ...d, kind: 'flow' }), 0);
    assert.ok(connected(d));
    const pairs = d.edges.map((e) => `${e.from}>${e.to}`);
    assert.ok(!pairs.includes('idee>plan') && !pairs.includes('skript>render'), 'the jumped-over arrows are replaced');
    for (const p of ['idee>quellen', 'quellen>plan', 'skript>sprechtext', 'sprechtext>animation', 'animation>render']) assert.ok(pairs.includes(p), p);
    assert.equal(d.edges.find((e) => e.from === 'skript').label, 'fertig geplant', 'the replaced arrow keeps its label on its first part');
    assert.equal(d.edges.length, 10, 'a chain of 11 boxes');
    assert.deepEqual(r.spec.nodes, spec.nodes, 'the simple view was already connected');
    assert.equal(normalizeCanvas(r.spec, { gate: true }).ok, true);
  });

  it('a loose run at the start / end attaches to the chain\'s first / last box', () => {
    const spec = ok({ ...chain(5), edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }] }); // n0 and n4 loose
    const { spec: out, spliced } = connectCanvas(spec);
    assert.deepEqual(spliced, ['n0', 'n4']);
    assert.deepEqual(out.edges.map((e) => `${e.from}>${e.to}`).sort(), ['n0>n1', 'n1>n2', 'n2>n3', 'n3>n4']);
  });

  it('no plausible place (a hub, not a chain): the loose boxes are dropped and named in the caption', () => {
    const hub = ok({
      kind: 'architecture', title: 'Aufbau', caption: 'Die Teile vom Demo-Desk.', sources: src,
      groups: [{ id: 'a', label: 'Server' }, { id: 'b', label: 'Extra' }],
      nodes: [node('gw', 'Gateway', { group: 'a' }), node('x', 'Zusatzdienst', { group: 'b' }), node('w', 'Web', { group: 'a' }), node('br', 'Bridge', { group: 'a' }), node('v', 'Voice', { group: 'a' })],
      edges: [{ from: 'gw', to: 'w' }, { from: 'gw', to: 'br' }, { from: 'gw', to: 'v' }, { from: 'w', to: 'br' }, { from: 'v', to: 'w' }],
    });
    const r = connectCanvas(hub);
    assert.deepEqual(r.dropped, ['Zusatzdienst']);
    assert.equal(r.spec.nodes.length, 4);
    assert.equal(r.spec.caption, 'Die Teile vom Demo-Desk. Ohne Verbindung weggelassen: Zusatzdienst.');
    assert.deepEqual(r.spec.groups.map((g) => g.id), ['a'], 'a group left without boxes goes too');
    assert.equal(normalizeCanvas(r.spec, { gate: true }).ok, true);
  });

  it('a loose run between two boxes without a direct arrow is dropped (no new fork), the caption note fits the limit', () => {
    const spec = ok({ ...chain(5), caption: 'x'.repeat(160), edges: [{ from: 'n0', to: 'n1' }, { from: 'n1', to: 'n4' }, { from: 'n3', to: 'n4' }] }); // n2 loose, no n1 -> n3
    const r = connectCanvas(spec);
    assert.deepEqual(r.dropped, ['Schritt 3']);
    assert.deepEqual(r.spec.nodes.map((n) => n.id), ['n0', 'n1', 'n3', 'n4']);
    assert.ok(r.spec.caption.length <= 160);
    assert.match(r.spec.caption, /^x+… Ohne Verbindung weggelassen: Schritt 3\.$/);
  });

  it('nothing to do: the spec comes back unchanged (same object); other kinds are untouched', () => {
    const spec = ok(chain(4));
    assert.equal(connectCanvas(spec).spec, spec);
    const pie = ok({ kind: 'pie', title: 'Anteile', sources: src, items: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] });
    assert.equal(connectCanvas(pie).spec, pie);
  });

  it('ensureSimple (Claude canvases, the illustrator\'s last step) never shows loose boxes', () => {
    const { spec } = ensureSimple(ok(VIDEO));
    assert.equal(loose(spec), 0);
    assert.equal(loose({ ...spec.detail, kind: 'flow' }), 0);
    assert.equal(spec.detail.nodes.length, 11);
  });
});

describe('canvas_render: repaired at once, no model round', () => {
  const session = (bus, audits) => {
    const ill = createIllustrator({ bus, hub: {}, complete: async () => { throw new Error('no model call expected'); }, run: async () => ({ ok: true, content: '' }), audit: () => {} });
    return createCanvasSession({ bus, illustrator: ill, by: 'text', provider: 'claude', emit: () => {}, ctx: {}, audit: (a) => audits.push(a), debounceMs: () => 30, researchMs: () => 5000 });
  };

  it('the live shape: the detail is published connected (11 boxes, a chain), audited', () => {
    const bus = createCanvasBus();
    const audits = [];
    const r = session(bus, audits).render(VIDEO);
    assert.equal(r.ok, true);
    const spec = bus.latest().find((e) => e.id === 'erklaervideo').spec;
    assert.equal(spec.detail.nodes.length, 11);
    assert.ok(connected(spec.detail) && connected(spec));
    assert.ok(audits.some((a) => a.action === 'canvas.connected' && /spliced 3, dropped 0/.test(a.detail)));
  });

  it('a loose box in the simple view of a non-chain is dropped with a caption note', () => {
    const bus = createCanvasBus();
    const r = session(bus, []).render({ kind: 'flow', id: 'stern', title: 'Stern', sources: src, nodes: [node('m', 'Mitte'), node('a', 'Ast A'), node('b', 'Ast B'), node('c', 'Ast C'), node('z', 'Allein')], edges: [{ from: 'm', to: 'a' }, { from: 'm', to: 'b' }, { from: 'm', to: 'c' }, { from: 'b', to: 'a' }] });
    assert.equal(r.ok, true);
    const spec = bus.latest().find((e) => e.id === 'stern').spec;
    assert.deepEqual(spec.nodes.map((n) => n.id), ['m', 'a', 'b', 'c']);
    assert.match(spec.caption, /Ohne Verbindung weggelassen: Allein\./);
  });

  it('a detail that is too thin after the repair is left out; the simple drawing still shows', () => {
    const bus = createCanvasBus();
    const audits = [];
    const thin = { kind: 'flow', nodes: [node('a', 'Eins'), node('b', 'Zwei'), node('c', 'Drei')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] };
    const r = session(bus, audits).render({ ...chain(4), id: 'duenn', detail: thin });
    assert.equal(r.ok, true);
    const spec = bus.latest().find((e) => e.id === 'duenn').spec;
    assert.equal(spec.nodes.length, 4);
    assert.equal(spec.detail, undefined);
    // since critic round 1 (P2-5) a detail with fewer boxes than the simple view is dropped by normalizeCanvas, before the gate
  });
});

describe('illustrator: loose boxes are a quality-gate failure -> the one repair round', () => {
  let bus;
  let audits;
  beforeEach(() => { bus = createCanvasBus(); audits = []; });
  const memory = { noteTool() {}, toolsUsed: () => [], snapshot: () => ({ turns: [{ role: 'user', text: 'Zeichne, wie ein Erklärvideo entsteht' }], facts: '' }), turnTexts: () => [], lastUser: () => '', userTurns: () => [] };
  const answer = (spec) => ({ message: { content: JSON.stringify(spec), tool_calls: [] }, costUsd: 0.001 });
  const fixed = { ...VIDEO, detail: { ...VIDEO_DETAIL, edges: STEPS.slice(1).map((id, i) => ({ from: STEPS[i], to: id })) } };
  const draw = async (script) => {
    let calls = 0;
    const prompts = [];
    const ill = createIllustrator({ bus, hub: {}, complete: async ({ messages }) => { calls += 1; prompts.push(messages.at(-1).content); return answer(script.shift()); }, run: async () => ({ ok: true, content: '' }), audit: (a) => audits.push(a) });
    const r = await ill.draw({ id: 'erklaervideo', request: 'Zeichne, wie ein Erklärvideo entsteht', by: 'text', publish: (p) => bus.publish(p), memory });
    return { r, calls, prompts, spec: bus.latest()[0]?.spec };
  };

  it('loose boxes in the detail -> the repair prompt names them; the repaired answer is published', async () => {
    const { calls, prompts, spec } = await draw([VIDEO, fixed]);
    assert.equal(calls, 2);
    assert.match(prompts[1], /rejected: detail: flow has boxes without any arrow/);
    assert.equal(spec.detail.nodes.length, 11);
    assert.ok(connected(spec.detail));
  });

  it('the repair has loose boxes again -> the deterministic splice; never a third call, never loose boxes', async () => {
    const { calls, spec, r } = await draw([VIDEO, VIDEO]);
    assert.equal(r.ok, true);
    assert.equal(calls, 2);
    assert.equal(spec.detail.nodes.length, 11);
    assert.ok(connected(spec.detail) && connected(spec));
    assert.ok(audits.some((a) => a.action === 'canvas.repair.fallback'));
  });

  it('loose boxes in the simple view, both answers: the fallback is connected', async () => {
    const top = { ...chain(5), id: 'erklaervideo', edges: [{ from: 'n0', to: 'n1' }, { from: 'n1', to: 'n3' }, { from: 'n3', to: 'n4' }] };
    const { calls, spec, r } = await draw([top, top]);
    assert.equal(r.ok, true);
    assert.equal(calls, 2);
    assert.equal(spec.nodes.length, 5);
    assert.ok(connected(spec));
  });
});
