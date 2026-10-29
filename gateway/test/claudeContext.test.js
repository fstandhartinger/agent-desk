import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DESK_ORIGIN, completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';
import { formatChatContext } from '../src/claudeSessions.js';

const POINTS = { page: { title: 'Warum Agenten Limits brauchen', context: 'Kontext' }, points: { p1: { title: 'Limit', short: 'kurz', more: 'lang' } } };
const TIMELINE = { scenes: [{ id: 's1', start: 0, end: 60 }], words: [{ w: 'Hallo', s: 9, e: 10 }, { w: 'Welt', s: 11, e: 12 }] };

let explainer;
let openrouter;
let gw;
let bridge;
let cookie;
let script;

before(async () => {
  explainer = await fakeServer((req, res) => {
    const body = req.url.endsWith('points.json') ? POINTS : req.url.endsWith('timeline.json') ? TIMELINE : null;
    if (!body || req.url.includes('unknown-page')) return res.writeHead(404).end();
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body)));
  setEnv({ EXPLAINER_ORIGIN: explainer.url, OPENROUTER_BASE_URL: openrouter.url });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
  bridge = await connectFakeBridge(gw.port, { 'claude.list': () => ({ sessions: [] }), 'claude.start': () => ({ sid: 'd20261024-abc123' }), 'audit.append': () => ({}) });
});
after(() => { bridge.ws.close(); gw.close(); explainer.close(); openrouter.close(); });

const started = () => bridge.requests.filter((r) => r.method === 'claude.start').at(-1).params;

describe('claude.start gets the page title and the recent chat transcript', () => {
  it('from the Claude API: title and narration come from the published explainer, chat turns are formatted', async () => {
    const chatContext = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Nachricht ${i}` }));
    const res = await fetch(`${gw.base}/api/claude/sessions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Mach X', page: { slug: 'demo-slug', t: 10, pointId: 'p1', title: 'Vom Browser (ignoriert)' }, chatContext }) });
    assert.equal(res.status, 200);
    const params = started();
    assert.equal(params.page.title, 'Warum Agenten Limits brauchen');
    assert.equal(params.page.sceneId, 's1');
    assert.equal(params.page.point.title, 'Limit');
    assert.match(params.page.transcriptNear, /Hallo Welt/);
    assert.match(params.chatContext, /^Florian: Nachricht 2\nDesk-Agent: Nachricht 3/);
    assert.ok(params.chatContext.endsWith('Desk-Agent: Nachricht 13'));
    assert.ok(!params.chatContext.includes('Nachricht 1\n'));
  });

  it('falls back to the title the browser sent when the explainer cannot be loaded', async () => {
    await fetch(`${gw.base}/api/claude/sessions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Mach Y', page: { slug: 'unknown-page', t: 1, title: 'Eigener Titel' } }) });
    assert.equal(started().page.title, 'Eigener Titel');
  });

  it('from the text agent tool claude_task (after the click): page title and the last chat turns of the conversation', async () => {
    script = (body) => (body.messages.some((m) => m.role === 'tool')
      ? completionStream({ text: 'Gestartet.' })
      : completionStream({ toolCalls: [{ id: 'c1', name: 'claude_task', args: JSON.stringify({ prompt: 'Recherchiere Z' }) }] }));
    const messages = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Frage ${i}` }));
    messages.push({ role: 'user', content: 'Starte eine Session dazu' });
    const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c', messages: messages.slice(-39), page: { slug: 'demo-slug', t: 10 } }) });
    const events = await readSse(res, (e) => e.some((x) => x.type === 'done'));
    const proposal = events.find((e) => e.type === 'claude_proposal');
    const before = bridge.requests.filter((r) => r.method === 'claude.start').length;
    const click = await fetch(`${gw.base}/api/claude/proposal`, { method: 'POST', headers: { cookie, origin: DESK_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ id: proposal.id }) });
    assert.equal(click.status, 200);
    assert.equal(bridge.requests.filter((r) => r.method === 'claude.start').length, before + 1);
    const params = started();
    assert.equal(params.page.title, 'Warum Agenten Limits brauchen');
    assert.equal(params.chatContext.split('\n').length, 12);
    assert.ok(params.chatContext.endsWith('Florian: Starte eine Session dazu'));
  });
});

describe('formatChatContext', () => {
  it('keeps the newest 12 turns within 6 KB and drops unknown roles', () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `${i}`.padEnd(1400, 'x') }));
    const out = formatChatContext([{ role: 'system', content: 'geheim' }, ...long]);
    assert.ok(out.length <= 6000 && !out.includes('geheim'));
    assert.ok(out.includes('Florian: 19'));
    assert.equal(formatChatContext('a'.repeat(9000)).length, 6000);
    assert.equal(formatChatContext(undefined), undefined);
    assert.equal(formatChatContext([]), undefined);
  });
});
