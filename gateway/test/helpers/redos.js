// ReDoS harness (critic round 6, P1-1). This file exists twice, byte-identical: gateway/test/helpers/redos.js and
// bridge/test/redos-helpers.js. It finds EVERY regex of a source file (literals by a small JS scanner, `new RegExp(...)`
// built at import time by recording the constructor) and builds an adversarial corpus of repeated separators, quotes,
// colons, blanks, label words and long single tokens. All inputs are synthetic.
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const KEYWORDS_BEFORE = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)$/;

/** Every regex literal of a JS source as [source, flags, line]. Skips strings, template text and comments. */
export function regexLiterals(src) {
  const out = [];
  let i = 0;
  let last = ''; // last significant char (or word end)
  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  const tmplDepth = []; // brace depth stack for `${ … }` inside template literals
  let braces = 0;
  const skipString = (q) => {
    i += 1;
    while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
    i += 1;
  };
  const skipTemplate = () => {
    // from just after a backtick (or a closing `}` of `${`): read until the closing backtick or the next `${`
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { i += 1; return; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; tmplDepth.push(braces); braces += 1; last = '{'; return; }
      i += 1;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
    if (c === '"' || c === "'") { skipString(c); last = 'a'; continue; }
    if (c === '`') { i += 1; skipTemplate(); last = 'a'; continue; }
    if (c === '{') { braces += 1; last = c; i += 1; continue; }
    if (c === '}') {
      braces -= 1;
      if (tmplDepth.length && tmplDepth[tmplDepth.length - 1] === braces) { tmplDepth.pop(); i += 1; skipTemplate(); last = 'a'; continue; }
      last = c; i += 1; continue;
    }
    if (c === '/') {
      const before = src.slice(Math.max(0, i - 12), i).trimEnd();
      const isRe = last === '' || REGEX_BEFORE.has(last) || KEYWORDS_BEFORE.test(before);
      if (isRe) {
        const start = i;
        let j = i + 1;
        let cls = false;
        while (j < src.length && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j += 1;
        }
        if (src[j] === '/') {
          let k = j + 1;
          while (/[a-z]/.test(src[k] ?? '')) k += 1;
          out.push([src.slice(start + 1, j), src.slice(j + 1, k), lineOf(start)]);
          i = k;
          last = 'a';
          continue;
        }
      }
      last = c; i += 1; continue;
    }
    if (!/\s/.test(c)) last = /[\w$]/.test(c) ? 'a' : c;
    i += 1;
  }
  return out;
}

/** Import a module while recording every RegExp it builds with `new RegExp(...)` / `RegExp(...)` at import time. */
export async function importRecordingRegExps(url) {
  const Native = globalThis.RegExp;
  const built = [];
  globalThis.RegExp = new Proxy(Native, {
    construct(target, args) { const re = Reflect.construct(target, args); built.push(re); return re; },
    apply(target, self, args) { const re = Reflect.apply(target, self, args); built.push(re); return re; },
  });
  try {
    const mod = await import(`${url}?redos=${Date.now()}`);
    return { mod, built };
  } finally {
    globalThis.RegExp = Native;
  }
}

/** All regexes of one source file: literals (compiled here) plus the ones it builds while importing. */
export async function regexesOf(fileUrl) {
  const src = fs.readFileSync(fileUrl, 'utf8');
  const res = [];
  for (const [source, flags, line] of regexLiterals(src)) {
    try { res.push({ re: new RegExp(source, flags), where: `${line}: /${source.slice(0, 60)}/` }); } catch { /* a division the scanner took for a regex */ }
  }
  // a module that only runs inside a worker (offloadWorker.js) cannot be imported here: its literals are still scanned
  const { built } = await importRecordingRegExps(fileUrl.href).catch(() => ({ built: [] }));
  for (const re of built) res.push({ re, where: `new RegExp /${re.source.slice(0, 60)}/` });
  return res;
}

const SEPS = [' ', '  ', '\t', ':', ' :', '  :', ': ', '=', ' = ', '==', ' ist', ' is', ' lautet', '->', ' -> ', '→', '  →', '—>', '=>', '"', "'", '`',
  '|', '/', ' / ', '\n', '\\n', '\r\n', '-', '_', '.', '*', '**', '#', '>', '<', '{', '}', '[', ']', '(', ')', ',', ';', '$', '%', '@', '?', '&', '~', '+', '!',
  ' | ', '- ', '* ', '> ', '\n\n', ' \n', '\\\\', '\\"', '"\\n', ':\n', ' :-> = ', 'ä', '„', '“', '…', '–', '€', '1', '0x', '12:'];
