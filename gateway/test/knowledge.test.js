import test from 'node:test';
import assert from 'node:assert/strict';
import { attachKnowledge, knowledgeIndex, knowledgeLines, refreshKnowledge, setKnowledgeForTest } from '../src/knowledge.js';
import { buildInstructions } from '../src/prompt.js';
import { buildInstructions as voiceInstructions } from '../src/voice/instructions.js';
import { buildMessages } from '../src/viz.js';
import { TOOL_DEFS, statusText } from '../src/tools.js';

const RULE = 'Das ist dein Grundwissen über Florians Themen; für Details rufe knowledge_read auf, bevor du suchst.';

test('attachKnowledge loads INDEX through ctx.knowledge and caches it; a failing bridge keeps the cached text', async () => {
  let calls = 0;
  let fail = false;
  const hub = { async call(method, params) { calls += 1; assert.equal(method, 'ctx.knowledge'); assert.deepEqual(params, {}); if (fail) throw new Error('offline'); return { found: true, text: '# Index\n## SN92 / REAX' }; } };
  const stop = attachKnowledge(hub);
  await refreshKnowledge();
  assert.match(knowledgeIndex(), /SN92/);
  knowledgeIndex();
  knowledgeIndex();
  assert.ok(calls <= 2, `cached, not fetched per prompt (${calls})`);
  fail = true;
  await refreshKnowledge();
  assert.match(knowledgeIndex(), /SN92/, 'stale index beats no index');
  stop();
});

test('no index loaded → no knowledge lines (the prompt does not promise knowledge it lacks)', () => {
  assert.deepEqual(knowledgeLines(''), []);
});

test('the index and the knowledge_read rule are in EVERY system prompt: text agent, voice, illustrator', () => {
  setKnowledgeForTest('## SN92 / REAX\nOwner emissions: 100-alpha tranches, tax reserve ~40 %');
  for (const prompt of [buildInstructions(null), buildInstructions(null, { spoken: true }), voiceInstructions(null), buildMessages({ turns: [] })[0].content]) {
    assert.ok(prompt.includes(RULE), prompt.slice(0, 200));
    assert.match(prompt, /100-alpha tranches/);
  }
});

test('knowledge_read tool: declared, optional topic, German status line', () => {
  const def = TOOL_DEFS.find((t) => t.name === 'knowledge_read');
  assert.ok(def);
  assert.deepEqual(def.parameters.required, []);
  assert.match(def.description, /BEFORE search_files/);
  assert.equal(statusText('knowledge_read', { topic: 'Steuer' }), 'Ich schaue in mein Wissen zu Steuer …');
});
