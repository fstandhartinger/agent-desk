// Critic round 2: P2-3 ("Verwerfen" drops the proposal server-side) and P2-4 (a failed post / start does not burn the
// gateway handoff slot; a Claude proposal survives every failure before a session can exist).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DESK_ORIGIN, completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';
import { createHandoffStore, HANDOFF_LIMITS } from '../src/handoff.js';
import { createClaudeProposalStore, contextTurnsOf, proposalEvent } from '../src/claudeProposal.js';

describe('P2-4 handoff store: the daily slot counts only after a successful post', () => {
  it('release() gives the slot back, commit() keeps it, both are idempotent', () => {
    const store = createHandoffStore();
    for (let i = 0; i < HANDOFF_LIMITS.perDay * 2; i++) {
      const taken = store.take('a', store.propose({ sid: 'a', title: 'T', task: 'X' }).id);
      assert.ok(taken.proposal, `failed post ${i} must not use a slot`);
      taken.release(); taken.release();
    }
    for (let i = 0; i < HANDOFF_LIMITS.perDay; i++) { const t = store.take('a', store.propose({ sid: 'a', title: 'T', task: 'X' }).id); t.commit(); t.commit(); t.release(); }
    assert.equal(store.take('a', store.propose({ sid: 'a', title: 'T', task: 'X' }).id).error, 'limit');
  });
  it('a post still running holds its slot (no 11th concurrent click)', () => {
    const store = createHandoffStore();
    const running = Array.from({ length: HANDOFF_LIMITS.perDay }, () => store.take('a', store.propose({ sid: 'a', title: 'T', task: 'X' }).id));
    assert.ok(running.every((t) => t.proposal));
    assert.equal(store.take('a', store.propose({ sid: 'a', title: 'T', task: 'X' }).id).error, 'limit');
    running[0].release();
    assert.ok(store.take('a', store.propose({ sid: 'a', title: 'T', task: 'X' }).id).proposal);
  });
});

describe('P2-3 stores: discard', () => {
  it('handoff and claude proposals are gone after discard, only for their own session', () => {
    for (const store of [createHandoffStore(), createClaudeProposalStore()]) {
      const p = store.propose({ sid: 'a', title: 'T', task: 'X', prompt: 'X' });
      assert.equal(store.discard('b', p.id), false);
      assert.equal(store.discard('a', '../x'), false);
      assert.equal(store.discard('a', p.id), true);
      assert.equal(store.take('a', p.id).error, 'unknown');
      assert.equal(store.discard('a', p.id), false);
    }
  });
});

describe('P2-2: the proposal event says how many chat turns go along', () => {
  it('counts the formatChatContext lines; 0 for a running session', () => {
    const p = { id: 'c0', prompt: 'x', title: 't', chatContext: 'Florian: a\nzweite Zeile\nDesk-Agent: b\nFlorian: c' };
    assert.equal(contextTurnsOf(p), 3);
    assert.equal(proposalEvent(p).contextTurns, 3);
    assert.equal(contextTurnsOf({ ...p, sessionId: 'd20261028-aaaaaa' }), 0);
    assert.equal(contextTurnsOf({ ...p, chatContext: undefined }), 0);
  });
});

