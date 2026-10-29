import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.js';
import { fromCanonical, isDenied, resolveAllowed, toCanonical } from './paths.js';

// code.outline: the files of a code directory with line counts, first doc comment and local imports, so an agent can
// draw an architecture diagram from real code (docs/CANVAS.md "Bridge").

const MAX_FILES = 300;
const MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const LANG = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'ts', '.tsx': 'ts',
  '.py': 'py', '.sh': 'sh', '.bash': 'sh',
};
const JS_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'];

const squash = (s, n = 160) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** First comment of the file (after a shebang): block/line comments for JS/TS, docstring or # lines for Python, # lines for shell. */
export function firstDoc(text, lang) {
  const lines = text.replace(/^#!.*\n/, '').replace(/^﻿/, '').split('\n');
  const body = lines.join('\n').trimStart();
  if (lang === 'js' || lang === 'ts') {
    // index search, not /^\/\*+\s*([\s\S]*?)\*\// (quadratic on an unclosed "/****…", critic r7)
    const end = body.startsWith('/*') ? body.indexOf('*/', 2) : -1;
    if (end >= 0) return squash(body.slice(2, end).replace(/^\*+/, '').replace(/^[ \t]*\*[ \t]?/gm, ''));
    const run = [];
    for (const l of body.split('\n')) {
      const m = /^\s*\/\/\s?(.*)$/.exec(l);
      if (!m) break;
      run.push(m[1]);
    }
    return squash(run.join(' '));
  }
  if (lang === 'py') {
    const ds = /^(?:[rRuU]?)("""|''')([\s\S]*?)\1/.exec(body);
    if (ds) return squash(ds[2]);
  }
  const run = [];
  for (const l of body.split('\n')) {
    const m = /^\s*#\s?(.*)$/.exec(l);
    if (!m) { if (!l.trim() && !run.length) continue; break; }
    run.push(m[1]);
  }
  return squash(run.join(' '));
}

function jsSpecs(text) {
  const out = new Set();
  const res = [
    /\b(?:import|export)\s(?:(?!\b(?:import|export)\b)[^'"`;])*?from\s*['"]([^'"]+)['"]/g, // the lazy scan stops at the next import (critic r7)
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of res) for (const m of text.matchAll(re)) if (m[1].startsWith('.')) out.add(m[1]);
  return [...out];
}

function pySpecs(text) {
  const out = [];
  for (const m of text.matchAll(/^[ \t]*from\s+(\.+)((?:\w[\w.]*)?)\s+import\s+([\w, ]+)/gm)) {
    const base = `${'../'.repeat(m[1].length - 1) || './'}${m[2].replaceAll('.', '/')}`;
    if (m[2]) out.push(base);
    else for (const name of m[3].split(',').map((s) => s.trim()).filter(Boolean)) out.push(`${base}${name}`);
  }
  for (const m of text.matchAll(/^[ \t]*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.,\s]*))/gm)) {
    for (const mod of (m[1] ?? m[2]).split(',').map((s) => s.trim().split(/(?<!\s)\s+as\s+/)[0]).filter(Boolean)) out.push(`abs:${mod.replaceAll('.', '/')}`);
  }
  return out;
}

function shSpecs(text) {
  const out = [];
  for (const m of text.matchAll(/^[ \t]*(?:source|\.)\s+["']?([^\s"';|&]+)/gm)) out.push(m[1]);
  return out;
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function candidates(base, lang) {
  if (lang === 'py') return [`${base}.py`, path.join(base, '__init__.py')];
  if (lang === 'sh') return [base];
  const list = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => path.join(base, `index${e}`))];
  const swap = /\.(m?js|cjs|jsx?)$/.exec(base);
  if (swap) list.push(base.replace(/\.(m?js|cjs|jsx?)$/, '.ts'), base.replace(/\.(m?js|cjs|jsx?)$/, '.tsx'));
  return list;
}

/** Resolves import specs of one file to root-relative paths of files that exist inside the root. */
function resolveImports(file, lang, text, rootReal) {
  const dir = path.dirname(file);
  let specs = lang === 'py' ? pySpecs(text) : lang === 'sh' ? shSpecs(text) : jsSpecs(text);
  specs = specs.map((s) => {
    if (s.startsWith('abs:')) return { base: path.join(rootReal, s.slice(4)), alt: path.join(dir, s.slice(4)) };
    if (lang === 'sh') {
      const home = process.env.BRIDGE_HOME || process.env.HOME || '';
      const x = s.replace(/^(\$HOME|\$\{HOME\}|~)(?=\/)/, home);
      if (x.includes('$')) return null; // variable paths cannot be resolved statically
      return { base: path.resolve(dir, x) };
    }
    return { base: path.resolve(dir, s) };
  }).filter(Boolean);
  const found = new Set();
  for (const { base, alt } of specs) {
    for (const b of [base, alt].filter(Boolean)) {
      const hit = candidates(b, lang).find((c) => isFile(c));
      if (!hit) continue;
      let real;
      try { real = fs.realpathSync(hit); } catch { continue; }
      if (real !== rootReal && real.startsWith(rootReal + path.sep) && real !== file) found.add(path.relative(rootReal, real));
      break;
    }
  }
  return [...found].sort();
}

export async function outline({ path: p } = {}) {
  const rootReal = resolveAllowed(fromCanonical(String(p ?? '')));
  if (!fs.statSync(rootReal).isDirectory()) throw new Error('not a directory');
  const files = [];
  let truncated = false;
  const stack = [rootReal];
  walk: while (stack.length) {
    const dir = stack.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // symlinks never leave the root; skipping them also avoids loops
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !isDenied(abs)) stack.push(abs);
        continue;
      }
      const lang = LANG[path.extname(e.name).toLowerCase()];
      if (!e.isFile() || !lang) continue;
      try { resolveAllowed(abs); } catch { continue; } // deny list (e.g. *.env, secrets) and realpath check
      if (files.length >= MAX_FILES) { truncated = true; break walk; }
      const size = fs.statSync(abs).size;
      let text = '';
      if (size <= MAX_FILE_BYTES) text = fs.readFileSync(abs, 'utf8');
      files.push({
        path: path.relative(rootReal, abs), lines: size <= MAX_FILE_BYTES ? (text.match(/\n/g)?.length ?? 0) + (text && !text.endsWith('\n') ? 1 : 0) : null,
        lang, doc: redact(firstDoc(text, lang)), imports: resolveImports(abs, lang, text, rootReal),
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: toCanonical(rootReal), files, truncated };
}
