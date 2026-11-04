import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildInstructions } from '../src/voice/instructions.js';
// Trace a#92a698: the prompt was built before the attach and said "kein Screen Agent verbunden" for the whole session.
it('inside the Screen Agent the voice knows it, before any frame arrived', () => {
  const text = buildInstructions(null, undefined, { provider: 'xai', screen: false, screenAgent: true });
  assert.match(text, /Du läufst gerade im Screen Agent/);
  assert.match(text, /computer_task den ganzen Computer/);
  assert.match(text, /Du siehst Florians Bildschirm: /);
  assert.doesNotMatch(text, /Es ist kein Screen Agent verbunden/);
  assert.doesNotMatch(text, /Ohne verbundenen Screen Agent/);
  assert.match(text, /meint er GENAU das Markierte/);
});
it('in the browser nothing changes', () => {
  const text = buildInstructions(null, undefined, { provider: 'xai', screen: false });
  assert.match(text, /Es ist kein Screen Agent verbunden/);
  assert.doesNotMatch(text, /Du läufst gerade im Screen Agent/);
});
