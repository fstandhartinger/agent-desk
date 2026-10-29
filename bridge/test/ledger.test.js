import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseNumber, findAmount, parseTaxText, parseBoardText, parseExport, aggregate, categorize, mergeSources, splitFields, cleanCounterparty, entries, resetLedgerCache,
} from '../src/ledger.js';

const fixture = fs.readFileSync(new URL('./fixtures/tax-lines.txt', import.meta.url), 'utf8');

test('numbers: German comma, English thousands, plain decimals', () => {
  assert.equal(parseNumber('4,47'), 4.47);
  assert.equal(parseNumber('3,210.00'), 3210);
  assert.equal(parseNumber('3.210,00'), 3210);
  assert.equal(parseNumber('1.234.567'), 1234567);
  assert.equal(parseNumber('1,500'), 1500);
  assert.equal(parseNumber('4.47'), 4.47);
});

test('amounts: USD/EUR/€/$ in front or behind, rates and dates ignored', () => {
  assert.deepEqual(findAmount('x USD 5.00 (EUR ~4.47 on card)'), { amount: 5, currency: 'USD', index: 2, end: 10 });
  assert.equal(findAmount('165,00 € Hetzner').currency, 'EUR');
  assert.equal(findAmount('165,00 € Hetzner').amount, 165);
  assert.equal(findAmount('$12.50 charged').currency, 'USD');
  assert.equal(findAmount('2026-10-24 USD 5').amount, 5); // the "24" of the date is not an amount
  assert.equal(findAmount('at EUR 211.40/TAO we paid EUR 14.80').amount, 14.8); // rate skipped
  assert.equal(findAmount('no money here 3 months'), null);
});

test('fields split at top-level commas only, numbers keep their comma', () => {
  assert.deepEqual(splitFields('2026-10-19, EUR 3,210.00 net, Hub (A, B), purpose'), ['2026-10-19', 'EUR 3,210.00 net', 'Hub (A, B)', 'purpose']);
  assert.deepEqual(splitFields('a | b, c | d'), ['a', 'b, c', 'd']);
});

test('variant: comma form with "EUR ~x on card", time, KG, receipt', () => {
  const [e] = parseTaxText('2026-09-15 08:05Z, USD 5.00 (EUR ~4.47 on card), GammaAPI Ltd (Springfield, api.gamma.example), wallet auto-recharge for LLM API usage, Stripe receipt #9100-0001 / Gmail UID 91010, KG business (paid with a private Bank Visa *0000)', { entryId: '1' });
  assert.deepEqual({ ...e }, {
    date: '2026-09-15', time: '08:05', amount: 5, currency: 'USD', eurApprox: 4.47, counterparty: 'GammaAPI Ltd',
    purpose: 'wallet auto-recharge for LLM API usage', ref: 'Gmail UID 91010', kg: true, category: 'LLM-APIs', entry: 1,
  });
});

test('variant: pipe form with estimate, KG and receipt path', () => {
  const [e] = parseTaxText('2026-10-22 UTC | USD 3.70 (quoted-rate estimate) | RunPod | GPU rental pod pod-demo-01 (RTX PRO 6000), stock eval | KG | demo/receipts/COST-demo-01.json', {});
  assert.equal(e.counterparty, 'RunPod');
  assert.equal(e.amount, 3.7);
  assert.equal(e.currency, 'USD');
  assert.equal(e.eurApprox, 3.31); // fixed-rate fallback
  assert.equal(e.kg, true);
  assert.equal(e.category, 'GPU');
  assert.match(e.ref, /receipts\/COST-demo-01\.json/);
});

test('variant: German decimal comma and "€" suffix, private flag, missing time', () => {
  const [e] = parseTaxText('2026-10-05, 1.234,56 €, Hetzner Online GmbH, Server Miete Oktober, Rechnung 12345, privat', {});
  assert.equal(e.amount, 1234.56);
  assert.equal(e.currency, 'EUR');
  assert.equal(e.time, undefined);
  assert.equal(e.kg, false);
  assert.equal(e.counterparty, 'Hetzner Online GmbH');
  assert.equal(e.category, 'Hosting/Server');
});

test('variant: dollar sign, KG vs private vs unknown', () => {
  assert.equal(parseTaxText('2026-10-05, $12.50, Namecheap, domain renewal, inv 1, KG', {})[0].kg, true);
  assert.equal(parseTaxText('2026-10-05, $12.50, Namecheap, domain renewal, inv 1, private', {})[0].kg, false);
  assert.equal(parseTaxText('2026-10-05, $12.50, Namecheap, domain renewal, inv 1', {})[0].kg, null);
  assert.equal(parseTaxText('2026-10-05, $12.50, Namecheap, domain renewal, inv 1', {})[0].category, 'Domains');
});

