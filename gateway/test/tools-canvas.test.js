import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv();
const { TOOL_DEFS, BRIDGE_TOOLS, runTool, statusText, resolveToolName } = await import('../src/tools.js');
const { Limits } = await import('../src/limits.js');
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator } = await import('../src/illustrator.js');

const fakeHub = (handlers = {}) => ({ calls: [], async call(method, params) { this.calls.push([method, params]); return handlers[method]?.(params) ?? {}; } });
function canvasCtx(hub = fakeHub()) {
  const bus = createCanvasBus();
  const illustrator = createIllustrator({ bus, hub, complete: async () => ({ message: { content: '', tool_calls: [] }, costUsd: 0 }), audit: () => {} });
  return { ctx: { hub, page: null, audit: () => {}, limits: new Limits(), canvas: createCanvasSession({ bus, illustrator, by: 'text', ctx: {} }) }, bus };
}

describe('canvas tool definitions', () => {
  const def = (name) => TOOL_DEFS.find((t) => t.name === name);
  it('canvas_render declares nested arrays/objects/numbers; canvas_draw is async and takes request/kind/id', () => {
    const p = def('canvas_render').parameters;
    assert.deepEqual(p.required, ['kind', 'title']);
    assert.equal(p.properties.nodes.items.type, 'object');
    assert.equal(p.properties.items.items.properties.value.type, 'number');
    assert.equal(p.properties.series.items.properties.points.items.properties.y.type, 'number');
    assert.equal(p.properties.rows.items.items.type, 'string');
    assert.deepEqual(p.properties.kind.enum.length, 10);
    assert.equal(def('canvas_draw').async, true);
    assert.deepEqual(def('canvas_draw').parameters.required, ['request']);
  });
  it('ledger_spend / code_outline map to the bridge methods with exactly their arguments', () => {
    assert.deepEqual(BRIDGE_TOOLS.ledger_spend[0], 'ledger.entries');
    assert.deepEqual(BRIDGE_TOOLS.ledger_spend[1]({ from: '2026-10-01', to: '2026-10-24', groupBy: 'category', kgOnly: true }), { from: '2026-10-01', to: '2026-10-24', groupBy: 'category', kgOnly: true });
    assert.deepEqual(BRIDGE_TOOLS.code_outline, ['code.outline', BRIDGE_TOOLS.code_outline[1]]);
    assert.deepEqual(BRIDGE_TOOLS.code_outline[1]({ path: '/x' }), { path: '/x' });
    assert.deepEqual(def('ledger_spend').parameters.properties.groupBy.enum, ['counterparty', 'category', 'month']);
  });
  it('near-miss names resolve to the canvas tools', () => {
    assert.equal(resolveToolName('canvas_rendr'), 'canvas_render');
    assert.equal(resolveToolName('canvas_draws'), 'canvas_draw');
    assert.equal(resolveToolName('ledger_spnd'), 'ledger_spend');
  });
});

describe('status lines', () => {
  it('German "I am doing X" lines for the new tools', () => {
    assert.equal(statusText('canvas_draw', { request: 'x' }), 'Ich zeichne dir das auf …');
    assert.equal(statusText('canvas_render', {}), 'Ich zeichne dir das auf …');
    assert.equal(statusText('ledger_spend', {}), 'Ich hole die Zahlen aus dem Ledger …');
    assert.equal(statusText('code_outline', { path: '/x' }), 'Ich schaue mir den Code an …');
  });
});

