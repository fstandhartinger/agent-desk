// Upgrades 28 Oct (docs/UPGRADES-1028.md §5): simple diagrams by default, the full version as `detail`. Simple limits per
// kind, detail validation, the deterministic simplifier, the illustrator's one repair, canvas_render. Synthetic data only.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_EARLY: '0', DESK_CANVAS_TIMEOUT_MS: '800' });
const { normalizeCanvas, simpleError, simplifySpec, ensureSimple, detailSpec, attachDetail, SIMPLE } = await import('../src/canvas.js');
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator, infoCount, shrinks } = await import('../src/illustrator.js');
const { TOOL_DEFS } = await import('../src/tools.js');
const { canvasLines } = await import('../src/prompt.js');

const src = [{ label: 'Gespräch', ref: 'Gespräch' }];
const node = (id, label = id.toUpperCase(), extra = {}) => ({ id, label, ...extra });
const chain = (n, extra = {}) => ({ kind: 'flow', title: 'Ablauf', sources: src, nodes: Array.from({ length: n }, (_, i) => node(`n${i}`, `Schritt ${i + 1}`)), edges: Array.from({ length: Math.max(0, n - 1) }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })), ...extra });
const ok = (spec) => { const r = normalizeCanvas(spec); assert.equal(r.ok, true, r.error); return r.spec; };
const gate = (spec) => normalizeCanvas(spec, { gate: true });

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

// a synthetic desk architecture (10 boxes, 4 groups), a payout flow with a decision, a deployment pipeline
const ARCH = {
  kind: 'architecture', title: 'Aufbau vom Demo-Desk', highlight: 'gateway', sources: src,
  groups: [{ id: 'browser', label: 'Browser' }, { id: 'server', label: 'Server' }, { id: 'werkstatt', label: 'Werkstatt' }, { id: 'anbieter', label: 'Anbieter' }],
  nodes: [node('web', 'Web-App', { group: 'browser' }), node('canvas', 'Canvas', { group: 'browser' }), node('gateway', 'Gateway', { group: 'server' }), node('zeichner', 'Zeichnerin', { group: 'server' }), node('relay', 'Voice-Relay', { group: 'server' }), node('bridge', 'Bridge', { group: 'werkstatt' }), node('sessions', 'Code-Sessions', { group: 'werkstatt' }), node('ledger', 'Ledger', { group: 'werkstatt' }), node('voice', 'Voice-Anbieter', { group: 'anbieter' }), node('llm', 'Sprachmodell', { group: 'anbieter' })],
  edges: [{ from: 'web', to: 'gateway', label: 'HTTPS und WebSocket' }, { from: 'canvas', to: 'gateway' }, { from: 'gateway', to: 'zeichner' }, { from: 'gateway', to: 'relay' }, { from: 'gateway', to: 'bridge', label: 'WS' }, { from: 'bridge', to: 'sessions' }, { from: 'bridge', to: 'ledger' }, { from: 'relay', to: 'voice' }, { from: 'zeichner', to: 'llm' }],
};
const PAYOUT = {
  kind: 'flow', title: 'Wie eine Auszahlung läuft', highlight: 'check', sources: src,
  nodes: [node('antrag', 'Antrag'), node('pruefung', 'Belege prüfen', { detail: 'Rechnung und Betrag' }), node('check', 'Freigabe?', { shape: 'diamond' }), node('rueckfrage', 'Rückfrage an Antragsteller'), node('bank', 'Überweisung'), node('buchung', 'Buchung'), node('beleg', 'Beleg ablegen'), node('fertig', 'Erledigt', { tone: 'moss' })],
  edges: [{ from: 'antrag', to: 'pruefung' }, { from: 'pruefung', to: 'check' }, { from: 'check', to: 'bank', label: 'ja' }, { from: 'check', to: 'rueckfrage', label: 'nein, Beleg fehlt noch' }, { from: 'rueckfrage', to: 'pruefung' }, { from: 'bank', to: 'buchung' }, { from: 'buchung', to: 'beleg' }, { from: 'beleg', to: 'fertig' }],
};

