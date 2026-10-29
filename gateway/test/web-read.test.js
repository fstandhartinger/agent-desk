// web_read (docs/UPGRADES-1028.md §4): SSRF guard, redirects, pinning, extraction, limits. Synthetic data only;
// no test touches the real network (lookup and transport are injected; the pinning test uses a local server).
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { checkUrl, createRateLimit, htmlToText, isPublicAddress, pinnedLookup, webRead } from '../src/webRead.js';
import { runTool } from '../src/tools.js';

const PUBLIC = '93.184.216.34';
const lookupMap = (map) => async (host) => {
  if (!(host in map)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return [].concat(map[host]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const page = (status, headers, body = '') => ({ status, headers, body: Readable.from([Buffer.from(body)]) });
const always = () => true;

/** transport stand-in: answers per URL, records every (url, address) it was asked to connect to. */
function fakeTransport(routes) {
  const seen = [];
  const transport = async ({ url, address }) => {
    seen.push({ url: url.href, address: address.address });
    const route = routes[url.href];
    if (!route) throw new Error(`unexpected fetch ${url.href}`);
    return route();
  };
  return { transport, seen };
}

describe('isPublicAddress', () => {
  const blocked = ['127.0.0.1', '127.8.9.10', '10.89.0.3', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc12:3456::1', '::ffff:127.0.0.1', '::ffff:10.89.0.3', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2001:db8::1', 'fe80::1%eth0', 'not-an-ip'];
  const allowed = [PUBLIC, '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:93.184.216.34'];
  for (const ip of blocked) it(`blocks ${ip}`, () => assert.equal(isPublicAddress(ip), false));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isPublicAddress(ip), true));
});

describe('isPublicAddress: IPv4 embedded in IPv6 (critic round 1, P2-1)', () => {
  const blocked = ['::ffff:0:7f00:1', '::ffff:0:127.0.0.1', '0:0:0:0:ffff:0:a9fe:a9fe', '::ffff:0:10.89.0.3', '::127.0.0.1', '::0:7f00:1', '64:ff9b:1::7f00:1', '64:ff9b:1:ffff::1', '64:ff9b::127.0.0.1',
    '2002:a9fe:a9fe::1', '2001:0:4136:e378::1', '2a00:1450::5efe:127.0.0.1', 'fe80::200:5efe:a9fe:a9fe', '2a00:1450::200:5efe:10.0.0.1'];
  const allowed = ['::ffff:0:93.184.216.34', '64:ff9b::8.8.8.8', '2002:0808:0808::1', '2a00:1450::5efe:8.8.8.8'];
  for (const ip of blocked) it(`blocks ${ip}`, () => assert.equal(isPublicAddress(ip), false));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isPublicAddress(ip), true));
  it('a URL with the IPv4-translated loopback is refused before any connection', async () => {
    const { resolveChecked } = await import('../src/webRead.js');
    await assert.rejects(resolveChecked(checkUrl('http://[::ffff:0:7f00:1]/')));
  });
});

describe('checkUrl', () => {
  for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'http://user:pw@example.com/', 'http://example.com:8080/', 'https://example.com:22/', 'http://localhost/', 'http://intranet/', 'http://printer.local/', 'javascript:alert(1)', 'not a url']) {
    it(`refuses ${bad}`, () => assert.throws(() => checkUrl(bad)));
  }
  it('accepts http on 80 and https on 443', () => {
    assert.equal(checkUrl('http://example.com:80/a').hostname, 'example.com');
    assert.equal(checkUrl('https://example.com:443/a').hostname, 'example.com');
  });
});

