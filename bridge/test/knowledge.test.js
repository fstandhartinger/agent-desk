import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-knowledge-'));
process.env.BRIDGE_HOME = home;
const { knowledge, listTopics, matchTopic } = await import('../src/knowledge.js');
const { resolveAllowed } = await import('../src/paths.js');
const K = path.join(home, 'desk-knowledge');

const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(K, rel)), { recursive: true });
  fs.writeFileSync(path.join(K, rel), text);
};

after(() => fs.rmSync(home, { recursive: true, force: true }));

test('without the knowledge folder: a clear "not built yet" answer, no throw', async () => {
  const r = await knowledge({});
  assert.equal(r.found, false);
  assert.match(r.note, /noch nicht angelegt/);
});

test('INDEX without topic, topic files by fuzzy / German / keyword match', async () => {
  write('INDEX.md', '# Florians Themen\n## SN92 / REAX\n');
  write('topics/sn92-reax.md', '# SN92 / REAX subnet\n<!-- keywords: sn92, reax, subnet, subnetz 92, bittensor -->\nfacts\n');
  write('topics/owner-emissions-tax.md', '# Owner emissions and tax reserve\n<!-- keywords: owner emissions, tax, steuer, rücklage, tranche, talisman, euro -->\nThe api_key=abcdefghijklmnop must not leak\n');
  write('topics/servers.md', '# Servers: Sandy, LeChonk, sandy-prod\n<!-- keywords: server, sandy, lechonk, sandy-prod, paas, gpu -->\n');
  const index = await knowledge({});
  assert.equal(index.topic, 'INDEX');
  assert.match(index.text, /Florians Themen/);
  assert.equal((await knowledge({ topic: 'sn92' })).topic, 'sn92-reax');
  assert.equal((await knowledge({ topic: 'Subnetz 92' })).topic, 'sn92-reax');
  assert.equal((await knowledge({ topic: 'Steuerrücklage' })).topic, 'owner-emissions-tax');
  assert.equal((await knowledge({ topic: 'Steuern' })).topic, 'owner-emissions-tax');
  assert.equal((await knowledge({ topic: 'Server' })).topic, 'servers');
  assert.equal((await knowledge({ topic: 'owner-emissions-tax' })).topic, 'owner-emissions-tax');
});

test('redaction applies to knowledge text; marker/keyword comment lines are dropped; unknown topics list what exists', async () => {
  const r = await knowledge({ topic: 'tax' });
  assert.doesNotMatch(r.text, /<!--/);
  assert.match(r.text, /^# Owner emissions and tax reserve\nThe /);
  assert.doesNotMatch(r.text, /abcdefghijklmnop/);
  const miss = await knowledge({ topic: 'Kochrezepte' });
  assert.equal(miss.found, false);
  assert.ok(miss.topics.some((t) => t.startsWith('servers:')));
});

test('listTopics reads titles and keywords; matchTopic ranks', async () => {
  const topics = await listTopics();
  assert.deepEqual(topics.map((t) => t.slug), ['owner-emissions-tax', 'servers', 'sn92-reax']);
  assert.equal(matchTopic('bittensor', topics)[0].topic.slug, 'sn92-reax');
});

test('desk-knowledge and the laptop mirror are read roots; deny list still applies inside them', () => {
  assert.ok(resolveAllowed(path.join(K, 'INDEX.md')));
  const mirror = path.join(home, 'data', 'laptop-mirror', 'memory');
  fs.mkdirSync(mirror, { recursive: true });
  fs.writeFileSync(path.join(mirror, 'project_sn92.md'), 'x');
  fs.writeFileSync(path.join(mirror, 'secrets.md'), 'x');
  assert.ok(resolveAllowed(path.join(mirror, 'project_sn92.md')));
  assert.throws(() => resolveAllowed(path.join(mirror, 'secrets.md')), /not allowed/);
  assert.throws(() => resolveAllowed(path.join(K, '..', '.bashrc')), /not allowed/);
});

test('Claude desk sessions: PROMPT.md links the knowledge index and says to read the topic file first', async () => {
  const { buildPrompt } = await import('../src/prompt.js');
  const md = buildPrompt({ sid: 'd1', title: 't', prompt: 'Wie steht es um die Steuerrücklage?', dir: '/tmp/d1' });
  assert.match(md, /~\/desk-knowledge\/INDEX\.md/);
  assert.match(md, /matching topic file FIRST/);
  assert.ok(md.indexOf('desk-knowledge') < md.indexOf('## Task'));
});
