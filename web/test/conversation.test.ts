import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The legacy single-conversation key must be migrated on first load.
localStorage.setItem('desk.conversation.v1', JSON.stringify({
  id: 'c_legacy',
  messages: [
    { id: 'm1', role: 'user', via: 'text', parts: [{ kind: 'text', text: 'Welche Jobs laufen gerade?' }], ts: 1000, status: 'done' },
    { id: 'm2', role: 'assistant', via: 'text', parts: [{ kind: 'text', text: 'Sieben Jobs laufen.' }], ts: 2000, status: 'streaming' },
  ],
}));
const conv = await import('../src/lib/conversation.ts');
const { convStore, libraryStore, addMessage, appendText, newConversation, openConversation, deleteConversation, searchConversations, flushConversation, setStatusText, finish, dayGroup } = conv;

test('legacy conversation is migrated, a reload never resurrects a spinner', () => {
  assert.equal(convStore.get().id, 'c_legacy');
  assert.equal(convStore.get().messages[1].status, 'stopped');
  assert.equal(localStorage.getItem('desk.conversation.v1'), null);
  assert.equal(libraryStore.get()[0].title, 'Welche Jobs laufen gerade?');
});

test('Neues Gespräch keeps the old one in the history; open switches back', () => {
  newConversation();
  const fresh = convStore.get().id;
  assert.notEqual(fresh, 'c_legacy');
  assert.equal(convStore.get().messages.length, 0);
  addMessage('user', 'text', 'Was hat Florian heute entschieden?');
  const a = addMessage('assistant', 'text');
  appendText(a, 'Drei Entscheidungen zu Voice und Desk.');
  flushConversation();
  assert.deepEqual(libraryStore.get().map((m) => m.id).sort(), [fresh, 'c_legacy'].sort());
  openConversation('c_legacy');
  assert.equal(convStore.get().id, 'c_legacy');
  openConversation(fresh);
  assert.equal(conv.textOf(convStore.get().messages[1]), 'Drei Entscheidungen zu Voice und Desk.');
});

test('an empty new conversation is not listed and a second "new" is a no-op', () => {
  newConversation();
  const id = convStore.get().id;
  newConversation();
  assert.equal(convStore.get().id, id);
  flushConversation();
  assert.ok(!libraryStore.get().some((m) => m.id === id));
});

test('search matches titles and full message text, case-insensitive', () => {
  assert.deepEqual(searchConversations('JOBS').map((m) => m.id), ['c_legacy']);
  assert.equal(searchConversations('voice und desk').length, 1);
  assert.equal(searchConversations('gibt es nicht').length, 0);
  assert.equal(searchConversations('').length, libraryStore.get().length);
});

test('delete removes storage and, for the open conversation, starts a fresh one', () => {
  openConversation('c_legacy');
  deleteConversation('c_legacy');
  assert.equal(localStorage.getItem('desk.conv.c_legacy'), null);
  assert.ok(!libraryStore.get().some((m) => m.id === 'c_legacy'));
  assert.notEqual(convStore.get().id, 'c_legacy');
  assert.equal(convStore.get().messages.length, 0);
});

test('status line is transient: cleared by the first text delta and by finish', () => {
  const a = addMessage('assistant', 'text');
  setStatusText(a, 'Ich schaue kurz in die Jobs …');
  assert.equal(convStore.get().messages.at(-1)!.statusText, 'Ich schaue kurz in die Jobs …');
  appendText(a, 'Sieben.');
  assert.equal(convStore.get().messages.at(-1)!.statusText, undefined);
  setStatusText(a, 'noch was');
  finish(a);
  assert.equal(convStore.get().messages.at(-1)!.statusText, undefined);
});

test('history groups by calendar day', () => {
  const now = new Date(2026, 9, 24, 9, 0).getTime();
  assert.equal(dayGroup(new Date(2026, 9, 24, 0, 5).getTime(), now), 'Heute');
  assert.equal(dayGroup(new Date(2026, 9, 23, 23, 50).getTime(), now), 'Gestern');
  assert.equal(dayGroup(new Date(2026, 9, 19).getTime(), now), 'Letzte 7 Tage');
  assert.equal(dayGroup(new Date(2026, 8, 1).getTime(), now), 'Älter');
});

test('history preview shows plain text, not markdown', () => {
  const c = { id: 'c_md', messages: [
    { id: 'u', role: 'user' as const, via: 'text' as const, parts: [{ kind: 'text' as const, text: 'Jobs?' }], ts: 1, status: 'done' as const },
    { id: 'a', role: 'assistant' as const, via: 'text' as const, parts: [{ kind: 'text' as const, text: 'Gerade laufen **5 Jobs**: siehe [STATE](jobs/x/STATE.md) und `ls`.' }], ts: 2, status: 'done' as const },
  ] };
  assert.equal(conv.metaOf(c).preview, 'Gerade laufen 5 Jobs: siehe STATE und ls.');
});
