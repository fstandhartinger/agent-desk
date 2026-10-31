import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, errorFrom, fmtRetry, germanError, withRetry } from '../src/lib/api.ts';

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('English gateway errors never reach the UI (critic D11)', async () => {
  const wrong = await errorFrom(res(401, { error: 'invalid code' }));
  assert.equal(wrong.message, 'Dieser Zugangscode stimmt nicht.');
  const locked = await errorFrom(res(429, { error: 'too many attempts' }, { 'retry-after': '900' }));
  assert.equal(locked.message, 'Zu viele Versuche – erneut möglich in 15 min.');
  assert.equal(locked.retryAfter, 900);
  assert.ok(locked instanceof ApiError);
});

test('German server messages pass through; retry time is added once', async () => {
  const e = await errorFrom(res(429, { error: 'Zu viele Versuche – bitte in 15 Minuten erneut.' }, { 'retry-after': '900' }));
  assert.equal(e.message, 'Zu viele Versuche – bitte in 15 Minuten erneut.');
  const chat = await errorFrom(res(429, { error: 'Chat-Limit erreicht.' }, { 'retry-after': '42' }));
  assert.equal(chat.message, 'Chat-Limit erreicht – erneut möglich in 42 s.');
});

test('empty or non-JSON bodies fall back to a German status text', async () => {
  const e = await errorFrom(new Response('<html>bad gateway</html>', { status: 502 }));
  assert.equal(e.message, 'Der Dienst antwortet gerade nicht.');
  assert.equal(germanError('', 418), 'Fehler 418 – bitte erneut versuchen.');
});

test('retry formatting', () => {
  assert.equal(fmtRetry(5), 'in 5 s');
  assert.equal(fmtRetry(61), 'in 2 min');
  assert.equal(fmtRetry(7200), 'in 2 h');
  assert.equal(withRetry('Gesperrt.', undefined), 'Gesperrt.');
});

test('auth.me posts companion session IDs to the native host only in companion mode', async () => {
  const { auth } = await import('../src/lib/api.ts');
  const originalFetch = globalThis.fetch;
  const runtime = globalThis as unknown as { location?: { search: string }; chrome?: unknown };
  const originalLocation = runtime.location, originalChrome = runtime.chrome;
  const messages: unknown[] = [];
  runtime.chrome = { webview: { postMessage: (message: unknown) => messages.push(message) } };
  globalThis.fetch = async () => res(200, { ok: true, sid: 'fake-sid' });
  try {
    runtime.location = { search: '?companion=1' };
    assert.equal((await auth.me()).sid, 'fake-sid');
    assert.deepEqual(messages, [{ type: 'session', sid: 'fake-sid' }]);
    runtime.location = { search: '' }; await auth.me(); assert.equal(messages.length, 1);
  } finally { globalThis.fetch = originalFetch; runtime.location = originalLocation; runtime.chrome = originalChrome; }
});
