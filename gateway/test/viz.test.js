import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVizGenerator, validateSpec, parseJSON, describeEvent, buildMessages } from '../src/viz.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const good = { v: 1, title: 'Stand', caption: 'Ein Satz.', focus: 'b', nodes: [{ id: 'a', label: 'Agent', kind: 'agent', tone: 'violet' }, { id: 'b', label: 'Job', kind: 'job', tone: 'papaya' }], edges: [{ from: 'a', to: 'b', style: 'flow' }] };

test('validateSpec clamps sizes, drops bad edges and unknown enums', () => {
  const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `N ${i}`, label: 'x'.repeat(50), kind: 'alien', tone: 'pink', value: 'v'.repeat(30) }));
  const edges = [
    { from: 'n-0', to: 'n-1', style: 'zigzag', label: 'l'.repeat(40) },
    { from: 'n-0', to: 'n-1' }, // duplicate
    { from: 'n-0', to: 'n-0' }, // self loop
    { from: 'n-0', to: 'ghost' }, // dangling
  ];
  const s = validateSpec({ title: 'T', nodes, edges, focus: 'nope', steps: [{ label: 'a', state: 'weird' }] });
  assert.equal(s.nodes.length, 12);
  assert.equal(s.nodes[0].id, 'n-0');
  assert.equal(s.nodes[0].kind, 'idea');
  assert.equal(s.nodes[0].tone, 'neutral');
  assert.ok(s.nodes[0].label.length <= 28 && s.nodes[0].label.endsWith('…'));
  assert.ok(s.nodes[0].value.length <= 16);
  assert.deepEqual(s.edges.map((e) => [e.from, e.to, e.style]), [['n-0', 'n-1', 'flow']]);
  assert.ok(s.edges[0].label.length <= 20);
  assert.equal(s.focus, undefined);
  assert.equal(s.steps, undefined); // only todo steps → no progress to show
});

test('validateSpec keeps progress steps and colours an all-neutral focus', () => {
  const s = validateSpec({
    title: 'T', focus: 'b',
    nodes: [{ id: 'a', label: 'A', tone: 'neutral' }, { id: 'b', label: 'B', tone: 'neutral' }],
    steps: [{ label: 'eins', state: 'done' }, { label: 'zwei', state: 'weird' }],
  });
  assert.deepEqual(s.steps, [{ label: 'eins', state: 'done' }, { label: 'zwei', state: 'todo' }]);
  assert.equal(s.nodes[1].tone, 'papaya');
  assert.equal(s.nodes[0].tone, 'neutral');
});

test('validateSpec rejects garbage and focuses the first new node when focus is missing', () => {
  assert.equal(validateSpec(null), null);
  assert.equal(validateSpec({ nodes: [] }), null);
  assert.equal(validateSpec({ nodes: [{ id: '', label: 'x' }] }), null);
  const prev = validateSpec(good);
  const next = validateSpec({ ...good, focus: undefined, nodes: [...good.nodes, { id: 'c', label: 'Neu', kind: 'file' }] }, prev);
  assert.equal(next.focus, 'c');
});

test('validateSpec drops nonsense nodes and placeholder fields (critic: a "false" number node)', () => {
  const s = validateSpec({
    title: 'null', caption: 'undefined', focus: 'jobs',
    nodes: [
      { id: 'jobs', label: 'Laufende Jobs', kind: 'job', tone: 'papaya', value: '7 aktiv' },
      { id: 'fd', label: 'finalDone', kind: 'number', tone: 'amber', value: 'false' },
      { id: 'n0', label: 'Fertig', kind: 'number', tone: 'moss', value: 0 },
      { id: 'b', label: false, kind: 'idea' },
      { id: 'c', label: 'null', kind: 'idea' },
      { id: 'd', label: ' – ', kind: 'idea' },
      { id: 'e', label: { text: 'x' }, kind: 'idea' },
      { id: 'f', label: 'Board', kind: 'board', value: 'N/A', group: 'undefined' },
      { id: 'g', label: 'Render-Queue', kind: 'risk', value: null },
    ],
    edges: [{ from: 'jobs', to: 'f', label: 'false' }, { from: 'jobs', to: 'g', label: 'blockiert' }, { from: 'jobs', to: 'fd' }],
    steps: [{ label: 'null', state: 'done' }, { label: 'Jobs abfragen', state: 'done' }],
  });
  assert.deepEqual(s.nodes.map((n) => n.id), ['jobs', 'n0', 'f', 'g']);
  assert.equal(s.nodes[1].value, '0'); // a real zero stays
  assert.equal(s.nodes[2].value, undefined);
  assert.equal(s.nodes[2].group, undefined);
  assert.equal(s.nodes[3].value, undefined);
  assert.deepEqual(s.edges, [{ from: 'jobs', to: 'f', style: 'flow' }, { from: 'jobs', to: 'g', style: 'flow', label: 'blockiert' }]);
  assert.equal(s.title, 'Laufende Jobs'); // junk title falls back
  assert.equal(s.caption, undefined);
  assert.deepEqual(s.steps, [{ label: 'Jobs abfragen', state: 'done' }]);
});