describe('validate() with nested arguments', () => {
  const render = (args) => runTool('canvas_render', args, canvasCtx().ctx);
  const good = { kind: 'bar', title: 'Kosten', items: [{ label: 'A', value: 3 }, { label: 'B', value: 4 }] };

  it('accepts a valid nested call and shows it', async () => {
    const r = await render(good);
    assert.equal(r.ok, true, r.content);
    assert.equal(JSON.parse(r.content).shown, true);
  });
  it('a number given as "165,00 €" passes validate and is parsed by the canvas validator', async () => {
    const { ctx, bus } = canvasCtx();
    const r = await runTool('canvas_render', { ...good, items: [{ label: 'A', value: '165,00 €' }, { label: 'B', value: 2 }] }, ctx);
    assert.equal(r.ok, true, r.content);
    assert.equal(bus.latest()[0].spec.items[0].value, 165);
  });
  it('numbers inside strings fields are stringified (a model wrote 5 for a label)', async () => {
    const { ctx, bus } = canvasCtx();
    const r = await runTool('canvas_render', { kind: 'table', title: 'T', columns: ['A', 'B'], rows: [[1, 2], ['x', 3]] }, ctx);
    assert.equal(r.ok, true, r.content);
    assert.deepEqual(bus.latest()[0].spec.rows, [['1', '2'], ['x', '3']]);
  });
  it('wrong shapes are errors naming the path', async () => {
    for (const [args, re] of [
      [{ ...good, items: 'x' }, /items must be an array/],
      [{ ...good, items: [5] }, /items\[0\] must be an object/],
      [{ ...good, items: [{ label: 'A' }] }, /items\[0\]\.value is missing/],
      [{ ...good, items: [{ label: { a: 1 }, value: 1 }] }, /items\[0\]\.label must be a string/],
      [{ ...good, sources: {} }, /sources must be an array/],
      [{ ...good, kind: 'radar' }, /kind must be one of/],
      [{ ...good, title: undefined }, /missing argument: title/],
      [{ ...good, title: 7 }, /title must be a string/],
    ]) {
      const r = await render(args);
      assert.equal(r.ok, false);
      assert.match(r.content, re);
    }
  });
  it('unknown top-level arguments are dropped, unknown nested fields survive to the canvas validator (which drops them)', async () => {
    const { ctx, bus } = canvasCtx();
    const r = await runTool('canvas_render', { ...good, sneaky: 1, items: [{ label: 'A', value: 1, onclick: 'x' }, { label: 'B', value: 2 }] }, ctx);
    assert.equal(r.ok, true);
    assert.ok(!('onclick' in bus.latest()[0].spec.items[0]));
  });
  it('arrays are bounded before they are walked (a model looping 10k items)', async () => {
    const r = await render({ ...good, items: Array.from({ length: 10_000 }, (_, i) => ({ label: `i${i}`, value: i })) });
    assert.equal(r.ok, true);
  });
  it('canvas tools without a canvas in the context fail cleanly', async () => {
    const r = await runTool('canvas_draw', { request: 'x' }, { hub: fakeHub(), page: null, audit: () => {} });
    assert.equal(r.ok, false);
    assert.match(r.content, /canvas is not available/);
  });
  it('canvas_draw: empty request is an error; valid call returns zeichne at once', async () => {
    const { ctx } = canvasCtx();
    assert.equal((await runTool('canvas_draw', { request: '  ' }, ctx)).ok, false);
    const r = await runTool('canvas_draw', { request: 'Flussdiagramm vom Versand', kind: 'flow' }, ctx);
    assert.deepEqual(JSON.parse(r.content), { ok: true, id: 'flussdiagramm-vom-versand', status: 'zeichne' });
    ctx.canvas.cancelAll();
  });
});

