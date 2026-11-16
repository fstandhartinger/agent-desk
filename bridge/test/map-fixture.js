// A small synthetic desk home for the map tests: core docs, knowledge topics, a notes mirror with jobs (one denied by name, one
// with a denied file, one with a secret in it), a laptop mirror, a skill, a code repo and a fake `sandy-read` for the board.
// Everything is invented. Import this BEFORE ../src/paths.js is loaded (BRIDGE_HOME is read at import time).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// built at run time: the repo is public and secret scanners match key-shaped literals in files
export const SECRET = ['sk', 'proj', 'AbCdEf0123456789xyzXYZ0123456789abcdefQQ'].join('-');
export const DENIED_MARKER = 'DENIEDMARKERZEBRA';

const write = (file, text, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) { const t = new Date(mtime); fs.utimesSync(file, t, t); }
};

export const DECISIONS = `<!-- LeChonk READ-ONLY copy: header comment, not an entry -->
## 2026-11-14 10:00Z — Acme crypto rule stays
- Never run crypto nodes at Acme Cloud: the contract forbids mining. Applies to all agents.
resolved-keys: hetzner-crypto-rule-1114

## 2026-11-02 09:30Z — Scoring phase budget
- Florian approved USD 370 for a 36-hour scoring phase on 3 GPUs.
Key: scoring-budget-1102

## 2026-10-20 08:00Z — Tax reserve share
- Keep 25 % of widget revenue as tax reserve.
`;

