import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainText } from '../src/lib/plainText.ts';

test('markdown becomes plain text for previews', () => {
  assert.equal(plainText('Ergebnis: **5.**'), 'Ergebnis: 5.');
  assert.equal(plainText('## Titel\n- *eins*\n- `zwei` und [Link](http://x.y)'), 'Titel eins zwei und Link');
  assert.equal(plainText('```js\nconst a = 1;\n```\nfertig'), 'const a = 1; fertig');
  assert.equal(plainText('snake_case_name und 2*3*4'), 'snake_case_name und 2*3*4');
});
