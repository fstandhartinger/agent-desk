#!/usr/bin/env node
// Secret gate for a chat mirror before it leaves the host (16 Nov 2026, review #63459): every file below <dir>, whatever its
// extension, is run through the bridge's own redact() (the shape patterns of redactPatterns.js, this host's exact secret values
// and their fragments). A file passes only when redact() leaves it unchanged, so the gate covers exactly the token families the
// redactor knows, and grows with it. A file too complex for the redaction budget fails (fail closed); so does an unreadable one.
// Output: counts and relative paths only, never text. Exit 0 = clean, 3 = at least one file failed, 2 = usage.
// Usage: node scan.mjs <dir> [--max-bytes N]
import fs from 'node:fs';
import path from 'node:path';
import { redact, REDACT_FALLBACK } from '../../src/redact.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const mi = args.indexOf('--max-bytes');
const MAX_BYTES = mi >= 0 ? Number(args[mi + 1]) : 4 * 1024 * 1024;
if (!dir || !fs.existsSync(dir) || !Number.isFinite(MAX_BYTES)) { console.error('usage: scan.mjs <dir> [--max-bytes N]'); process.exit(2); }

/** Every regular file below root (symlinks are reported, never followed). */
function* walk(root) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield { p, link: e.isSymbolicLink(), file: e.isFile() };
  }
}

const failed = [];
let files = 0;
let bytes = 0;
for (const { p, link, file } of walk(dir)) {
  const rel = path.relative(dir, p);
  if (link || !file) { failed.push({ rel, why: link ? 'symlink' : 'not a regular file' }); continue; }
  files += 1;
  let text;
  try {
    const st = fs.statSync(p);
    bytes += st.size;
    if (st.size > MAX_BYTES) { failed.push({ rel, why: 'too large to check' }); continue; }
    text = fs.readFileSync(p, 'utf8');
  } catch { failed.push({ rel, why: 'unreadable' }); continue; }
  // Lines one by one: the budgeted pattern run is per call, and a long day file would hit the budget as a whole.
  let why = null;
  for (const line of text.split('\n')) {
    const out = redact(line);
    if (out === line) continue;
    why = out === REDACT_FALLBACK ? 'line too complex for the secret check' : 'secret-shaped text';
    break;
  }
  if (why) failed.push({ rel, why });
}
console.log(JSON.stringify({ dir: path.resolve(dir), files, bytes, failed: failed.length }));
for (const f of failed) console.log(`FAIL ${f.why}: ${f.rel}`);
process.exit(failed.length ? 3 : 0);
