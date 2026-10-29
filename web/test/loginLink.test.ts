import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepLinkNext, requestLoginLink } from '../src/lib/loginLink.ts';
import { ApiError } from '../src/lib/api.ts';

test('only an explainer deep link (?x=slug) offers the Telegram link; next keeps path + query, never a hash', () => {
  assert.equal(deepLinkNext({ pathname: '/', search: '?x=live-desk-intro&t=42' }), '/?x=live-desk-intro&t=42');
  assert.equal(deepLinkNext({ pathname: '/', search: '' }), null);
  assert.equal(deepLinkNext({ pathname: '/', search: '?x=../../etc' }), null);
  assert.equal(deepLinkNext({ pathname: '/', search: '?x=a&k=secret' }), '/?x=a', 'a stray code param is not forwarded');
});

test('success, rate limit (with retry time) and Telegram outage read in German', async () => {
  let body: unknown;
  const ok = await requestLoginLink('/?x=a', async (b) => { body = b; return { ok: true }; });
  assert.deepEqual(body, { next: '/?x=a' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /Telegram/);
  const limited = await requestLoginLink('/?x=a', async () => { throw new ApiError(429, 'Zu viele Anfragen – bitte kurz warten. – erneut möglich in 9 min.', 540); });
  assert.equal(limited.ok, false);
  assert.equal(limited.ok === false && limited.retryAfter, 540);
  assert.match(limited.text, /erneut möglich in 9 min/);
  assert.doesNotMatch(limited.text, /erneut möglich.*erneut möglich/, 'retry time said once');
  const fresh = await requestLoginLink('/?x=a', async () => { throw new ApiError(429, 'Gerade erst einen Link geschickt.', 600); });
  assert.equal(fresh.text, 'Gerade erst einen Link geschickt – erneut möglich in 10 min.');
  const down = await requestLoginLink('/?x=a', async () => { throw new ApiError(502, 'Der Dienst antwortet gerade nicht.'); });
  assert.match(down.text, /Telegram ist gerade nicht erreichbar/);
});
