import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPortrait, trackFraction } from '../src/lib/fullscreen.ts';

test('portrait is height > width only', () => {
  assert.equal(isPortrait(390, 844), true);
  assert.equal(isPortrait(844, 390), false);
  assert.equal(isPortrait(800, 800), false);
});

test('trackFraction: normal track reads clientX', () => {
  const r = { left: 100, top: 50, width: 200, height: 32 };
  assert.equal(trackFraction(r, 200, 32, 200, 9999), 0.5);
  assert.equal(trackFraction(r, 200, 32, 50, 0), 0);
  assert.equal(trackFraction(r, 200, 32, 999, 0), 1);
});

test('trackFraction: track rotated 90° (wide layout, tall bounding box) reads clientY, top = start', () => {
  const r = { left: 300, top: 100, width: 32, height: 400 };
  assert.equal(trackFraction(r, 400, 32, 0, 100), 0);
  assert.equal(trackFraction(r, 400, 32, 0, 300), 0.5);
  assert.equal(trackFraction(r, 400, 32, 0, 900), 1);
});
