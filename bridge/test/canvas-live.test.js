import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// One short real turn: the desk header alone must make Claude emit a desk-canvas block that becomes a canvas event.
const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-canvas-live-'));
process.env.DESK_SESSIONS_DIR = sessions;
const { createClaude } = await import('../src/claude.js');
const skip = process.env.SKIP_REAL_CLAUDE === '1' ? 'SKIP_REAL_CLAUDE set' : false;

test('real Claude session draws a flow on the canvas from the desk header', { skip, timeout: 300_000 }, async (t) => {
  t.after(() => fs.rmSync(sessions, { recursive: true, force: true }));
  const events = [];
  const claude = createClaude({ emit: (topic, data) => { if (topic.startsWith('claude:d')) events.push(data); } });
  const { sid } = await claude.start({
    title: 'canvas smoke', model: 'sonnet', effort: 'low',
    prompt: 'Erkläre in zwei Sätzen, wie ein Brief zum Empfänger kommt (Absender, Post, Empfänger), und zeichne den Ablauf.',
  });
  const deadline = Date.now() + 240_000;
  while (!events.some((e) => e.kind === 'status' && ['idle', 'error', 'stopped'].includes(e.state)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  claude.shutdown();
  const kinds = events.map((e) => e.kind);
  console.log(`event kinds: ${[...new Set(kinds)].join(', ')}`);
  const canvas = events.filter((e) => e.kind === 'canvas');
  const spec = canvas[0]?.spec;
  console.log(`canvas events: ${canvas.length}; spec: ${JSON.stringify(spec)?.slice(0, 400)}`);
  assert.ok(canvas.length >= 1, `no canvas event; errors: ${JSON.stringify(events.filter((e) => e.kind === 'canvas_error' || e.kind === 'error'))}`);
  assert.equal(spec.kind, 'flow');
  assert.ok(Array.isArray(spec.nodes) && spec.nodes.length >= 3);
  const shown = events.filter((e) => e.kind === 'text' || e.kind === 'text_delta').map((e) => e.text).join('');
  assert.match(shown, /\[Skizze auf der Canvas: /);
  assert.ok(!shown.includes('desk-canvas'), 'the raw block must not be shown');
  const stored = fs.readFileSync(path.join(sessions, sid, 'events.jsonl'), 'utf8');
  assert.match(stored, /"kind":"canvas"/);
});
