import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasStream, stripCanvasBlocks, placeholder } from '../src/canvas.js';
import { Normalizer } from '../src/events.js';
import { buildPrompt, CANVAS_HELP } from '../src/prompt.js';

const SPEC = { v: 2, id: 'demo', kind: 'flow', title: 'Demo Ablauf', nodes: [{ id: 'a', label: 'A' }], sources: [{ label: 'x', ref: 'Gespräch' }] };
const BLOCK = `\`\`\`desk-canvas\n${JSON.stringify(SPEC)}\n\`\`\``;

const run = (chunks) => {
  const s = new CanvasStream();
  const evs = chunks.flatMap((c) => s.push(c));
  evs.push(...s.flush());
  return { evs, shown: evs.filter((e) => e.kind === 'text_delta').map((e) => e.text).join(''), canvases: evs.filter((e) => e.kind === 'canvas'), errors: evs.filter((e) => e.kind === 'canvas_error') };
};

test('one chunk: block becomes a canvas event and a placeholder, surrounding text stays', () => {
  const r = run([`Hier ist es.\n${BLOCK}\nUnd weiter.`]);
  assert.deepEqual(r.canvases, [{ kind: 'canvas', spec: SPEC }]);
  assert.equal(r.shown, 'Hier ist es.\n[Skizze auf der Canvas: Demo Ablauf]\nUnd weiter.');
  assert.deepEqual(r.errors, []);
});

test('block split across text_delta chunks at every possible position gives the same result', () => {
  const full = `Davor.\n${BLOCK}\nDanach.`;
  const expected = run([full]);
  for (let i = 1; i < full.length; i++) {
    const r = run([full.slice(0, i), full.slice(i)]);
    assert.equal(r.shown, expected.shown, `split at ${i}`);
    assert.deepEqual(r.canvases, expected.canvases, `split at ${i}`);
  }
  const r = run([...full].map((c) => c)); // one character at a time
  assert.equal(r.shown, expected.shown);
  assert.equal(r.canvases.length, 1);
});

test('an unfinished fence is held back: nothing of it is shown before it closes', () => {
  const s = new CanvasStream();
  const first = s.push('Text\n```desk-can');
  assert.equal(first.map((e) => e.text).join(''), 'Text\n');
  const second = s.push('vas\n{"v":2,"id":"a-b","ki');
  assert.deepEqual(second, []);
  assert.ok(s.holding);
  const third = s.push('nd":"pie","title":"T","items":[],"sources":[]}\n```\n');
  assert.equal(third[0].kind, 'canvas');
  assert.equal(third[0].spec.kind, 'pie');
  assert.equal(third[1].text, '[Skizze auf der Canvas: T]\n');
});

test('a lookalike (``` inline, other fence languages, mid-line marker) is plain text', () => {
  const r = run(['```js\nconst a = 1;\n```\nund `` ```desk-canvas inline ``` ende\n', '``', '` kein Block']);
  assert.equal(r.canvases.length, 0);
  assert.equal(r.errors.length, 0);
  assert.equal(r.shown, '```js\nconst a = 1;\n```\nund `` ```desk-canvas inline ``` ende\n``` kein Block');
});

test('invalid JSON becomes canvas_error and a short placeholder, never the raw block', () => {
  const r = run(['A\n```desk-canvas\n{"v":2,"id":\n```\nB']);
  assert.equal(r.canvases.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /not valid JSON/);
  assert.equal(r.shown, 'A\n[Skizze auf der Canvas: ungültig]\nB');
  const arr = run(['```desk-canvas\n[1,2]\n```\n']);
  assert.match(arr.errors[0].message, /one JSON object/);
});

test('a block that is never closed is flushed at the end of the turn as text plus an error', () => {
  const r = run(['Vorher\n```desk-canvas\n{"v":2,']);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /never closed/);
  assert.match(r.shown, /^Vorher\n```desk-canvas\n\{"v":2,$/);
});

test('two blocks in one answer, and the same block twice, are announced once each', () => {
  const other = { ...SPEC, id: 'other', title: 'Zweite' };
  const two = run([`${BLOCK}\ntext\n\`\`\`desk-canvas\n${JSON.stringify(other)}\n\`\`\`\n`]);
  assert.deepEqual(two.canvases.map((e) => e.spec.id), ['demo', 'other']);
  const seen = new Set();
  const a = stripCanvasBlocks(BLOCK, seen);
  const b = stripCanvasBlocks(BLOCK, seen);
  assert.equal(a.events.length, 1);
  assert.equal(b.events.length, 0);
  assert.equal(b.text, a.text);
});

