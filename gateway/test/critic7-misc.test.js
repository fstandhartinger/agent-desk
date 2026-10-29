// Critic round 7: P2-2 (the loop detector cut a legitimate list and the closing summary claimed missing results), P2-5
// (code_outline "files: 0" read as an empty folder), P2-6 (an auto canvas said "ohne Fakten" for a part the agent's results
// cover). All data synthetic.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';
import { unsupportedGap } from '../src/illustrator.js';
import { LoopDetector, NoResultsClaimFilter } from '../src/proseGuard.js';
import { runTool } from '../src/tools.js';

const ERR = (ip) => `ERROR: address not allowed for ${ip} (private, loopback, link-local or reserved)`;

describe('P2-2: LoopDetector and a legitimate list', () => {
  it('the critic repro (loopfp.mjs): three list items with the same error text are no loop', () => {
    const d = new LoopDetector();
    const lines = ['1. a — blockiert: address not allowed for ::1 (private, loopback, link-local or reserved)\n', '2. b — blockiert: address not allowed for 10.0.0.1 (private, loopback, link-local or reserved)\n', '3. c — blockiert: address not allowed for 169.254.169.254 (private, loopback, link-local or reserved)\n', '4. d — ok\n'];
    for (const l of lines) assert.equal(d.push(l), false, l);
  });
  it('the same words in prose are no loop when they quote this turn\'s tool results', () => {
    const d = new LoopDetector();
    d.allow([ERR('::1'), ERR('10.0.0.1'), ERR('169.254.169.254')].join('\n'));
    const prose = 'Die erste Adresse: private, loopback, link-local or reserved. Die zweite auch: private, loopback, link-local or reserved. Und die dritte: private, loopback, link-local or reserved. ';
    assert.equal(d.push(prose), false);
  });
  it('a list whose items repeat word for word is still a loop, and so is repeating prose', () => {
    const d = new LoopDetector();
    const item = (n) => `${n}. Die Quelle ist die Notiz im Wissen unter topics.\n`;
    assert.equal(d.push(item(1)) || d.push(item(2)) || d.push(item(3)), true);
    const p = new LoopDetector();
    assert.equal(p.push('und die Quelle dafür ist die Notiz im Wissen unter topics, '.repeat(3)), true);
  });
  it('streamed in small pieces, a list item split over pushes gives its counts back at the line end', () => {
    const d = new LoopDetector();
    const text = [1, 2, 3, 4, 5].map((n) => `${n}. Ziel ${n} wird vom Desk nicht abgerufen, weil die Adresse intern ist\n`).join('');
    let looped = false;
    for (let i = 0; i < text.length; i += 7) looped ||= d.push(text.slice(i, i + 7));
    assert.equal(looped, false);
  });
  it('NoResultsClaimFilter drops "keine Ergebnisse vorliegen" sentences and keeps the rest', () => {
    const f = new NoResultsClaimFilter();
    const out = f.push('Alle Anfragen an interne Ziele wurden abgelehnt. Für den Rest deiner Liste habe ich keine Ergebnisse vorliegen. ') + f.push('Die Ergebnisse fehlen für Punkt 5.') + f.flush();
    assert.equal(out, 'Alle Anfragen an interne Ziele wurden abgelehnt.');
    const off = new NoResultsClaimFilter(() => false);
    assert.equal(off.push('Dazu habe ich keine Ergebnisse vorliegen. ') + off.flush(), 'Dazu habe ich keine Ergebnisse vorliegen. ');
  });
});