describe('webRead SSRF cases', () => {
  const direct = ['http://127.0.0.1/', 'http://[::1]/', 'http://10.89.0.3/', 'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://[::ffff:127.0.0.1]/', 'http://100.100.100.200/'];
  for (const url of direct) {
    it(`refuses ${url} without connecting`, async () => {
      const { transport, seen } = fakeTransport({});
      await assert.rejects(webRead({ url }, { lookup: lookupMap({}), transport, rateLimit: always }), /not allowed/);
      assert.equal(seen.length, 0);
    });
  }

  it('refuses a DNS name that resolves to a private address', async () => {
    const { transport, seen } = fakeTransport({});
    await assert.rejects(webRead({ url: 'https://evil.example.com/' }, { lookup: lookupMap({ 'evil.example.com': '10.89.0.3' }), transport, rateLimit: always }), /not allowed/);
    assert.equal(seen.length, 0);
  });

  it('refuses when ANY of the resolved addresses is private (rebinding with mixed answers)', async () => {
    const { transport, seen } = fakeTransport({});
    await assert.rejects(webRead({ url: 'https://mixed.example.com/' }, { lookup: lookupMap({ 'mixed.example.com': [PUBLIC, '127.0.0.1'] }), transport, rateLimit: always }), /not allowed/);
    assert.equal(seen.length, 0);
  });

  it('refuses a redirect to a private address (checked again before the second hop)', async () => {
    const { transport, seen } = fakeTransport({ 'https://pub.example.com/': () => page(302, { location: 'http://169.254.169.254/latest/meta-data/' }) });
    await assert.rejects(webRead({ url: 'https://pub.example.com/' }, { lookup: lookupMap({ 'pub.example.com': PUBLIC }), transport, rateLimit: always }), /not allowed/);
    assert.equal(seen.length, 1);
  });

  it('refuses a redirect to a name that resolves privately', async () => {
    const { transport, seen } = fakeTransport({ 'https://pub.example.com/': () => page(301, { location: 'https://inner.example.net/x' }) });
    await assert.rejects(webRead({ url: 'https://pub.example.com/' }, { lookup: lookupMap({ 'pub.example.com': PUBLIC, 'inner.example.net': '192.168.0.10' }), transport, rateLimit: always }), /not allowed/);
    assert.equal(seen.length, 1);
  });

  it('refuses a redirect to another port or scheme', async () => {
    for (const location of ['http://pub.example.com:8080/', 'file:///etc/passwd']) {
      const { transport } = fakeTransport({ 'https://pub.example.com/': () => page(302, { location }) });
      await assert.rejects(webRead({ url: 'https://pub.example.com/' }, { lookup: lookupMap({ 'pub.example.com': PUBLIC }), transport, rateLimit: always }), /port|http/);
    }
  });

  it('follows at most 5 redirects', async () => {
    const routes = {};
    for (let i = 0; i < 7; i++) routes[`https://pub.example.com/${i}`] = () => page(302, { location: `/${i + 1}` });
    const { transport, seen } = fakeTransport(routes);
    await assert.rejects(webRead({ url: 'https://pub.example.com/0' }, { lookup: lookupMap({ 'pub.example.com': PUBLIC }), transport, rateLimit: always }), /too many redirects/);
    assert.equal(seen.length, 6);
  });

  it('connects to the checked address (the transport gets it, no second resolve)', async () => {
    let lookups = 0;
    const lookup = async () => { lookups++; return [{ address: PUBLIC, family: 4 }]; };
    const { transport, seen } = fakeTransport({ 'https://pub.example.com/': () => page(200, { 'content-type': 'text/plain' }, 'hallo') });
    const out = await webRead({ url: 'https://pub.example.com/' }, { lookup, transport, rateLimit: always });
    assert.equal(out.text, 'hallo');
    assert.equal(lookups, 1);
    assert.deepEqual(seen, [{ url: 'https://pub.example.com/', address: PUBLIC }]);
  });
});

