#!/usr/bin/env node
// Secret gate for a chat mirror before it leaves the host (16 Nov 2026, review #63459 and the Claude review of PR #49). Every file
// below <dir>, whatever its extension, and every file name is run through the bridge's own redact() (the shape patterns of
// redactPatterns.js, this host's exact secret values and their fragments). A file passes only when redact() leaves each line and
// each pair of adjacent lines unchanged (a key on one line, its value on the next), and, for files up to 8 KB, the whole text.
// mirror.mjs writes its output as exactly such a fixed point (settle()). Fails closed: no known secret values loaded, symlinks,
// special files, binary or non-UTF-8 content, unreadable or too large files, text too complex for the redaction budget.
// Output: counts and relative paths only, never text (a name that is itself secret-shaped is shown as "<name hidden>").
// Exit 0 = clean; anything else blocks the push (3 = at least one failure, 2 = usage, 1 = crash).
// Usage: node scan.mjs <dir> [--max-bytes N]
import fs from 'node:fs';
import path from 'node:path';
import { redact, REDACT_FALLBACK, OFFLOAD_FROM } from '../../src/redact.js';
import { secretValueCount } from '../../src/secretValues.js';

const args = process.argv.slice(2);
const mi = args.indexOf('--max-bytes');
const MAX_BYTES = mi >= 0 ? Number(args[mi + 1]) : 4 * 1024 * 1024;
const positional = args.filter((a, i) => !a.startsWith('--') && !(mi >= 0 && i === mi + 1));
const dir = positional.length === 1 ? positional[0] : null;
if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || !Number.isFinite(MAX_BYTES) || MAX_BYTES <= 0) {
  console.error('usage: scan.mjs <dir> [--max-bytes N]');
  process.exit(2);
}

const failed = [];
const fail = (rel, why) => failed.push({ rel: redact(rel) === rel ? rel : '<name hidden>', why });

// Without this host's secret values only the shape patterns would run: a plain password would pass (fail closed instead).
if (!(secretValueCount() > 0)) {
  console.log(JSON.stringify({ dir: path.resolve(dir), files: 0, bytes: 0, failed: 1 }));
  console.log('FAIL no known secret values loaded: the exact-value check cannot run');
  process.exit(3);
}

/** Every entry below root; symlinks are reported, never followed. */
function* walk(root) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    yield { p, link: e.isSymbolicLink(), file: e.isFile(), directory: e.isDirectory() };
    if (e.isDirectory()) yield* walk(p);
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const changed = (t) => { const out = redact(t); return out === t ? null : (out === REDACT_FALLBACK ? 'text too complex for the secret check' : 'secret-shaped text'); };

let files = 0;
let bytes = 0;
for (const { p, link, file, directory } of walk(dir)) {
  const rel = path.relative(dir, p);
  if (redact(rel) !== rel) { fail(rel, 'secret-shaped file name'); continue; }
  if (directory) continue;
  if (link || !file) { fail(rel, link ? 'symlink' : 'not a regular file'); continue; }
  files += 1;
  let text;
  try {
    const st = fs.statSync(p);
    bytes += st.size;
    if (st.size > MAX_BYTES) { fail(rel, 'too large to check'); continue; }
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) { fail(rel, 'binary content'); continue; }
    text = utf8.decode(buf);
  } catch (err) { fail(rel, err instanceof TypeError ? 'not valid UTF-8' : 'unreadable'); continue; }
  const lines = text.split('\n');
  let why = text.length <= OFFLOAD_FROM ? changed(text) : null;
  for (let i = 0; !why && i < lines.length; i += 1) why = changed(lines[i]) ?? (i + 1 < lines.length ? changed(`${lines[i]}\n${lines[i + 1]}`) : null);
  if (why) fail(rel, why);
}
console.log(JSON.stringify({ dir: path.resolve(dir), files, bytes, failed: failed.length }));
for (const f of failed) console.log(`FAIL ${f.why}: ${f.rel}`);
process.exit(failed.length ? 3 : 0);