const LABELS = ['secret', 'key', 'pw', 'token', 'Token', 'passwort', 'Passwort', 'password', 'geheim', 'Geheimnis', 'Zugangsdaten', 'kennwort',
  'schlüssel', 'app secret', 'login', 'code', 'Code', 'PIN', 'tan', 'api_key', 'API_KEY', 'SYNTH_TOKEN', 'Authorization', 'Bearer', 'cookie',
  'export A_B', 'A_B=', 'machine x', 'mysql', 'sshpass', 'docker login', 'echo x', 'ssh-keygen', 'seed', 'mnemonic', 'private key', 'fingerprint',
  'http://', 'https://a.example/', '?token=', 'sk-', 'eyJ', '-----BEGIN PRIVATE KEY-----', '| key |', 'Bridge', 'läuft auf', 'Korrektur',
  'nein', 'mail', 'uid', 'claude', 'gpt', 'EUR', '€', 'Runde', 'karte', 'deploy', 'push', 'schreib', 'mail an'];
const TOKENS = ['a', 'A', '0', 'Zq7x', 'deadbeef', 'ab_', 'x.y-z', 'aA1', 'abc def'];

const fill = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

/**
 * Short probes (exponential blowups show within ~100 chars): label + n separators + a failing tail, for every label,
 * separator and pairs of separators. Returns [name, text].
 */
export function shortCorpus(n = 24) {
  const out = [];
  const tails = ['', '!', ' x', '"', '\n'];
  for (const label of LABELS) {
    for (const sep of SEPS) out.push([`${label}+${JSON.stringify(sep)}x${n}`, label + sep.repeat(n) + tails[(label.length + sep.length) % tails.length]]);
    for (let a = 0; a < SEPS.length; a += 3) {
      const b = (a * 7 + label.length) % SEPS.length;
      out.push([`${label}+(${JSON.stringify(SEPS[a] + SEPS[b])})x${n / 2}`, label + (SEPS[a] + SEPS[b]).repeat(n / 2) + '!']);
    }
  }
  for (const s of SEPS) for (const t of TOKENS) out.push([`(${JSON.stringify(s + t)})x${n}`, (s + t).repeat(n)]);
  return out;
}

/** Long probes (polynomial blowups): 20 kB runs of separators, label+separator units, long single tokens. */
export function longCorpus(size = 20_000) {
  const out = [];
  for (const s of SEPS) out.push([`run ${JSON.stringify(s)}`, fill(s, size)]);
  for (const l of LABELS) {
    out.push([`run ${JSON.stringify(`${l}: `)}`, fill(`${l}: `, size)]);
    out.push([`run ${JSON.stringify(`${l} `)}`, fill(`${l} `, size)]);
    out.push([`${JSON.stringify(l)} + 20 kB token`, `${l}: ${fill('Zq7x', size)}`]);
    out.push([`${JSON.stringify(l)} + 20 kB seps`, `${l}${fill(' : -> = ', size)}`]);
  }
  for (const t of TOKENS) out.push([`run ${JSON.stringify(t)}`, fill(t, size)]);
  out.push(['long word', fill('abcdefghij', size)]);
  out.push(['long hex', fill('0123456789abcdef', size)]);
  out.push(['long base64', fill('QWxhZGRpbjpvcGVuIHNlc2FtZQ', size)]);
  out.push(['quotes', fill(`"'\``, size)]);
  out.push(['prose', fill('Das ist ein ganz normaler Satz über Tokens und Schlüssel, pw und Geheimnisse. ', size)]);
  out.push(['Geheimnis ist ist', `Das Geheimnis ist${fill(' ist', size)}`]);
  out.push(['table rows', `| a | key |\n|---|---|\n${fill('| x | y |\n', size)}`]);
  out.push(['table no closing pipe', `| a | key |\n|---|---|\n${fill(`| ${'x'.repeat(50)}\n`, size)}`]);
  out.push(['nested brackets', fill('([{<', size / 2) + fill('>}])', size / 2)]);
  out.push(['url path', `https://a.example/${fill('a/', size)}`]);
  out.push(['url query', `https://a.example/?${fill('a=b&', size)}`]);
  out.push(['camel', fill('AbCd', size)]);
  out.push(['digits dots', fill('1.2,', size)]);
  out.push(['cjk', fill('测试', size)]);
  return out;
}

/** Deterministic random token strings (the critic's fuzz shape): a prefix, a 1-3 token unit repeated 12-21 times, a suffix. */
export function fuzzCorpus(count = 400, seed = 7) {
  const T = [...SEPS, ...LABELS.slice(0, 20), ...TOKENS];
  let s = seed;
  const rnd = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const toks = Array.from({ length: 20 + rnd(40) }, () => T[rnd(T.length)]);
    const unit = toks.slice(0, 1 + rnd(3)).join('');
    out.push([`fuzz ${i}`, toks.slice(0, 5).join('') + unit.repeat(12 + rnd(10)) + toks.slice(5, 10).join('')]);
  }
  return out;
}

/** Time one regex over one input the way the code uses it (a full global scan, or a single test). */
export function timeRegex(re, text) {
  const r = new RegExp(re.source, re.flags);
  const t = performance.now();
  if (r.global || r.sticky) { r.lastIndex = 0; text.replace(r, ''); } else r.test(text);
  return performance.now() - t;
}