describe('simple limits per kind (§5)', () => {
  it('flow / architecture: <= 5 boxes, <= 6 arrows, one fork and one merge at most', () => {
    assert.equal(simpleError(ok(chain(5))), undefined);
    assert.match(simpleError(ok(chain(6))), /6 boxes \(max 5\).*detail/);
    const star = ok({ ...chain(5), edges: [1, 2, 3, 4].map((i) => ({ from: 'n0', to: `n${i}` })) });
    assert.equal(simpleError(star), undefined, 'one hub fanning out is one branch');
    const twoForks = ok({ ...chain(5), edges: [{ from: 'n0', to: 'n1' }, { from: 'n0', to: 'n2' }, { from: 'n1', to: 'n3' }, { from: 'n1', to: 'n4' }] });
    assert.match(simpleError(twoForks), /branches too much/);
    const dense = ok({ ...chain(5), edges: [...chain(5).edges, { from: 'n0', to: 'n2' }, { from: 'n1', to: 'n3' }, { from: 'n2', to: 'n4' }] });
    assert.match(simpleError(dense), /7 arrows \(max 6\)/);
  });

  it('sequence, timeline, pie / bar, table', () => {
    const seq = (actors, messages) => ok({ kind: 'sequence', title: 'Ablauf', sources: src, actors: Array.from({ length: actors }, (_, i) => ({ id: `a${i}`, label: `A${i}` })), messages: Array.from({ length: messages }, (_, i) => ({ from: `a${i % actors}`, to: `a${(i + 1) % actors}`, label: `m${i}` })) });
    assert.equal(simpleError(seq(5, 6)), undefined);
    assert.match(simpleError(seq(6, 6)), /6 actors/);
    assert.match(simpleError(seq(3, 7)), /7 messages/);
    const tl = (n) => ok({ kind: 'timeline', title: 'Verlauf', sources: src, events: Array.from({ length: n }, (_, i) => ({ date: `2026-10-${10 + i}`, label: `E${i}` })) });
    assert.equal(simpleError(tl(5)), undefined);
    assert.match(simpleError(tl(6)), /6 events/);
    const items = (kind, n) => ok({ kind, title: 'Anteile', sources: src, items: Array.from({ length: n }, (_, i) => ({ label: `L${i}`, value: i + 1 })) });
    assert.equal(simpleError(items('pie', 6)), undefined);
    assert.match(simpleError(items('pie', 7)), /7 items/);
    assert.match(simpleError(items('bar', 8)), /8 items/);
    const table = (n) => ok({ kind: 'table', title: 'Jobs', sources: src, columns: ['Job', 'Stand'], rows: Array.from({ length: n }, (_, i) => [`job-${i}`, 'läuft']) });
    assert.equal(simpleError(table(5)), undefined);
    assert.match(simpleError(table(6)), /6 rows/);
  });

  it('line, sankey and custom_svg have no simple limit', () => {
    const line = ok({ kind: 'line', title: 'Verlauf', sources: src, series: [{ name: 'a', points: Array.from({ length: 30 }, (_, i) => ({ x: `d${i}`, y: i })) }] });
    assert.equal(simpleError(line), undefined);
    assert.equal(ensureSimple(line).simplified, false);
  });
});