describe('pinned lookup', () => {
  it('http.request connects to the pinned address, whatever the host name says', async () => {
    const server = http.createServer((req, res) => res.end(`host=${req.headers.host}`));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const body = await new Promise((resolve, reject) => {
      http.get(`http://does-not-exist.invalid:${port}/`, { lookup: pinnedLookup({ address: '127.0.0.1', family: 4 }), agent: false }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    server.close();
    assert.equal(body, `host=does-not-exist.invalid:${port}`);
  });
  it('answers the all:true form too', () => {
    pinnedLookup({ address: PUBLIC, family: 4 })('x', { all: true }, (err, list) => assert.deepEqual(list, [{ address: PUBLIC, family: 4 }]));
  });
});

describe('content', () => {
  const lookup = lookupMap({ 'pub.example.com': PUBLIC });
  it('turns HTML into title, main text and links; scripts and styles are dropped', async () => {
    const html = '<html><head><title>Beispiel &amp; Test</title><style>.x{}</style></head><body><nav>Menü</nav><main><h1>Überschrift</h1><p>Erster Absatz mit genug Text. '.padEnd(300, 'x') + '</p><script>alert(1)</script><a href="/weiter">Weiter lesen</a></main></body></html>';
    const { transport } = fakeTransport({ 'https://pub.example.com/': () => page(200, { 'content-type': 'text/html; charset=utf-8' }, html) });
    const out = await webRead({ url: 'https://pub.example.com/' }, { lookup, transport, rateLimit: always });
    assert.equal(out.title, 'Beispiel & Test');
    assert.match(out.text, /Überschrift\nErster Absatz/);
    assert.doesNotMatch(out.text, /alert|Menü|\.x\{\}/);
    assert.deepEqual(out.links, [{ label: 'Weiter lesen', href: 'https://pub.example.com/weiter' }]);
  });
  it('PDF is refused with a clear message', async () => {
    const { transport } = fakeTransport({ 'https://pub.example.com/a.pdf': () => page(200, { 'content-type': 'application/pdf' }, '%PDF') });
    await assert.rejects(webRead({ url: 'https://pub.example.com/a.pdf' }, { lookup, transport, rateLimit: always }), /PDF wird nicht unterstützt/);
  });
  it('binary content types are refused', async () => {
    const { transport } = fakeTransport({ 'https://pub.example.com/x': () => page(200, { 'content-type': 'application/octet-stream' }, 'xx') });
    await assert.rejects(webRead({ url: 'https://pub.example.com/x' }, { lookup, transport, rateLimit: always }), /not supported/);
  });
  it('stops reading at the byte cap and says so', async () => {
    const { transport } = fakeTransport({ 'https://pub.example.com/big': () => page(200, { 'content-type': 'text/plain' }, 'a'.repeat(5000)) });
    const out = await webRead({ url: 'https://pub.example.com/big', maxChars: 100000 }, { lookup, transport, rateLimit: always, maxBytes: 1000 });
    assert.equal(out.truncated, true);
    assert.equal(out.text.length, 1000);
  });
  it('htmlToText decodes entities and keeps paragraphs', () => {
    const { text } = htmlToText('<p>A&nbsp;&uuml;&#228;&#x2013;B</p><p>C</p>', 'https://x.example/');
    assert.equal(text, 'A üä–B\nC');
  });
});

describe('limits and the tool', () => {
  it('rate limit: 30 per 10 minutes per key', () => {
    let t = 0;
    const limit = createRateLimit({ now: () => t });
    for (let i = 0; i < 30; i++) assert.equal(limit('s1'), true);
    assert.equal(limit('s1'), false);
    assert.equal(limit('s2'), true);
    t += 10 * 60_000 + 1;
    assert.equal(limit('s1'), true);
  });
  it('runTool web_read refuses a private target and audits the call', async () => {
    const audits = [];
    const out = await runTool('web_read', { url: 'http://169.254.169.254/latest/meta-data/' }, { hub: {}, audit: (e) => audits.push(e), sid: 's-web' });
    assert.equal(out.ok, false);
    assert.match(out.content, /not allowed/);
    assert.equal(audits[0].action, 'tool.web_read');
    assert.equal(audits[0].detail.ok, false);
    assert.equal(audits[0].detail.host, 'gateway');
  });
});
