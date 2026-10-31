import assert from 'node:assert/strict';
import { it, after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-card-link-'));
process.env.BRIDGE_HOME = home;
const { cardLink } = await import('../src/notify.js');
after(() => fs.rm(home, { recursive: true, force: true }));
it('fixed card index yields only generic title and validated details link', async () => {
 const cards = path.join(home, '.notify', 'cards'); await fs.mkdir(cards, { recursive: true });
 await fs.writeFile(path.join(cards, '123.json'), JSON.stringify({ text: 'Private EUR 999 secret body <a href="https://cards.app.mintapis.com/p/fake_token">Details</a>' }));
 const result = await cardLink({ id: '123' });
 assert.equal(result.url, 'https://cards.app.mintapis.com/p/fake_token');
 assert.equal(result.title, 'Karte 123'); assert.doesNotMatch(JSON.stringify(result), /999|secret body/);
 for (const id of ['../123', '..', '1/2', '123.json']) await assert.rejects(cardLink({ id }), /invalid card id/);
 await fs.writeFile(path.join(cards, '124.json'), 'x'.repeat(65537));
 await assert.rejects(cardLink({ id: '124' }), /too large/);
});