test('missing date falls back to the board entry timestamp; no amount or no date at all is unparsed', () => {
  assert.equal(parseTaxText('EUR 3.00, Foo, bar, KG', { entryTs: '2026-10-01T10:00:00Z' })[0].date, '2026-10-01');
  assert.deepEqual(parseTaxText('EUR 3.00, Foo, bar, KG', {}), []);
  assert.deepEqual(parseTaxText('2026-10-01, Foo, no amount, KG', {}), []);
});

test('"~USD 100 each" with two timestamps is two bookings', () => {
  const got = parseTaxText('2026-10-23 ~21:20Z and ~21:30Z, Lium account credit top-ups by Florian (amounts inferred: ~USD 100 each; balance 76 -> 173), provider Lium (lium.io), purpose: training', {});
  assert.deepEqual(got.map((e) => [e.time, e.amount]), [['21:20', 100], ['21:30', 100]]);
});

test('category keyword table', () => {
  const c = (a, b = '') => categorize(a, b);
  assert.equal(c('OpenRouter'), 'LLM-APIs');
  assert.equal(c('UpCloud Oy', 'refill for GPU hosting'), 'GPU');
  assert.equal(c('Hetzner'), 'Hosting/Server');
  assert.equal(c('Namecheap', 'domain'), 'Domains');
  assert.equal(c('Sentry', 'subscription'), 'Abos');
  assert.equal(c('Finanzamt', 'Steuer'), 'Steuer/Gebühren');
  assert.equal(c('Telnyx', 'phone line'), 'Telefonie');
  assert.equal(c('miner-a (uid 1)', '120.0 α ≈ 4.1000 TAO, one-time goodwill payment'), 'SN92-Auszahlungen');
  assert.equal(c('miner-e', '20.0 alpha stake transfer to coldkey 5Fake'), 'SN92-Auszahlungen');
  assert.equal(c('RunPod', 'GPU pod top-up'), 'GPU');
  assert.equal(c('Misc GmbH', 'something'), 'Sonstiges');
});

test('synthetic fixture: 25 TAX posts parse, nothing unparsed, multi-payment post becomes 3 entries', () => {
  const r = parseBoardText(fixture);
  // 25 "TAX:" lines: 1 is a quoted duplicate (0 entries), 1 multi-payment header (3 numbered payments), 1 "~USD 100 each" with two timestamps (2 entries)
  assert.equal(fixture.split('\n').filter((l) => /^[>\s]*TAX:/.test(l)).length, 25);
  assert.deepEqual(r.unparsed, []);
  assert.equal(r.entries.length, 27); // 25 - 1 duplicate - 1 header + 3 numbered + 1 extra for "each"
  assert.ok(r.entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.amount > 0 && e.counterparty && e.ref));
  assert.equal(r.maxId, 1041);
  const by = (n) => r.entries.filter((e) => e.entry === n);
  const pick = (n) => ({ ...by(n)[0] });
  // eight chosen lines, exact values
  assert.deepEqual(pick(1001), { date: '2026-09-12', amount: 1299, currency: 'EUR', eurApprox: 1299, counterparty: 'AlphaGPU Ltd', purpose: 'GPU server rental September', ref: '#22 · Eintrag 1001', kg: true, category: 'GPU', entry: 1001 }); // 1.299,00 €
  assert.deepEqual([pick(1002).amount, pick(1002).kg, pick(1002).category], [14.9, false, 'Abos']); // "privat"
  assert.deepEqual([pick(1003).amount, pick(1003).currency, pick(1003).eurApprox, pick(1003).kg], [12.5, 'USD', 11.18, null]); // $12.50, no KG hint
  assert.deepEqual([pick(1004).amount, pick(1004).counterparty, pick(1004).ref], [2345, 'AlphaGPU Ltd', 'portal pro forma PDF (evidence/pf-0001/pdfs/)']); // "2,345.00 net"
  assert.deepEqual(by(1009).map((e) => [e.time, e.counterparty, e.amount, e.category]), [['09:14', 'miner-a', 951.3, 'SN92-Auszahlungen'], ['09:15', 'miner-b', 510.4, 'SN92-Auszahlungen'], ['09:16', 'miner-c', 255.2, 'SN92-Auszahlungen']]); // EUR 211.40/TAO is a rate, not a payment
  assert.deepEqual([pick(1011).amount, pick(1011).currency, pick(1011).eurApprox, pick(1011).ref], [68.8, 'USD', 61.51, 'receipts/COST-demo-02.json']); // pipe form, fixed-rate fallback
  assert.deepEqual(by(1013).map((e) => [e.time, e.amount, e.counterparty]), [['21:20', 100, 'ZetaGPU'], ['21:30', 100, 'ZetaGPU']]); // "~USD 100 each"
  assert.deepEqual(pick(1030), { date: '2026-09-15', time: '08:05', amount: 6, currency: 'USD', eurApprox: 5.36, counterparty: 'GammaAPI Ltd', purpose: 'wallet auto-recharge for LLM API usage', ref: 'Gmail UID 91010', kg: true, category: 'LLM-APIs', entry: 1030 }); // "EUR ~5.36 on card"
  assert.equal(pick(1018).date, '2026-10-22'); // no date in the line: board timestamp
  assert.equal(by(1015)[0].counterparty, 'MinerD'); // "to X's coldkey"
  assert.equal(by(1041).length, 0); // quoted duplicate
});

