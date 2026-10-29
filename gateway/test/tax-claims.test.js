// Round 9 (critic r8 F2/C3): unsourced tax-law statements. Synthetic text only.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { TAX_NO_SOURCE, TaxClaimFilter, isUnsourcedTaxClaim } from '../src/taxFilter.js';
import { buildInstructions as textPrompt } from '../src/prompt.js';
import { buildInstructions as voicePrompt } from '../src/voice/instructions.js';
import { SYSTEM_PROMPT } from '../src/illustrator.js';
import { completionStream, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';

describe('tax claim filter', () => {
  it('flags rule statements without a source in the sentence', () => {
    for (const s of ['Steuerpflicht entsteht beim Tausch in Fiat.', 'Das ist steuerfrei.', 'Der Betrag unterliegt der Einkommensteuer.', 'Die Erträge werden als Einkommen versteuert.']) assert.equal(isUnsourcedTaxClaim(s), true, s);
  });
  it('keeps them with a source reference, and leaves other sentences alone', () => {
    assert.equal(isUnsourcedTaxClaim('Laut topics/example-tax.md ist der Betrag steuerfrei.'), false);
    assert.equal(isUnsourcedTaxClaim('Steuerfrei, siehe Board #12.'), false);
    assert.equal(isUnsourcedTaxClaim('Die Steuer wird später besprochen.'), false);
    assert.equal(isUnsourcedTaxClaim('Das Gateway läuft auf Sandy.'), false);
  });
  it('streams: unsourced sentence replaced once, the rest passes through unchanged', () => {
    const f = new TaxClaimFilter();
    const pieces = ['Kurz zur Lage. Steuerpflicht ent', 'steht beim Tausch. Danach ist alles steuerfrei. ', 'Ende', ' der Antwort.'];
    const out = pieces.map((p) => f.push(p)).join('') + f.flush();
    assert.equal(out, `Kurz zur Lage. ${TAX_NO_SOURCE} Danach ist alles steuerfrei. Ende der Antwort.`.replace('Danach ist alles steuerfrei. ', ''));
  });
});

describe('prompts carry the tax rule', () => {
  it('text, voice and illustrator', () => {
    const rule = /Steuerrechtliche Aussagen nur mit Quelle/;
    assert.match(textPrompt(null), rule);
    assert.match(voicePrompt(null), rule);
    assert.match(textPrompt(null, { spoken: true }), /keine Quelle – frag den Steuerberater/);
    assert.match(SYSTEM_PROMPT, /Dazu habe ich keine Quelle – frag den Steuerberater/);
  });
});

describe('text chat replaces an unsourced tax claim', () => {
  let openrouter; let script; let gw; let cookie;
  before(async () => {
    openrouter = await fakeServer((req, res, body) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(script(body, openrouter.seen.length - 1)));
    setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
    gw = await startGateway();
    cookie = (await login(gw.base)).cookie;
  });
  after(() => { gw.close(); openrouter.close(); });
  beforeEach(() => { openrouter.seen.length = 0; });
  const ask = async (content) => {
    const res = await fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content }] }) });
    const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));
    return events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  };
  it('end to end', async () => {
    script = () => completionStream({ text: 'Zur Einordnung: Steuerpflicht entsteht beim Tausch in Fiat (nicht beim Erhalt). Sprich das mit dem Steuerberater ab.' });
    const text = await ask('Wann entsteht die Steuerpflicht?');
    assert.equal(text, `${TAX_NO_SOURCE} Sprich das mit dem Steuerberater ab.`);
    assert.doesNotMatch(text, /Fiat/);
  });
  it('a sourced sentence stays', async () => {
    // round 12: a cited file must be one the turn carries (here: the question names it)
    script = () => completionStream({ text: 'Laut knowledge/example-tax.md ist der Betrag steuerfrei.' });
    assert.equal(await ask('Ist das laut knowledge/example-tax.md steuerfrei?'), 'Laut knowledge/example-tax.md ist der Betrag steuerfrei.');
  });
});