/** Run every regex over every input; returns the slowest hits over the budget, worst first. Retries a slow hit once (GC noise). */
export function scanSlow(regexes, corpus, budgetMs) {
  const slow = [];
  let worst = { ms: 0 };
  for (const { re, where } of regexes) {
    for (const [name, text] of corpus) {
      let ms = timeRegex(re, text);
      if (ms > budgetMs) ms = Math.min(ms, timeRegex(re, text));
      if (ms > worst.ms) worst = { ms, where, name };
      if (ms > budgetMs) slow.push({ ms: Math.round(ms), where, name, len: text.length });
    }
  }
  return { slow: slow.sort((a, b) => b.ms - a.ms), worst };
}

// The same scan in a worker thread: an exponential regex blocks its thread for hours, so the test thread kills it after
// `timeoutMs` and reports the regex and the input it hung on.
const WORKER = `const { parentPort, workerData } = require('node:worker_threads');
const { regexes, corpus, budgetMs } = workerData;
const time = (re, text) => { const t = performance.now(); if (re.global || re.sticky) { re.lastIndex = 0; text.replace(re, ''); } else re.test(text); return performance.now() - t; };
const slow = []; let worst = { ms: 0 };
for (const [i, { source, flags, where }] of regexes.entries()) {
  const re = new RegExp(source, flags);
  for (const [j, [name, text]] of corpus.entries()) {
    if (j % 64 === 0) parentPort.postMessage({ at: [i, j] });
    let ms = time(re, text);
    if (ms > budgetMs) ms = Math.min(ms, time(re, text), time(re, text));
    if (ms > worst.ms) worst = { ms, where, name };
    if (ms > budgetMs) slow.push({ ms: Math.round(ms), where, name, len: text.length });
  }
}
parentPort.postMessage({ done: { slow: slow.sort((a, b) => b.ms - a.ms), worst } });`;

export function scanInWorker(regexes, corpus, budgetMs, timeoutMs = 120_000) {
  const list = regexes.map(({ re, where }) => ({ source: re.source, flags: re.flags, where }));
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: { regexes: list, corpus, budgetMs } });
    let at = [0, 0];
    const timer = setTimeout(() => {
      w.terminate();
      // the worker posts progress every 64 inputs: the hang is in regex at[0], at or after input at[1]
      const hung = { ms: Infinity, where: list[at[0]].where, name: `hung at or after ${corpus[at[1]][0]}`, len: corpus[at[1]][1].length };
      resolve({ slow: [hung], worst: hung });
    }, timeoutMs);
    w.on('message', (m) => {
      if (m.at) at = m.at;
      if (m.done) { clearTimeout(timer); w.terminate(); resolve(m.done); }
    });
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Critic round 7, P1-1 / P2-1: the 20 kB corpus above missed polynomial regexes that only blow up when the run is followed
// by a char that makes the match fail ("-" x n + "\0" against /-+$/), and the FILES lists left out webRead.js. These helpers
// give every source file, the recheck attack strings of fixtures/redos-attacks.json and runs with failing tails.

/** Every .js file under a src directory URL (recursive), as URLs. */
export function srcFiles(dirUrl) {
  const out = [];
  const walk = (url) => {
    for (const e of fs.readdirSync(url, { withFileTypes: true })) {
      const next = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, url);
      if (e.isDirectory()) walk(next);
      else if (e.name.endsWith('.js')) out.push(next);
    }
  };
  walk(dirUrl);
  return out.sort((a, b) => a.href.localeCompare(b.href));
}

/** One recheck attack ({pumps: [[prefix, pump]...], suffix}) pumped to about `size` chars. */
export function pumpAttack({ pumps, suffix }, size) {
  const per = pumps.reduce((n, [, p]) => n + p.length, 0) || 1;
  const k = Math.ceil(size / per);
  return pumps.map(([prefix, p]) => prefix + p.repeat(k)).join('') + suffix;
}

const TAIL_UNITS = [' ', '\t', '\n', '\r\n', '-', '.', '_', '/', '\\', ':', '=', ',', ';', '#', '*', '"', "'", '`', '<', '>', '(', '[', '{', '|', '%', '&',
  'a', 'A', 'z', '0', '9', 'ß', 'ä', 'aß', 'aµ', 'Aa', 'a1', '1.', '1,', '0x', 'eyJ', 'eyJJJ0e-0-', '%3C', '=%3C', '/WEBHOOK', 'SECRET', 'TOKEN',
  'secret', 'token ', 'pw ', ' :', ' = ', '<a x ', '<!--', '<p>', '<TITLE>', '<USE:HREF=', 'call_', 'import ', '## ', '- ', '1. ', '€', '–'];
const TAILS = ['\u0000', '\n!', '\r', ' x', 'x'];
/** Runs of one unit (`size` chars) followed by a char that makes most matches fail: the shape of a polynomial blowup. */
export function tailCorpus(size = 64_000) {
  return TAIL_UNITS.flatMap((u, i) => [[`run ${JSON.stringify(u)} + ${JSON.stringify(TAILS[i % TAILS.length])}`, fill(u, size) + TAILS[i % TAILS.length]]]);
}