test('synthetic fixture: totals by category and month, worked out by hand', () => {
  const list = parseBoardText(fixture).entries;
  const sums = (opts, key) => Object.fromEntries(aggregate(list, opts).totals.map((t) => [`${t.key}/${t.currency}`, [t.sum, t.count]]));
  // GPU EUR: 1299 + 2345 + 3 x 80 + 175 + 6.80 = 4065.80 (7); GPU USD: 3.70 + 68.80 + 2 x 100 = 272.50 (4)
  // SN92 EUR: 951.30 + 510.40 + 255.20 + 145.23 = 1862.13 (4)
  // LLM USD: 84.20 + 50 + 5 x 6 + 10 = 174.20 (8); Telefonie USD 25; Abos EUR 14.90; Domains USD 12.50, EUR 9
  assert.deepEqual(sums({ groupBy: 'category' }), {
    'GPU/EUR': [4065.8, 7], 'SN92-Auszahlungen/EUR': [1862.13, 4], 'GPU/USD': [272.5, 4], 'LLM-APIs/USD': [174.2, 8],
    'Telefonie/USD': [25, 1], 'Abos/EUR': [14.9, 1], 'Domains/USD': [12.5, 1], 'Domains/EUR': [9, 1],
  });
  // September: EUR 1299 + 14.90 = 1313.90 (2), USD 3 x 6 = 18 (3)
  const months = sums({ groupBy: 'month' });
  assert.deepEqual(months['2026-09/EUR'], [1313.9, 2]);
  assert.deepEqual(months['2026-09/USD'], [18, 3]);
  assert.equal(aggregate(list, { kgOnly: true }).count, 20);
  assert.equal(aggregate(list, { from: '2026-10-12', to: '2026-10-12' }).count, 4); // three payouts + one GammaAPI recharge
});

test('duplicates: the same TAX line quoted twice counts once', () => {
  const t = '#5 [2026-10-02T10:00:00Z] a · note\nTAX: 2026-10-02, EUR 10.00, Foo GmbH, tool, inv 1, KG\n\n#6 [2026-10-02T11:00:00Z] b · note\n> TAX: 2026-10-02, EUR 10.00, Foo GmbH, tool, inv 1, KG\n';
  assert.equal(parseBoardText(t).entries.length, 1);
});

test('TAX mentioned mid-sentence is not a ledger line', () => {
  assert.equal(parseBoardText('#5 [2026-10-02T10:00:00Z] a · note\nSee TAX: 2026-10-02, EUR 10.00, Foo, x, KG\nSTANDING RULE: post TAX: date\n').entries.length, 0);
});

test('aggregation: date filter, groupBy, kgOnly', () => {
  const list = parseBoardText(fixture).entries;
  const all = aggregate(list, {});
  assert.equal(all.count, list.length);
  const oct20 = aggregate(list, { from: '2026-10-20', to: '2026-10-20' });
  assert.ok(oct20.entries.every((e) => e.date === '2026-10-20'));
  assert.ok(oct20.count > 0 && oct20.count < all.count);
  const byCp = aggregate(list, { groupBy: 'counterparty' });
  assert.ok(byCp.totals.find((t) => t.key === 'GammaAPI Ltd' && t.currency === 'USD' && t.sum === 40)); // 5 x 6 + 10
  const byMonth = aggregate(list, { groupBy: 'month' });
  assert.deepEqual([...new Set(byMonth.totals.map((t) => t.key))].sort(), ['2026-09', '2026-10']);
  const kg = aggregate(list, { kgOnly: true });
  assert.ok(kg.entries.every((e) => e.kg === true));
  assert.ok(kg.count < all.count);
  assert.throws(() => aggregate(list, { groupBy: 'nope' }), /groupBy/);
  assert.throws(() => aggregate(list, { from: '24.10.2026' }), /YYYY-MM-DD/);
});

