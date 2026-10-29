// Round 10 (critic r9 §8 items 1-2) end to end through POST /api/chat: the money list only answers spending questions,
// names and amounts in the prose come from what the model was given. All data synthetic.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';

let openrouter; let script; let gw; let bridge; let cookie;

// Florian's own sentences from the critic run (no data in them, only the question)
const TAX_Q = 'Ich habe eine Frage über unsere Steuerrücklagen und über die Notwendigkeit, ständig erhaltene Honoraremissionen überweisen zu müssen und dann in Euro umwandeln zu müssen.';
const TAX_Q2 = 'Es geht darum, dass unser Subnetz 92 Honoraremissionen emittiert und die gehen an sich in meinen Besitz über, und ich muss momentan ungefähr die Hälfte davon regelmäßig in Euro umwandeln, damit ich die Steuerlast in Deutschland bedienen kann.';
const KNOWLEDGE = '{"found":true,"topic":"owner-emissions-tax","path":"/home/flori/desk-knowledge/topics/owner-emissions-tax.md"}\n---\n# Owner-Emissionen (Testdaten)\nTranchen zu 111 α, Preisgrenze 0,0123 EUR, Zweck: Einkommensteuer (~41 %) + Firmenkosten. Rücklage 2.222,00 € je Quartal.';
const EXPLAIN = 'Die Emissionen werden in Tranchen zu 111 α verkauft. Unter der Preisgrenze von 0,0123 EUR wird nicht verkauft. Die Rücklage liegt bei 2.222,00 € je Quartal. Dafür brauchst du rund 9.999,00 € extra.';

before(async () => {
  openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body, openrouter.seen.length - 1)));
  setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'deepseek/deepseek-v9.1-test', DESK_CANVAS_MODEL: 'deepseek/deepseek-v9.1-test', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
  bridge = await connectFakeBridge(gw.port, {
    'ledger.entries': () => ({
      entries: [
        { date: '2026-10-01', amount: 700, currency: 'EUR', eurApprox: 700, counterparty: 'AlphaCloud', purpose: 'Miete', category: 'GPU', kg: true },
        { date: '2026-10-02', amount: 500, currency: 'EUR', eurApprox: 500, counterparty: 'GammaPayout', purpose: 'Auszahlung', category: 'Auszahlungen', kg: false },
      ],
      count: 2, groupBy: 'category', totals: [], totalsEurApprox: [{ key: 'GPU', sumEur: 700, count: 1 }, { key: 'Auszahlungen', sumEur: 500, count: 1 }], source: { kind: 'board', ref: 'Board #22' },
    }),
    'ctx.knowledge': () => KNOWLEDGE,
  });
});
after(() => { bridge.ws.close(); gw.close(); openrouter.close(); });
beforeEach(() => { openrouter.seen.length = 0; });

const ask = async (content) => {
  const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c', messages: [{ role: 'user', content }] }) });
  const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));
  return events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
};
const both = (i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'k1', name: 'knowledge_read', args: JSON.stringify({ topic: 'owner-emissions-tax' }) }, { id: 'l1', name: 'ledger_spend', args: JSON.stringify({ groupBy: 'category' }) }] }) : null);

describe('r10 item 1: the money guard answers only spending questions', () => {
  it('Florian\'s tax-reserve question with ledger_spend as context keeps the explanation, sourced numbers stay, no spend list', async () => {
    script = (_b, i) => both(i) ?? completionStream({ text: EXPLAIN });
    const text = await ask(TAX_Q);
    assert.match(text, /Tranchen zu 111 α/);
    assert.match(text, /Preisgrenze von 0,0123 EUR/);
    assert.match(text, /2\.222,00 € je Quartal/); // the knowledge_read number counts as sourced
    assert.doesNotMatch(text, /Laut Ledger|AlphaCloud|Summe: 1\.200/); // no deterministic spend list
    assert.doesNotMatch(text, /9\.999/); // an amount in no tool result is dropped with its sentence
  });

  it('the second tax sentence too (Subnetz 92 / Steuerlast)', async () => {
    script = (_b, i) => both(i) ?? completionStream({ text: EXPLAIN });
    const text = await ask(TAX_Q2);
    assert.match(text, /^Die Emissionen werden in Tranchen/);
    assert.doesNotMatch(text, /Laut Ledger/);
  });

  it('the money question still gets the deterministic list (same turn shape)', async () => {
    script = (_b, i) => both(i) ?? completionStream({ text: 'Das meiste geht an AlphaCloud: 3.333,00 €.' });
    const text = await ask('Wofür geben wir das Geld aus?');
    assert.match(text, /Laut Ledger:\n- GPU: 700,00 € \(ca\.\), 1 Eintrag/);
    assert.doesNotMatch(text, /3\.333/);
  });
});

