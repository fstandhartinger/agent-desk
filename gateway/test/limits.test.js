import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FailureLimiter, Limits } from '../src/limits.js';

describe('Limits', () => {
  it('allows 40 chats per 10 minutes per session, independently per sid', () => {
    const limits = new Limits();
    for (let i = 0; i < 40; i += 1) assert.equal(limits.check('a', 'chat').ok, true);
    const blocked = limits.check('a', 'chat');
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 600);
    assert.equal(limits.check('b', 'chat').ok, true);
  });

  it('allows 60 transcriptions and 25 Claude starts', () => {
    const limits = new Limits();
    for (let i = 0; i < 60; i += 1) limits.check('a', 'transcribe');
    assert.equal(limits.check('a', 'transcribe').ok, false);
    for (let i = 0; i < 25; i += 1) limits.check('a', 'claudeStart');
    assert.equal(limits.check('a', 'claudeStart').ok, false);
  });

  it('limits voice to 2 concurrent sessions and 90 minutes a day', () => {
    const limits = new Limits();
    limits.voiceOpen('a');
    limits.voiceOpen('a');
    assert.equal(limits.check('a', 'voice').ok, false);
    limits.voiceClose('a', 60);
    assert.equal(limits.check('a', 'voice').ok, true);
    limits.voiceClose('a', 90 * 60);
    assert.equal(limits.check('a', 'voice').ok, false);
  });

  it('refuses paid work above the daily USD cap', () => {
    process.env.DESK_DAILY_USD_CAP = '1';
    const limits = new Limits();
    limits.addCost(0.6);
    assert.equal(limits.check('a', 'spend').ok, true);
    limits.addCost(0.5);
    assert.equal(limits.check('a', 'spend').ok, false);
    limits.addCost(Number.NaN);
    limits.addCost(-3);
    assert.ok(Math.abs(limits.costToday() - 1.1) < 1e-9);
    delete process.env.DESK_DAILY_USD_CAP;
  });

  it('rejects unknown kinds', () => {
    assert.throws(() => new Limits().check('a', 'nope'));
  });
});

describe('FailureLimiter', () => {
  it('blocks after max failures inside the window and recovers afterwards', () => {
    const limiter = new FailureLimiter(3, 1000);
    for (let i = 0; i < 3; i += 1) limiter.fail('ip', 1000 + i);
    assert.ok(limiter.retryAfter('ip', 1500) > 0);
    assert.equal(limiter.retryAfter('ip', 2100), 0);
    limiter.fail('ip', 3000);
    limiter.reset('ip');
    assert.equal(limiter.retryAfter('ip', 3001), 0);
  });
});

describe('limit messages', () => {
  it('say in German how long to wait', () => {
    const limits = new Limits();
    for (let i = 0; i < 40; i += 1) limits.check('a', 'chat');
    assert.match(limits.check('a', 'chat').reason, /^Zu viele Nachrichten – bitte in (9|10) Minuten erneut$/);
    for (let i = 0; i < 25; i += 1) limits.check('a', 'claudeStart');
    assert.match(limits.check('a', 'claudeStart').reason, /^Das Tageslimit für Claude-Sessions ist erreicht – bitte in \d+ Stunden erneut$/);
  });
});