describe('end to end: discard routes, failed post, failed start', () => {
  let openrouter; let script; let gw; let sandy; let lechonk; let cookie;
  let boardFails = false; let listFails = false; let startFails = false; let boardCalls = 0; let starts = 0;
  before(async () => {
    openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body, openrouter.seen.length - 1)));
    setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
    gw = await startGateway();
    cookie = (await login(gw.base)).cookie;
    sandy = await connectFakeBridge(gw.port, { 'board.handoff': () => { boardCalls += 1; if (boardFails) throw new Error('board down'); return { entryId: 90002 }; }, 'audit.append': () => ({ ok: true }) }, { host: 'sandy' });
    lechonk = await connectFakeBridge(gw.port, {
      'claude.list': () => { if (listFails) throw new Error('list failed'); return { sessions: [] }; },
      'claude.start': () => { starts += 1; if (startFails) throw new Error('start crashed'); return { sid: 'd20261028-cccccc' }; },
      'ctx.knowledge': () => '', 'audit.append': () => ({ ok: true }),
    });
  });
  after(() => { sandy.ws.close(); lechonk.ws.close(); gw.close(); openrouter.close(); });
  beforeEach(() => { openrouter.seen.length = 0; boardFails = false; listFails = false; startFails = false; boardCalls = 0; starts = 0; });

  const propose = async (tool, args) => {
    script = (b) => (!b?.messages?.some((m) => m.role === 'tool') ? completionStream({ toolCalls: [{ id: 't1', name: tool, args: JSON.stringify(args) }] }) : completionStream({ text: 'Die Karte steht bereit.' }));
    const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Bitte vorschlagen' }] }) });
    const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));
    const found = events.find((e) => e.type === (tool === 'claude_task' ? 'claude_proposal' : 'handoff'));
    return found;
  };
  const post = (path, id, headers = {}) => fetch(`${gw.base}${path}`, { method: 'POST', headers: { cookie, origin: DESK_ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id }) });

  it('POST /api/handoff/discard removes the proposal; the click afterwards is 404 and posts nothing', async () => {
    const evt = await propose('handoff_propose', { title: 'Beispiel deployen', task: 'Bitte das Beispiel deployen (synthetisch).' });
    assert.equal((await post('/api/handoff/discard', evt.id, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(`${gw.base}/api/handoff/discard`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: evt.id }) })).status, 403);
    assert.equal((await fetch(`${gw.base}/api/handoff/discard`, { method: 'POST', headers: { origin: DESK_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ id: evt.id }) })).status, 401);
    assert.equal((await fetch(`${gw.base}/api/handoff/discard`, { headers: { cookie } })).status, 405);
    assert.equal((await post('/api/handoff/discard', '../x')).status, 400);
    const res = await post('/api/handoff/discard', evt.id);
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, removed: true }]);
    assert.equal((await post('/api/handoff', evt.id)).status, 404);
    assert.equal(boardCalls, 0);
  });

  it('POST /api/claude/proposal/discard removes the proposal; the click afterwards is 404 and starts nothing', async () => {
    const evt = await propose('claude_task', { prompt: 'Prüfe den Beispiel-Job' });
    assert.equal(typeof evt.contextTurns, 'number');
    assert.equal((await post('/api/claude/proposal/discard', evt.id, { origin: 'https://evil.example' })).status, 403);
    const other = (await login(gw.base)).cookie;
    const foreign = await fetch(`${gw.base}/api/claude/proposal/discard`, { method: 'POST', headers: { cookie: other, origin: DESK_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ id: evt.id }) });
    assert.deepEqual(await foreign.json(), { ok: true, removed: false }); // another session cannot drop it
    assert.deepEqual(await (await post('/api/claude/proposal/discard', evt.id)).json(), { ok: true, removed: true });
    assert.equal((await post('/api/claude/proposal', evt.id)).status, 404);
    assert.equal(starts, 0);
  });

  it('a failed board post does not count against the gateway daily limit', async () => {
    boardFails = true;
    for (let i = 0; i < HANDOFF_LIMITS.perDay; i++) {
      const evt = await propose('handoff_propose', { title: `Fehlversuch ${i}`, task: 'Synthetischer Auftrag' });
      assert.equal((await post('/api/handoff', evt.id)).status, 502);
    }
    boardFails = false;
    const evt = await propose('handoff_propose', { title: 'Jetzt klappt es', task: 'Synthetischer Auftrag' });
    assert.equal((await post('/api/handoff', evt.id)).status, 200, '11th click after 10 failures still has a slot');
  });

  it('claude.list failing (before any start) keeps the proposal; a crash of claude.start itself does not', async () => {
    const evt = await propose('claude_task', { prompt: 'Prüfe den Beispiel-Job' });
    listFails = true;
    assert.equal((await post('/api/claude/proposal', evt.id)).status, 502);
    listFails = false;
    startFails = true;
    assert.equal((await post('/api/claude/proposal', evt.id)).status, 502, 'still usable after the list failure');
    assert.equal(starts, 1);
    startFails = false;
    assert.equal((await post('/api/claude/proposal', evt.id)).status, 404, 'claude.start reached the bridge: it may have run, so no replay');
    assert.equal(starts, 1);
  });
});
