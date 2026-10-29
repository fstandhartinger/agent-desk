import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { DESK_ORIGIN, connectFakeBridge, setEnv, startGateway } from './helpers/env.js';

setEnv();
let gw;
let auth;
let bridge;
let handler;
const sent = [];

before(async () => {
  gw = await startGateway();
  auth = await import('../src/auth.js');
  bridge = await connectFakeBridge(gw.port, { 'notify.loginLink': (params) => handler(params) });
});
after(() => { bridge.ws.close(); gw.close(); });
beforeEach(() => {
  auth.resetLoginLimitsForTests();
  sent.length = 0;
  handler = (params) => { sent.push(params); return { sent: true, detail: 'ok' }; };
});

const request = (body, headers = {}) => fetch(`${gw.base}/api/auth/request-link`, { method: 'POST', headers: { 'content-type': 'application/json', origin: DESK_ORIGIN, ...headers }, body: JSON.stringify(body) });

describe('POST /api/auth/request-link', () => {
  it('needs no cookie, sends a login link through the bridge, and the link logs in and keeps next', async () => {
    const res = await request({ next: '/?x=video-send&t=42' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(sent.length, 1);
    const url = new URL(sent[0].url);
    assert.equal(`${url.origin}${url.pathname}${url.search}`, `${DESK_ORIGIN}/?x=video-send&t=42`);
    const code = decodeURIComponent(url.hash.replace(/^#k=/, ''));
    assert.match(code, /^L1\./);
    const login = await fetch(`${gw.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /^desk_s=/);
  });

  it('next defaults to the start page', async () => {
    assert.equal((await request({})).status, 200);
    assert.equal(sent[0].url.startsWith(`${DESK_ORIGIN}/#k=L1.`), true);
  });

  it('only same-origin paths of the form "/" or "/?query" are accepted', async () => {
    for (const next of ['//evil.example', 'https://evil.example/', '/other', '/?a#frag', '/?a b', '/?a\nb', '\\\\evil', 42, `/?${'x'.repeat(600)}`]) {
      const res = await request({ next });
      assert.equal(res.status, 400, JSON.stringify(next).slice(0, 40));
      assert.match((await res.json()).error, /Ungültiges Ziel/);
    }
    assert.equal(sent.length, 0);
    assert.equal((await request({ next: '/' })).status, 200);
  });

  it('is limited globally: 1 per 10 minutes and 4 per day, with a German message and retryAfter', async () => {
    let now = Date.now();
    const clock = mock.method(Date, 'now', () => now);
    try {
      assert.equal((await request({})).status, 200);
      const blocked = await request({});
      assert.equal(blocked.status, 429);
      const body = await blocked.json();
      assert.match(body.error, /Login-Link wurde gerade erst geschickt – bitte in 10 Minuten erneut/);
      assert.ok(body.retryAfter > 590 && body.retryAfter <= 600);
      assert.equal(blocked.headers.get('retry-after'), String(body.retryAfter));
      for (let i = 0; i < 3; i += 1) {
        now += 11 * 60_000;
        assert.equal((await request({})).status, 200, `request ${i + 2}`);
      }
      now += 11 * 60_000;
      const day = await request({});
      assert.equal(day.status, 429);
      assert.ok((await day.json()).retryAfter > 3600, 'the day limit waits for hours');
      assert.equal(sent.length, 4);
      now += 24 * 3600_000;
      assert.equal((await request({})).status, 200);
    } finally {
      clock.mock.restore();
    }
  });

  it('a delivery failure answers 502 and does not use up the allowance', async () => {
    handler = () => ({ sent: false, detail: 'notify exit 75' });
    const failed = await request({});
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /nicht per Telegram geschickt/);
    handler = (params) => { sent.push(params); return { sent: true }; };
    assert.equal((await request({})).status, 200);
  });

  it('refuses cross-site posts', async () => {
    assert.equal((await request({}, { origin: 'https://evil.example' })).status, 403);
    assert.equal(sent.length, 0);
  });

  it('writes an audit line without the link itself', async () => {
    const lines = [];
    const log = mock.method(console, 'log', (line) => lines.push(String(line)));
    try {
      await request({ next: '/?x=a' });
    } finally {
      log.mock.restore();
    }
    const audit = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.action === 'login.request_link');
    assert.ok(audit);
    assert.equal(audit.actor, 'anonymous');
    assert.ok(!lines.some((l) => l.includes('L1.')), 'the link never reaches the log');
  });
});

describe('safeNext', () => {
  it('accepts / and /?…, rejects the rest', async () => {
    const { safeNext } = auth;
    assert.equal(safeNext(undefined), '/');
    assert.equal(safeNext('/'), '/');
    assert.equal(safeNext('/?x=a&t=3'), '/?x=a&t=3');
    for (const bad of ['/a', '//a', 'http://a', '/?a#b', ' /']) assert.equal(safeNext(bad), null, bad);
  });
});

describe('request-link dry run (test hook for critics)', () => {
  const saved = process.env.DESK_TEST_DRYRUN;
  after(() => { if (saved === undefined) delete process.env.DESK_TEST_DRYRUN; else process.env.DESK_TEST_DRYRUN = saved; });

  it('x-desk-dry-run: 1 is ignored unless DESK_TEST_DRYRUN=1 (a real link goes out)', async () => {
    delete process.env.DESK_TEST_DRYRUN;
    const res = await request({ next: '/' }, { 'x-desk-dry-run': '1' });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
  });

  it('with DESK_TEST_DRYRUN=1 the header signs but sends nothing and uses no allowance; next "" is valid (= "/")', async () => {
    process.env.DESK_TEST_DRYRUN = '1';
    for (const next of ['', '/', '/?x=a']) {
      const res = await request({ next }, { 'x-desk-dry-run': '1' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).dryRun, true);
    }
    assert.equal(sent.length, 0);
    assert.equal((await request({ next: '//evil.example' }, { 'x-desk-dry-run': '1' })).status, 400); // validation still runs
    assert.equal((await request({})).status, 200); // the allowance is untouched
    assert.equal(sent.length, 1);
  });

  it('without the header the env var alone changes nothing', async () => {
    process.env.DESK_TEST_DRYRUN = '1';
    assert.equal((await request({})).status, 200);
    assert.equal(sent.length, 1);
  });
});
