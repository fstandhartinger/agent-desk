// Round 12 (critic r11 §7 items 1, 3) end to end through POST /api/chat: invented files / paths / domains / product names
// drop their sentence, self-correction loops are dropped, a repeating stream is stopped and closed with a clean summary.
// All data synthetic.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';

let openrouter; let script; let gw; let bridge; let cookie; let audits;

const KNOWLEDGE = '{"found":true,"topic":"demo-bench","path":"/home/flori/desk-knowledge/topics/demo-bench.md"}\n---\n# DemoBench (Testdaten)\nDemoBench v9.9 ist live auf demobench.example.com, gebaut von Quarkworks. Bewertet 12 Modelle.';
const read = (i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'k1', name: 'knowledge_read', args: JSON.stringify({ topic: 'demo-bench' }) }] }) : null);

before(async () => {
  openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body, openrouter.seen.length - 1)));
  setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
  bridge = await connectFakeBridge(gw.port, { 'ctx.knowledge': () => KNOWLEDGE, 'audit.append': (line) => { audits.push(line); return { ok: true }; } });
});
after(() => { bridge.ws.close(); gw.close(); openrouter.close(); });
beforeEach(() => { openrouter.seen.length = 0; audits = []; });

const ask = async (content) => {
  const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c12', messages: [{ role: 'user', content }] }) });
  const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));
  return events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
};

describe('r12 item 1: prose names come from the turn', () => {
  it('critic repro (JevBench answer): an invented domain and an invented CamelCase brand drop their sentences, sourced ones stay', async () => {
    script = (_b, i) => read(i) ?? completionStream({ text: 'DemoBench v9.9 ist live auf demobench.example.com. Das Board liegt auf `benchmarkmind.io` von DecisionMind. Bewertet werden 12 Modelle von Quarkworks.' });
    const text = await ask('Was ist DemoBench und wie ist der Stand?');
    assert.match(text, /DemoBench v9\.9 ist live auf demobench\.example\.com\./);
    assert.match(text, /Bewertet werden 12 Modelle von Quarkworks\./);
    assert.doesNotMatch(text, /benchmarkmind|DecisionMind/);
  });

  it('a cited path / file / flag that no tool result carries drops its sentence ("/home/florian", "notify --send")', async () => {
    script = (_b, i) => read(i) ?? completionStream({ text: 'Laut /home/flori/desk-knowledge/topics/demo-bench.md sind es 12 Modelle. Die Quelle ist /home/florian/notes/bench.md. Sende es mit `notify --send`. Fertig.' });
    const text = await ask('Was steht in der DemoBench-Notiz?');
    assert.match(text, /^Laut \/home\/flori\/desk-knowledge\/topics\/demo-bench\.md sind es 12 Modelle\./);
    assert.doesNotMatch(text, /florian|--send/);
    assert.match(text, /Fertig\./);
  });
});

describe('r12 item 3: self-correction loops', () => {
  it('critic repro (deictic answer): "korrekt:", "— nein …", "ich verheddere mich", "Ich beende das" are dropped', async () => {
    const LOOP = 'DemoBench bewertet 12 Modelle.\nQuelle ist `/home/flori/desk-knowledge/topics/demo-bench.md` — nein, die Quelle ist der Index.\nKorrekt: die Datei liegt unter topics.\nIch verheddere mich hier.\nIch beende das: die Notiz ist die Quelle.\nNein, das stimmt so nicht.\nErst die Notiz `demo`… genauer: richtig ist:\nMehr steht dort nicht.';
    script = (_b, i) => read(i) ?? completionStream({ text: LOOP });
    const text = await ask('Kannst du mir dazu mehr sagen?');
    assert.match(text, /^DemoBench bewertet 12 Modelle\./);
    assert.match(text, /Mehr steht dort nicht\./);
    assert.doesNotMatch(text, /— nein|Korrekt:|verheddere|beende das|Nein, das stimmt|genauer|richtig ist/i);
  });

  it('a first-sentence "Nein, …" that answers the question stays', async () => {
    script = (_b, i) => read(i) ?? completionStream({ text: 'Nein, DemoBench bewertet nur 12 Modelle. Mehr steht dort nicht.' });
    assert.match(await ask('Bewertet DemoBench mehr als 12 Modelle?'), /^Nein, DemoBench bewertet nur 12 Modelle\./);
  });

  it('a stream that repeats itself is stopped; one more round without tools closes the answer with a short summary', async () => {
    const REPEAT = 'DemoBench bewertet 12 Modelle. '.concat('Die Quelle dafür ist die Notiz im Wissen unter topics, ', 'und die Quelle dafür ist die Notiz im Wissen unter topics, '.repeat(6));
    script = (body, i) => read(i) ?? (body.messages.at(-1).content.startsWith('Du wiederholst dich') ? completionStream({ text: 'Kurz: DemoBench bewertet 12 Modelle, Quelle ist die DemoBench-Notiz.' }) : completionStream({ text: REPEAT }));
    const text = await ask('Was ist DemoBench?');
    assert.match(text, /^DemoBench bewertet 12 Modelle\./);
    assert.match(text, /Kurz: DemoBench bewertet 12 Modelle, Quelle ist die DemoBench-Notiz\.$/);
    assert.ok((text.match(/Notiz im Wissen unter topics/g) ?? []).length <= 1, text);
    assert.equal(openrouter.seen.length, 3, 'tool round, looping round, summary round');
    assert.equal(openrouter.seen[2].body.tools, undefined, 'the summary round has no tools');
  });
});
