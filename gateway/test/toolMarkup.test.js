import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolMarkupFilter } from '../src/toolMarkup.js';

const run = (chunks) => {
  const filter = new ToolMarkupFilter();
  const shown = chunks.map((c) => filter.push(c)).join('') + filter.flush();
  return { shown, dropped: filter.dropped };
};

describe('ToolMarkupFilter', () => {
  it('passes ordinary text, including angle brackets, unchanged', () => {
    const text = 'Zeile <b>fett</b> und a < b, <tool> ist kein Marker, [TOOL] auch nicht';
    assert.deepEqual(run([text]), { shown: text, dropped: false });
    assert.deepEqual(run(text.match(/.{1,3}/gs)), { shown: text, dropped: false });
  });

  it('cuts the DeepSeek DSML markup, wherever the chunks split it', () => {
    const answer = 'Ich schaue nach.\n\n<｜DSML｜ calls><｜DSML｜ invoke name="read_file">';
    for (const size of [1, 2, 3, 5, 100]) {
      const result = run(answer.match(new RegExp(`.{1,${size}}`, 'gs')));
      assert.deepEqual(result, { shown: 'Ich schaue nach.\n\n', dropped: true }, `chunk size ${size}`);
    }
  });

  it('drops the other known tool-call dialects', () => {
    for (const markup of ['<tool_call>{"name":"x"}</tool_call>', '<|tool_call_begin|>', '<function_calls><invoke name="x">', '[TOOL_CALLS][{"name":"x"}]', '<invoke name="x">']) {
      assert.deepEqual(run(['Antwort: ', markup]), { shown: 'Antwort: ', dropped: true }, markup);
    }
  });

  it('releases a held-back marker prefix at the end when it never became a marker', () => {
    assert.deepEqual(run(['Wert <｜']), { shown: 'Wert <｜', dropped: false });
  });

  it('shows nothing after the markup, even when plain text follows', () => {
    assert.deepEqual(run(['<｜DSML｜ calls>', ' noch Text']), { shown: '', dropped: true });
  });
});