test('export: markdown table with German headers, plus TAX lines; board fills only what is newer or missing', () => {
  const md = '# Geldbewegungen\n\n| Datum | Betrag | Währung | Gegenpartei | Zweck | Beleg | KG |\n|---|---|---|---|---|---|---|\n| 2026-10-01 | 1.234,50 | EUR | Hetzner | Server | R1 | KG |\n| 2026-10-02 | 20 | USD | OpenRouter | Guthaben | R2 | privat |\n| kaputt | x | | | | | |\nTAX: 2026-10-03, EUR 5.00, Foo, tool, inv, KG\n';
  const ex = parseExport(md);
  assert.equal(ex.entries.length, 3);
  assert.equal(ex.unparsed.length, 1);
  assert.deepEqual([ex.entries[0].amount, ex.entries[0].currency, ex.entries[0].kg, ex.entries[0].category], [1234.5, 'EUR', true, 'Hosting/Server']);
  assert.equal(ex.entries[1].kg, false);
  const board = parseBoardText('#1 [2026-10-02T10:00:00Z] a · n\nTAX: 2026-10-02, USD 20.00, OpenRouter, Guthaben, inv, KG\n\n#2 [2026-10-05T10:00:00Z] a · n\nTAX: 2026-10-05, EUR 7.00, Bar, thing, inv, KG\n').entries;
  const m = mergeSources(ex.entries, board);
  assert.equal(m.boardAdded, 1); // the 2 Oct booking is already in the export, 5 Oct is newer
  assert.equal(m.entries.length, 4);
});

test('entries(): fake agent-board is paged once, cached for 5 min, refreshed with --since, board only when no export', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'agent-board');
  const second = '#99999 [2026-10-25T10:00:00Z] a · note\nTAX: 2026-10-25, EUR 1.00, Newcomer, test, inv, KG\n';
  fs.writeFileSync(path.join(dir, 'full.txt'), fixture);
  fs.writeFileSync(path.join(dir, 'since.txt'), second);
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$3" = "--since" ]; then cat '${dir}/since.txt'; else cat '${dir}/full.txt'; fi\n`, { mode: 0o755 });
  process.env.BRIDGE_BOARD_BIN = bin;
  process.env.LEDGER_EXPORT = path.join(dir, 'missing.md');
  resetLedgerCache();
  try {
    const a = await entries({});
    assert.equal(a.source.kind, 'board');
    assert.equal(a.unparsed, 0);
    const b = await entries({ groupBy: 'counterparty' });
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'second call served from cache');
    assert.equal(b.count, a.count);
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      const c = await entries({});
      assert.equal(c.count, a.count + 1);
    } finally { Date.now = realNow; }
    assert.match(fs.readFileSync(log, 'utf8'), /read 22 --since \d+/);
    assert.ok(a.fxNote.includes('0.894'));
  } finally {
    delete process.env.BRIDGE_BOARD_BIN;
    delete process.env.LEDGER_EXPORT;
    resetLedgerCache();
  }
});

test('the counterparty carries no purpose or receipt text ("— pro forma PF/…")', () => {
  for (const line of [
    '2026-10-05, EUR 100.00 net, Example GPU Hub / Foocorp — pro forma PF/12/345, 1x server rental, KG',
    '2026-10-05 | EUR 100.00 | Example GPU Hub / Foocorp — pro forma PF/12/345 | server rental | KG',
    '2026-10-05, EUR 100.00 net, Example GPU Hub / Foocorp, pro forma PF/12/345, 1x server rental, KG',
  ]) {
    const [entry] = parseTaxText(line, { entryId: 5 });
    assert.equal(entry.counterparty, 'Example GPU Hub / Foocorp', line);
    assert.match(entry.ref, /pro forma PF\/12\/345/); // the receipt stays where it belongs
  }
  assert.equal(cleanCounterparty('Plain Vendor GmbH'), 'Plain Vendor GmbH');
});

test('an undated TAX line that only references another entry (#id) is not a second payment', () => {
  const text = '#2001 [2026-10-20T10:00:00Z] agent-a · note\nTAX: 2026-10-20 10:00Z, USD 20.00, DemoAPI LLC, prepaid API credits, Stripe receipt #9000-0099, KG\n\n#2002 [2026-10-20T23:00:00Z] agent-a · finding\nSummary\n- TAX: DemoAPI USD 20 #2001; other receipt not found yet\n';
  const r = parseBoardText(text);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].entry, 2001);
});
