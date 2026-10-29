import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMessage, convStore, upsertClaudeProposal, type ClaudeCard } from '../src/lib/conversation.ts';
import { discardClaudeProposal, submitClaudeProposal } from '../src/lib/claudeProposal.ts';

// Critic round 1, P0-1: a `claude_task` proposal is a card; only the click calls the gateway (POST /api/claude/proposal {id}).
const ev = { type: 'claude_proposal' as const, id: 'c0123456789abcdef', prompt: 'Prüfe den Beispiel-Job\nund berichte', title: 'Beispiel-Job prüfen', model: 'opus' as const };
const card = (id = ev.id) => {
  for (const m of convStore.get().messages) for (const p of m.parts) if (p.kind === 'claude' && p.card.id === id) return p.card as ClaudeCard;
  return undefined;
};
const opened: string[] = [];
(globalThis as unknown as { window: EventTarget }).window ??= new EventTarget();
window.addEventListener('desk:open-claude-session', (e) => opened.push(String((e as CustomEvent).detail)));

test('a claude_proposal event becomes one pending card and starts nothing by itself', () => {
  const calls: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...a: unknown[]) => (calls.push(a), new Response('{}'))) as typeof fetch;
  const id = addMessage('assistant', 'text');
  upsertClaudeProposal(id, ev);
  upsertClaudeProposal(id, ev);
  assert.equal(convStore.get().messages.find((m) => m.id === id)!.parts.filter((p) => p.kind === 'claude').length, 1);
  assert.deepEqual([card()?.state, card()?.prompt, card()?.model], ['pending', ev.prompt, 'opus']);
  assert.equal(calls.length, 0);
  globalThis.fetch = realFetch;
});

test('the click posts only {id} once, same-origin, and opens the started session', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify({ ok: true, sid: 'd20261028-aaaaaa' }), { headers: { 'content-type': 'application/json' } }))) as typeof fetch;
  await Promise.all([submitClaudeProposal(ev.id), submitClaudeProposal(ev.id)]);
  globalThis.fetch = realFetch;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/claude/proposal');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { id: ev.id }); // the text is NOT sent: the gateway uses the stored proposal
  assert.deepEqual([card()?.state, card()?.startedSid], ['done', 'd20261028-aaaaaa']);
  assert.deepEqual(opened, ['d20261028-aaaaaa']);
});

test('expired / used proposal → German error; discard settles the card and drops it on the gateway (critic r2 P2-3)', async () => {
  const id = addMessage('assistant', 'voice');
  upsertClaudeProposal(id, { ...ev, id: 'c1111111111111111', sessionId: 'd20261028-bbbbbb' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;
  await submitClaudeProposal('c1111111111111111');
  assert.equal(card('c1111111111111111')?.state, 'error');
  assert.match(card('c1111111111111111')?.error ?? '', /abgelaufen/);
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response('{"ok":true,"removed":true}'))) as typeof fetch;
  await discardClaudeProposal('c1111111111111111');
  globalThis.fetch = realFetch;
  assert.equal(card('c1111111111111111')?.state, 'discarded');
  assert.deepEqual(calls.map((c) => [c.url, c.init.method, c.init.credentials, JSON.parse(String(c.init.body))]), [['/api/claude/proposal/discard', 'POST', 'same-origin', { id: 'c1111111111111111' }]]);
});

// Critic round 2, P2-2: the card shows the whole prompt (scroll box ≤ 40vh, no 3-line clamp) and what goes along with it.
test('the confirm card renders the full prompt and the "Mitgegeben" line', async () => {
  const { createServer } = await import('vite');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
  try {
    const { default: Card, contextLine } = await vite.ssrLoadModule('/src/components/chat/ClaudeProposalCard.tsx');
    const prompt = ['Zeile 1: prüfe den Beispiel-Job', 'Zeile 2', 'Zeile 3', 'Zeile 4: danach auch das Beispiel-Archiv ansehen', ...Array.from({ length: 30 }, (_, i) => `Zeile ${i + 5}`)].join('\n');
    const html = renderToStaticMarkup(createElement(Card, { card: { id: 'c2222222222222222', title: 'Langer Auftrag', prompt, state: 'pending', contextTurns: 5 } }));
    assert.match(html, /Zeile 4: danach auch das Beispiel-Archiv ansehen/);
    assert.match(html, /Zeile 34/);
    assert.match(html, /max-h-\[40vh\]/);
    assert.match(html, /overflow-y-auto/);
    assert.doesNotMatch(html, /line-clamp/);
    assert.doesNotMatch(html, /Ganzen Auftrag zeigen/);
    assert.match(html, /Mitgegeben: die letzten 5 Nachrichten aus dem Chat/);
    assert.equal(contextLine(1), 'Mitgegeben: die letzte Nachricht aus dem Chat');
    assert.match(contextLine(0), /keine Chat-Nachrichten/);
    const toSession = renderToStaticMarkup(createElement(Card, { card: { id: 'c3333333333333333', title: 'T', prompt: 'x', sessionId: 'd20261028-bbbbbb', state: 'pending' } }));
    assert.doesNotMatch(toSession, /Mitgegeben/); // into a running session only the text itself goes
  } finally {
    await vite.close();
  }
});