test('parseJSON tolerates fences and surrounding prose', () => {
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSON('sure: {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.equal(parseJSON('no json'), null);
  assert.equal(parseJSON('{broken'), null);
});

test('describeEvent covers Claude events; desk tools go through the ledger, not prose lines', () => {
  assert.equal(describeEvent({ type: 'tool', name: 'list_jobs', args: { activeOnly: true }, status: 'start' }), null);
  assert.match(describeEvent({ kind: 'tool_use', name: 'Edit', path: 'web/src/App.tsx' }), /Edit web\/src\/App.tsx/);
  assert.equal(describeEvent({ kind: 'text_delta', text: 'x' }), null);
});

test('buildMessages passes the previous spec for id stability', () => {
  const m = buildMessages({ turns: [{ role: 'user', text: 'Hallo' }], events: [], page: null, prev: good });
  const input = JSON.parse(m[1].content);
  assert.equal(input.previousSpec.nodes[0].id, 'a');
  assert.deepEqual(input.conversation, ['Florian: Hallo']);
});

test('generator debounces bursts into one call and emits a validated spec', async () => {
  const calls = [];
  const out = [];
  const g = createVizGenerator({
    emit: (m) => out.push(m), debounceMs: 30, model: 'm',
    complete: async (req) => { calls.push(req); return { json: good, costUsd: 0.0001 }; },
  });
  g.noteTurn({ role: 'user', text: 'Was läuft gerade?' });
  g.noteEvent({ type: 'tool', id: '1', name: 'list_jobs', status: 'start' });
  g.noteEvent({ type: 'tool', id: '1', name: 'list_jobs', status: 'done', summary: '2 Jobs' });
  await sleep(80);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'm');
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'viz');
  assert.equal(out[0].spec.focus, 'b');
  g.close();
});

test('only one call in flight; notes during a call coalesce into one follow-up with the previous spec', async () => {
  let active = 0;
  let maxActive = 0;
  const prevs = [];
  const g = createVizGenerator({
    emit: () => {}, debounceMs: 10,
    complete: async ({ messages }) => {
      active++; maxActive = Math.max(maxActive, active);
      prevs.push(JSON.parse(messages[1].content).previousSpec ?? null);
      await sleep(60);
      active--;
      return { json: good };
    },
  });
  g.noteTurn({ role: 'user', text: 'eins' });
  await sleep(25);
  g.noteTurn({ role: 'assistant', text: 'zwei' });
  g.noteTurn({ role: 'user', text: 'drei' });
  await sleep(200);
  assert.equal(maxActive, 1);
  assert.equal(prevs.length, 2);
  assert.equal(prevs[0], null);
  assert.equal(prevs[1].nodes[0].id, 'a');
  g.close();
});

test('failed or invalid answers keep the old spec and report the error', async () => {
  const out = [];
  const errors = [];
  let n = 0;
  const g = createVizGenerator({
    emit: (m) => out.push(m), debounceMs: 5, onError: (e) => errors.push(e.message),
    complete: async () => {
      n++;
      if (n === 1) return { json: good };
      if (n === 2) return { json: { nodes: 'nope' } };
      throw new Error('HTTP 500');
    },
  });
  g.noteTurn({ role: 'user', text: 'a' }); await sleep(30);
  g.noteTurn({ role: 'user', text: 'b' }); await sleep(30);
  g.noteTurn({ role: 'user', text: 'c' }); await sleep(30);
  assert.equal(n, 3);
  assert.equal(out.length, 1);
  assert.equal(g.spec.title, 'Stand');
  assert.deepEqual(errors, ['HTTP 500']);
  g.close();
});

test('close() stops pending work and drops late answers', async () => {
  const out = [];
  let called = 0;
  const g = createVizGenerator({ emit: (m) => out.push(m), debounceMs: 20, complete: async () => { called++; await sleep(30); return { json: good }; } });
  g.noteTurn({ role: 'user', text: 'x' });
  g.close();
  await sleep(60);
  assert.equal(called, 0);
  const h = createVizGenerator({ emit: (m) => out.push(m), debounceMs: 1, complete: async () => { called++; await sleep(30); return { json: good }; } });
  h.noteTurn({ role: 'user', text: 'x' });
  await sleep(10);
  h.close();
  await sleep(50);
  assert.equal(called, 1);
  assert.equal(out.length, 0);
});

test('activity alone does not trigger a call before the first turn', async () => {
  let called = 0;
  const g = createVizGenerator({ emit: () => {}, debounceMs: 1, complete: async () => { called++; return { json: good }; } });
  g.noteEvent({ type: 'tool', id: '1', name: 'x', status: 'start' });
  await sleep(20);
  assert.equal(called, 0);
  g.close();
});

const toolInput = (req) => JSON.parse(req.messages[1].content).tools;

