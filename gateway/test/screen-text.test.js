// On-screen text for speech (9 Nov 2026): names that are readable on his screen become hints for the recognisers, the dictation clean-up and the voice model.
// The case behind it: three cards about companies on screen, he names one, speech recognition writes a better-known word that sounds alike.
// All names here are fictional ("Opnar AI", "Oppel AI", "Nordgatan", "Outwing"); this repository is public.
import assert from 'node:assert/strict';
import { after, before, beforeEach, it } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { setEnv, login, listen, fakeServer } from './helpers/env.js';
import { syn } from './synthetic.js';

setEnv({ DESK_VISION_FRESH_WAIT_MS: '400', DESK_VISION_CAP_USD_HOUR: '0.6' });
const { createApp } = await import('../src/server.js');
const { screenTerms, heardLikeScreen, hearingHint, soundsLike, createScreenText, screenTextBody, MAX_SCREEN_TEXT } = await import('../src/screenText.js');
const { createDeviceMedia, guardTerms, pcmToWav } = await import('../src/deviceMedia.js');
const { MERGE_PROMPT } = await import('../src/dictationContext.js');

const SCREEN = `AI Agent notifications
bot
DU BIST DRAN
Nordgatan (Lund) unser Angebot schicken?
Senden = Mail über ihr Formular: EU-Decision-API plus Gratis-Test, kostet nur Testzeit.
Ändern = ich passe den Text an.
Nicht jetzt = keine Mail.
Senden (empfohlen)
Ändern
Nicht jetzt
DU BIST DRAN
Oppel AI (Lund) ein Angebot schicken?
Why: Oppel ist ein EU-Model-Router mit Jev im Katalog; laut Discord lieben ihre Kunden Jev.
Senden (empfohlen)
DU BIST DRAN
Outwing ein Angebot als Zweitquelle für ihre KI-Entscheidungen schicken?
Why: Laut Discord nutzt Outwing Jev produktiv für 900 Teams und fragte nach höheren Limits.
Hugging Face · decisionmodels.io · JevBench · s1-pro`;

it('screenTerms: the names on the screen come out, buttons and headings do not', () => {
  const terms = screenTerms(SCREEN);
  for (const name of ['Oppel AI', 'Nordgatan', 'Outwing', 'Hugging Face', 'decisionmodels.io', 'JevBench', 's1-pro', 'Discord']) assert.ok(terms.includes(name), `${name} missing in ${terms.join(' | ')}`);
  for (const junk of ['Senden', 'Ändern', 'Nicht', 'DU BIST DRAN', 'DU', 'Mail', 'Angebot', 'Why']) assert.ok(!terms.includes(junk), `${junk} is no name`);
  assert.ok(terms.indexOf('Oppel AI') < 8, 'a name of two words ranks high');
  assert.ok(terms.length <= 60 && terms.every((t) => t.length <= 40));
  assert.ok(screenTerms('Why: Nordgatan wertet Feedback aus, ein FizzVille-Zwilling.').includes('FizzVille'), 'the name inside a compound');
  assert.deepEqual(screenTerms(''), []);
  assert.deepEqual(screenTerms('und oder aber 123 456'), []);
  assert.ok(screenTerms(`${'Lorem '.repeat(4000)}\nOutwing (Lund)`).length <= 60, 'a huge text stays bounded');
});