describe('P2-2 end to end: a list of seven blocked URLs is answered in full', () => {
  let openrouter; let script; let gw; let bridge; let cookie;
  before(async () => {
    openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body, openrouter.seen.length - 1)));
    setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
    gw = await startGateway();
    cookie = (await login(gw.base)).cookie;
    bridge = await connectFakeBridge(gw.port, { 'audit.append': () => ({ ok: true }) });
  });
  after(() => { bridge.ws.close(); gw.close(); openrouter.close(); });
  beforeEach(() => { openrouter.seen.length = 0; });
  const ask = async (content) => {
    const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c7', messages: [{ role: 'user', content }] }) });
    const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));
    return events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  };
  const IPS = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '169.254.169.254', '127.0.0.1', '192.168.0.1', '172.16.0.1'];
  const calls = completionStream({ toolCalls: IPS.map((ip, i) => ({ id: `w${i}`, name: 'web_read', args: JSON.stringify({ url: `http://${ip}/` }) })) });

  it('the answer quoting the same error line seven times is not cut', async () => {
    const LIST = `Alle sieben sind abgewehrt:\n${IPS.map((ip, i) => `${i + 1}. ${ip} — blockiert: address not allowed for ${ip} (private, loopback, link-local or reserved)`).join('\n')}\nFertig.`;
    script = (_b, i) => (i === 0 ? calls : completionStream({ text: LIST }));
    const text = await ask('Lies diese sieben URLs.');
    assert.match(text, /7\. 172\.16\.0\.1 — blockiert: address not allowed for 172\.16\.0\.1 \(private, loopback, link-local or reserved\)/);
    assert.match(text, /Fertig\.$/);
    assert.equal(openrouter.seen.length, 2, 'no summary round');
  });
  it('after a real loop the closing summary may not claim that results are missing', async () => {
    const REPEAT = 'Ergebnis: '.concat('die Prüfung meldet einen Fehler bei der Adresse, '.repeat(6));
    script = (body, i) => (i === 0 ? calls : body.messages.at(-1).content.startsWith('Du wiederholst dich')
      ? completionStream({ text: 'Alle sieben Ziele wurden abgelehnt. Für den Rest deiner Liste habe ich keine Ergebnisse vorliegen.' })
      : completionStream({ text: REPEAT }));
    const text = await ask('Lies diese sieben URLs.');
    assert.match(text, /Alle sieben Ziele wurden abgelehnt\./);
    assert.doesNotMatch(text, /keine Ergebnisse/);
    assert.match(openrouter.seen[2].body.messages.at(-1).content, /liegen dir vor/);
  });
});

describe('P2-5: code_outline with no code files', () => {
  it('says "keine Code-Dateien", not an empty folder', async () => {
    const hub = { call: async () => ({ root: '/home/flori/probe', files: [], truncated: false }), pick: () => 'sandy' };
    const r = await runTool('code_outline', { path: '/home/flori/probe' }, { hub, audit: () => {} });
    assert.equal(r.ok, true);
    assert.match(r.content, /keine Code-Dateien/);
    assert.match(r.summary, /keine Code-Dateien/);
  });
  it('a folder with code files has no such note', async () => {
    const hub = { call: async () => ({ root: '/r', files: [{ path: 'a.js', lines: 3 }], truncated: false }), pick: () => 'sandy' };
    assert.doesNotMatch((await runTool('code_outline', { path: '/r' }, { hub, audit: () => {} })).content, /keine Code-Dateien/);
  });
});

describe('P2-6: an auto canvas may not say "ohne Fakten" for a part the agent covered', () => {
  const results = ['{"hits":[{"agent":"codex","host":"sandy","title":"cos-deputy-opus","text":"Regex-Review"}]}', '{"hits":[{"agent":"claude","title":"critic-7"}]}'];
  it('the critic repro: "(Codex-Teil ohne Fakten)" with a Codex result is unsupported, in the title parenthesis', () => {
    const gap = unsupportedGap({ title: 'Claude-Chats zu ReDoS (Codex-Teil ohne Fakten)' }, results);
    assert.equal(gap.where, 'title');
    assert.equal(gap.paren, '(Codex-Teil ohne Fakten)');
  });
  it('a caption "keine Daten" when results exist is unsupported; one naming a part with no result stays', () => {
    assert.equal(unsupportedGap({ title: 'X', caption: 'Zum Discord-Teil keine Daten gefunden.' }, results), null);
    assert.equal(unsupportedGap({ title: 'X', caption: 'Keine Daten.' }, results).where, 'caption');
  });
  it('when every agent result is an error, a gap claim stays', () => {
    assert.equal(unsupportedGap({ title: 'Codex-Teil ohne Ergebnisse' }, ['ERROR: no bridge with chat search is connected']), null);
  });
});
