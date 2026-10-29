// Round 8 (critic r7 F2) end to end: the text agent's money answer with self-corrections is replaced by the ledger's list.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';

let openrouter; let script; let gw; let bridge; let cookie;
const BAD = 'AlphaCloud liegt bei 1.234,50 € – Moment, das stimmt nicht, mein erster Satz war falsch. Entschuldige. fakecorp221: 221 € – Moment, auch das stimmt nicht. **6.000 €** (Unbekannt?). Ich merke, ich vermische gerade die Zahlen.';
const GOOD = 'Am meisten geht an AlphaCloud: 700,00 € (ca.). Danach GammaPayout mit 500,00 € (ca.).';

before(async () => {
  openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body, openrouter.seen.length - 1)));
  setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
  bridge = await connectFakeBridge(gw.port, {
    'ledger.entries': () => ({
      entries: [
        { date: '2026-10-01', amount: 700, currency: 'EUR', eurApprox: 700, counterparty: 'AlphaCloud', purpose: 'Miete', category: 'GPU', kg: true },
        { date: '2026-10-02', amount: 500, currency: 'EUR', eurApprox: 500, counterparty: 'GammaPayout', purpose: 'Auszahlung', category: 'Auszahlungen', kg: false },
      ],
      count: 2, groupBy: 'counterparty', totals: [], totalsEurApprox: [{ key: 'AlphaCloud', sumEur: 700, count: 1 }, { key: 'GammaPayout', sumEur: 500, count: 1 }], source: { kind: 'board', ref: 'Board #22' },
    }),
  });
});
after(() => { bridge.ws.close(); gw.close(); openrouter.close(); });
beforeEach(() => { openrouter.seen.length = 0; });

const ask = async (content) => {
  const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c', messages: [{ role: 'user', content }] }) });
  const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));
  return events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
};