describe('detail validation', () => {
  it('keeps a valid detail (same kind, own limits) and exposes it as a full spec with the shared ids', () => {
    const spec = ok({ ...chain(4), id: 'ablauf', detail: { ...chain(9), title: 'Ablauf im Detail' } });
    assert.equal(spec.detail.kind, 'flow');
    assert.equal(spec.detail.nodes.length, 9);
    assert.equal(spec.detail.title, 'Ablauf im Detail');
    const full = detailSpec(spec);
    assert.equal(full.id, 'ablauf');
    assert.deepEqual(full.sources, spec.sources);
    assert.deepEqual(spec.nodes.map((n) => n.id), full.nodes.slice(0, 4).map((n) => n.id));
    assert.equal(detailSpec(ok(chain(4))), null);
  });

  it('rejects another kind and a broken detail with a "detail:" error a model can act on', () => {
    assert.match(normalizeCanvas({ ...chain(4), detail: { kind: 'pie', items: [{ label: 'a', value: 1 }] } }).error, /detail\.kind must be "flow"/);
    assert.match(normalizeCanvas({ ...chain(4), detail: { nodes: [node('a')], edges: [{ from: 'a', to: 'ghost' }] } }).error, /^detail: edges\[0\]\.to: unknown node "ghost"/);
    assert.match(normalizeCanvas({ ...chain(4), detail: 'mehr' }).error, /detail must be an object/);
    assert.match(gate({ ...chain(4), detail: { ...chain(8), nodes: chain(8).nodes.map((n, i) => (i === 2 ? { ...n, label: 'Platzhalter' } : n)) } }).error, /^detail: nodes\[2\]\.label is a placeholder/);
  });

  it('applies the existing limits to the detail and drops a detail that repeats the simple view', () => {
    const big = ok({ ...chain(4), detail: chain(30) });
    assert.equal(big.detail.nodes.length, 24);
    assert.equal(ok({ ...chain(4), detail: chain(4) }).detail, undefined);
  });
});

