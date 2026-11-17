import assert from 'node:assert/strict';
import test from 'node:test';
import { readProjectDirectory } from '../scripts/chats/mirror.mjs';

const missing = () => Object.assign(new Error('synthetic missing directory'), { code: 'ENOENT' });

test('chat mirror retries a Claude project directory that disappears during enumeration', () => {
  let calls = 0;
  const entries = readProjectDirectory('/synthetic/.claude/projects/project-a', () => {
    calls += 1;
    if (calls === 1) throw missing();
    return ['01234567-session.jsonl'];
  });

  assert.deepEqual(entries, ['01234567-session.jsonl']);
  assert.equal(calls, 2);
});

test('chat mirror fails closed when a Claude project directory stays missing', () => {
  let calls = 0;
  assert.throws(() => readProjectDirectory('/synthetic/.claude/projects/project-a', () => {
    calls += 1;
    throw missing();
  }), (error) => error.code === 'ERR_INCOMPLETE_CHAT_SNAPSHOT' && /Claude project directory disappeared/.test(error.message));

  assert.equal(calls, 3);
});

test('chat mirror does not retry other directory errors', () => {
  let calls = 0;
  const denied = Object.assign(new Error('synthetic permission error'), { code: 'EACCES' });
  assert.throws(() => readProjectDirectory('/synthetic/.claude/projects/project-a', () => {
    calls += 1;
    throw denied;
  }), denied);
  assert.equal(calls, 1);
});