describe('ledger_spend / code_outline results', () => {
  const LEDGER = {
    entries: Array.from({ length: 200 }, (_, i) => ({ date: '2026-10-01', amount: i, currency: 'USD', eurApprox: i * 0.9, counterparty: 'OpenAI', purpose: `Aufladung ${i}`, category: 'LLM-APIs', kg: true })),
    totals: [{ key: 'LLM-APIs', currency: 'USD', sum: 19900, count: 200 }],
    totalsEurApprox: [{ key: 'LLM-APIs', sumEur: 17910, count: 200 }],
    fxNote: 'USD→EUR 0.9', source: { kind: 'board', ref: 'Board #22 · Eintrag 25697', asOf: '2026-10-24' }, unparsed: 0,
  };
  it('the totals survive the size cap (header first), entries are cut with a note', async () => {
    const hub = fakeHub({ 'ledger.entries': () => LEDGER });
    const out = await runTool('ledger_spend', { groupBy: 'category', kgOnly: true }, { ...canvasCtx(hub).ctx, maxChars: 2500 });
    assert.equal(out.ok, true);
    assert.ok(out.content.length <= 2500);
    const [header, body] = out.content.split('\n---\n');
    assert.deepEqual(JSON.parse(header).totalsEurApprox, [{ key: 'LLM-APIs', sumEur: 17910, count: 200 }]);
    assert.equal(JSON.parse(header).entryCount, 200);
    assert.match(body, /weitere Einträge nicht gezeigt, Summen oben sind vollständig/);
    assert.deepEqual(hub.calls[0], ['ledger.entries', { from: undefined, to: undefined, groupBy: 'category', kgOnly: true }]);
  });
  it('code_outline: one line per file; docs and imports are dropped step by step to fit', async () => {
    const files = Array.from({ length: 60 }, (_, i) => ({ path: `src/file${i}.js`, lines: 100 + i, lang: 'js', doc: `Doc ${'d'.repeat(150)}`, imports: ['./a.js', './b.js'] }));
    const hub = fakeHub({ 'code.outline': () => ({ root: '/x/src', files, truncated: false }) });
    const small = await runTool('code_outline', { path: '/x/src' }, { ...canvasCtx(hub).ctx, maxChars: 2500 });
    assert.ok(small.content.length <= 2500);
    assert.match(small.content, /src\/file0\.js \(100 Z\.\)/);
    assert.match(small.content, /src\/file59\.js/);
    const big = await runTool('code_outline', { path: '/x/src' }, { ...canvasCtx(hub).ctx, maxChars: 20_000 });
    assert.match(big.content, /file0\.js \(100 Z\.\) – Doc d+ → \.\/a\.js, \.\/b\.js/);
  });
  it('a bridge without the methods yields a clean error for the model', async () => {
    const hub = { async call() { throw new Error('unknown method'); } };
    const out = await runTool('ledger_spend', {}, canvasCtx(hub).ctx);
    assert.equal(out.ok, false);
    assert.match(out.content, /unknown method/);
  });
});

describe('safety nets', () => {
  it('secrets in a model-written spec are redacted before they reach the browser', async () => {
    const { normalizeCanvas } = await import('../src/canvas.js');
    const r = normalizeCanvas({ kind: 'table', title: 'Key sk-abcdefghijklmnopqrstuvwxyz0123', columns: ['A'], rows: [['token: abcdefghijklmnop']] });
    assert.equal(r.ok, true);
    assert.ok(!JSON.stringify(r.spec).includes('abcdefghijklmnopqrstuvwxyz'));
    assert.ok(!JSON.stringify(r.spec).includes('abcdefghijklmnop"'));
    assert.match(r.spec.title, /\[REDACTED\]/);
  });

  it('drawing stops when the daily cost cap is reached (explicit: error for the model; automatic: silently skipped)', async () => {
    const { Limits } = await import('../src/limits.js');
    const limits = new Limits();
    limits.addCost(1000);
    const bus = createCanvasBus();
    let calls = 0;
    const illustrator = createIllustrator({ bus, hub: {}, complete: async () => { calls += 1; return { message: { content: '', tool_calls: [] }, costUsd: 0 }; }, audit: () => {} });
    const session = createCanvasSession({ bus, illustrator, by: 'text', ctx: { limits, sid: 's' }, debounceMs: () => 5 });
    assert.throws(() => session.draw({ request: 'Zeichne etwas' }), /daily cost limit/);
    session.noteTurn({ role: 'user', text: 'Wie funktioniert das?' });
    session.autoTurn({ answerText: 'Eins ist so. Zwei ist so. Drei ist so.' });
    await session.idle();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 0);
    assert.equal(bus.replay(0).length, 0);
  });

  it('the Activity VizSpec generator is off unless DESK_ACTIVITY_VIZ=1', async () => {
    const { createActivityViz } = await import('../src/viz.js');
    const noModelCalls = { emit() {}, complete: async () => { throw new Error('model call'); } };
    delete process.env.DESK_ACTIVITY_VIZ;
    const off = createActivityViz(noModelCalls);
    off.noteTurn({ role: 'user', text: 'x' });
    off.noteEvent({ type: 'tool', status: 'start', name: 'list_jobs' });
    off.close();
    process.env.DESK_ACTIVITY_VIZ = '1';
    try {
      const on = createActivityViz({ ...noModelCalls, debounceMs: 1_000_000 });
      assert.notEqual(on, off);
      on.close();
    } finally {
      delete process.env.DESK_ACTIVITY_VIZ;
    }
  });
});