describe('deterministic simplifier', () => {
  const check = (spec, original) => {
    assert.ok(spec.nodes.length <= SIMPLE.nodes, `${spec.nodes.length} nodes`);
    assert.ok(spec.edges.length <= SIMPLE.edges);
    assert.equal(simpleError(spec), undefined);
    assert.ok(connected(spec), 'connected');
    const ids = new Set(original.nodes.map((n) => n.id));
    for (const n of spec.nodes) assert.ok(ids.has(n.id), `kept id ${n.id}`);
    for (const n of spec.nodes) assert.ok(n.label.length <= SIMPLE.label && !n.detail);
    for (const e of spec.edges) assert.ok(!e.label || e.label.split(/\s+/).length <= SIMPLE.edgeWords);
    assert.deepEqual(detailSpec(spec).nodes, original.nodes, 'the original is the detail');
    assert.equal(gate(spec).ok, true, gate(spec).error);
  };

  it('architecture: the main path through the highlight, groups only with 2+ kept boxes, original as detail', () => {
    const original = ok(ARCH);
    const simple = simplifySpec(original);
    check(simple, original);
    assert.ok(simple.nodes.some((n) => n.id === 'gateway'), 'the highlight stays');
    assert.equal(simple.highlight, 'gateway');
    for (const g of simple.groups ?? []) assert.ok(simple.nodes.filter((n) => n.group === g.id).length >= 2);
    assert.equal(simple.edges.find((e) => e.from === 'web')?.label, undefined, 'a 3-word edge label is not cut into nonsense');
  });

  it('payout flow with a loop: highlight-centred, long path collapsed with a dashed arrow', () => {
    const original = ok(PAYOUT);
    const simple = simplifySpec(original);
    check(simple, original);
    assert.ok(simple.nodes.some((n) => n.id === 'check'));
    assert.equal(simple.nodes[0].id, 'antrag');
    assert.ok(simple.nodes.some((n) => n.id === 'fertig'), 'the end of the main path stays');
    assert.ok(simple.edges.some((e) => e.style === 'dashed'), 'a collapsed stretch is dashed');
  });

  it('many generated graphs: always <= 5 connected boxes, ids kept, deterministic', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let t = 0; t < 60; t += 1) {
      const n = 6 + Math.floor(rnd() * 12);
      const nodes = Array.from({ length: n }, (_, i) => node(`k${i}`, `Knoten Nummer ${i} mit langem Namen`));
      const edges = [];
      for (let i = 1; i < n; i += 1) edges.push({ from: `k${Math.floor(rnd() * i)}`, to: `k${i}`, label: rnd() < 0.3 ? 'ja' : undefined }); // a tree
      for (let k = 0; k < 4; k += 1) { const a = Math.floor(rnd() * n); const b = Math.floor(rnd() * n); if (a !== b) edges.push({ from: `k${a}`, to: `k${b}` }); }
      const original = ok({ kind: 'flow', title: 'Zufall', sources: src, nodes, edges, highlight: rnd() < 0.5 ? `k${Math.floor(rnd() * n)}` : undefined });
      const simple = simplifySpec(original);
      check(simple, original);
      assert.deepEqual(simplifySpec(original), simple);
    }
  });

  it('pie folds the tail into "Sonstige" (the total stays exact), bar keeps the 6 largest, table the first 5 rows', () => {
    const pie = ok({ kind: 'pie', title: 'Ausgaben', sources: src, unit: 'EUR', items: [10, 50, 5, 30, 2.5, 7, 1.25, 20].map((value, i) => ({ label: `Posten ${i}`, value })) });
    const p = simplifySpec(pie);
    assert.equal(p.items.length, 6);
    assert.equal(p.items.reduce((s, i) => s + i.value, 0), pie.items.reduce((s, i) => s + i.value, 0));
    assert.equal(p.items.at(-1).label, 'Sonstige (3)');
    assert.equal(p.detail.items.length, 8);
    const bar = simplifySpec({ ...pie, kind: 'bar' });
    assert.deepEqual(bar.items.map((i) => i.value), [10, 50, 5, 30, 7, 20]); // the 6 largest, in their own order
    const table = simplifySpec(ok({ kind: 'table', title: 'Jobs', sources: src, columns: ['Job', 'Stand'], rows: Array.from({ length: 9 }, (_, i) => [`job-${i}`, 'läuft']) }));
    assert.equal(table.rows.length, 5);
    assert.equal(table.detail.rows.length, 9);
  });

  it('sequence and timeline keep first and last, notes / details go to the detail', () => {
    const seq = ok({ kind: 'sequence', title: 'Wer ruft wen', sources: src, actors: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, label: id.toUpperCase() })), messages: Array.from({ length: 12 }, (_, i) => ({ from: ['a', 'b', 'c'][i % 3], to: ['b', 'c', 'd', 'e', 'f', 'g'][i % 6], label: `Schritt ${i}`, note: 'mehr' })) });
    const s = simplifySpec(seq);
    assert.ok(s.actors.length <= 5 && s.messages.length <= 6 && s.messages.every((m) => !m.note));
    assert.equal(simpleError(s), undefined);
    const tl = ok({ kind: 'timeline', title: 'Verlauf', highlight: 'E4', sources: src, events: Array.from({ length: 12 }, (_, i) => ({ date: `2026-10-${10 + i}`, label: `E${i}`, detail: 'mehr' })) });
    const t = simplifySpec(tl);
    assert.deepEqual(t.events.map((e) => e.label).filter((l) => ['E0', 'E4', 'E11'].includes(l)), ['E0', 'E4', 'E11']);
    assert.equal(t.events.length, 5);
  });

  it('ensureSimple: a fitting spec is untouched; only cosmetic overflow keeps every box and moves the full text to detail', () => {
    const fits = ok(chain(4));
    assert.deepEqual(ensureSimple(fits), { spec: fits, simplified: false });
    const wordy = ok({ ...chain(4), nodes: chain(4).nodes.map((n, i) => (i === 1 ? { ...n, label: 'Belege und Rechnungen gründlich prüfen', detail: 'mehr dazu' } : n)) });
    const { spec, simplified } = ensureSimple(wordy);
    assert.equal(simplified, true);
    assert.equal(spec.nodes.length, 4);
    assert.ok(spec.nodes[1].label.length <= SIMPLE.label && !spec.nodes[1].detail);
    assert.equal(spec.detail.nodes[1].label, 'Belege und Rechnungen gründlich prüfen');
  });

  it('a spec that already has a detail keeps it when its simple view is simplified', () => {
    const spec = ok({ ...chain(7), detail: chain(12) });
    const simple = ensureSimple(spec).spec;
    assert.ok(simple.nodes.length <= 5);
    assert.equal(simple.detail.nodes.length, 12);
  });

  it('attachDetail merges sources and drops a detail equal to the simple body', () => {
    const top = ok({ ...chain(4), sources: [{ label: 'a', ref: '/a' }] });
    const full = ok({ ...chain(8), sources: [{ label: 'b', ref: '/b' }] });
    const both = attachDetail(top, full);
    assert.deepEqual(both.sources.map((s) => s.ref), ['/a', '/b']);
    assert.equal(attachDetail(top, top).detail, undefined);
  });

  it('refinement bookkeeping counts the detail: simple + detail is no shrink of the full drawing', () => {
    const full = ok(chain(9));
    const simple = simplifySpec(full);
    assert.equal(infoCount(simple), 9);
    assert.equal(shrinks(full, simple), false);
  });
});