/** Creates the fake home and returns {home, mapDir, boardCmd, boardFile, env, run(args), setBoard(entries)}. */
export function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'map-home-'));
  const mapDir = path.join(home, 'desk-knowledge', 'map');
  const mirror = path.join(home, '.cache', 'agent-desk', 'job-notes');
  const boardFile = path.join(home, 'board-entries.json');
  const boardCmd = path.join(home, 'fake-sandy-read.mjs');

  write(path.join(home, 'AGENTS.md'), '# Shared rules\n\nIntro line about the rules.\n\n## 0. Servers\n\nSandy is the control plane.\n\n## 1. Money\n\nNever spend without a limit.\n');
  write(path.join(home, 'DECISIONS.md'), DECISIONS);
  write(path.join(home, 'STATE.md'), '# STATE\n\nCurrent picture only.\n');
  write(path.join(home, 'CLAUDE.md'), 'Read AGENTS.md first.\n');
  write(path.join(home, 'desk-knowledge', 'INDEX.md'), '# Knowledge index\n\nTopics: tax and reserves.\n');
  write(path.join(home, 'desk-knowledge', 'topics', 'steuer.md'), '# Tax and reserves\n<!-- keywords: tax, reserve -->\nThe tax reserve is 25 percent of widget revenue; the quarterly estimate is due in March.\n');

  const job = (name, files, mtime = '2026-11-02T10:00:00Z') => {
    for (const [file, text] of Object.entries(files)) write(path.join(mirror, name, file), text, mtime);
  };
  job('alpha-job-20261101', {
    'STATE.md': '# STATE — alpha\n\nLead: opus.\n- step one done\n- FINAL DONE\n',
    'RESULT.md': `# RESULT — alpha\n\n## Summary\nThe landing pages went live and the scoring phase budget was confirmed.\n\nNote: OPENAI_API_KEY=${SECRET} must never appear.\n`,
    'PROMPT.md': '# Landing pages for alpha\n\nBuild the pages.\n',
    'token.txt': `${DENIED_MARKER} denied by file name`,
    'sub/notes.md': '# Sub notes\n\nDeeper file about marmalade recipes.\n',
  });
  write(path.join(mirror, 'alpha-job-20261101', 'big.md'), `# Big\n${'lorem ipsum '.repeat(200_000)}\n`, '2026-11-02T10:00:00Z'); // > 2 MB: skipped
  job('beta-job-20261002', { 'STATE.md': '# STATE beta\n\nworking on pricing\n- next: critic round\n', 'PROMPT.md': '# Pricing review for beta\n\nCheck the price list.\n' }, '2026-10-05T10:00:00Z');
  job('widget-emission-tranche-20261015', { 'STATE.md': '# STATE tranche\n\nTranche converted.\n- PARKED\n' }, '2026-10-16T10:00:00Z');
  job('wallet-keys-20261101', { 'STATE.md': `# denied by name\n\n${DENIED_MARKER}\n` });
  job('nodate-job', { 'STATE.md': '# STATE nodate\n\nOld job without a date suffix.\n' }, '2026-08-05T10:00:00Z');
  write(path.join(mirror, '.synced'), new Date().toISOString());

  const laptop = path.join(home, 'data', 'laptop-mirror');
  write(path.join(laptop, 'INDEX.md'), '# Laptop-Spiegel\n\n## Projekt Demo\n');
  write(path.join(laptop, 'sessions', 'Demo__abcd1234__2026-11-10.md'),
    '# Laptop Claude Code, Projekt Demo, Sitzung abcd1234, 2026-11-10 (UTC)\n\nNur gesprochener Text.\n\n### 2026-11-10 09:00 UTC — Florian\nWie viel kostet die Bewertungsphase mit 36 Stunden?\n\n### 2026-11-10 09:01 UTC — Claude\nEtwa 370 USD für drei GPUs, das ist freigegeben.\n');
  write(path.join(laptop, 'sessions', 'Demo__abcd1234__2026-11-12.md'), '# Laptop Claude Code, Projekt Demo, Sitzung abcd1234, 2026-11-12 (UTC)\n\n### 2026-11-12 08:00 UTC — Florian\nBitte prüfe den Zustand der Server.\n');
  // server agent chats as a compact mirror (bridge/scripts/chats/mirror.mjs, discovery round 2)
  const chats = path.join(home, 'desk-knowledge', 'chats-mirror', 'lechonk');
  write(path.join(chats, 'INDEX.md'), '# Agent-Chats lechonk\n\n## Projekt jobs-demo-job\n');
  write(path.join(chats, 'sessions', 'jobs-demo-job__0badc0de__2026-11-15.md'), '# Agent-Chat lechonk, Codex, Projekt jobs-demo-job, Sitzung 0badc0de, 2026-11-15 (UTC)\n\n### 2026-11-15 15:30 UTC — Auftrag/Mensch\nPrüfe den Duo-Gewinn von Trainingsversuch 2.\n\n### 2026-11-15 15:40 UTC — Agent (Codex)\nDer Duo-Gewinn ist ein Messartefakt der Rehearsal-Fenster.\n');
  write(path.join(laptop, 'memory', 'feedback-demo.md'), '---\nname: feedback-demo\ndescription: Florian prefers short answers\n---\nKeep answers short.\n');

  write(path.join(home, '.agents', 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill used to test the map\n---\n# Demo\n\nThis skill talks about cucumbers.\n');
  write(path.join(home, 'Dev', 'explainer-pages', 'pages', 'demo-page-abc123', 'deepdive.md'), '# Demo explainer\n\nA page about penguins and their winter plans.\n');
  write(path.join(home, 'Dev', 'explainer-pages', 'pages', 'demo-page-abc123', 'context.json'), JSON.stringify({ title: 'Demo explainer title' }));
  write(path.join(home, 'Dev', 'explainer-pages', 'pages', '.slugs'), 'not a page');
  write(path.join(home, 'work', 'agent-desk', 'README.md'), '# agent-desk\n\nA private agent page for testing the code source.\n\nSecond paragraph.\n');
  write(path.join(home, 'work', 'agent-desk', 'docs', 'SPEC.md'), '# Spec\n\nThe bridge protocol is described here.\n');
  write(path.join(home, 'work', 'agent-desk', 'bridge', 'src', 'x.js'), '// source code is not indexed\nexport const sourceMarkerPelican = 1;\n');
  write(path.join(home, 'work', 'agent-desk', 'bridge', 'README.md'), '# bridge\n\nThe LeChonk side.\n');

  fs.writeFileSync(boardCmd, `#!/usr/bin/env node
import fs from 'node:fs';
const sql = process.argv[3] || '';
const file = ${JSON.stringify(boardFile)};
const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
if (/from threads/.test(sql)) {
  console.log(JSON.stringify(['id', 'title']));
  console.log(JSON.stringify([22, 'System1 Models + REAX']));
  console.log(JSON.stringify([15, 'Ops & security']));
} else {
  const after = Number(/id > (\\d+)/.exec(sql)?.[1] ?? 0);
  console.log(JSON.stringify(['id', 'thread_id', 'author', 'kind', 'created_at', 'body']));
  for (const e of entries.filter((x) => x[0] > after).slice(0, 1000)) console.log(JSON.stringify(e));
}
`, { mode: 0o755 });
  const setBoard = (entries) => fs.writeFileSync(boardFile, JSON.stringify(entries));
  setBoard([
    [1, 22, 'claude:job-a', 'decision', '2026-11-13T10:00:00Z', 'Decision: the scoring phase takes 36 hours and costs USD 370, approved.'],
    [2, 15, 'codex:job-b', 'note', '2026-11-14T11:00:00Z', 'Disk check on LeChonk is green.'],
    [3, 22, 'claude:job-c', 'finding', '2026-11-14T12:00:00Z', 'Tax reserve invoice for the widget shipment arrived.'],
  ]);

  const env = { ...process.env, BRIDGE_HOME: home, BRIDGE_NOTES_MIRROR: mirror };
  const run = (...args) => {
    execFileSync(process.execPath, [new URL('../scripts/map/build.mjs', import.meta.url).pathname, '--dir', mapDir, '--board-cmd', boardCmd, '--quiet', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    return JSON.parse(fs.readFileSync(path.join(mapDir, 'status.json'), 'utf8'));
  };
  return { home, mapDir, mirror, boardCmd, boardFile, env, run, setBoard, write, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
