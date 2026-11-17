import assert from 'node:assert/strict';
import test from 'node:test';
import { renderIndex, isRedactionFixedPoint, INDEX_CUT } from '../scripts/chats/mirror.mjs';
import { REDACT_FALLBACK, OFFLOAD_FROM } from '../src/redact.js';

const secret = `ghp_${'a1B2c3D4e5'.repeat(3)}`;
const lines = ['# Agent-Chats sandy (Inhaltsverzeichnis)\n', '## Projekt demo'];
for (let i = 0; i < 3000; i += 1) lines.push(`- Claude ${String(i).padStart(8, '0')}: 2026-11-17, 4 KB: Frage Nummer ${i} zum Ledger`);
lines.push(`- Claude deadbeef: 2026-11-17, 1 KB: token ${secret} pasted`);

test('a large index is redacted line by line, never replaced wholesale by the fallback marker', () => {
  const out = renderIndex(lines);
  assert.ok(out.length > OFFLOAD_FROM * 10);
  assert.ok(!out.includes(REDACT_FALLBACK));
  assert.ok(out.includes('Frage Nummer 2999 zum Ledger'));
  assert.ok(!out.includes(secret));
  assert.ok(isRedactionFixedPoint(out.split('\n')));
});

test('the cap cuts at a line boundary and says so', () => {
  const out = renderIndex(lines, 20_000);
  assert.ok(out.length <= 20_000 + INDEX_CUT.length + 1);
  assert.ok(out.endsWith(INDEX_CUT));
  assert.ok(out.split('\n').slice(2, -1).every((l) => l === '' || l.startsWith('- ') || l.startsWith('#') || l.startsWith('##')));
  assert.ok(isRedactionFixedPoint(out.split('\n')));
});
