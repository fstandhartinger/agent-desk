// Critic round 6, P1-1: every regex of the bridge files that see tool text stays linear on adversarial input (the same
// harness as gateway/test/redos.test.js; redos-helpers.js is a byte-identical copy of gateway/test/helpers/redos.js).
// All inputs are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fuzzCorpus, longCorpus, regexesOf, scanInWorker, shortCorpus, srcFiles } from './redos-helpers.js';
import { redact } from '../src/redact.js';

// Critic round 7: every source file, not a hand-picked list
const SRC = new URL('../src/', import.meta.url);
const FILES = srcFiles(SRC).map((u) => u.href.slice(SRC.href.length));
const BUDGET_MS = 50;
const SHORT = [...shortCorpus(24), ...fuzzCorpus(400)];
const LONG = longCorpus(20_000);
const report = (slow) => slow.slice(0, 8).map((s) => `${s.ms} ms ${s.where} [${s.name}, ${s.len} chars]`).join('\n');

describe('bridge regexes stay linear on adversarial input (critic round 6, ReDoS)', () => {
  for (const file of FILES) {
    it(`${file}: no regex over ${BUDGET_MS} ms on short probes and 20 kB runs`, async () => {
      const regexes = await regexesOf(new URL(`../src/${file}`, import.meta.url));
      if (file === 'redactPatterns.js') assert.ok(regexes.length > 50, 'the scanner found no regex');
      if (!regexes.length) return; // a file without any regex
      const { slow } = await scanInWorker(regexes, [...SHORT, ...LONG], BUDGET_MS, 60_000);
      assert.equal(slow.length, 0, `super-linear regexes in ${file}:\n${report(slow)}`);
    });
  }

  it('the critic-6 mail-subject repro finishes fast in the bridge redact()', () => {
    for (const text of [`Re: secret${'  :'.repeat(30)}`, `secret${'  :'.repeat(170_000)}`, `pw${' : -> = '.repeat(6_000)}`]) {
      const t = performance.now();
      redact(text);
      assert.ok(performance.now() - t < 2_000, `${text.slice(0, 30)}… (${text.length} chars): ${Math.round(performance.now() - t)} ms`);
    }
  });

  it('redos-helpers.js is byte-identical to the gateway copy (when the gateway is checked out)', (t) => {
    const gw = new URL('../../gateway/test/helpers/redos.js', import.meta.url);
    if (!fs.existsSync(gw)) return t.skip('no gateway checkout');
    assert.equal(fs.readFileSync(new URL('./redos-helpers.js', import.meta.url), 'utf8'), fs.readFileSync(gw, 'utf8'));
  });
});
