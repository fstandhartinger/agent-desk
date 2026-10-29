import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callDetail, callTarget, resultSummary } from '../describe.ts';

// Real `summary` strings as the gateway sends them: redacted, whitespace-flattened JSON, cut at 200 chars.
const LIST = '{ "jobs": [ { "name": "mail-domains-gmail-20261002", "path": "/home/flori/jobs/mail-domains-gmail-20261002", "modified": "2026-10-24T09:12:00.000Z", "finalDone": true, "host": "sandy", "summary": "…';
const STATUS = '{ "name": "reax2-next-steps-20261024", "path": "/home/flori/jobs/reax2-next-steps-20261024", "modified": "2026-10-24T09:40:00.000Z", "finalDone": false, "host": "lechonk", "state": "# STATE…';
const CORE = '{ "name": "DECISIONS", "path": "/home/flori/DECISIONS.md", "size": 184320, "truncated": true, "text": "# Decisions resolved-keys: …';
const READ = '{ "path": "/home/flori/jobs/x/workers/voice/OUTPUT.md", "offset": 0, "lines": 120, "size": 5120, "truncated": false, "text": "…';

test('ActivityRail chips never show raw JSON (critic: tiles showed { "name": …)', () => {
  const cases = [
    ['list_jobs', LIST, 'mail-domains-gmail-20261002 …'],
    ['job_status', STATUS, 'reax2-next-steps-20261024 · offen'],
    ['read_core_doc', CORE, 'DECISIONS.md · 180 KB'],
    ['read_file', READ, 'OUTPUT.md · 120 Zeilen'],
    ['search_files', '{ "query": "lium", "hits": [] }', 'keine Treffer'],
    ['search_files', '{ "query": "lium", "hits": [ { "path": "/home/flori/jobs/jev/STATE.md", "line": 3, "text": "Pod lium…', 'Treffer: STATE.md'],
    ['claude_task', '{ "sid": "d20261024-a3f9c1" }', 'Session d20261024-a3f9c1 gestartet'],
    ['claude_task', '{ "sid": "d20261024-a3f9c1", "sent": true }', 'an d20261024-a3f9c1 gesendet'],
    ['claude_status', '{ "sessions": [ { "sid": "d1", "title": "x" }, { "sid": "d2", "title": "y" } ] }', '2 Sessions'],
    ['explainer_point', '{ "title": "Gleiche GPU, gleiche Session", "short": "…', 'Gleiche GPU, gleiche Session'],
    ['board_read', '{ "text": "#120 [2026-10-24 09:00] gpu-reaper: …', 'Einträge gelesen'],
    ['some_new_tool', '{ "weird": [1, 2, 3] }', ''],
  ];
  for (const [name, summary, want] of cases) assert.equal(resultSummary(name, summary), want, name);
  for (const [name, summary] of cases) {
    const d = callDetail({ name, status: 'done', target: 'ziel', summary });
    assert.doesNotMatch(d, /[{}"[\]]/, `${name}: ${d}`);
  }
});

test('targets are human: file basename, job name, thread number, quoted query', () => {
  assert.equal(callTarget('read_file', { path: '/home/flori/jobs/x/STATE.md', offset: 0 }), 'STATE.md');
  assert.equal(callTarget('read_core_doc', { name: 'DECISIONS' }), 'DECISIONS.md');
  assert.equal(callTarget('job_status', { name: 'reax2-next-steps-20261024' }), 'reax2-next-steps-20261024');
  assert.equal(callTarget('board_read', { thread: '15', limit: 5 }), '#15');
  assert.equal(callTarget('search_chats', { query: 'gemini live' }), '„gemini live“');
  assert.equal(callTarget('list_jobs', { activeOnly: true }), '');
  assert.equal(callTarget('board_threads', {}), '');
});

test('details: running shows the target, errors show the message, plain-text summaries pass through', () => {
  assert.equal(callDetail({ name: 'list_jobs', status: 'start', target: '' }), 'läuft …');
  assert.equal(callDetail({ name: 'read_file', status: 'start', target: 'STATE.md' }), 'STATE.md');
  assert.equal(callDetail({ name: 'read_file', status: 'error', target: 'x', summary: 'path not allowed' }), 'path not allowed');
  assert.equal(callDetail({ name: 'read_file', status: 'error', target: 'x', summary: '{"code":1}' }), 'Fehler');
  assert.equal(callDetail({ name: 'job_status', status: 'done', target: 'job-a', summary: 'STATE.md: 5 workers, 2 accepted' }), 'STATE.md: 5 workers, 2 accepted');
  assert.equal(callDetail({ name: 'board_threads', status: 'done', target: '', summary: '' }), 'fertig');
});
