// Critic round 6, P1-1: one regex of redactPatterns.js backtracked exponentially ("secret" + 20 x "  :" took 8 s and froze the
// whole desk). This test runs EVERY regex of the files that see tool or model text (literals and the ones built with
// new RegExp) against a generated adversarial corpus and fails on any super-linear blowup. All inputs are synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fuzzCorpus, longCorpus, regexesOf, scanInWorker, shortCorpus, srcFiles } from './helpers/redos.js';
import { redact } from '../src/redact.js';
import { redactText } from '../src/redactPatterns.js';
import { syn } from './synthetic.js';

// Critic round 7: every source file (webRead.js was missing and froze the desk on a crafted page)
const SRC = new URL('../src/', import.meta.url);
const FILES = srcFiles(SRC).map((u) => u.href.slice(SRC.href.length));
const BUDGET_MS = 50; // per regex and input; a linear regex needs < 30 ms on 20 kB, an exponential one hangs at ~100 chars
const SHORT = [...shortCorpus(24), ...fuzzCorpus(400)];
const LONG = longCorpus(20_000);
const report = (slow) => slow.slice(0, 8).map((s) => `${s.ms} ms ${s.where} [${s.name}, ${s.len} chars]`).join('\n');

describe('every regex stays linear on adversarial input (critic round 6, ReDoS)', () => {
  for (const file of FILES) {
    it(`${file}: short probes (exponential) and 20 kB runs (polynomial) stay under ${BUDGET_MS} ms`, async () => {
      const regexes = await regexesOf(new URL(`../src/${file}`, import.meta.url));
      if (file === 'redactPatterns.js') assert.ok(regexes.length > 50, 'the scanner found no regex');
      if (!regexes.length) return; // a file without any regex
      const { slow } = await scanInWorker(regexes, [...SHORT, ...LONG], BUDGET_MS, 60_000);
      assert.equal(slow.length, 0, `super-linear regexes in ${file}:\n${report(slow)}`);
    });
  }

  it('the critic-6 repros finish fast in redact()', () => {
    for (const text of [
      `secret${'  :'.repeat(30)}`, `Re: secret${'  :'.repeat(30)}`, `Das Geheimnis ist${' ist'.repeat(60)}`, `the key${' ->'.repeat(60)}`,
      `pw${' : -> = '.repeat(6_000)}`, `Das Geheimnis ist${' ist'.repeat(12_000)}`, `secret${'  :'.repeat(170_000)}`,
    ]) {
      const t = performance.now();
      redact(text);
      assert.ok(performance.now() - t < 400, `${text.slice(0, 30)}… (${text.length} chars): ${Math.round(performance.now() - t)} ms`);
    }
  });

  it('the round-6 label rule still masks values after one to three separators', () => {
    assert.equal(redactText('pw: : Sommer24!x'), 'pw: : [REDACTED]');
    assert.equal(redactText('secret := Zq7xWv2PLk9mRt4YbN8cHs3G'), 'secret := [REDACTED]');
    assert.equal(redactText('Das Geheimnis ist: Zq7xWv2PLk9mRt4YbN8cHs3G'), 'Das Geheimnis ist: [REDACTED]');
  });
});

describe('redact() works in overlapping chunks above 64 kB (critic round 6, P1-1 guard; critic round 7: chunked from 64 kB)', () => {
  it('a 1 MB text takes bounded time and secrets on chunk borders are still masked', () => {
    const filler = 'Ein ganz normaler Satz ohne Geheimnisse. '.repeat(25_000); // ~1 MB
    const secret = syn('OPENAI_API_KEY=Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G·aB1');
    let text = filler;
    for (const at of [200_000, 262_144 - 10, 400_000, 524_288 - 5, 900_000]) text = `${text.slice(0, at)}\n${secret}\n${text.slice(at)}`;
    const t = performance.now();
    const out = redact(text);
    assert.ok(performance.now() - t < 5_000, `${Math.round(performance.now() - t)} ms`);
    assert.ok(!out.includes('Zq7xWv2PLk9mRt4YbN8cHs3GaB1'), 'a secret survived on a chunk border');
    assert.equal((out.match(/OPENAI_API_KEY=\[REDACTED\]/g) ?? []).length, 5);
    assert.equal(out.length, text.length - 5 * ('Zq7xWv2PLk9mRt4YbN8cHs3GaB1'.length - '[REDACTED]'.length));
  });
  it('ordinary long text is unchanged', () => {
    const text = 'Die Pipeline hat 12 Schritte und läuft auf Sandy.\n'.repeat(10_000);
    assert.equal(redact(text), text);
  });
});
