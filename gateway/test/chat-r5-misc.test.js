// Critic round 4 P2-3 (answer started mid-sentence, invented identifiers) and P2-7 (source label of a mail drawing). All data synthetic.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';
import { ProseGuardFilter, createProseGuard, cutAt, unknownIdentifiers } from '../src/proseGuard.js';
import { deriveSources } from '../src/illustrator.js';

let openrouter; let script; let gw; let bridge; let cookie;
const MAIL = '{"ok":true,"uid":"4711"}\n---\nBetreff: Rechenleistung\nAm 24. Juni sollen Anfragen zur Anmietung von Rechenleistung direkt an das Team gestellt werden. Commit abc1234 im Repo demo-org/demo-repo.';

before(async () => {
  openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body, openrouter.seen.length - 1)));
  setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
  bridge = await connectFakeBridge(gw.port, { 'mail.read': () => MAIL, 'audit.append': () => ({ ok: true }) }, { host: 'sandy' });
});
after(() => { bridge.ws.close(); gw.close(); openrouter.close(); });
beforeEach(() => { openrouter.seen.length = 0; });

const ask = async (content) => {
  const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content }] }) });
  const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));
  return events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
};
const chunked = (text, n) => text.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g'));
const mailCall = { id: 'm1', name: 'mail_read', args: JSON.stringify({ account: 'demo', uid: '4711' }) };

describe('P2-3 hold / release keeps every character', () => {
  it('round 1 = text + tool call, round 2 = answer: nothing lost, rounds separated by one paragraph break', async () => {
    const answer = 'Am 24. Juni sollen Anfragen zur Anmietung von Rechenleistung direkt an das Team gestellt werden.';
    script = (body, i) => (i === 0
      ? completionStream({ text: 'Ich lese die Mail.', toolCalls: [mailCall] })
      : completionStream({ text: answer }));
    const text = await ask('Lies die Mail 4711');
    assert.equal(text, `Ich lese die Mail.\n\n${answer}`);
    assert.ok(text.includes('Am 24. Juni sollen'), 'the sentence start survives');
  });

  it('round 1 = short non-announcement text (< 40 chars) is shown completely', async () => {
    script = () => completionStream({ text: 'Am 24. Juni, kurz.' });
    assert.equal(await ask('Wann?'), 'Am 24. Juni, kurz.');
  });

  it('answer streamed in tiny pieces after a tool call stays intact', async () => {
    const answer = 'Am 24. Juni sollen Anfragen zur Anmietung von Rechenleistung direkt an das Team gestellt werden. Danach folgt ein zweiter Satz.';
    script = (body, i) => (i === 0 ? completionStream({ toolCalls: [mailCall] }) : completionStream({ text: answer }));
    assert.equal(await ask('Lies die Mail 4711'), answer);
  });
});

