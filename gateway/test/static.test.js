import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setEnv, startGateway } from './helpers/env.js';

const root = mkdtempSync(path.join(tmpdir(), 'desk-public-'));
mkdirSync(path.join(root, 'assets'));
writeFileSync(path.join(root, 'index.html'), `<!doctype html><title>desk</title>${'<!-- pad -->'.repeat(100)}`);
writeFileSync(path.join(root, 'assets', 'app-abc123.js'), 'console.log("hi");'.repeat(100));
writeFileSync(path.join(root, '..', 'desk-outside-secret.txt'), 'secret');
setEnv({ DESK_PUBLIC_DIR: root });

let gw;
before(async () => { gw = await startGateway(); });
after(() => gw.close());
const get = (p, headers = {}) => fetch(`${gw.base}${p}`, { headers });

describe('static files', () => {
  it('serves index.html with no-cache and falls back to it for SPA routes', async () => {
    for (const p of ['/', '/chat/42', '/?x=slug&t=3']) {
      const res = await get(p);
      assert.equal(res.status, 200, p);
      assert.match(await res.text(), /<title>desk<\/title>/);
    }
    assert.equal((await get('/')).headers.get('cache-control'), 'no-cache');
  });

  it('gives hashed assets a year of immutable cache and compresses them', async () => {
    const res = await get('/assets/app-abc123.js', { 'accept-encoding': 'br, gzip' });
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('content-encoding'), 'br');
    assert.equal(await res.text(), 'console.log("hi");'.repeat(100)); // fetch decodes br transparently
    const gz = await get('/assets/app-abc123.js', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
  });

  it('404s missing files with an extension and blocks traversal', async () => {
    assert.equal((await get('/assets/missing.js')).status, 404);
    for (const p of ['/..%2Fdesk-outside-secret.txt', '/%2e%2e/desk-outside-secret.txt', '/assets/%00.js', '/%']) {
      const res = await get(p);
      assert.ok(!(await res.text()).includes('secret') || res.status === 404, p);
      assert.notEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8', p);
    }
  });
});