describe('r10 item 2: names come from what the model was given', () => {
  it('"Welche Modelle nutzt das Agent-Desk-Gateway?": invented models are replaced or dropped, the real ones stay', async () => {
    const TABLE = 'Laut desk_status:\n\n| Rolle | Modell |\n|---|---|\n| Text | deepseek/deepseek-v9-test |\n| Stimme | OpenAI gpt-4o-realtime-preview |\n| Stimme | xAI grok-voice-3.0 |\n\nZusätzlich ElevenLabs eleven_turbo_v2_5 für Sprache.\n';
    script = (_b, i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'd1', name: 'desk_status', args: '{}' }] }) : completionStream({ text: TABLE }));
    const text = await ask('Welche Modelle nutzt das Agent-Desk-Gateway für Text, Zeichnen und Stimme?');
    assert.match(text, /\| Text \| deepseek\/deepseek-v9\.1-test \|/); // close sibling of the configured model -> replaced
    assert.match(text, /grok-voice-3\.0/);
    assert.doesNotMatch(text, /gpt-4o-realtime|eleven_turbo/);
    // the prompt itself carries the desk facts now (root cause: the text agent never saw them)
    assert.match(openrouter.seen[0].body.messages[0].content, /Desk-Fakten[\s\S]*Text-Agent \(Chat\): deepseek\/deepseek-v9\.1-test[\s\S]*gpt-live-1[\s\S]*scribe_v2/);
  });

  it('an unknown host in a bridge position becomes the connected bridge host; elsewhere its sentence is dropped', async () => {
    script = (_b, i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'd1', name: 'desk_status', args: '{}' }] }) : completionStream({ text: 'Der Browser spricht mit dem Gateway. Jeder Werkzeugaufruf geht über die Bridge → Leontin. Die Daten liegen auf Quarkbox. Fertig.' }));
    const text = await ask('Erklär mir die Architektur vom Agent-Desk-Gateway.');
    assert.match(text, /Bridge → LeChonk/);
    assert.doesNotMatch(text, /Leontin|Quarkbox/);
    assert.match(text, /Fertig\./);
  });

  it('"X? — nein, Y" self-corrections keep only Y; a "Korrektur zum Namen" sentence is dropped', async () => {
    const SELF = '- **AlphaCorp** (CTO Max? nein — Erika Muster) – größter Kunde.\n- Slots je USD 2.000? — nein: Decke USD 2.000 gilt für Projekt B.\n\nKorrektur zum Namen: Erika Muster ist CTO.';
    script = () => completionStream({ text: SELF });
    const text = await ask('Welche Kunden haben wir?');
    assert.match(text, /\(Erika Muster\) – größter Kunde/);
    assert.match(text, /- Decke USD 2\.000 gilt für Projekt B\./);
    assert.doesNotMatch(text, /nein|Max\?|Korrektur/);
  });

  it('r10 live meltdown sentences ("verwechselt — korrigiert", "verrannt") are dropped, the sourced lines stay', async () => {
    script = () => completionStream({ text: '- **AlphaCorp** – größter Kunde.\nIch habe hier zwei Einträge verwechselt — korrigiert: AlphaCorp ist richtig.\nIch habe mich verrannt.\n- **GammaCorp** – EU-Tier.' });
    const text = await ask('Welche Kunden haben wir?');
    assert.match(text, /AlphaCorp\*\* – größter Kunde\.\n/);
    assert.match(text, /GammaCorp\*\* – EU-Tier\./);
    assert.doesNotMatch(text, /verwechselt|verrannt/);
  });
});
