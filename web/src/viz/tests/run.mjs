// Unit tests for the pure viz modules (layout, describe). The web package has no test runner and may not add one, so
// esbuild (already installed as Vite's bundler) compiles each *.test.mjs with its TS imports, then `node --test` runs
// them. Usage (from web/): node src/viz/tests/run.mjs
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here).filter((f) => f.endsWith('.test.mjs'));
const out = mkdtempSync(path.join(tmpdir(), 'viz-tests-'));
try {
  await build({
    entryPoints: tests.map((f) => path.join(here, f)),
    outdir: out, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
    // lucide-react is only used for icons; tests never render, so a stub keeps the bundle tiny.
    plugins: [{ name: 'stub-icons', setup(b) { b.onResolve({ filter: /^lucide-react$/ }, () => ({ path: 'lucide', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const Bot = null, Briefcase = null, FileText = null, Hash = null, Lightbulb = null, MessagesSquare = null, Scale = null, Sparkles = null, TriangleAlert = null, User = null, Wrench = null;', loader: 'js' })); } }],
  });
  const files = readdirSync(out).filter((f) => f.endsWith('.js')).map((f) => path.join(out, f));
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