const answer = (spec) => ({ message: { content: JSON.stringify(spec), tool_calls: [] }, costUsd: 0.001 });

describe('illustrator: one model call, one repair only when the simple view is too big', () => {
  let bus;
  let audits;
  beforeEach(() => { bus = createCanvasBus(); audits = []; });
  const memory = { noteTool() {}, toolsUsed: () => [], snapshot: () => ({ turns: [{ role: 'user', text: 'Erklär mir den Ablauf' }], facts: '' }), turnTexts: () => [], lastUser: () => '', userTurns: () => [] };
  const draw = async (script) => {
    let calls = 0;
    const ill = createIllustrator({ bus, hub: {}, complete: async () => { calls += 1; return answer(script.shift()); }, run: async () => ({ ok: true, content: '' }), audit: (a) => audits.push(a) });
    const r = await ill.draw({ id: 'ablauf', request: 'Erklär mir den Ablauf', by: 'text', publish: (p) => bus.publish(p), memory });
    return { r, calls, spec: bus.latest()[0]?.spec };
  };

  it('simple + detail in one JSON: one call, published as is', async () => {
    const { calls, spec } = await draw([{ ...chain(4), detail: chain(10) }]);
    assert.equal(calls, 1);
    assert.equal(spec.nodes.length, 4);
    assert.equal(spec.detail.nodes.length, 10);
    assert.ok(!audits.some((a) => a.action === 'canvas.repair'));
  });

  it('a simple topic: one call, no detail', async () => {
    const { calls, spec } = await draw([chain(4)]);
    assert.equal(calls, 1);
    assert.equal(spec.detail, undefined);
  });

  it('a 10-box top level -> one repair that moves the extra into detail', async () => {
    const { calls, spec } = await draw([chain(10), { ...chain(4), detail: chain(10) }]);
    assert.equal(calls, 2);
    assert.ok(audits.some((a) => a.action === 'canvas.repair' && /10 boxes \(max 5\)/.test(a.detail)));
    assert.equal(spec.nodes.length, 4);
    assert.equal(spec.detail.nodes.length, 10);
  });

  it('the repair is too big again -> the deterministic simple view, the model\'s version as detail; never a third call', async () => {
    const { calls, spec, r } = await draw([chain(10), chain(11)]);
    assert.equal(calls, 2);
    assert.equal(r.ok, true);
    assert.ok(spec.nodes.length <= 5 && connected(spec));
    assert.equal(spec.detail.nodes.length, 11);
    assert.ok(audits.some((a) => a.action === 'canvas.repair.fallback'));
  });

  it('a broken detail never costs the simple drawing', async () => {
    const broken = { ...chain(4), detail: { nodes: [node('a')], edges: [{ from: 'a', to: 'ghost' }] } };
    const { spec, r } = await draw([broken, broken]);
    assert.equal(r.ok, true);
    assert.equal(spec.nodes.length, 4);
    assert.equal(spec.detail, undefined);
  });
});