it('heardLikeScreen: a better-known word that sounds like a name on the screen is paired with it; what was heard right is left alone', () => {
  const terms = screenTerms(SCREEN);
  assert.deepEqual(heardLikeScreen('Äh, erklär mir, um was es bei OpenAI geht.', terms).map((p) => [p.heard, p.screen]), [['OpenAI', 'Oppel AI']]);
  assert.deepEqual(heardLikeScreen('Nein, ich spreche von Opel AI, wie auf dem Bildschirm zu sehen ist.', terms).map((p) => [p.heard, p.screen]), [['Opel AI', 'Oppel AI']]);
  assert.deepEqual(heardLikeScreen('Was ist mit Nordgarten?', terms).map((p) => p.screen), ['Nordgatan']);
  assert.deepEqual(heardLikeScreen('Schick das Angebot an Outwink.', terms).map((p) => p.screen), ['Outwing']);
  assert.deepEqual(heardLikeScreen('Erklär mir, worum es bei Oppel AI geht.', terms), [], 'heard right');
  assert.deepEqual(heardLikeScreen('Schick das an Outwing und sag Bescheid.', terms), [], 'heard right, a neighbouring word does not make it a mishearing');
  assert.deepEqual(heardLikeScreen('Ist Hugging Face eine Option, oder decisionmodels.io?', terms), []);
  assert.deepEqual(heardLikeScreen('Unser Kunde Fizwil braucht das.', ['FizzVille', 'Nordgatan']).map((p) => [p.heard, p.screen]), [['Fizwil', 'FizzVille']], 'a name written by ear');
  assert.deepEqual(heardLikeScreen('Wir wollen wissen, was Wilma wirklich will.', ['FizzVille', 'Nordgatan', 'Outwing']), [], 'ordinary words with w');
  assert.deepEqual(heardLikeScreen('Die Outwings und Nordgatans dieser Welt.', ['Outwing', 'Nordgatan']), [], 'inflected forms of a name on screen');
  assert.deepEqual(heardLikeScreen('Wie viele Anfragen sind über die Knöpfe hereingekommen, und was wissen wir?', ['FizzVille', 'Nordgatan', 'Outwing']), [], 'an everyday phrase that happens to sound like a name');
  assert.deepEqual(heardLikeScreen('Erklär mir bitte den Unterschied zwischen Sonnet und Opus.', terms), []);
  assert.deepEqual(heardLikeScreen('Wie spät ist es und wie wird das Wetter morgen?', terms), []);
  assert.deepEqual(heardLikeScreen('OpenAI', []), []);
  assert.ok(soundsLike('OpenAI', 'Oppel AI') >= 0.7 && soundsLike('Wetter', 'Oppel AI') < 0.4);
  const hint = hearingHint('Erklär mir, um was es bei OpenAI geht.', terms);
  assert.match(hint, /^\[Hinweis vom Desk, nicht von Florian:/);
  assert.match(hint, /"Oppel AI" \(erkannt wurde "OpenAI"\)/);
  assert.equal(hearingHint('Wie spät ist es?', terms), '');
});

it('the per-device store: memory only, three minutes, validated shape, another device sees nothing', () => {
  let t = 1000;
  const store = createScreenText({ now: () => t });
  const r = store.note('dev1', { reason: 'dictation', process: 'chrome', title: 'Telegram Web', text: SCREEN });
  assert.equal(r.ok, true);
  assert.ok(r.terms >= 6);
  assert.ok(store.terms('dev1').includes('Oppel AI'));
  assert.deepEqual(store.terms('dev2'), []);
  assert.equal(store.terms('dev1', 3).length, 3);
  t += 180_001;
  assert.deepEqual(store.terms('dev1'), [], 'gone after three minutes');
  assert.equal(store._byDevice.size, 0);
  for (const bad of [null, [], {}, { reason: 'other', text: 'x' }, { reason: 'dictation' }, { reason: 'dictation', text: 5 }, { reason: 'session', text: 'x', extra: 1 }, { reason: 'session', text: 'x'.repeat(MAX_SCREEN_TEXT + 201) }, { reason: 'session', text: 'x', frameVersion: -1 }, { reason: 'session', text: 'x', title: 'x'.repeat(201) }])
    assert.throws(() => screenTextBody(bad), /Ungültiger Bildschirmtext/, JSON.stringify(bad)?.slice(0, 60));
  // a key that slipped through the app's redaction never becomes a term
  store.note('dev1', { reason: 'session', text: syn('Zugang OPENROUTER_API_KEY=sk-·or-·v1-·0123·4567·89ab·cdef·0123·4567·89ab·cdef·0123·4567·89ab·cdef·0123·4567·89ab·cdef fertig\nOutwing (Lund)') });
  assert.ok(!store.terms('dev1').some((x) => /sk-or|0123456789abcdef/.test(x)));
  assert.ok(store.terms('dev1').includes('Outwing'));
});

it('dictation: the names on his screen reach every recogniser as hints and the clean-up as context; the word guard knows them', async () => {
  const wav = pcmToWav(Buffer.alloc(2 * 32000));
  const seen = { mai: null, whisperPrompt: null, merge: null };
  const media = createDeviceMedia({
    env: { OPENROUTER_API_KEY: 'k', OPENAI_API_KEY: 'o', DESK_DICTATE_SOURCES: 'mai,openai' },
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.includes('chat/completions')) { seen.merge = JSON.parse(opts.body); return Response.json({ choices: [{ message: { content: 'Erklär mir, um was es bei Oppel AI geht.' } }] }); }
      if (u.includes('openrouter')) { seen.mai = JSON.parse(opts.body); return Response.json({ text: 'Erklär mir, um was es bei Oppel AI geht', usage: { seconds: 2, cost: 0.00005 } }); }
      seen.whisperPrompt = opts.body.get('prompt');
      return Response.json({ text: 'Erklär mir, um was es bei OpenAI geht.' });
    },
  });
  const names = screenTerms(SCREEN).slice(0, 40);
  const r = await media.dictate(wav, { process: 'chrome', fieldBefore: '', visibleIds: [], recentTerms: [], titles: [], bildschirmNamen: names }, { items: [] });
  const phrases = seen.mai.provider.options.azure.phraseList.phrases;
  for (const name of ['Oppel AI', 'Nordgatan', 'Outwing']) { assert.ok(phrases.includes(name), `MAI phrase ${name}`); assert.ok(seen.whisperPrompt.includes(name), `prompt ${name}`); }
  assert.ok(phrases.indexOf('Oppel AI') < phrases.indexOf('JevBench') || !phrases.includes('JevBench') || phrases.indexOf('Oppel AI') < 45, 'screen names come before the standing glossary');
  const mergeText = JSON.stringify(seen.merge);
  assert.ok(mergeText.includes('bildschirmNamen') && mergeText.includes('Oppel AI'), 'the clean-up reads the screen names as data');
  assert.equal(r.text, 'Erklär mir, um was es bei Oppel AI geht.', 'the screen name wins over the better-known word and passes the word guard');
  assert.match(MERGE_PROMPT, /context\.bildschirmNamen/);
  assert.ok(guardTerms({ items: [] }, {}, ['Oppel AI']).size > guardTerms({ items: [] }, {}).size);
  // without screen names nothing changes for the request shape
  seen.mai = null;
  await media.dictate(wav, { process: 'chrome', fieldBefore: '', visibleIds: [], recentTerms: [], titles: [] }, { items: [] });
  assert.ok(!seen.mai.provider.options.azure.phraseList.phrases.includes('Oppel AI'));
});

