import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fakeServer, login, setEnv, startGateway } from './helpers/env.js';

const AUDIO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const POINTS = { page: { title: 'Titel', context: 'KONTEXT '.repeat(3000) }, points: { gate: { title: 'Gate', short: 'kurz', more: 'lang' } } };
const TIMELINE = {
  title: 'Titel',
  scenes: [{ id: 'a', start: 0, end: 30 }, { id: 'b', start: 30, end: 90 }],
  words: Array.from({ length: 90 }, (_, i) => ({ w: `w${i}`, s: i, e: i + 0.5 })),
};

let upstream;
let gw;
let cookie;
before(async () => {
  upstream = await fakeServer((req, res) => {
    const file = req.url.split('/').pop();
    if (file === 'points.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(POINTS));
    if (file === 'card.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ card_id: 18917 }));
    if (file === '000.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([137,80,78,71,13,10,26,10]));
    if (file === 'timeline.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(TIMELINE));
    if (file === 'audio.mp3') {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (!range) return res.writeHead(200, { 'content-length': AUDIO.length, 'accept-ranges': 'bytes' }).end(AUDIO);
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : AUDIO.length - 1;
      return res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${AUDIO.length}`, 'content-length': end - start + 1 }).end(AUDIO.subarray(start, end + 1));
    }
    return res.writeHead(404).end('nope');
  });
  setEnv({ EXPLAINER_ORIGIN: upstream.url });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
});
after(() => { gw.close(); upstream.close(); });

const get = (path, headers = {}) => fetch(`${gw.base}/api/explainer/${path}`, { headers: { cookie, ...headers } });

describe('explainer proxy', () => {
  it('rejects bad slugs and files before any upstream call', async () => {
    const before = upstream.seen.length;
    for (const path of ['AB/points.json', 'a/points.json', 'good-slug/passwd', 'good-slug/evil.exe', 'good-slug/UPPER.png', 'good-slug/..%2Fsecret.json', 'good-slug/a%00.png', `${'x'.repeat(81)}/points.json`]) {
      assert.ok([400, 404].includes((await get(path)).status), path);
    }
    assert.equal((await get('good-slug/index.html/extra')).status, 404);
    assert.equal(upstream.seen.length, before);
  });

  it('proxies points.json and caches it', async () => {
    const first = await get('demo-slug/points.json');
    assert.equal(first.status, 200);
    assert.equal((await first.json()).points.gate.title, 'Gate');
    assert.match(first.headers.get('content-security-policy'), /'unsafe-inline'/);
    await get('demo-slug/points.json');
    assert.equal(upstream.seen.filter((r) => r.url === '/p/demo-slug/points.json').length, 1);
  });

  it('proxies the public card and only generated end-frame paths', async () => {
    const card = await get('demo-slug/card.json');
    assert.deepEqual(await card.json(), { card_id: 18917 });
    assert.equal(card.headers.get('cache-control'), 'no-store');
    const before = upstream.seen.filter((r) => r.url === '/p/demo-slug/card.json').length;
    await get('demo-slug/card.json');
    assert.equal(upstream.seen.filter((r) => r.url === '/p/demo-slug/card.json').length, before + 1);
    const frame = await get('demo-slug/end-frames/000.png');
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get('content-type'), 'image/png');
    for (const path of ['context.json', 'deepdive.md', 'end-frames/other.png', 'end-frames/000.png/extra', 'other/000.png']) {
      assert.ok([400, 404].includes((await get(`demo-slug/${path}`)).status), path);
    }
  });

  it('maps upstream 404 to 404', async () => {
    assert.equal((await get('demo-slug/words.json')).status, 404);
  });

  it('passes Range requests through for audio.mp3', async () => {
    const full = await get('demo-slug/audio.mp3');
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(Buffer.from(await full.arrayBuffer()).length, 1000);
    const part = await get('demo-slug/audio.mp3', { range: 'bytes=100-199' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), AUDIO.subarray(100, 200));
    assert.equal(upstream.seen.at(-1).headers.range, 'bytes=100-199');
  });
});

describe('page context', () => {
  it('builds the point and ±20 s transcript from server data only', async () => {
    const { loadPageContext } = await import('../src/page.js');
    const ctx = await loadPageContext({ slug: 'demo-slug', t: 40, pointId: 'gate', point: { title: 'forged' }, transcriptNear: 'forged' });
    assert.equal(ctx.title, 'Titel');
    assert.equal(ctx.sceneId, 'b');
    assert.deepEqual(ctx.point, { title: 'Gate', short: 'kurz', more: 'lang' });
    assert.ok(ctx.transcriptNear.startsWith('w20 ') && ctx.transcriptNear.endsWith(' w60'), ctx.transcriptNear);
    assert.ok(ctx.context.length <= 12_000);
  });

  it('returns null for unknown or malformed pages', async () => {
    const { loadPageContext } = await import('../src/page.js');
    assert.equal(await loadPageContext(undefined), null);
    assert.equal(await loadPageContext({ slug: '../etc', t: 1 }), null);
  });
});