describe('P2-3 sentence cut and identifier guard', () => {
  it('a day-number dot before a month is no sentence end; a real one still is', () => {
    assert.equal(cutAt('Am 24. Juni sollen sie kommen. Danach'), 'Am 24. Juni sollen sie kommen.'.length);
    assert.equal(cutAt('Es sind 24. Dann geht es weiter'), 'Es sind 24.'.length);
    const f = new ProseGuardFilter(createProseGuard({ given: () => '', checkAmounts: () => true }));
    assert.equal(f.push('Am 24. Juni sollen Anfragen kommen. ') + f.flush(), 'Am 24. Juni sollen Anfragen kommen. ');
  });

  it('unknownIdentifiers flags SHAs, repo slugs, mail uids and ISO dates the source lacks', () => {
    const src = 'mail uid 36541 vom 2026-06-24, commit abc1234 in demo-org/demo-repo'.toLowerCase();
    assert.deepEqual(unknownIdentifiers('Commit abc1234 in demo-org/demo-repo, Mail 36541 vom 2026-06-24.', src), []);
    assert.deepEqual(unknownIdentifiers('Commit d177e4e', src), ['d177e4e']);
    assert.deepEqual(unknownIdentifiers('Repo demo-orgx/demo-repo', src), ['demo-orgx/demo-repo']);
    assert.deepEqual(unknownIdentifiers('Mail 3651', src), ['Mail 3651']);
    assert.deepEqual(unknownIdentifiers('am 2024-06-24', src), ['2024-06-24']);
    assert.deepEqual(unknownIdentifiers('Ein/Aus, und/oder, 24/7, defaced, 20261028, Pfad /home/x/a-b/c-d, https://demo-org/x-y', src), []);
  });

  it('r6 P1-2: short SHA / UUID prefixes and the date part of ISO timestamps count as known', () => {
    assert.deepEqual(unknownIdentifiers('Session 01a18405 lief', '"session":"01a18405-991a-4c2b-9f00-123456789abc"'), []);
    assert.deepEqual(unknownIdentifiers('Commit 6f38935 ist live.', 'commit 6f38935c0ffee1234567890abcdef1234567890a'), []);
    assert.deepEqual(unknownIdentifiers('am 2026-10-28 um 12:54', '"ts":"2026-10-28t12:54:00z"'), []);
    assert.deepEqual(unknownIdentifiers('am 2026-10-28 um 12:54', 'ts 2026-10-28 12:54'), []);
    assert.deepEqual(unknownIdentifiers('am 2026-10-29', '"ts":"2026-10-28t12:54:00z"'), ['2026-10-29']);
    assert.deepEqual(unknownIdentifiers('Commit deadbe1', 'commit 6f38935c0ffee'), ['deadbe1']);
  });

  it('r6 P1-2 live shape: a chats answer keeps its heading, only the unknown id becomes "…"', () => {
    const guard = createProseGuard({ given: () => '{"agent":"codex","project":"demo-proj","session":"01a18405-991a-4c2b-9f00-123456789abc","ts":"2026-10-28T19:38:00Z"}', checkAmounts: () => true });
    const ok = guard.check('Codex, Projekt demo-proj, Session 01a18405 (2026-10-28 19:38 UTC).');
    assert.equal(ok.notes.length, 0);
    assert.equal(ok.text, 'Codex, Projekt demo-proj, Session 01a18405 (2026-10-28 19:38 UTC).');
    const part = guard.check('Codex, Projekt demo-proj, Session 99ffee12 lief.');
    assert.equal(part.text, 'Codex, Projekt demo-proj, Session … lief.');
  });

  it('the guard replaces an unsupported identifier once tools ran, and keeps grounded ones', () => {
    const guard = createProseGuard({ given: () => 'Mail 4711 Commit abc1234 demo-org/demo-repo 2026-06-24', checkAmounts: () => true });
    assert.equal(guard.check('Commit abc1234 im Repo demo-org/demo-repo.').notes.length, 0);
    const bad = guard.check('Commit d177e4e im Repo fstranational/agent-desk.');
    assert.equal(bad.dropped, undefined, 'r6: the identifier is replaced, the sentence stays');
    assert.equal(bad.text, 'Commit … im Repo ….');
    assert.match(bad.notes[0], /identifier/);
    const off = createProseGuard({ given: () => '', checkAmounts: () => false });
    assert.equal(off.check('Commit d177e4e.').dropped, undefined, 'no tool ran: no identifier check');
  });

  it('end to end: the invented identifier sentence is not shown', async () => {
    script = (body, i) => (i === 0
      ? completionStream({ toolCalls: [mailCall] })
      : completionStream({ text: 'Die Mail nennt Commit abc1234. Außerdem steht dort Commit d177e4e im Repo fstranational/agent-desk. Mehr gibt es nicht.' }));
    const text = await ask('Lies die Mail 4711');
    assert.match(text, /abc1234/);
    assert.doesNotMatch(text, /d177e4e|fstranational/);
    assert.match(text, /Mehr gibt es nicht\./);
  });
});

describe('P2-7 source label of a drawing from the main agent\'s mail read', () => {
  const mail = { name: 'mail_read', args: { account: 'demo', uid: '4711' }, ok: true, content: MAIL, own: false };
  const board = { name: 'board_search', args: { query: 'Rechenleistung' }, ok: true, content: '{}', own: true };
  it('names the mail, not the illustrator\'s own board search', () => {
    assert.deepEqual(deriveSources([mail, board]).map((s) => s.label), ['Mail 4711 (demo)']);
    assert.deepEqual(deriveSources([board, mail]).map((s) => s.label), ['Mail 4711 (demo)']);
  });
  it('the illustrator\'s own lookup still counts when the agent read nothing usable', () => {
    assert.deepEqual(deriveSources([board]).map((s) => s.label), ['Board-Suche']);
    assert.deepEqual(deriveSources([{ ...mail, own: false, name: 'web_read' }, board]).map((s) => s.label), ['Board-Suche']);
  });
});