// ---- the route and the voice context, through the real server ----
function jpeg(w = 800, h = 450) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([head, randomBytes(3000), Buffer.from([0xff, 0xd9])]);
}
let rows = [], registry, app, base, cookie, sid, token, deviceId, clock = Date.now(), version = 0, handle, ctxTexts, traces, described = 'Chrome zeigt Telegram Web mit drei Karten.';
before(async () => {
  registry = await fakeServer(async (req, res, body) => {
    const u = new URL(req.url, 'http://fake');
    let data = {};
    if (u.pathname === '/v1/devices' && req.method === 'POST') { const id = randomUUID(); rows.push({ ...body, id, expires_at: new Date(body.expires_at).toISOString() }); data = { id }; }
    else if (u.pathname === '/v1/devices/verify') {
      const row = rows.find((r) => r.hash === body.hash && !r.revoked_at);
      if (!row) { res.writeHead(404, { 'content-type': 'application/json' }).end('{}'); return; }
      data = row;
    } else if (u.pathname === '/v1/resolve') data = { items: [], unknown: [] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  });
  Object.assign(process.env, { ARTIFACTS_URL: registry.url, ARTIFACTS_DESK_TOKEN: 'fake' });
  const media = { vision: async () => ({ text: described, change: 'x', usage: { inputTokens: 1500, outputTokens: 140 }, ms: 5 }) };
  app = createApp({ deviceOptions: { now: () => clock, media } });
  base = `http://127.0.0.1:${await listen(app.server)}`;
  cookie = (await login(base)).cookie;
  sid = (await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()).sid;
  ({ token, deviceId } = await (await fetch(`${base}/api/device/pair`, { method: 'POST', headers: { cookie, origin: process.env.DESK_ORIGIN } })).json());
});
after(() => { app.server.close(); registry.close(); });
beforeEach(() => {
  clock += 3600_000 * 2; ctxTexts = []; traces = [];
  handle?.(); app.devices.vision._states.clear();
  handle = app.devices.vision.attach(sid, { kind: 'voice', announced: true, trace: (type, data) => traces.push({ type, ...data }), setContext: (text) => { ctxTexts.push(text); return 'sent'; } });
});
const postText = (body, auth = `Bearer ${token}`) => fetch(`${base}/api/device/screen-text`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const postFrame = (o = {}) => fetch(`${base}/api/device/session/${sid}/frame`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, frameVersion: ++version, jpeg: jpeg().toString('base64'), process: 'chrome', title: 'Telegram Web', masked: 0, ids: [], reason: 'interval', ...o }) });
const namen = (text) => JSON.parse(/<computer_data>\n([\s\S]*)\n<\/computer_data>|<artifact_data>\n([\s\S]*)\n<\/artifact_data>/.exec(text).slice(1).find(Boolean).replace(/^"|"$/g, (m) => m)).namen;