test('placeholder falls back to the id, then to "Skizze"', () => {
  assert.equal(placeholder({ id: 'x-y' }), '[Skizze auf der Canvas: x-y]');
  assert.equal(placeholder({}), '[Skizze auf der Canvas: Skizze]');
  assert.equal(placeholder({ title: 'x'.repeat(100) }).length, '[Skizze auf der Canvas: ]'.length + 70);
});

test('Normalizer: stream-json deltas + final message give ONE canvas event and no raw block in text', () => {
  const n = new Normalizer();
  const full = `Ich zeichne es.\n${BLOCK}\nFertig.`;
  const parts = [full.slice(0, 20), full.slice(20, 60), full.slice(60)];
  const events = [];
  for (const t of parts) events.push(...n.feed({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } }));
  events.push(...n.feed({ type: 'stream_event', event: { type: 'content_block_stop' } }));
  events.push(...n.feed({ type: 'assistant', message: { content: [{ type: 'text', text: full }] } }));
  events.push(...n.feed({ type: 'result', duration_ms: 1, num_turns: 1 }));
  assert.equal(events.filter((e) => e.kind === 'canvas').length, 1);
  assert.deepEqual(events.find((e) => e.kind === 'canvas').spec, SPEC);
  const shownLive = events.filter((e) => e.kind === 'text_delta').map((e) => e.text).join('');
  const finalText = events.find((e) => e.kind === 'text').text;
  assert.equal(shownLive, 'Ich zeichne es.\n[Skizze auf der Canvas: Demo Ablauf]\nFertig.');
  assert.equal(finalText, shownLive);
  assert.ok(!JSON.stringify(events.filter((e) => e.kind !== 'canvas')).includes('desk-canvas'));
});

test('Normalizer: without partial messages the complete text still yields the canvas event; flush() ends a half block', () => {
  const n = new Normalizer();
  const evs = n.feed({ type: 'assistant', message: { content: [{ type: 'text', text: BLOCK }] } });
  assert.deepEqual(evs.map((e) => e.kind), ['canvas', 'text']);
  const m = new Normalizer();
  m.feed({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '```desk-canvas\n{"v":' } } });
  assert.deepEqual(m.flush().map((e) => e.kind), ['canvas_error', 'text_delta']);
});

test('Normalizer redacts secrets inside a canvas spec', () => {
  const n = new Normalizer();
  const spec = { ...SPEC, caption: 'key sk-abcdefghijklmnop1234' };
  const evs = n.feed({ type: 'assistant', message: { content: [{ type: 'text', text: `\`\`\`desk-canvas\n${JSON.stringify(spec)}\n\`\`\`` }] } });
  assert.equal(evs[0].spec.caption, 'key [REDACTED]');
});

test('desk header in PROMPT.md teaches the block: example, kinds, and the instruction to draw', () => {
  const md = buildPrompt({ sid: 'd20261024-abcdef', title: 't', prompt: 'erkläre', dir: '/tmp/x' });
  assert.equal(md, md); // built without throwing
  for (const needle of ['```desk-canvas', '"kind":"flow"', 'flow | architecture | sequence | pie | bar | line | table | timeline | sankey | custom_svg', 'Zeichne, wenn du eine Struktur, einen Ablauf oder Zahlen erklärst; Florian sieht es live', 'sources']) {
    assert.ok(md.includes(needle), needle);
  }
  // the example inside the header is itself a valid block with three nodes
  const example = /```desk-canvas\n([\s\S]*?)\n```/.exec(CANVAS_HELP)[1];
  const spec = JSON.parse(example);
  assert.equal(spec.nodes.length, 3);
  assert.equal(spec.v, 2);
});
