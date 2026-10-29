import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posterTime, type Explainer } from '../src/lib/explainer.ts';

const withScenes = (scenes: { id: string; start: number; end: number }[]) => ({ timeline: { duration: 90, scenes, words: [] } }) as unknown as Explainer;

test('the poster frame is the first scene after its opening animation, never past the scene', () => {
  assert.equal(posterTime(withScenes([{ id: 'a', start: 0.2, end: 16 }])), 4.7);
  assert.equal(posterTime(withScenes([{ id: 'a', start: 0, end: 2 }])), 1);
  assert.equal(posterTime(withScenes([])), 0);
});
