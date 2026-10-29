// Critic round 7, P2-1: every regex of every bridge source file against runs with failing tails (64 kB) and the recheck attack
// strings of fixtures/redos-attacks.json (64 kB and 200 kB), 100 ms per regex and input (the same harness as
// gateway/test/redos-attacks.test.js); and the bridge redact() keeps a hard budget and fails closed. All inputs are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { pumpAttack, regexesOf, scanInWorker, srcFiles, tailCorpus } from './redos-helpers.js';
import { REDACT_BUDGET_MS, REDACT_FALLBACK, redact, redactAsync, redactDeepAsync, setRedactOffloadForTests } from '../src/redact.js';
import { syn } from './synthetic.js';

const ATTACKS = JSON.parse(fs.readFileSync(new URL('./fixtures/redos-attacks.json', import.meta.url), 'utf8'));
const SRC = new URL('../src/', import.meta.url);
const BUDGET_MS = 100;
const TAIL = tailCorpus(64_000);
const rel = (u) => `bridge/src/${u.href.slice(SRC.href.length)}`;
const pumped = (list, sizes) => list.flatMap((a) => sizes.map((n) => [`recheck ${a.file}:${a.line} @${n}`, pumpAttack(a, n)]));
const report = (slow) => slow.slice(0, 8).map((s) => `${s.ms} ms ${s.where} [${s.name}, ${s.len} chars]`).join('\n');
const ANY_TEXT = new Set(['bridge/src/redactPatterns.js', 'bridge/src/redact.js', 'bridge/src/secretValues.js']);

describe('every regex of every bridge file stays linear on failing-tail runs and recheck attacks (critic round 7)', () => {
  for (const file of srcFiles(SRC)) {
    it(`${rel(file)}: no regex over ${BUDGET_MS} ms`, async () => {
      const regexes = await regexesOf(file);
      if (!regexes.length) return;
      const own = ANY_TEXT.has(rel(file)) ? ATTACKS : ATTACKS.filter((a) => a.file === rel(file));
      const { slow } = await scanInWorker(regexes, [...TAIL, ...pumped(own, [64_000, 200_000])], BUDGET_MS, 240_000);
      assert.equal(slow.length, 0, `super-linear regexes in ${rel(file)}:\n${report(slow)}`);
    });
  }
  it('fixtures/redos-attacks.json is byte-identical to the gateway copy (when the gateway is checked out)', (t) => {
    const gw = new URL('../../gateway/test/fixtures/redos-attacks.json', import.meta.url);
    if (!fs.existsSync(gw)) return t.skip('no gateway checkout');
    assert.equal(fs.readFileSync(new URL('./fixtures/redos-attacks.json', import.meta.url), 'utf8'), fs.readFileSync(gw, 'utf8'));
  });
});

describe('bridge redact() has a hard budget and fails closed (critic round 7, P2-1)', () => {
  it(`every recheck attack at 200 kB finishes within the budget (${REDACT_BUDGET_MS} ms)`, async () => {
    // warm-up: the bridge loads its secret value list on the first call (~1 s) and the workers start once; both are not the budget
    redact(`warm ${'x'.repeat(10_000)}`);
    await redactAsync(`warm ${'x'.repeat(10_000)}`);
    for (const a of ATTACKS) {
      const text = pumpAttack(a, 200_000);
      let t = performance.now();
      redact(text);
      assert.ok(performance.now() - t < REDACT_BUDGET_MS + 500, `redact ${a.file}:${a.line} ${Math.round(performance.now() - t)} ms`);
      t = performance.now();
      await redactAsync(text);
      assert.ok(performance.now() - t < REDACT_BUDGET_MS + 500, `redactAsync ${a.file}:${a.line} ${Math.round(performance.now() - t)} ms`);
    }
  });
  it('redactDeepAsync masks big and small strings like redactDeep', async () => {
    const secret = syn('OPENAI_API_KEY=Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G·aB1');
    const value = { small: secret, big: [`${'Ein normaler Satz. '.repeat(1_000)}\n${secret}\n`], n: 3 };
    const out = await redactDeepAsync(value);
    assert.equal(out.small, 'OPENAI_API_KEY=[REDACTED]');
    assert.ok(out.big[0].endsWith('\nOPENAI_API_KEY=[REDACTED]\n'));
    assert.equal(out.n, 3);
  });
  it('a redaction over the budget returns the fallback, never the text', async () => {
    const restore = setRedactOffloadForTests({ patterns: new URL('./fixtures/slow-redact.mjs', import.meta.url).href, budgetMs: 150 });
    try {
      const text = `${syn('OPENAI_API_KEY=Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G·aB1')} ${'x'.repeat(20_000)}`;
      assert.equal(redact(text), REDACT_FALLBACK);
      assert.equal(await redactAsync(text), REDACT_FALLBACK);
    } finally {
      restore();
    }
  });
});
