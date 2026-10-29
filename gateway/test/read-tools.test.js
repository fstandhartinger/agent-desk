// 28 Oct read tools (docs/UPGRADES-1028.md §4): routing, chats fan-out, refusal of write tools, handoff flow, audit.
// All data synthetic.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { BRIDGE_HOST, BridgeHub, routeOf } from '../src/bridgeHub.js';
import { BRIDGE_TOOLS, RUN_READONLY_COMMANDS, TOOL_DEFS, resolveToolName, runTool } from '../src/tools.js';
import { createHandoffStore, HANDOFF_LIMITS } from '../src/handoff.js';
import { buildInstructions } from '../src/prompt.js';
import { buildInstructions as buildVoiceInstructions } from '../src/voice/instructions.js';
import { geminiDeclarations } from '../src/voice/schema.js';
import { BRIDGE_TOKEN, DESK_ORIGIN, completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';

/** A ws stand-in: records frames, answers every request with handler(method, params). */
function fakeWs(host, hub, handler = () => ({ ok: true })) {
  const listeners = {};
  const ws = {
    readyState: 1,
    sent: [],
    on: (ev, fn) => { listeners[ev] = fn; },
    close: () => { ws.readyState = 3; listeners.close?.(); },
    terminate: () => ws.close(),
    send: (raw) => {
      const msg = JSON.parse(raw);
      ws.sent.push(msg);
      if (msg.t !== 'req') return;
      Promise.resolve().then(() => handler(msg.method, msg.params)).then(
        (result) => listeners.message?.(Buffer.from(JSON.stringify({ t: 'res', id: msg.id, ok: true, result }))),
        (err) => listeners.message?.(Buffer.from(JSON.stringify({ t: 'res', id: msg.id, ok: false, error: err.message }))),
      );
    },
  };
  hub.attach(ws, host);
  return { ws, hello: (caps) => listeners.message(Buffer.from(JSON.stringify({ t: 'hello', caps }))) };
}

const reqs = (conn) => conn.ws.sent.filter((m) => m.t === 'req' && m.method !== 'claude.list').map((m) => m.method);

describe('bridge routing (ROUTE)', () => {
  it('host allowlist is exactly lechonk|sandy', () => {
    for (const ok of ['lechonk', 'sandy']) assert.ok(BRIDGE_HOST.test(ok));
    for (const bad of ['other', 'sandy-prod', 'Sandy', 'lechonk2', '', 'sandy\n']) assert.ok(!BRIDGE_HOST.test(bad), bad);
  });

  it('route table per contract', () => {
    assert.deepEqual(routeOf('discord.read'), ['sandy']);
    assert.deepEqual(routeOf('mail.search'), ['sandy']);
    assert.deepEqual(routeOf('ops.run'), ['sandy']);
    assert.deepEqual(routeOf('board.read'), ['sandy', 'lechonk']);
    assert.deepEqual(routeOf('ctx.read'), ['sandy', 'lechonk']);
    assert.deepEqual(routeOf('jobs.list'), ['sandy', 'lechonk']);
    assert.deepEqual(routeOf('skills.list'), ['sandy', 'lechonk']);
    assert.deepEqual(routeOf('claude.start'), ['lechonk']);
    assert.deepEqual(routeOf('ctx.knowledge'), ['lechonk', 'sandy']);
    assert.deepEqual(routeOf('ledger.entries'), ['lechonk', 'sandy']);
    assert.deepEqual(routeOf('code.outline'), ['lechonk', 'sandy']);
    assert.deepEqual(routeOf('notify.loginLink'), ['lechonk']);
  });

  it('sandy is preferred when both are connected', async () => {
    const hub = new BridgeHub();
    const s = fakeWs('sandy', hub);
    const l = fakeWs('lechonk', hub);
    await hub.call('ctx.read', { path: '/x' });
    await hub.call('board.threads', {});
    assert.deepEqual(reqs(s), ['ctx.read', 'board.threads']);
    assert.deepEqual(reqs(l), []);
  });

  it('falls back to lechonk when sandy is offline', async () => {
    const hub = new BridgeHub();
    const s = fakeWs('sandy', hub);
    const l = fakeWs('lechonk', hub);
    s.ws.close();
    await hub.call('jobs.list', {});
    assert.deepEqual(reqs(l), ['jobs.list']);
  });

  it('skips a host whose hello does not announce the method', async () => {
    const hub = new BridgeHub();
    const s = fakeWs('sandy', hub);
    const l = fakeWs('lechonk', hub);
    s.hello(['ctx.read']);
    l.hello(['ctx.read', 'skills.list']);
    await hub.call('skills.list', {});
    assert.deepEqual(reqs(l), ['skills.list']);
  });

  it('claude.* never goes to sandy, even when only sandy is connected', async () => {
    const hub = new BridgeHub();
    const s = fakeWs('sandy', hub);
    await assert.rejects(hub.call('claude.start', { prompt: 'x' }), /lechonk/);
    await assert.rejects(hub.call('claude.list', {}), /lechonk/);
    assert.deepEqual(reqs(s), []);
  });

  it('mail/discord/ops never go to lechonk', async () => {
    const hub = new BridgeHub();
    const l = fakeWs('lechonk', hub);
    for (const m of ['mail.search', 'discord.list', 'ops.run']) await assert.rejects(hub.call(m, {}), /sandy/);
    assert.deepEqual(reqs(l), []);
  });

  it('statusAll lists both bridges, the missing one offline', () => {
    const hub = new BridgeHub();
    fakeWs('lechonk', hub);
    const all = hub.statusAll();
    assert.deepEqual(all.map((b) => [b.host, b.connected]), [['lechonk', true], ['sandy', false]]);
  });
});

describe('chats_search fan-out and chat_read', () => {
  const hit = (over) => ({ agent: 'claude', ts: '2026-10-27T10:00:00Z', text: 'synthetic hit', ref: 'r1', ...over });
  function twoHosts({ sandy, lechonk }) {
    const hub = new BridgeHub();
    const s = fakeWs('sandy', hub, (m, p) => (m === 'chats.search' ? sandy(p) : { turns: [{ role: 'user', text: `read ${p.ref}` }] }));
    const l = fakeWs('lechonk', hub, (m, p) => (m === 'chats.search' ? lechonk(p) : { turns: [{ role: 'user', text: `read ${p.ref}` }] }));
    return { hub, s, l };
  }

  it('asks both hosts, merges, dedupes, sorts newest first and tags the host into hit and ref', async () => {
    const { hub } = twoHosts({
      sandy: () => ({ hits: [hit({ ref: 'a', ts: '2026-10-26T00:00:00Z', text: 'older on sandy' }), hit({ ref: 'dup', ts: '2026-10-25T00:00:00Z', text: 'same' })] }),
      lechonk: () => ({ hits: [hit({ ref: 'b', ts: '2026-10-28T00:00:00Z', text: 'newer on lechonk', agent: 'codex' }), hit({ ref: 'dup2', ts: '2026-10-25T00:00:00Z', text: 'same' })] }),
    });
    const out = await runTool('chats_search', { query: 'synthetic', agent: 'all' }, { hub, audit: () => {} });
    assert.equal(out.ok, true, out.content);
    const result = JSON.parse(out.content);
    assert.deepEqual(result.hosts, ['sandy', 'lechonk']);
    assert.deepEqual(result.hits.map((h) => [h.host, h.ref]), [['lechonk', 'lechonk~b'], ['sandy', 'sandy~a'], ['sandy', 'sandy~dup']]);
  });

  it('one host failing still returns the other with a note', async () => {
    const { hub } = twoHosts({ sandy: () => { throw new Error('rg missing'); }, lechonk: () => ({ hits: [hit()] }) });
    const result = JSON.parse((await runTool('chats_search', { query: 'x' }, { hub, audit: () => {} })).content);
    assert.equal(result.hits.length, 1);
    assert.match(result.unavailable[0], /^sandy: rg missing/);
  });

  it('host argument limits the search; limit is capped at 40', async () => {
    const seen = [];
    const { hub } = twoHosts({ sandy: (p) => (seen.push(['sandy', p.limit]), { hits: [] }), lechonk: (p) => (seen.push(['lechonk', p.limit]), { hits: [] }) });
    await runTool('chats_search', { query: 'x', host: 'lechonk', limit: 500 }, { hub, audit: () => {} });
    assert.deepEqual(seen, [['lechonk', 40]]);
  });

  it('the old name search_chats still works', async () => {
    assert.equal(resolveToolName('search_chats'), 'chats_search');
    const { hub } = twoHosts({ sandy: () => ({ hits: [] }), lechonk: () => ({ hits: [] }) });
    assert.equal((await runTool('search_chats', { query: 'x' }, { hub, audit: () => {} })).ok, true);
  });

  it('chat_read goes to the host named in the ref, with the bare ref', async () => {
    const { hub, s, l } = twoHosts({ sandy: () => ({ hits: [] }), lechonk: () => ({ hits: [] }) });
    const out = await runTool('chat_read', { ref: 'lechonk~opaque123', limit: 5 }, { hub, audit: () => {} });
    assert.match(out.content, /read opaque123/);
    assert.deepEqual(reqs(l), ['chats.read']);
    assert.deepEqual(reqs(s), []);
  });

  it('every call is audited with tool, host, ms, ok and short redacted args', async () => {
    const audits = [];
    const { hub } = twoHosts({ sandy: () => ({ hits: [] }), lechonk: () => ({ hits: [] }) });
    await runTool('chats_search', { query: 'password=hunter2 x' }, { hub, audit: (e) => audits.push(e) });
    const [entry] = audits;
    assert.equal(entry.action, 'tool.chats_search');
    assert.equal(entry.detail.host, 'sandy+lechonk');
    assert.equal(entry.detail.ok, true);
    assert.ok(Number.isInteger(entry.detail.ms));
    assert.ok(!entry.detail.args.includes('hunter2'), entry.detail.args);
  });
});

describe('other read tools', () => {
  const hubFor = (handlers) => {
    const hub = new BridgeHub();
    const s = fakeWs('sandy', hub, (m, p) => handlers[m]?.(p) ?? { none: true });
    return { hub, s };
  };
  it('mail/skills/ops/discord go to sandy with exactly the contract params', async () => {
    const { hub, s } = hubFor({});
    await runTool('mail_search', { query: 'Rechnung', limit: 3 }, { hub, audit: () => {} });
    await runTool('mail_read', { account: 'acc1', uid: '42' }, { hub, audit: () => {} });
    await runTool('skills_list', { query: 'mail' }, { hub, audit: () => {} });
    await runTool('skill_read', { name: 'demo', file: 'references/a.md' }, { hub, audit: () => {} });
    await runTool('run_readonly', { command: 'disk' }, { hub, audit: () => {} });
    await runTool('discord_read', {}, { hub, audit: () => {} });
    await runTool('discord_read', { channel: '@me/123456789012345678', limit: 99 }, { hub, audit: () => {} });
    const frames = s.ws.sent.filter((m) => m.t === 'req' && m.method !== 'claude.list').map((m) => [m.method, m.params]);
    assert.deepEqual(frames, [
      ['mail.search', { query: 'Rechnung', limit: 3 }],
      ['mail.read', { account: 'acc1', uid: '42' }],
      ['skills.list', { query: 'mail' }],
      ['skills.read', { name: 'demo', file: 'references/a.md' }],
      ['ops.run', { command: 'disk' }],
      ['discord.list', {}],
      ['discord.read', { channel: '@me/123456789012345678', limit: 50 }],
    ]);
  });
  it('run_readonly accepts only the fixed ids; discord_read validates the channel', async () => {
    const { hub, s } = hubFor({});
    for (const command of ['rm -rf /', 'quota-pace status; id', 'disk ', 'send']) {
      const out = await runTool('run_readonly', { command }, { hub, audit: () => {} });
      assert.equal(out.ok, false, command);
    }
    assert.deepEqual(RUN_READONLY_COMMANDS, ['quota_status', 'asks_open', 'board_threads', 'sched_list', 'disk', 'jobs_running']);
    for (const channel of ['../../x', '123/abc', '@me/1; send', 'general']) assert.equal((await runTool('discord_read', { channel }, { hub, audit: () => {} })).ok, false, channel);
    assert.deepEqual(reqs(s), []);
  });
  it('tool results are redacted before the model sees them (mail with a one-time code and a reset link)', async () => {
    const { hub } = hubFor({ 'mail.read': () => ({ subject: 'Anmeldung', text: 'Ihr Bestätigungscode lautet 739201. Oder: https://login.example.com/reset?token=abcdefghijklmnopqrstuvwxyz' }) });
    const out = await runTool('mail_read', { account: 'acc1', uid: '1' }, { hub, audit: () => {} });
    assert.ok(!out.content.includes('739201'));
    assert.ok(!out.content.includes('abcdefghijklmnopqrstuvwxyz'));
  });
  it('voice cap: results stay within 2500 characters', async () => {
    const { hub } = hubFor({ 'skills.read': () => ({ text: 'y'.repeat(20_000) }) });
    const out = await runTool('skill_read', { name: 'demo' }, { hub, audit: () => {}, maxChars: 2500 });
    assert.ok(out.content.length <= 2500);
    const text = await runTool('skill_read', { name: 'demo' }, { hub, audit: () => {} });
    assert.ok(text.content.length <= 6000);
  });
});

describe('refusal path: no tool writes, sends or deploys', () => {
  const WRITE = ['send_mail', 'mail_send', 'discord_send', 'send_discord', 'deploy', 'notify', 'notify_send', 'pay', 'board_post', 'post_board', 'board_handoff', 'board.handoff', 'handoff', 'hand_off', 'handoff_proposal', 'handoff_propse', 'delete_file', 'write_file', 'publish'];
  it('none of these names exists or maps onto a real tool', async () => {
    for (const name of WRITE) {
      assert.equal(resolveToolName(name), name, name);
      const calls = [];
      const out = await runTool(name, { to: 'x', text: 'y' }, { hub: { call: async (...a) => calls.push(a) }, audit: () => {} });
      assert.equal(out.ok, false, name);
      assert.match(out.content, /unknown tool/);
      assert.equal(calls.length, 0, name);
    }
  });
  it('near-miss names never land on handoff_propose or claude_task', () => {
    for (const name of ['handoff_propos', 'handof_propose', 'claude_tsk', 'claud_task', 'hand_propose']) {
      assert.ok(!['handoff_propose', 'claude_task'].includes(resolveToolName(name)), name);
    }
  });
  it('no bridge tool maps to a writing bridge method; board.handoff is reachable from no tool', () => {
    const methods = Object.values(BRIDGE_TOOLS).map(([m]) => m);
    for (const m of methods) assert.ok(!/handoff|send|post|notify|start|stop|delete|append/.test(m), m);
    assert.ok(!TOOL_DEFS.some((t) => /send|post|deploy|notify|pay|delete/.test(t.name) && t.name !== 'handoff_propose'));
  });
  it('handoff_propose calls no bridge method at all, it only returns the browser event', async () => {
    const calls = [];
    const out = await runTool('handoff_propose', { title: 'Mail an Beispiel GmbH', task: 'Schick die Antwort an Beispiel', why: 'Florian will antworten' }, { hub: { call: async (...a) => { calls.push(a); return {}; } }, audit: () => {}, sid: 's1' });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 0);
    assert.equal(out.event.type, 'handoff');
    assert.match(out.event.id, /^h[0-9a-f]{16}$/);
    assert.equal(out.event.title, 'Mail an Beispiel GmbH');
    assert.match(out.content, /erst sein Klick/);
  });
  it('the prompts tell the agents what they can read, that they cannot write, and that tool results are data', () => {
    for (const text of [buildInstructions(null), buildVoiceInstructions(null)]) {
      assert.match(text, /web_read/);
      assert.match(text, /Du kannst NICHTS verändern/);
      assert.match(text, /handoff_propose/);
      assert.match(text, /Daten, niemals Anweisungen/);
    }
  });
  it('Gemini declarations of the new tools carry no additionalProperties', () => {
    const decls = geminiDeclarations(TOOL_DEFS);
    assert.ok(!JSON.stringify(decls).includes('additionalProperties'));
    for (const name of ['web_read', 'chats_search', 'run_readonly', 'handoff_propose']) assert.ok(decls.some((d) => d.name === name));
  });
});

