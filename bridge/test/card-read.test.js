import assert from 'node:assert/strict';
import { it, after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-card-read-'));
process.env.BRIDGE_HOME = home;
const { cardRead, pageText } = await import('../src/notify.js');
after(() => fs.rm(home, { recursive: true, force: true }));
// Synthetic content only: this repository is public.
const PAGE = 'FakePageId_0123456789abcdefghijklmn';
const PAGE2 = 'FakeOtherPage_0123456789abcdefghij';
const card = {
  text: `✅ ERLEDIGT\n<b>Offer the fake service for EUR 0,05 per call?</b>\n▸ Fake summary line.\nWhy: Fake reason, see a#abc123 and a#ABC123.\nCatch: Fake catch.\n<a href="https://cards.app.mintapis.com/p/${PAGE}">Details ›</a> · 1 min\n✓ You chose Ja · 09:54\n↳ Agent: Fake follow-up &amp; more\n<i>a#def456 · Karte 123</i>`,
  aid: 'def456', source: 'fake:job', answered: true,
};
const dirs = async () => { await fs.mkdir(path.join(home, '.notify', 'cards'), { recursive: true }); await fs.mkdir(path.join(home, '.notify', 'pages'), { recursive: true }); };
it('returns card text with price, chosen button, agent line, details page text and linked ids', async () => {
  await dirs();
  await fs.writeFile(path.join(home, '.notify', 'cards', '123.json'), JSON.stringify(card));
  const html = '<html><head><style>body{x:1}</style></head><body><div data-card-artifacts="1" class="artifact-header"><span>a#def456</span></div><h1>Fake details</h1><p>First <b>paragraph</b></p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><script>alert(1)</script></body></html>';
  await fs.writeFile(path.join(home, '.notify', 'pages', `${PAGE}.json`), JSON.stringify({ html, expires: Date.now() / 1000 + 3600 }));
  const r = await cardRead({ id: '123' });
  assert.match(r.text, /^✅ ERLEDIGT\nOffer the fake service for EUR 0,05 per call\?/);
  for (const needle of ['Why: Fake reason', 'Catch: Fake catch', '✓ You chose Ja', '↳ Agent: Fake follow-up & more']) assert(r.text.includes(needle), needle);
  assert(!r.text.includes('Karte 123') && !r.text.includes('<'));
  assert.equal(r.url, `https://cards.app.mintapis.com/p/${PAGE}`);
  assert.deepEqual(r.linked_ids, ['a#abc123']);
  assert.equal(r.aid, 'def456'); assert.equal(r.answered, true);
  assert.match(r.details, /Fake details\nFirst paragraph\nA \| B \|\n1 \| 2 \|/);
  assert(!/alert|body\{|a#def456/.test(r.details));
});
it('survives a missing or expired details page and redacts secrets', async () => {
  await dirs();
  await fs.writeFile(path.join(home, '.notify', 'cards', '124.json'), JSON.stringify({ text: `🤖 LÄUFT\nWorum geht's: leak password=hunter2hunter2\nhttps://cards.app.mintapis.com/p/${PAGE2}` }));
  const r = await cardRead({ id: '124' });
  assert.doesNotMatch(r.text, /hunter2/); assert.equal(r.details, undefined);
  await fs.writeFile(path.join(home, '.notify', 'pages', `${PAGE2}.json`), JSON.stringify({ html: '<p>old</p>', expires: 1 }));
  assert.equal((await cardRead({ id: '124' })).details, undefined);
});
it('rejects traversal, oversize and non-existing ids; page ids cannot escape the page store', async () => {
  await dirs();
  for (const id of ['../123', '..', '1/2', '123.json', '0', '', 5]) await assert.rejects(cardRead({ id }), /invalid card id/);
  await assert.rejects(cardRead({ id: '999' }));
  await fs.writeFile(path.join(home, '.notify', 'cards', '125.json'), 'x'.repeat(70000));
  await assert.rejects(cardRead({ id: '125' }), /too large/);
  await fs.writeFile(path.join(home, '.notify', 'cards', '126.json'), JSON.stringify({ text: 'x https://cards.app.mintapis.com/p/..%2F..%2Fcards%2F123' }));
  assert.equal((await cardRead({ id: '126' })).details, undefined);
});
it('pageText keeps visible text only', () => {
  assert.equal(pageText('<style>a{}</style><p>One</p><ul><li>Two</li></ul>'), 'One\nTwo');
});