test('start + done of the same tool id reach the model as one "fertig" entry, never "läuft" (critic D-new-2)', async () => {
  const calls = [];
  const g = createVizGenerator({ emit: () => {}, debounceMs: 20, complete: async (req) => { calls.push(req); return { json: good }; } });
  g.noteTurn({ role: 'user', text: 'Was hat Florian heute entschieden?' });
  g.noteEvent({ type: 'tool', id: 't1', name: 'decisions_recent', args: {}, status: 'start' });
  g.noteEvent({ type: 'tool', id: 't1', name: 'decisions_recent', args: {}, status: 'done', ms: 6, content: JSON.stringify({ entriesToday: 13, shown: 12, entries: [] }, null, 1) });
  await sleep(60);
  assert.equal(calls.length, 1);
  assert.deepEqual(toolInput(calls[0]), [{ tool: 'decisions_recent', was: 'Entscheidungen', status: 'fertig', ms: 6, fakten: { heute: 13, gezeigt: 12 } }]);
  assert.doesNotMatch(calls[0].messages[1].content, /läuft/);
  g.close();
});

const stale = { v: 1, title: 'Entscheidungen', caption: 'Die Abfrage läuft noch.', focus: 'q', nodes: [{ id: 'agent', label: 'Agent', kind: 'agent', tone: 'violet' }, { id: 'q', label: 'decisions_recent', kind: 'tool', tone: 'amber', value: 'läuft' }], edges: [{ from: 'agent', to: 'q', style: 'pulse' }] };

test('a tool that finishes while the model writes is shown finished in that very answer', async () => {
  const out = [];
  let release;
  const g = createVizGenerator({ emit: (m) => out.push(m.spec), debounceMs: 5, complete: () => new Promise((r) => { release = () => r({ json: stale }); }) });
  g.noteTurn({ role: 'user', text: 'Was hat Florian heute entschieden?' });
  g.noteEvent({ type: 'tool', id: 't1', name: 'decisions_recent', args: {}, status: 'start' });
  await sleep(20);
  g.noteEvent({ type: 'tool', id: 't1', name: 'decisions_recent', args: {}, status: 'done', ms: 6, summary: '{ "entriesToday": 13' });
  release();
  await sleep(5);
  assert.equal(out[0].nodes[1].value, 'fertig');
  assert.equal(out[0].caption, undefined);
  g.close();
});

test('the spec on screen is corrected the moment its tool finishes, before any new model answer', async () => {
  const out = [];
  let n = 0;
  const g = createVizGenerator({ emit: (m) => out.push(m.spec), debounceMs: 5, complete: async () => (++n === 1 ? { json: stale } : new Promise(() => {})) });
  g.noteTurn({ role: 'user', text: 'Was hat Florian heute entschieden?' });
  g.noteEvent({ type: 'tool', id: 't1', name: 'decisions_recent', args: {}, status: 'start' });
  await sleep(30);
  assert.equal(out.length, 1);
  assert.equal(out[0].nodes[1].value, 'läuft'); // honest while it runs
  g.noteEvent({ type: 'tool', id: 't1', name: 'decisions_recent', args: {}, status: 'done', ms: 6 });
  assert.equal(out.length, 2);
  assert.deepEqual([out[1].nodes[1].value, out[1].nodes[1].tone], ['fertig', 'moss']);
  assert.equal(out[1].caption, undefined);
  g.close();
});

test('when the update after the answer fails, the spec on screen is still settled (no "prüft jetzt" left behind)', async () => {
  const out = [];
  let n = 0;
  const busy = { ...good, caption: 'Der Agent prüft jetzt die Liste.' };
  const g = createVizGenerator({ emit: (m) => out.push(m.spec), debounceMs: 5, complete: async () => { if (++n === 1) return { json: busy }; throw new Error('HTTP 502'); }, onError: () => {} });
  g.noteTurn({ role: 'user', text: 'Was läuft?' });
  await sleep(20);
  assert.equal(out[0].caption, busy.caption);
  g.noteTurn({ role: 'assistant', text: 'Zwei Jobs.' });
  await sleep(20);
  assert.equal(out.length, 2);
  assert.equal(out[1].caption, undefined);
  g.close();
});

test('title and caption are cut at a word boundary (live: "nächster Job ist rea…")', () => {
  const s = validateSpec({ ...good, title: '„Rags to Next Steps“ existiert nicht – nächster Job ist reax2-next-steps', caption: `${'Wort '.repeat(27)}Freigabe Republish offen.` });
  assert.ok(s.title.endsWith('ist…') && s.title.length <= 60, s.title);
  assert.ok(s.caption.endsWith('Freigabe…') || s.caption.endsWith('Wort…'), s.caption);
  assert.doesNotMatch(s.caption, /\b(Fr|Freig|Repub)\w*…$/);
});

test('tool done schedules the canvas even before any transcript arrives', async () => {
  let called = 0;
  const g = createVizGenerator({ emit: () => {}, debounceMs: 1, complete: async (req) => {
    called++;
    assert.equal(toolInput(req)[0].status, 'fertig');
    return { json: good };
  } });
  g.noteEvent({ type: 'tool', id: 'silent', name: 'list_jobs', status: 'done', content: '{"total":20,"open":17}' });
  await sleep(25);
  assert.equal(called, 1);
  g.close();
});
