import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Normalizer } from '../src/events.js';

const lines = fs.readFileSync(new URL('./fixtures/stream.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function normalise(input) {
  const n = new Normalizer();
  return { n, events: input.flatMap((o) => n.feed(o)) };
}

test('recorded stream-json becomes desk events in order', () => {
  const { n, events } = normalise(lines);
  const kinds = events.map((e) => e.kind);
  assert.deepEqual([...new Set(kinds)], ['tool_use', 'todo', 'tool_result', 'text_delta', 'text', 'result']);
  assert.ok(n.claudeSessionId);
  assert.equal(kinds.at(-1), 'result');
  assert.ok(kinds.indexOf('text_delta') < kinds.indexOf('text'));
});

test('tool_use carries path and command, tool_result a preview', () => {
  const { events } = normalise(lines);
  const read = events.find((e) => e.kind === 'tool_use' && e.name === 'Read');
  assert.equal(read.path, '/etc/hostname');
  const bash = events.find((e) => e.kind === 'tool_use' && e.name === 'Bash');
  assert.equal(bash.command, "echo hi");
  const res = events.find((e) => e.kind === 'tool_result' && e.id === bash.id);
  assert.deepEqual({ ok: res.ok, preview: res.preview }, { ok: true, preview: 'hi' });
});

test('TodoWrite becomes a todo event', () => {
  const { events } = normalise(lines);
  assert.deepEqual(events.find((e) => e.kind === 'todo').items, [{ content: 'check', status: 'in_progress' }]);
});

test('text deltas concatenate to the final text', () => {
  const { events } = normalise(lines);
  const joined = events.filter((e) => e.kind === 'text_delta').map((e) => e.text).join('');
  assert.equal(joined, events.find((e) => e.kind === 'text').text);
});

test('result carries duration, cost and turns', () => {
  const r = normalise(lines).events.find((e) => e.kind === 'result');
  assert.equal(typeof r.durationMs, 'number');
  assert.equal(typeof r.costUsd, 'number');
  assert.equal(typeof r.turns, 'number');
});

test('errors, secrets and garbage are handled', () => {
  const { events } = normalise([
    null, 'text', { type: 'unknown' }, { type: 'assistant', message: { content: 'x' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'key sk-abcdefghijklmnop1234' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'x'.repeat(2000) }] }] } },
    { type: 'result', is_error: true, result: 'boom', duration_ms: 5, num_turns: 1 },
  ]);
  assert.equal(events[0].text, 'key [REDACTED]');
  assert.equal(events[1].ok, false);
  assert.equal(events[1].preview.length, 600);
  assert.deepEqual(events.at(-1), { kind: 'error', message: 'boom' });
});
