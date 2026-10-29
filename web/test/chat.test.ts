import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendChat } from '../src/lib/chat.ts';
import { convStore, textOf } from '../src/lib/conversation.ts';

const sse = (events: unknown[], gapMs = 5) =>
  new Response(new ReadableStream({
    async start(c) {
      for (const e of events) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
        await new Promise((r) => setTimeout(r, gapMs));
      }
      c.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });

const last = () => convStore.get().messages.at(-1)!;

test('the {type:"status"} SSE event shows as an inline status line until the answer streams', async () => {
  const seen: (string | undefined)[] = [];
  const off = convStore.subscribe(() => seen.push(last().statusText));
  globalThis.fetch = async () => sse([
    { type: 'status', text: 'Ich schaue kurz in die Jobs …' },
    { type: 'tool', id: 't1', name: 'list_jobs', status: 'start' },
    { type: 'tool', id: 't1', name: 'list_jobs', status: 'done', summary: '7 Jobs', ms: 120 },
    { type: 'delta', text: 'Sieben Jobs laufen.' },
    { type: 'done', costUsd: 0.001, model: 'deepseek/deepseek-v4.1-flash-20261017:nitro' },
  ]);
  await sendChat('Welche Jobs laufen gerade?');
  off();
  assert.ok(seen.includes('Ich schaue kurz in die Jobs …'));
  assert.equal(last().statusText, undefined);
  assert.equal(textOf(last()), 'Sieben Jobs laufen.');
  assert.equal(last().status, 'done');
});

test('a rate-limited chat shows the German reason with the retry time', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Chat-Limit erreicht.' }), { status: 429, headers: { 'retry-after': '120' } });
  await sendChat('Noch eine Frage');
  assert.equal(last().status, 'error');
  assert.equal(last().error, 'Chat-Limit erreicht – erneut möglich in 2 min.');
});

test('a network failure reads "Keine Verbindung zum Server."', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await sendChat('Hallo?');
  assert.equal(last().error, 'Keine Verbindung zum Server.');
});

test('the composer is free at "done" although the stream stays open for the Live Canvas', async () => {
  const { chatState } = await import('../src/lib/chat.ts');
  let vizSent = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    async start(c) {
      const send = (e: unknown) => c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
      send({ type: 'delta', text: 'Fertig.' });
      send({ type: 'done', model: 'x' });
      await new Promise((r) => setTimeout(r, 60));
      vizSent = true;
      send({ type: 'viz', spec: { v: 1, title: 'T', nodes: [], edges: [] } });
      c.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const run = sendChat('Kurz?');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(chatState.get().streamingId, null, 'still streaming after done');
  assert.equal(last().status, 'done');
  await run;
  assert.ok(vizSent);
});
