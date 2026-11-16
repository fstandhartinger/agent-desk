// 16 Nov 2026: (1) evaluation material is hidden from the Desk (paths.js DESK_HIDE: the evaluating job, its Claude project dir,
// its chat-mirror files, ~/desk-knowledge/eval), (2) scan.mjs, the secret gate before a chat mirror leaves the host: every file,
// fail closed, never prints the text it found.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDenied, isHidden } from '../src/paths.js';

const JOB = 'agent-desk-context-discovery-20261115';

test('hidden: the evaluating job in every place it appears, and the gold set', () => {
  for (const p of [
    `/home/flori/jobs/${JOB}/PROMPT.md`,
    `/home/flori/jobs/${JOB}/testset/README.md`,
    `/home/flori/jobs-data/${JOB}/workers/testset/RESULT.md`,
    `/home/flori/.claude-C/projects/-home-flori-jobs-${JOB}/abc.jsonl`,
    `/home/flori/desk-knowledge/chats-mirror/lechonk/sessions/jobs-${JOB}-workers-map-index__b8140232__2026-11-15.md`,
    `jobs/2026-11/${JOB}`,
    JOB,
    '/home/flori/desk-knowledge/eval/questions.jsonl',
  ]) {
    assert.equal(isHidden(p), true, p);
    assert.equal(isDenied(p), true, p);
  }
});

test('not hidden: sister jobs, other knowledge, a folder merely named eval', () => {
  for (const p of [
    '/home/flori/jobs/agent-desk-voice-history-and-voices-20261115/PROMPT.md',
    '/home/flori/jobs/agent-desk-context-discovery-20261201/PROMPT.md',
    '/home/flori/desk-knowledge/topics/servers.md',
    '/home/flori/jobs/generalist-round2-build-20261113/eval/RESULT.md',
  ]) assert.equal(isHidden(p), false, p);
});

const SCAN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'chats', 'scan.mjs');
const KEY = ['sk', 'ant', 'api03', 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0PpOoNnMmLl'].join('-');

function scan(dir) {
  const r = spawnSync(process.execPath, [SCAN, dir], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('scan.mjs: a clean mirror passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  try {
    fs.mkdirSync(path.join(dir, 'sessions'));
    fs.writeFileSync(path.join(dir, 'sessions', 'a.md'), '# Chat\nWe grep for the prefix sk-ant- in the logs; password: [REDACTED]\n');
    fs.writeFileSync(path.join(dir, '.state.json'), '{"x":{"files":["a.md"]}}');
    const r = scan(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /"files":2,.*"failed":0/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan.mjs: a key in any file fails, the key is never printed; symlinks fail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.md'), 'nothing here\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), `line one\nexport ANTHROPIC_API_KEY=${KEY}\n`);
    fs.symlinkSync('/etc/hostname', path.join(dir, 'link.md'));
    const r = scan(dir);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /FAIL secret-shaped text: notes\.txt/);
    assert.match(r.out, /FAIL symlink: link\.md/);
    assert.doesNotMatch(r.out, /Zz9Yy8Xx7Ww6/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan.mjs: usage error on a missing dir', () => {
  assert.equal(scan('/nonexistent/scan-dir').code, 2);
});