describe('canvas_render (voice / text agents) goes through the same simple path', () => {
  const session = (bus, audits) => {
    const ill = createIllustrator({ bus, hub: {}, complete: async () => answer(chain(4)), run: async () => ({ ok: true, content: '' }), audit: () => {} });
    return createCanvasSession({ bus, illustrator: ill, by: 'voice', provider: 'xai', emit: () => {}, ctx: {}, audit: (a) => audits.push(a), debounceMs: () => 30, researchMs: () => 5000 });
  };

  it('an 8-box render is shown simple at once, the agent\'s version as detail', () => {
    const bus = createCanvasBus();
    const audits = [];
    const s = session(bus, audits);
    const { v, ...body } = ok({ ...PAYOUT, id: 'auszahlung' });
    const r = s.render(body);
    assert.equal(r.ok, true);
    const spec = bus.latest()[0].spec;
    assert.ok(spec.nodes.length <= 5);
    assert.equal(spec.detail.nodes.length, 8);
    assert.ok(audits.some((a) => a.action === 'canvas.simplified'));
  });

  it('a render with simple + detail is kept; a broken detail is dropped, the simple drawing still shows', () => {
    const bus = createCanvasBus();
    const s = session(bus, []);
    s.render({ ...chain(4), id: 'mit-detail', detail: chain(9) });
    assert.equal(bus.latest().find((e) => e.id === 'mit-detail').spec.detail.nodes.length, 9);
    s.render({ ...chain(4), id: 'kaputt', detail: { nodes: [node('a')], edges: [{ from: 'a', to: 'ghost' }] } });
    const kaputt = bus.latest().find((e) => e.id === 'kaputt').spec;
    assert.equal(kaputt.nodes.length, 4);
    assert.equal(kaputt.detail, undefined);
  });
});

describe('prompts and tool schema', () => {
  it('canvas_render accepts a nested detail; the prompts name the simple rule', () => {
    const render = TOOL_DEFS.find((t) => t.name === 'canvas_render');
    assert.equal(render.parameters.properties.detail.type, 'object');
    assert.ok(render.parameters.properties.detail.properties.nodes);
    assert.equal(render.parameters.properties.detail.properties.kind, undefined);
    assert.ok(canvasLines().some((l) => /höchstens 5 Kästen/.test(l) && /Details/.test(l)));
  });
});

describe('P2-5 (critic round 1): detail only when it adds something', async () => {
  const { normalizeCanvas, attachDetail, detailAdds } = await import('../src/canvas.js');
  const nodes = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Schritt ${i}`, ...extra }));
  const edges = (n) => Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
  const base = { v: 2, id: 'probe', kind: 'flow', title: 'Ablauf', caption: 'Drei Schritte.', sources: [{ label: 'Gespräch', ref: 'Gespräch' }], nodes: nodes(4), edges: edges(4) };

  it('same boxes with only node notes / edge labels → no detail (live: 5 of 20 canvases)', () => {
    const r = normalizeCanvas({ ...base, detail: { kind: 'flow', nodes: nodes(4, { detail: 'Notiz' }), edges: edges(4).map((e) => ({ ...e, label: 'dann' })) } });
    assert.equal(r.ok, true);
    assert.equal(r.spec.detail, undefined);
  });
  it('more boxes / arrows → the detail stays', () => {
    const r = normalizeCanvas({ ...base, detail: { kind: 'flow', nodes: nodes(7), edges: edges(7) } });
    assert.equal(r.spec.detail.nodes.length, 7);
  });
  it('attachDetail drops a detail that adds nothing, keeps one with more items', () => {
    const top = normalizeCanvas(base).spec;
    assert.equal(attachDetail(top, normalizeCanvas({ ...base, nodes: nodes(4, { detail: 'mehr Text' }) }).spec).detail, undefined);
    assert.ok(attachDetail(top, normalizeCanvas({ ...base, nodes: nodes(6), edges: edges(6) }).spec).detail);
  });
  it('a label the simple view had to cut keeps its full text behind Details', () => {
    assert.equal(detailAdds('flow', { nodes: [{ id: 'a', label: 'Sehr langer Schrittname …' }] }, { nodes: [{ id: 'a', label: 'Sehr langer Schrittname mit vollem Text' }] }), true);
    assert.equal(detailAdds('pie', { items: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] }, { items: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }, { label: 'C', value: 3 }] }), true);
    assert.equal(detailAdds('table', { columns: ['a'], rows: [['1']] }, { columns: ['a'], rows: [['1']] }), false);
  });
});