describe('text chat: money answers', () => {
  it('the model sees the list ("liste genau diese Werte") in the ledger result, and the bad answer text is replaced by that list', async () => {
    script = (_b, i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'c1', name: 'ledger_spend', args: JSON.stringify({ groupBy: 'counterparty' }) }] }) : completionStream({ text: BAD }));
    const text = await ask('Zeig mir als Balkendiagramm die Ausgaben nach Gegenpartei.');
    const toolMsg = openrouter.seen[1].body.messages.at(-1);
    assert.match(toolMsg.content, /liste genau diese Werte/);
    assert.match(toolMsg.content, /AlphaCloud: 700,00 € \(ca\.\), 1 Eintrag/);
    assert.doesNotMatch(text, /Moment|stimmt nicht|vermische|Entschuldige|6\.000|fakecorp|1\.234,50/);
    assert.match(text, /- AlphaCloud: 700,00 € \(ca\.\), 1 Eintrag\n- GammaPayout: 500,00 € \(ca\.\), 1 Eintrag\n- Summe: 1\.200,00 € \(ca\.\), 2 Einträge/);
  });

  it('a model answer with amounts is replaced by the deterministic list (no model-written numbers)', async () => {
    script = (_b, i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'c1', name: 'ledger_spend', args: JSON.stringify({ groupBy: 'counterparty' }) }] }) : completionStream({ text: GOOD }));
    const text = await ask('Wohin geht das Geld nach Gegenpartei?');
    assert.equal(text, 'Laut Ledger:\n- AlphaCloud: 700,00 € (ca.), 1 Eintrag\n- GammaPayout: 500,00 € (ca.), 1 Eintrag\n- Summe: 1.200,00 € (ca.), 2 Einträge');
  });

  it('r8 F2 repro: table with a wrong number, "Korrekt aus dem Ergebnis:", second table -> one list, one amount-free sentence, no copies', async () => {
    const TABLE = 'Das Geld geht vor allem in GPU-Miete.\n\n| Posten | Betrag |\n|---|---|\n| AlphaCloud | 3.111,11 € |\n\nKorrekt aus dem Ergebnis:\n\n| AlphaCloud | 700,00 € |\n| GammaPayout | 500,00 € |\n\nLaut Ledger:\n- AlphaCloud: 700,00 € (ca.), 1 Eintrag';
    script = (_b, i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'c1', name: 'ledger_spend', args: JSON.stringify({ groupBy: 'counterparty' }) }] }) : completionStream({ text: TABLE }));
    const text = await ask('Wofür geben wir das Geld aus?');
    assert.match(text, /^Das Geld geht vor allem in GPU-Miete\.\n\nLaut Ledger:\n- AlphaCloud: 700,00 € \(ca\.\), 1 Eintrag/);
    assert.doesNotMatch(text, /4\.972|Korrekt|\|/);
    assert.equal(text.match(/Laut Ledger:/g).length, 1);
    assert.equal(text.match(/AlphaCloud/g).length, 1);
  });

  it('a sentence cut at a date ("Stand 24.10. 21:04 UTC).") leaves no orphan fragment', async () => {
    script = (_b, i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'c1', name: 'ledger_spend', args: JSON.stringify({ groupBy: 'counterparty' }) }] }) : completionStream({ text: 'Das Geld geht vor allem an AlphaCloud (Stand 24.10. 21:04 UTC). Mehr dazu unten.' }));
    const text = await ask('Wofür geben wir das Geld aus?');
    assert.match(text, /^Mehr dazu unten\.\n\nLaut Ledger:/);
    assert.doesNotMatch(text, /UTC|Stand/);
  });

  it('r9 live: percentages and a sentence cut at "ca." never survive', async () => {
    script = (_b, i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'c1', name: 'ledger_spend', args: JSON.stringify({ groupBy: 'counterparty' }) }] }) : completionStream({ text: 'Ich zeichne dir die Verteilung auf. Bild: rund 58 % AlphaCloud, GammaPayout nur ca. 42 %.' }));
    const text = await ask('Wofür geben wir das Geld aus?');
    assert.match(text, /^Ich zeichne dir die Verteilung auf\.\n\nLaut Ledger:/);
    assert.doesNotMatch(text, /%|ca\.\s*$|Bild:/m);
  });

  it('a draft written before a further tool call is stripped of amounts too; the list still appears once, at the end', async () => {
    script = (_b, i) => {
      if (i === 0) return completionStream({ toolCalls: [{ id: 'c1', name: 'ledger_spend', args: JSON.stringify({ groupBy: 'counterparty' }) }] });
      if (i === 1) return completionStream({ text: 'AlphaCloud: 9.999,00 €', toolCalls: [{ id: 'c2', name: 'ledger_spend', args: JSON.stringify({ groupBy: 'counterparty' }) }] });
      return completionStream({ text: 'Es geht fast alles an AlphaCloud.' });
    };
    const text = await ask('Wofür geben wir das Geld aus?');
    assert.doesNotMatch(text, /9\.999/);
    assert.equal(text.match(/Laut Ledger:/g).length, 1);
    assert.ok(text.endsWith('Einträge'));
  });

  it('text before a tool call and the answer after it are separated by a paragraph break', async () => {
    script = (_b, i) => (i === 0 ? completionStream({ text: 'Ich schaue nach.', toolCalls: [{ id: 'c1', name: 'ledger_spend', args: JSON.stringify({ groupBy: 'counterparty' }) }] }) : completionStream({ text: GOOD }));
    assert.match(await ask('Wohin geht das Geld nach Gegenpartei?'), /^Ich schaue nach\.\n\nLaut Ledger:\n- AlphaCloud: 700,00/);
  });

  it('without a ledger result the guard does not interfere (a normal answer with "Moment" stays)', async () => {
    script = () => completionStream({ text: 'Einen Moment, das ist ein ganz normaler Satz.' });
    assert.equal(await ask('Hallo'), 'Einen Moment, das ist ein ganz normaler Satz.');
  });
});