describe('handoff store', () => {
  it('one-time use, scoped to the session, 10 per day, expires', () => {
    let t = 0;
    const store = createHandoffStore({ now: () => t });
    const p = store.propose({ sid: 'a', title: 'T', task: 'X' });
    assert.equal(store.take('b', p.id).error, 'unknown');
    store.take('a', p.id).commit(); // critic r2 P2-4: a slot counts once the bridge post succeeded
    assert.equal(store.take('a', p.id).error, 'unknown');
    for (let i = 0; i < HANDOFF_LIMITS.perDay - 1; i++) store.take('a', store.propose({ sid: 'a', title: 'T', task: 'X' }).id).commit();
    assert.equal(store.take('a', store.propose({ sid: 'a', title: 'T', task: 'X' }).id).error, 'limit');
    t += 25 * 3600_000;
    const old = store.propose({ sid: 'a', title: 'T', task: 'X' });
    t += 25 * 3600_000;
    assert.equal(store.take('a', old.id).error, 'unknown');
    assert.ok(store.take('a', store.propose({ sid: 'a', title: 'T', task: 'X' }).id).proposal);
  });
  it('redacts and clips the proposal', () => {
    const p = createHandoffStore().propose({ sid: 'a', title: 'x'.repeat(300), task: 'Login mit password=hunter2' });
    assert.equal(p.title.length, HANDOFF_LIMITS.title);
    assert.ok(!p.task.includes('hunter2'));
  });
});