it('POST /api/device/screen-text: device auth, shape checked, counts only in the answer; the names are in the next voice context', async () => {
  assert.equal((await postText({ reason: 'dictation', process: 'chrome', title: 'Telegram Web', text: SCREEN }, 'Bearer wrong')).status, 401);
  assert.equal((await postText({ reason: 'nonsense', text: 'x' })).status, 400);
  const res = await postText({ reason: 'session', process: 'chrome', title: 'Telegram Web', text: SCREEN, frameVersion: 7 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.terms >= 6);
  assert.ok(!JSON.stringify(body).includes('Oppel'), 'the answer repeats nothing of the screen');
  assert.ok(app.devices.screenText.terms(deviceId).includes('Oppel AI'));
  // a frame arrives: the context for the voice model lists the names and says what they are for
  assert.equal((await postFrame()).status, 200);
  const text = ctxTexts.at(-1);
  assert.match(text, /Unter "namen" stehen Namen, die gerade auf seinem Bildschirm zu lesen sind/);
  assert.ok(text.includes('Oppel AI') && text.includes('Nordgatan') && text.includes('Outwing'));
  assert.ok(app.devices.vision.names(sid).slice(0, 10).includes('Oppel AI'));
  assert.match(hearingHint('Erklär mir, um was es bei OpenAI geht.', app.devices.vision.names(sid)), /"Oppel AI"/);
});

it('with an older app (no screen text) the names come from the picture description; new screen text reaches the session at once', async () => {
  app.devices.screenText.clear(deviceId);
  described = 'Im Chrome ist Telegram Web offen. Drei Karten: Nordgatan (Lund), Oppel AI (Lund) und Outwing, jeweils mit den Knöpfen Senden (empfohlen), Ändern und Nicht jetzt.';
  assert.equal((await postFrame()).status, 200);
  const first = app.devices.vision.names(sid);
  assert.ok(first.includes('Oppel AI') && first.includes('Outwing'), first.join(' | '));
  const sent = ctxTexts.length;
  clock += 6000; // past the 5 s pace of context updates
  assert.equal((await postText({ reason: 'foreground', process: 'code', title: 'README.md', text: 'JevBench Rangliste\nKnowLine Gen1.5 gegen GLiDE loop' })).status, 200);
  assert.equal(ctxTexts.length, sent + 1, 'other names on screen: the context goes out without waiting for the next picture');
  assert.ok(ctxTexts.at(-1).includes('KnowLine'));
});

it('refresh(): his speech start asks the app for a fresh frame, but not when the picture is seconds old and never twice in a row', async () => {
  assert.equal((await postFrame()).status, 200);
  assert.equal(app.devices.vision.refresh(sid), false, 'the picture is fresh');
  clock += 5000;
  assert.equal(app.devices.vision.refresh(sid), true);
  assert.equal(app.devices.vision.refresh(sid), false, 'one request per 4 s');
  const poll = await (await fetch(`${base}/api/device/session/${sid}/commands`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(poll.fresh, true);
  assert.equal(app.devices.vision.refresh('unknown-session'), false);
});
