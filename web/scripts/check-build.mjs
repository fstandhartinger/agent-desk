// Fails the build when development-only code reaches the production bundle (critic D18: the mock layer shipped).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../dist/assets/', import.meta.url).pathname;
// Mock layer, canvas fixtures/demo (fixture titles are unique strings) and the dev demo page.
const FORBIDDEN = ['MockVoiceSocket', 'installMock', 'desk.mock.auth', 'Wie der Video-Versand blockiert wird', 'GPU-Stunden pro Job diese Woche', 'Canvas-Demo'];
const hits = readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .flatMap((f) => FORBIDDEN.filter((s) => readFileSync(join(dir, f), 'utf8').includes(s)).map((s) => `${f}: ${s}`));
if (hits.length) {
  console.error(`dev-only code in the production bundle:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
// Initial JS (entry + statically imported chunks + the App chunk the entry loads at start) must stay < 230 KB gzip;
// elkjs must be its own lazy chunk.
import { gzipSync } from 'node:zlib';
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const entry = /src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const src = (f) => readFileSync(join(dir, f), 'utf8');
const initial = new Set();
const visit = (f, dynamicToo) => {
  if (initial.has(f) || !files.includes(f)) return;
  initial.add(f);
  const code = src(f);
  for (const m of code.matchAll(/(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g)) visit(m[1], false);
  // The entry's dynamic import of App runs on every load (main.tsx boot), so it counts as initial.
  if (dynamicToo) for (const m of code.matchAll(/import\(["']\.\/(App-[^"']+\.js)["']\)/g)) visit(m[1], false);
};
if (entry) visit(entry, true);
const gz = [...initial].reduce((s, f) => s + gzipSync(src(f)).length, 0);
const elk = files.filter((f) => src(f).includes('org.eclipse.elk'));
console.log(`check-build: initial JS ${(gz / 1024).toFixed(1)} KB gzip (${[...initial].join(', ')}); elk chunk: ${elk.join(', ') || 'none'}`);
if (gz > 230 * 1024) { console.error('initial JS exceeds 230 KB gzip'); process.exit(1); }
if (elk.some((f) => initial.has(f))) { console.error('elkjs is in the initial bundle; it must be a lazy chunk'); process.exit(1); }
console.log('check-build: no mock code in dist');
