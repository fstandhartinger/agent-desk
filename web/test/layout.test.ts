import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MIN, defaultLayout, fitLayout } from '../src/lib/layout.ts';

test('stage is the hero: ~45 % of the width on wide desktops', () => {
  for (const vw of [1440, 1920]) {
    const { left } = fitLayout(defaultLayout(vw), vw);
    assert.ok(left / vw >= 0.42 && left / vw <= 0.46, `${vw}: ${left}`);
  }
});

test('the chat column never gets squeezed below its minimum, also with old saved widths', () => {
  for (const vw of [1024, 1280, 1366, 1440, 1920]) {
    for (const saved of [defaultLayout(vw), { leftShare: 0.7, right: 640, leftOpen: true, rightOpen: true }]) {
      const { left, right } = fitLayout(saved, vw);
      assert.ok(vw - left - right - 16 >= CHAT_MIN - 1, `${vw}: ${left}+${right}`);
    }
  }
});

test('a layout saved on a laptop still gives the stage ~45 % on a big screen', () => {
  const saved = defaultLayout(1440);
  assert.ok(fitLayout(saved, 1920).left >= 0.44 * 1920);
});
