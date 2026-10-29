import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldClaude } from '../src/lib/claudeView.ts';
import type { ClaudeEvent } from '../src/lib/types.ts';

const ev = (seq: number, e: object) => ({ seq, ts: '2026-10-24T10:00:00Z', ...e }) as ClaudeEvent;
const status = (seq: number, state: string) => ev(seq, { kind: 'status', state });

test('a result ends the busy header immediately and a later stop does not relabel the finished turn', () => {
  const stopped = foldClaude([status(1, 'running'), ev(2, { kind: 'result', durationMs: 1000 }), status(3, 'stopped')]);
  assert.equal(stopped.blocks.find((b) => b.kind === 'result')?.stopped, undefined);
  const done = foldClaude([status(1, 'running'), ev(2, { kind: 'result', durationMs: 1000 }), status(3, 'idle')]);
  assert.equal(done.blocks.find((b) => b.kind === 'result')?.stopped, undefined);
});

test('a stop without a result event still shows a "stopped" block; stopping an idle session adds nothing', () => {
  const noResult = foldClaude([status(1, 'running'), ev(2, { kind: 'text', text: 'x' }), status(3, 'stopped')]);
  assert.equal(noResult.blocks.at(-1)?.kind === 'result' && noResult.blocks.at(-1)?.stopped, true);
  const afterIdle = foldClaude([status(1, 'running'), ev(2, { kind: 'result' }), status(3, 'idle'), status(4, 'stopped')]);
  assert.equal(afterIdle.blocks.find((b) => b.kind === 'result')?.stopped, undefined);
});

test('newest result/status wins across consecutive Claude turns', () => {
  const finished = [status(1, 'running'), ev(2, { kind: 'result' })];
  assert.equal(foldClaude(finished).state, 'idle');
  assert.equal(foldClaude([...finished, status(3, 'running')]).state, 'running');
  assert.equal(foldClaude([...finished, status(3, 'stopped')]).state, 'stopped');
});
