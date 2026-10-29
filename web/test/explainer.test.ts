import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posterTime, type Explainer } from '../src/lib/explainer.ts';

const withScenes = (scenes: { id: string; start: number; end: number }[]) => ({ timeline: { duration: 90, scenes, words: [] } }) as unknown as Explainer;

test('the poster frame is the first scene after its opening animation, never past the scene', () => {
  assert.equal(posterTime(withScenes([{ id: 'a', start: 0.2, end: 16 }])), 4.7);
  assert.equal(posterTime(withScenes([{ id: 'a', start: 0, end: 2 }])), 1);
  assert.equal(posterTime(withScenes([])), 0);
});

test('copy targets the current scene at cuts and the final scene at the video end', async () => {
  const { endFrameAt, slideTextAt } = await import('../src/lib/explainer.ts');
  const x = {
    timeline: { duration: 60, words: [], scenes: [{ id: 'a', start: 0, end: 30 }, { id: 'b', start: 30, end: 60, text: '42 Prozent' }] },
    points: { page: {}, points: { b: { title: 'Ergebnis' } } },
    endFrames: [{ id: 'a', endFrame: 'end-frames/000.png', text: 'Einstieg' }, { id: 'b', endFrame: 'end-frames/001.png' }],
  } as Explainer;
  assert.equal(endFrameAt(x, 29.999)?.endFrame, 'end-frames/000.png');
  assert.equal(endFrameAt(x, 30)?.endFrame, 'end-frames/001.png');
  assert.equal(endFrameAt(x, 60)?.endFrame, 'end-frames/001.png');
  assert.equal(slideTextAt(x, 60), 'Ergebnis\n\n42 Prozent');
  x.endFrames![1].endFrame = '../context.json';
  assert.equal(endFrameAt(x, 60), undefined);
});
