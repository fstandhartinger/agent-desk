import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSvg } from '../src/canvas/sanitize.ts';

const wrap = (inner: string, attrs = 'viewBox="0 0 100 50"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;
const clean = (inner: string) => sanitizeSvg(wrap(inner), 'p-')!.inner;
const DANGER = /script|onload|onclick|onerror|foreignObject|javascript:|<iframe|<img|<image|<use|<a[ >]|<style|<animate|<set|http:|https:|data:|expression/i;

test('keeps an ordinary sketch: shapes, text, gradients, markers (ids prefixed)', () => {
  const out = sanitizeSvg(wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect x="1" y="2" width="10" height="5" fill="url(#g)"/><text x="5" y="5" font-size="4">Hallo &amp; tschüss</text><path d="M0 0 L10 10" marker-end="url(#m)"/>'), 'p-')!;
  assert.deepEqual(out.viewBox, [0, 0, 100, 50]);
  assert.match(out.inner, /<linearGradient id="p-g">/);
  assert.match(out.inner, /fill="url\(#p-g\)"/);
  assert.match(out.inner, /marker-end="url\(#p-m\)"/);
  assert.match(out.inner, /Hallo &amp; tschüss/);
});

test('drops <script> with its content, also nested and in odd case', () => {
  for (const evil of ['<script>alert(1)</script>', '<g><SCRIPT>alert(1)</SCRIPT></g>', '<script href="x.js"/>', '<g><script><![CDATA[alert(1)]]></script></g>']) {
    const out = clean(evil);
    assert.doesNotMatch(out, /alert|script/i, evil);
  }
});

test('drops on* event handlers', () => {
  const out = sanitizeSvg('<svg viewBox="0 0 10 10" onload="alert(1)"><rect width="5" height="5" onclick="alert(2)" ONMOUSEOVER="x()"/></svg>')!;
  assert.doesNotMatch(out.inner, /alert|onload|onclick|onmouseover/i);
  assert.match(out.inner, /<rect width="5" height="5">/);
});

test('drops foreignObject and everything inside it', () => {
  const out = clean('<foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></div></foreignObject><circle r="3"/>');
  assert.doesNotMatch(out, DANGER);
  assert.match(out, /<circle r="3">/);
});

test('drops javascript: and external hrefs (href and xlink:href), keeps local #refs only', () => {
  const out = clean('<a href="javascript:alert(1)"><text>x</text></a><use href="#a"/><use xlink:href="https://evil.example/s.svg#x"/><rect href="javascript:alert(1)"/><text href="#ok">t</text>');
  assert.doesNotMatch(out, DANGER);
  assert.match(out, /href="#p-ok"/);
});

test('drops external url() in attributes and styles, CSS escapes and data: URIs', () => {
  const out = clean([
    '<rect fill="url(https://evil.example/x.svg#p)"/>',
    '<rect fill="url(  data:image/svg+xml;base64,AAAA)"/>',
    '<rect style="fill:url(http://evil.example/a);stroke:#fff"/>',
    '<rect fill="\\75rl(http://evil.example/b)"/>',
    '<rect fill="u&#x72;l(http://evil.example/c)"/>',
    '<rect style="background:expression(alert(1))"/>',
  ].join(''));
  assert.doesNotMatch(out, DANGER);
  assert.match(out, /style="stroke:#fff"/, 'the safe declaration survives');
});

test('drops <style>, <image>, <animate>/<set> (which could rewrite href) and entity tricks in a DOCTYPE', () => {
  const out = sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><svg viewBox="0 0 10 10"><style>rect{fill:url(http://evil)}</style><image href="http://evil/x.png"/><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onload" to="alert(1)"/><text>&x;</text></svg>')!;
  assert.doesNotMatch(out.inner, /<script|<style|<image|<animate|<set|alert\(1\)<|javascript|http:/i);
});

test('attribute values cannot break out of their quotes', () => {
  const out = clean(`<rect fill='a" onload="alert(1)'/><text x="1">"&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;</text>`);
  assert.doesNotMatch(out, /<script|\sonload="/i, 'the quote is escaped, so onload stays inside the value');
  assert.match(out, /fill="a&quot; onload=&quot;alert\(1\)"/);
  assert.match(out, /&lt;script&gt;/, 'text stays text');
});

test('no svg root, oversized input or element floods → null', () => {
  assert.equal(sanitizeSvg('<div>hi</div>'), null);
  assert.equal(sanitizeSvg(`<svg>${'x'.repeat(41000)}</svg>`), null);
  assert.equal(sanitizeSvg(`<svg>${'<g/>'.repeat(3100)}</svg>`), null);
});

test('missing viewBox falls back to width/height', () => {
  assert.deepEqual(sanitizeSvg('<svg width="300" height="120"><rect/></svg>')!.viewBox, [0, 0, 300, 120]);
});
