import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiveVoiceTranscript } from '../src/lib/voiceController.ts';
import { convStore, finish, textOf, upsertTool, addMessage } from '../src/lib/conversation.ts';
import { activityStore, toolLabel } from '../src/lib/activity.ts';

test('typed voice echo is one Getippt user turn and feeds activity with the same label', () => {
  convStore.set({ id: 'voice-test', messages: [] });
  receiveVoiceTranscript('user', 'Welche Jobs?', true, false, true);
  const messages = convStore.get().messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].via, 'typed');
  assert.equal(messages[0].status, 'done');
  assert.equal(textOf(messages[0]), 'Welche Jobs?');
  assert.equal(activityStore.get().at(-1)?.label, 'Getippt');
});

test('interrupted punctuation-only voice answers disappear but tool chips and meaningful replies survive', () => {
  convStore.set({ id: 'voice-test', messages: [] });
  receiveVoiceTranscript('assistant', '...', false, true);
  receiveVoiceTranscript('user', 'Hallo', true, false);
  assert.equal(convStore.get().messages.length, 1);
  receiveVoiceTranscript('assistant', 'Ja!', true, false);
  assert.equal(textOf(convStore.get().messages.at(-1)!), 'Ja!');
  const id = addMessage('assistant', 'voice', '…');
  upsertTool(id, { type: 'tool', id: 't', name: 'decisions_recent', status: 'done' });
  finish(id);
  assert.ok(convStore.get().messages.some((m) => m.id === id));
  assert.equal(toolLabel('decisions_recent'), 'Entscheidungen');
});
