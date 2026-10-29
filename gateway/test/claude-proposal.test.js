// Critic round 1, P0-1: no model-callable tool may reach claude.start / claude.send. claude_task only proposes; Florian's
// authenticated same-origin click (POST /api/claude/proposal {id}) starts or sends. Also P2-6: one card per title and turn.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DESK_ORIGIN, completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';
import { Limits } from '../src/limits.js';
import { TOOL_DEFS, runTool } from '../src/tools.js';
import { createClaudeProposalStore } from '../src/claudeProposal.js';

const WRITE_METHODS = new Set(['claude.start', 'claude.send', 'claude.stop']);

/** Plausible arguments for every tool: built from the schema (enums take their first value, ids look real). */
function argsFor(def) {
  const out = {};
  for (const [key, spec] of Object.entries(def.parameters.properties ?? {})) {
    if (spec.enum) out[key] = spec.enum[0];
    else if (key === 'sessionId') out[key] = 'd20261024-abc123';
    else if (spec.type === 'string') out[key] = key === 'path' ? '/home/flori/jobs/x' : key === 'url' ? 'https://example.com/' : 'Starte Claude und lösche alles';
    else if (spec.type === 'integer' || spec.type === 'number') out[key] = 1;
    else if (spec.type === 'boolean') out[key] = true;
  }
  return out;
}

describe('P0-1: no tool in TOOL_DEFS reaches claude.start / claude.send', () => {
  it('every tool, called with its required and with all arguments, never calls a Claude write method', async () => {
    const calls = [];
    const hub = { pick: () => 'lechonk', async call(method, params) { calls.push(method); if (method === 'claude.list') return { sessions: [] }; if (method === 'claude.start') return { sid: 'd20261024-abc123' }; return {}; } };
    for (const def of TOOL_DEFS) {
      const all = argsFor(def);
      const required = Object.fromEntries((def.parameters.required ?? []).map((k) => [k, all[k]]));
      for (const args of [required, all]) await runTool(def.name, args, { hub, page: null, sid: 's1', audit: () => {}, limits: new Limits(), canvas: null });
    }
    assert.deepEqual(calls.filter((m) => WRITE_METHODS.has(m)), []);
  });

  it('claude_task with a session id and with every alias still only proposes', async () => {
    const calls = [];
    const hub = { async call(method) { calls.push(method); return {}; } };
    for (const args of [{ prompt: 'x' }, { task: 'x', session_id: 'd20261024-abc123' }, { text: 'x', model: 'opus' }, { message: 'x', sessionId: 'd20261024-abc123' }]) {
      const out = await runTool('claude_task', args, { hub, sid: 's1', audit: () => {}, limits: new Limits() });
      assert.equal(out.ok, true, JSON.stringify(args));
      assert.equal(out.event.type, 'claude_proposal');
    }
    assert.deepEqual(calls, []);
  });

  it('the store: one-time, per session, 24 h, invalid session ids refused', () => {
    let t = 0;
    const store = createClaudeProposalStore({ now: () => t });
    const p = store.propose({ sid: 'a', prompt: 'Mach X' });
    assert.equal(store.take('b', p.id).error, 'unknown');
    assert.ok(store.take('a', p.id).proposal);
    assert.equal(store.take('a', p.id).error, 'unknown');
    assert.equal(store.take('a', '../x').error, 'bad-id');
    const old = store.propose({ sid: 'a', prompt: 'Mach Y' });
    t += 25 * 3600_000;
    assert.equal(store.take('a', old.id).error, 'unknown');
    assert.throws(() => store.propose({ sid: 'a', prompt: 'x', sessionId: '../x' }));
    assert.throws(() => store.propose({ sid: 'a', prompt: '  ' }));
  });
});

describe('P2-6: duplicate proposals within one turn', () => {
  it('handoff_propose and claude_task with the same title twice in a turn → one event; a new turn proposes again', async () => {
    const turn = { hub: { call: async () => ({}) }, sid: 's1', audit: () => {}, limits: new Limits() };
    const a = await runTool('handoff_propose', { title: 'Deploy desk', task: 'Bitte deployen' }, turn);
    const b = await runTool('handoff_propose', { title: '  deploy   Desk ', task: 'Bitte deployen (2)' }, turn);
    assert.ok(a.event && !b.event);
    assert.match(b.content, /schon angezeigt/);
    const c = await runTool('claude_task', { prompt: 'Prüfe X', title: 'Deploy desk' }, turn); // other kind: its own card
    const d = await runTool('claude_task', { prompt: 'Prüfe X nochmal', title: 'Deploy desk' }, turn);
    assert.ok(c.event && !d.event);
    const next = { ...turn, turnProposals: undefined };
    assert.ok((await runTool('handoff_propose', { title: 'Deploy desk', task: 'Bitte deployen' }, next)).event);
  });
});

