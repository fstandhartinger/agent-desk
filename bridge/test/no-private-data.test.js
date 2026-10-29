import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The repo is PUBLIC. Test data must stay synthetic. This guard names nothing private:
//  1. generic patterns (card digits, wallet keys, VAT ids) and
//  2. a deny list of sha256 hashes of private tokens. The list is NOT in the repo (short amounts could be brute-forced from
//     public hashes): it lives in ~/.config/agent-desk/private-hashes.json (0600) on the workshop hosts, or DESK_PRIVATE_HASHES.
//     Without it only the generic patterns run. Failures print file:line only, never the token.
const root = new URL('../..', import.meta.url).pathname;
const hashesFile = process.env.DESK_PRIVATE_HASHES || path.join(process.env.HOME || '', '.config/agent-desk/private-hashes.json');
const haveHashes = fs.existsSync(hashesFile);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const GENERIC = new RegExp(['(••|Visa \\*)[1-9]\\d{3}\\b', '\\b5(?!Fake)[1-9A-HJ-NP-Za-km-z]{47}\\b', '\\bDE(?!0{9})\\d{9}\\b'].join('|'));

/** Candidate tokens of one line, lower-cased: whole words, comma-free numbers, German-format numbers, trailing ".00" dropped, hyphen/slash pieces. */
export function lineTokens(line) {
  const out = new Set();
  const add = (t) => { if (t.length >= 4) out.add(t); };
  for (const word of line.toLowerCase().split(/[\s"'`()[\]{}<>=;|*#!?\\€$£~≈]+/u)) {
    const t = word.replace(/^[.,:;/+_-]+|[.,:;/+_-]+$/g, '');
    if (t.length < 4) continue;
    add(t);
    const plain = /^\d{1,3}(\.\d{3})+,\d+$/.test(t) ? t.replaceAll('.', '').replace(',', '.') : t.replaceAll(',', '');
    add(plain);
    add(plain.replace(/\.0+$/, ''));
    for (const piece of t.split(/[,/:_-]/)) add(piece.replace(/^\.+|\.+$/g, ''));
  }
  return out;
}

/** 1-based line numbers of text where a token hashes into the deny set. */
export function denyHits(text, denySet) {
  const lines = [];
  text.split('\n').forEach((line, i) => {
    for (const t of lineTokens(line)) if (denySet.has(sha(t))) { lines.push(i + 1); break; }
  });
  return lines;
}

const trackedTextFiles = () => execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', cwd: root })
  .split('\0').filter((f) => f && !/(^|\/)package-lock\.json$/.test(f))
  .filter((f) => { try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; } });
const readText = (f) => {
  const buf = fs.readFileSync(path.join(root, f));
  return buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8');
};

test('deny list is well formed: unique sha256 hex, no plain tokens', { skip: !haveHashes && 'private hash list not on this host' }, () => {
  const list = JSON.parse(fs.readFileSync(hashesFile, 'utf8'));
  assert.ok(list.hashes.length >= 50);
  assert.ok(list.hashes.every((h) => /^[0-9a-f]{64}$/.test(h)));
  assert.equal(new Set(list.hashes).size, list.hashes.length);
});

test('the deny-list matcher finds a token in its various spellings and prints only line numbers', () => {
  const secret = 'zzsynthetic-token';
  const amount = '7654.32';
  const deny = new Set([sha(secret), sha(amount)]);
  const text = ['clean line', `see ${secret.toUpperCase()}, please`, 'x', 'paid EUR 7,654.32.', 'paid 7.654,32 € net', `id=${secret}`, 'part: zzsynthetic only'].join('\n');
  assert.deepEqual(denyHits(text, deny), [2, 4, 5, 6]);
  assert.deepEqual(denyHits('nothing here at 7654.33', deny), []);
});

test('tracked files carry no card digits, wallet keys or VAT ids', () => {
  const hits = [];
  for (const f of trackedTextFiles()) {
    const text = readText(f);
    if (text === null) continue;
    text.split('\n').forEach((line, i) => { if (GENERIC.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});

test('tracked files contain no private token from the hashed deny list', { skip: !haveHashes && 'private hash list not on this host' }, () => {
  const deny = new Set(JSON.parse(fs.readFileSync(hashesFile, 'utf8')).hashes);
  const hits = [];
  for (const f of trackedTextFiles()) {
    const text = readText(f);
    if (text === null) continue;
    for (const n of denyHits(text, deny)) hits.push(`${f}:${n}`);
  }
  assert.deepEqual(hits, []);
});
