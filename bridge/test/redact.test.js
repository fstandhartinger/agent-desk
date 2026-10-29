import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDeep } from '../src/redact.js';
import { syn } from './synthetic.js';

const SECRETS = {
  openai: 'sk-abcdefghijklmnop1234',
  xai: 'xai-abcdefghijklmnopqrstu1',
  google: `AIza${'a1B2c3D4e5'.repeat(3)}`,
  github: `ghp_${'a1B2c3D4e5'.repeat(3)}`,
  chutes: 'cpk_abcdefghijklmnopqrst.uv',
  bearer: 'Bearer abcdefghijklmnopqrstuvwx',
  pem: `-----${'BEGIN'} RSA PRIVATE KEY-----\nMIIabc\n-----${'END'} RSA PRIVATE KEY-----`,
  kv: 'API_KEY = hunter2hunter2',
  kv2: syn('password: "correct·horse"'),
};

for (const [name, secret] of Object.entries(SECRETS)) {
  test(`redacts ${name}`, () => {
    const out = redact(`before ${secret} after`);
    assert.ok(out.includes('[REDACTED]'), out);
    assert.ok(!out.includes(secret.slice(4, 18)), out);
  });
}

test('leaves ordinary text alone', () => {
  const text = 'Das Token-Limit liegt bei 5 und sk-short bleibt.';
  assert.equal(redact(text), text);
});

test('redactDeep walks objects and arrays', () => {
  const out = redactDeep({ a: ['x', { b: SECRETS.openai }], n: 3 });
  assert.equal(out.a[1].b, '[REDACTED]');
  assert.equal(out.n, 3);
});

test('does not match key prefixes inside words (job names like ask-investigate-…)', () => {
  for (const name of [
    'ask-investigate-job-20261024-long',
    'ask-watchdog-gpu-pods-20261023',
    '/home/flori/jobs/ask-investigate-comms-overview-20261024/STATE.md',
    'taskxai-abcdefghijklmnopqrstuvwxyz',
    'maskAIza' + 'a1B2c3D4e5'.repeat(3),
  ]) assert.equal(redact(name), name);
});

test('still redacts a key after punctuation, quotes and whitespace', () => {
  for (const prefix of ['', ' ', '"', '=', ':', '(', '/']) {
    assert.ok(redact(`${prefix}sk-abcdefghijklmnop1234`).includes('[REDACTED]'), JSON.stringify(prefix));
  }
});

test('critic round 2: dict reprs, aws ini, webhooks, camelCase, German prose (all synthetic)', () => {
  for (const [text, secret] of [
    [syn("clean = {'SYNTH_API_KEY': 'aa_9·aAA9·synt·hVal·ue01·2345·6789·abcd·efgh·ij'}"), 'aa_9aAA9synthValue'],
    [syn('aws_secret_acc·ess_key = synt·hFak·e012·3456·789a·bcde·fghi·jklm·nopq·rstu·v'), syn('synt·hFak·e012·3456·789')],
    ['https://hooks.slack.com/services/T0SYNTH/B0FAKE/synthfake0123456789abcdef', syn('synt·hfak·e012·3456·789')],
    [syn('"privateKey": "synt·hPri·vKey·Json·Valu·e012·3456·789"'), 'synthPrivKeyJsonValue'],
    ['Kennwort lautet Sommer2026!', 'Sommer2026!'],
    [syn('session_secret 9f8e·7d6c·5b4a·3928·1706·f5e4·d3c2·b1a0·9f8e·7d6c·5b4a·3928'), '9f8e7d6c5b4a3928'],
  ]) assert.ok(!redact(text).includes(secret), text);
  for (const keep of ['{"key":"LLM-APIs"}', 'Das Passwort ist abgelaufen.', 'max_tokens = 400000000']) assert.equal(redact(keep), keep);
});
