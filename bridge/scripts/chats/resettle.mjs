#!/usr/bin/env node
// Self-heal for the chat-mirror secret gate (#86913, 26 Nov 2026). mirror.mjs renders a day file as a fixed point of redact()
// and then leaves it alone until its transcript changes. When this host's secret value set grows later (a new store, a new
// value), an old day file that names the new value is no fixed point any more, and scan.mjs blocks the whole push, every run.
// This settles exactly the files the gate named, in the mirror directory, with the same settle() as the render. The gate itself
// is unchanged: the push script stages and scans the WHOLE mirror again afterwards and pushes only when that scan passes.
// Refuses anything that is not a regular file inside <mirror-dir> (no symlinks, no "..", no hidden names). Output: counts only.
// Usage: node resettle.mjs <mirror-dir> <scan-output-file>
import fs from 'node:fs';
import path from 'node:path';
import { redact, REDACT_FALLBACK, OFFLOAD_FROM } from '../../src/redact.js';
import { settle } from './mirror.mjs';

const FAIL_LINE = /^FAIL (?:secret-shaped text|text too complex for the secret check): (.+)$/;

/** Relative paths the gate failed on (hidden names and anything outside the mirror are skipped). */
export function failedPaths(scanOutput) {
  const out = [];
  for (const line of String(scanOutput).split('\n')) {
    const m = line.match(FAIL_LINE);
    if (!m || m[1] === '<name hidden>') continue;
    const rel = path.posix.normalize(m[1]);
    if (path.isAbsolute(rel) || rel.startsWith('..') || rel.split('/').some((p) => !p || p.startsWith('.'))) continue;
    out.push(rel);
  }
  return [...new Set(out)];
}

/** Settle one file in place (mode 0600, mtime kept). Returns 'settled' | 'unchanged' | 'refused'. */
export function resettleFile(dir, rel) {
  const root = fs.realpathSync(dir);
  const p = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(p); } catch { return 'refused'; }
  if (!st.isFile() || path.relative(root, fs.realpathSync(p)) !== rel) return 'refused';
  const text = fs.readFileSync(p, 'utf8');
  let base = text;
  if (text.length <= OFFLOAD_FROM) { const r = redact(text); if (r !== REDACT_FALLBACK) base = r; } // the gate checks small files whole too
  const next = settle(base);
  if (next === text) return 'unchanged';
  const tmp = `${p}.resettle.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, next, { mode: 0o600, flag: 'wx' }); // never through a planted file or symlink
    fs.chmodSync(tmp, 0o600);
    fs.utimesSync(tmp, st.atime, st.mtime);
    fs.renameSync(tmp, p);
  } catch (err) { try { fs.unlinkSync(tmp); } catch { /* not created */ } throw err; }
  return 'settled';
}

async function main() {
  const [dir, scanFile] = process.argv.slice(2);
  if (!dir || !scanFile || !fs.statSync(dir).isDirectory()) { console.error('usage: resettle.mjs <mirror-dir> <scan-output-file>'); process.exit(2); }
  const counts = { listed: 0, settled: 0, unchanged: 0, refused: 0 };
  for (const rel of failedPaths(fs.readFileSync(scanFile, 'utf8'))) { counts.listed += 1; counts[resettleFile(dir, rel)] += 1; }
  console.log(JSON.stringify({ resettle: path.resolve(dir), ...counts }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