describe('handoff end to end: proposal → click → one board call', () => {
  let openrouter; let script; let gw; let sandy; let lechonk; let cookie; let boardCalls;
  before(async () => {
    openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body, openrouter.seen.length - 1)));
    setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
    gw = await startGateway();
    cookie = (await login(gw.base)).cookie;
    sandy = await connectFakeBridge(gw.port, { 'board.handoff': (p) => { boardCalls.push(p); return { entryId: 90001 }; }, 'audit.append': () => ({ ok: true }) }, { host: 'sandy' });
    lechonk = await connectFakeBridge(gw.port, { 'ctx.knowledge': () => '', 'audit.append': () => ({ ok: true }) });
  });
  after(() => { sandy.ws.close(); lechonk.ws.close(); gw.close(); openrouter.close(); });
  beforeEach(() => { openrouter.seen.length = 0; boardCalls = []; });

  const propose = async () => {
    script = (_b, i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'h1', name: 'handoff_propose', args: JSON.stringify({ title: 'Antwort an Beispiel senden', task: 'Sende die Antwort an Beispiel (synthetisch).', why: 'Der Desk kann nicht senden' }) }] }) : completionStream({ text: 'Ich kann das nicht selbst senden; klick auf den Button.' }));
    const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Schick die Mail an Beispiel' }] }) });
    const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));
    return events.find((e) => e.type === 'handoff');
  };
  const click = (id, headers = {}) => fetch(`${gw.base}/api/handoff`, { method: 'POST', headers: { cookie, origin: DESK_ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id }) });

  it('the model proposal becomes an SSE event without any board call', async () => {
    const evt = await propose();
    assert.ok(evt, 'handoff event');
    assert.deepEqual(Object.keys(evt).filter((k) => k !== '_id').sort(), ['id', 'task', 'title', 'type', 'why']); // _id = the SSE sequence of chat.js
    assert.equal(boardCalls.length, 0);
  });

  it('click → exactly one board.handoff on sandy → {ok, entryId}; replay refused', async () => {
    const evt = await propose();
    const res = await click(evt.id);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, entryId: 90001 });
    assert.deepEqual(boardCalls, [{ title: 'Antwort an Beispiel senden', task: 'Sende die Antwort an Beispiel (synthetisch).', why: 'Der Desk kann nicht senden' }]);
    const again = await click(evt.id);
    assert.equal(again.status, 404);
    assert.equal(boardCalls.length, 1);
  });

  it('foreign origin and missing origin are refused, the proposal stays usable', async () => {
    const evt = await propose();
    assert.equal((await click(evt.id, { origin: 'https://evil.example' })).status, 403);
    const noOrigin = await fetch(`${gw.base}/api/handoff`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: evt.id }) });
    assert.equal(noOrigin.status, 403);
    assert.equal(boardCalls.length, 0);
    assert.equal((await click(evt.id)).status, 200);
  });

  it('no cookie → 401; another session cannot use the id', async () => {
    const evt = await propose();
    const res = await fetch(`${gw.base}/api/handoff`, { method: 'POST', headers: { origin: DESK_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ id: evt.id }) });
    assert.equal(res.status, 401);
    const other = (await login(gw.base)).cookie;
    const foreign = await fetch(`${gw.base}/api/handoff`, { method: 'POST', headers: { cookie: other, origin: DESK_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ id: evt.id }) });
    assert.equal(foreign.status, 404);
    assert.equal(boardCalls.length, 0);
  });

  it('GET and bad ids are refused', async () => {
    assert.equal((await fetch(`${gw.base}/api/handoff`, { headers: { cookie } })).status, 405);
    assert.equal((await click('../../x')).status, 400);
    assert.equal(boardCalls.length, 0);
  });

  it('/api/status shows both bridges', async () => {
    const body = await (await fetch(`${gw.base}/api/status`, { headers: { cookie } })).json();
    assert.deepEqual(body.bridges.map((b) => b.host).sort(), ['lechonk', 'sandy']);
  });

  it('a bridge with a host outside lechonk|sandy is refused at upgrade', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/bridge?host=sandy-prod`, { headers: { authorization: `Bearer ${BRIDGE_TOKEN}` } });
    const status = await new Promise((resolve) => { ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)); ws.on('error', () => resolve('error')); });
    assert.equal(status, 400);
  });
});