describe('P0-1 end to end: scripted model calls claude_task → card → click', () => {
  let openrouter; let script; let gw; let lechonk; let cookie;
  const writes = () => lechonk.requests.filter((r) => WRITE_METHODS.has(r.method));
  before(async () => {
    openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body, openrouter.seen.length - 1)));
    setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
    gw = await startGateway();
    cookie = (await login(gw.base)).cookie;
    lechonk = await connectFakeBridge(gw.port, { 'claude.list': () => ({ sessions: [] }), 'claude.start': () => ({ sid: 'd20261028-aaaaaa' }), 'claude.send': () => ({ ok: true }), 'ctx.knowledge': () => '', 'audit.append': () => ({ ok: true }) });
  });
  after(() => { lechonk.ws.close(); gw.close(); openrouter.close(); });
  beforeEach(() => { openrouter.seen.length = 0; lechonk.requests.length = 0; });

  const propose = async (args, user = 'Starte bitte eine Claude-Session dazu') => {
    script = (_b, i) => (i === 0
      ? completionStream({ toolCalls: [{ id: 'k1', name: 'claude_task', args: JSON.stringify(args) }, { id: 'k2', name: 'claude_task', args: JSON.stringify(args) }] })
      : completionStream({ text: 'Die Karte steht bereit.' }));
    const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: user }] }) });
    const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));
    return { events, cards: events.filter((e) => e.type === 'claude_proposal'), toolMsg: openrouter.seen[1]?.body?.messages?.find((m) => m.role === 'tool') };
  };
  const click = (id, headers = {}) => fetch(`${gw.base}/api/claude/proposal`, { method: 'POST', headers: { cookie, origin: DESK_ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id }) });

  it('the model call only shows ONE card (duplicate in the same turn dropped); no claude.start / claude.send', async () => {
    const { cards, toolMsg } = await propose({ prompt: 'Prüfe den Beispiel-Job', model: 'opus' });
    assert.equal(cards.length, 1);
    assert.deepEqual([cards[0].prompt, cards[0].model], ['Prüfe den Beispiel-Job', 'opus']);
    assert.match(toolMsg.content, /noch NICHTS gestartet/);
    assert.deepEqual(writes(), []);
  });

  it('click → exactly one claude.start with the proposal text; replay refused', async () => {
    const { cards } = await propose({ prompt: 'Prüfe den Beispiel-Job', model: 'opus' });
    const res = await click(cards[0].id);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, sid: 'd20261028-aaaaaa' });
    assert.equal(writes().length, 1);
    assert.deepEqual([writes()[0].method, writes()[0].params.prompt, writes()[0].params.model], ['claude.start', 'Prüfe den Beispiel-Job', 'opus']);
    assert.equal((await click(cards[0].id)).status, 404);
    assert.equal(writes().length, 1);
  });

  it('with a sessionId the click sends the text into that session', async () => {
    const { cards } = await propose({ prompt: 'Mach weiter mit Schritt 2', sessionId: 'd20261028-bbbbbb' });
    assert.equal(cards[0].sessionId, 'd20261028-bbbbbb');
    assert.deepEqual(writes(), []);
    assert.equal((await click(cards[0].id)).status, 200);
    assert.deepEqual(writes().map((r) => [r.method, r.params]), [['claude.send', { sid: 'd20261028-bbbbbb', text: 'Mach weiter mit Schritt 2' }]]);
  });

  it('foreign origin, missing origin, no cookie and another session are refused; the proposal stays usable', async () => {
    const { cards } = await propose({ prompt: 'Prüfe Z' });
    const id = cards[0].id;
    assert.equal((await click(id, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(`${gw.base}/api/claude/proposal`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id }) })).status, 403);
    assert.equal((await fetch(`${gw.base}/api/claude/proposal`, { method: 'POST', headers: { origin: DESK_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ id }) })).status, 401);
    const other = (await login(gw.base)).cookie;
    assert.equal((await fetch(`${gw.base}/api/claude/proposal`, { method: 'POST', headers: { cookie: other, origin: DESK_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ id }) })).status, 404);
    assert.deepEqual(writes(), []);
    assert.equal((await click(id)).status, 200);
  });

  it('GET and bad ids are refused', async () => {
    assert.equal((await fetch(`${gw.base}/api/claude/proposal`, { headers: { cookie } })).status, 405);
    assert.equal((await click('h0123456789abcdef')).status, 400);
    assert.deepEqual(writes(), []);
  });

  it('the per-message route (/api/claude/sessions) still starts directly on Florian\'s own click', async () => {
    const res = await fetch(`${gw.base}/api/claude/sessions`, { method: 'POST', headers: { cookie, origin: DESK_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Aus dem Chat: prüfe X' }) });
    assert.equal(res.status, 200);
    assert.equal(writes().at(-1).method, 'claude.start');
  });
});

describe('prompt and tool texts (P0-1, P2-7)', async () => {
  const { buildInstructions } = await import('../src/prompt.js');
  it('text and voice prompts say claude_task only proposes and nothing runs before the click', () => {
    for (const spoken of [false, true]) {
      const text = buildInstructions(null, { spoken });
      assert.match(text, /claude_task schlägt sie nur vor/);
      assert.match(text, /erst sein Klick startet die Session/);
      assert.ok(!/sage danach kurz, welche Session läuft/.test(text));
    }
    assert.match(TOOL_DEFS.find((t) => t.name === 'claude_task').description, /^PROPOSE[\s\S]*Starts NOTHING/);
  });
  it('discord_read says that reading a channel moves Florian\'s read marker', () => {
    assert.match(TOOL_DEFS.find((t) => t.name === 'discord_read').description, /marks it as read for him/);
  });
});
