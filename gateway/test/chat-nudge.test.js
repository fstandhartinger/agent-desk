// Critic round 2, P2-1: the text agent announced tool work ("I'll read both in parallel.") and stopped without a tool
// call. Such a round gets ONE more round with a nudge; a real short answer is not nudged. All data synthetic.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';
import { ACT_NUDGE, isAnnouncement, pathHint, userPaths } from '../src/chat.js';
import { buildInstructions } from '../src/prompt.js';
import { TOOL_DEFS } from '../src/tools.js';

let openrouter; let script; let gw; let bridge; let cookie;
const KNOWLEDGE = '{"found":true,"topic":"demo-bench","path":"/home/flori/desk-knowledge/topics/demo-bench.md"}\n---\n# DemoBench (Testdaten)\nDemoBench bewertet 12 Modelle.';

before(async () => {
  openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body, openrouter.seen.length - 1)));
  setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
  bridge = await connectFakeBridge(gw.port, { 'ctx.knowledge': () => KNOWLEDGE, 'audit.append': () => ({ ok: true }) });
});
after(() => { bridge.ws.close(); gw.close(); openrouter.close(); });
beforeEach(() => { openrouter.seen.length = 0; });

const ask = async (content) => {
  const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content }] }) });
  const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));
  return { text: events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), tools: events.filter((e) => e.type === 'tool' && e.status === 'start') };
};

describe('P2-1 announcement without a tool call', () => {
  it('detects DE/EN announcements, not answers', () => {
    for (const t of ["I'll read both in parallel.", "I'll search both chat histories in parallel.", 'Let me check the board entry.', 'Ich lese beide Einträge parallel.', 'Einen Moment, ich schaue nach.', 'Okay, ich prüfe das.', 'Lass mich kurz nachsehen …']) assert.ok(isAnnouncement(t), t);
    for (const t of ['DemoBench bewertet 12 Modelle.', 'Einen Moment, das ist ein ganz normaler Satz.', 'Ich weiß es nicht.', 'Ich habe beide gelesen: Eintrag 1 sagt X.', '', `Ich lese ${'sehr '.repeat(80)}viel.`]) assert.ok(!isAnnouncement(t), t);
  });

  it('critic repro: announce → nudge round → tool call → German answer', async () => {
    script = (body, i) => {
      if (i === 0) return completionStream({ text: "I'll read both in parallel." });
      if (i === 1) return completionStream({ toolCalls: [{ id: 'k1', name: 'knowledge_read', args: JSON.stringify({ topic: 'demo-bench' }) }] });
      return completionStream({ text: 'DemoBench bewertet 12 Modelle.' });
    };
    const { text, tools } = await ask('Lies den Board-Eintrag und die Seite');
    assert.equal(openrouter.seen.length, 3);
    const nudgeReq = openrouter.seen[1].body.messages;
    assert.deepEqual(nudgeReq.slice(-2).map((m) => [m.role, m.content]), [['assistant', "I'll read both in parallel."], ['system', ACT_NUDGE]]);
    assert.ok(openrouter.seen[1].body.tools?.length, 'the nudge round still has tools');
    assert.equal(tools.length, 1);
    assert.match(text, /DemoBench bewertet 12 Modelle\./);
    assert.doesNotMatch(text, /parallel/, 'critic r3 P2-4: the announcement is not part of the visible answer');
    assert.equal(text, 'DemoBench bewertet 12 Modelle.');
  });

  it('only one nudge per answer: a second announcement ends the turn', async () => {
    script = () => completionStream({ text: 'Ich schaue nach.' });
    await ask('Was ist DemoBench?');
    assert.equal(openrouter.seen.length, 2);
  });

  it('a normal short answer is not nudged', async () => {
    script = () => completionStream({ text: 'DemoBench bewertet 12 Modelle.' });
    const { text } = await ask('Was ist DemoBench?');
    assert.equal(openrouter.seen.length, 1);
    assert.match(text, /12 Modelle/);
  });
});

describe('P2-7 paths Florian gives are used verbatim', () => {
  it('extracts absolute /home/flori paths only, without trailing punctuation', () => {
    assert.deepEqual(userPaths('Lies /home/flori/jobs/demo-job/probe/notes.md. Und `/home/flori/bin/tool`, nicht /home/florian/a oder /tmp/home/flori/b'), ['/home/flori/jobs/demo-job/probe/notes.md', '/home/flori/bin/tool']);
    assert.deepEqual(userPaths('Was läuft gerade?'), []);
  });
  it('prompt and tool description say so; the chat adds a hint with the exact path', async () => {
    assert.match(buildInstructions(null), /absoluten Pfad, gib genau diesen Pfad wörtlich an read_file/);
    assert.match(TOOL_DEFS.find((t) => t.name === 'read_file').parameters.properties.path.description, /verbatim/);
    script = () => completionStream({ text: 'Die Notiz ist leer.' });
    await ask('Was steht in /home/flori/jobs/demo-job/probe/notes.md?');
    const msgs = openrouter.seen[0].body.messages;
    assert.deepEqual(msgs.at(-1), { role: 'system', content: pathHint(['/home/flori/jobs/demo-job/probe/notes.md']) });
  });
});
