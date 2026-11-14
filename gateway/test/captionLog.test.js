// Caption text log + live clean-up with the final pass's rules (14 Nov 2026).
// caption.log: what MAI heard and what the live clean-up made of it, per dictation, in a few events; the text is kept so doubled words at stutters and
// corrections that never show can be found afterwards. All names and sentences here are made up; this repository is public.
import assert from 'node:assert/strict';
import { after, before, afterEach, describe, it, mock } from 'node:test';
import { setEnv, login, listen, fakeServer } from './helpers/env.js';
import { createApp } from '../src/server.js';
import { createCaptionLog } from '../src/devices.js';
import { createDeviceMedia, pcmToWav } from '../src/deviceMedia.js';
import { LIVE_PROMPT, FINAL_PROMPT } from '../src/dictationContext.js';
import { boundData, MAX_EVENT_BYTES } from '../src/trace.js';

const answer = content => Response.json({ choices: [{ message: { content } }] });
const dataOf = body => JSON.parse(body.messages[1].content.replace(/^<artifact_data>\n|\n<\/artifact_data>$/g, ''));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 15)); } throw new Error('timeout'); };
const wav = (s = 1) => pcmToWav(Buffer.alloc(s * 32000));

// ---- the buffer itself ----
describe('createCaptionLog: when an event goes out', () => {
  const make = (opts = {}) => { const events = []; const log = createCaptionLog({ dlog: (deviceId, type, data) => events.push({ deviceId, type, data }), ...opts }); return { log, events }; };
  const win = (n, d = 'dic-1', text = 'das ist ein Fenster') => ({ at: 1_000_000 + n, k: 'w', d, n, ms: 420, sec: 6, text });
  const wide = n => win(n, 'dic-1', 'wort '.repeat(120).trim()); // 600 characters of text, about 680 of JSON
  afterEach(() => mock.timers.reset());

  it('20 items flush the event; the next item starts a new one', () => {
    const { log, events } = make();
    for (let i = 0; i < 19; i++) log.push('dev', win(i));
    assert.equal(events.length, 0); assert.equal(log.pendingCount('dev'), 19);
    log.push('dev', win(19));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'caption.log'); assert.equal(events[0].deviceId, 'dev'); assert.equal(events[0].data.d, 'dic-1'); assert.equal(events[0].data.items.length, 20);
    assert.deepEqual(events[0].data.items.map(i => i.n), Array.from({ length: 20 }, (_, i) => i), 'in order');
    log.push('dev', win(20)); assert.equal(log.pendingCount('dev'), 1); assert.equal(events.length, 1);
  });

  it('5,000 characters of pending JSON flush the event, and it stays far below the trace limit', () => {
    const { log, events } = make();
    for (let i = 0; i < 7; i++) log.push('dev', wide(i));
    assert.equal(events.length, 0, '7 x ~680 is still under 5,000');
    log.push('dev', wide(7));
    assert.equal(events.length, 1); assert.equal(events[0].data.items.length, 8);
    const size = JSON.stringify(boundData(events[0].data)).length;
    assert(size < MAX_EVENT_BYTES, `${size} bytes`); assert(!boundData(events[0].data).truncated);
  });

  it('15 s after the first pending item the event goes out, whatever came later', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { log, events } = make();
    log.push('dev', win(0));
    mock.timers.tick(10_000); log.push('dev', win(1)); // the clock runs from the first item
    mock.timers.tick(4_999); assert.equal(events.length, 0);
    mock.timers.tick(1);
    assert.equal(events.length, 1); assert.equal(events[0].data.items.length, 2); assert.equal(log.pendingCount('dev'), 0);
    mock.timers.tick(60_000); assert.equal(events.length, 1, 'nothing left to flush, no empty event');
    log.push('dev', win(2)); mock.timers.tick(15_000); assert.equal(events.length, 2, 'a new item starts a new 15 s');
  });

  it('a new dictation id flushes the old one first; an old app (no id) is its own group with d null', () => {
    const { log, events } = make();
    log.push('dev', win(0, 'dic-1')); log.push('dev', win(1, 'dic-1'));
    log.push('dev', win(0, 'dic-2'));
    assert.equal(events.length, 1); assert.equal(events[0].data.d, 'dic-1'); assert.equal(events[0].data.items.length, 2);
    log.push('dev', win(5, null));
    assert.equal(events.length, 2); assert.equal(events[1].data.d, 'dic-2'); assert.equal(events[1].data.items.length, 1);
    log.flush('dev');
    assert.equal(events.length, 3); assert.equal(events[2].data.d, null); assert.equal(events[2].data.items[0].d, null);
    log.flush('dev'); assert.equal(events.length, 3, 'flushing an empty buffer writes nothing');
  });

  it('devices have their own buffers; flush() without an id flushes all of them (shutdown)', () => {
    const { log, events } = make();
    log.push('a', win(0)); log.push('b', win(0)); log.push('b', win(1));
    log.flush();
    assert.deepEqual(events.map(e => [e.deviceId, e.data.items.length]).sort(), [['a', 1], ['b', 2]]);
  });

  it('an event that would pass 8,192 bytes is split, a single huge item is shortened: nothing falls into the truncated preview', () => {
    const { log, events } = make();
    const heavy = (n, ch) => ({ at: 2_000_000 + n, k: 'p', d: 'dic-1', ms: 600, ok: true, changed: 1, undone: 0, text: ch.repeat(1500), out: ch.repeat(990), before: ch.repeat(300) });
    for (let i = 0; i < 6; i++) log.push('dev', win(i, 'dic-1', 'wort '.repeat(100).trim())); // ~3,500 characters pending
    log.push('dev', heavy(0, '"')); // every quote costs two characters of JSON: about 5,700 more
    log.flush('dev');
    assert(JSON.stringify({ d: 'dic-1', items: [0, 1, 2, 3, 4, 5].map(i => win(i, 'dic-1', 'wort '.repeat(100).trim())).concat(heavy(0, '"')) }).length > MAX_EVENT_BYTES, 'precondition: as one event it would be truncated');
    assert(events.length >= 2, 'split');
    for (const e of events) { const b = boundData(e.data); assert(!b.truncated, `event of ${JSON.stringify(e.data).length} characters was truncated`); assert(JSON.stringify(b).length < MAX_EVENT_BYTES); }
    assert.deepEqual(events.flatMap(e => e.data.items.map(i => i.at)), [1_000_000, 1_000_001, 1_000_002, 1_000_003, 1_000_004, 1_000_005, 2_000_000], 'no item lost, in order');
    // control characters cost six characters each: one item alone is over the limit and loses the tail of its longest text, not the event
    events.length = 0;
    log.push('dev', heavy(1, '\u0001')); log.flush('dev');
    assert.equal(events.length, 1); assert(!boundData(events[0].data).truncated);
    const [item] = events[0].data.items;
    assert.equal(item.k, 'p'); assert.equal(item.ok, true); assert.equal(item.ms, 600); assert(item.text.length > 0 && item.text.length < 1500);
  });

  it('DESK_CAPTION_TEXT_LOG=off: counts and timings stay, the words (text, out, before) go', () => {
    const { log, events } = make({ textOn: () => false });
    log.push('dev', win(0)); log.push('dev', { at: 5, k: 'p', d: 'dic-1', ms: 700, ok: true, changed: 1, undone: 0, text: 'geheim', out: 'Geheim', before: 'davor' });
    log.flush('dev');
    const [w, p] = events[0].data.items;
    assert.deepEqual(w, { at: 1_000_000, k: 'w', d: 'dic-1', n: 0, ms: 420, sec: 6 });
    assert.deepEqual(p, { at: 5, k: 'p', d: 'dic-1', ms: 700, ok: true, changed: 1, undone: 0 });
    assert(!JSON.stringify(events).includes('geheim'));
  });

  it('a broken dlog never throws into the caption', () => {
    const log = createCaptionLog({ dlog: () => { throw new Error('trace down'); } });
    for (let i = 0; i < 25; i++) log.push('dev', win(i));
    log.flush('dev');
  });
});

// ---- the live clean-up with the final pass's rules ----
describe('media.polish live: the same rules and the same word guard as the final pass', () => {
  const live = (reply, env = {}) => {
    const seen = [];
    const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k', ...env }, fetchImpl: async (_u, opts) => { const body = JSON.parse(opts.body); seen.push(body); return answer(typeof reply === 'function' ? reply(dataOf(body)) : reply); } });
    return { media, seen };
  };

  it('the prompt is the live lead plus the shared rules of the final pass', () => {
    assert.match(LIVE_PROMPT, /^Du korrigierst live mitlaufende Untertitel/);
    assert.match(LIVE_PROMPT, /"davor" ist der Text unmittelbar vor "text"[^]*NIE in deine Antwort[^]*ersten Wort von "text"/);
    const rules = FINAL_PROMPT.slice(FINAL_PROMPT.indexOf('Regeln:'));
    assert(rules.length > 1500 && LIVE_PROMPT.endsWith(rules), 'live and final share one rule text');
    for (const rule of ['Stotterer streichen', 'doppelte Wörter', 'bildschirmNamen', 'Satzzeichen nach dem Sinn']) assert(LIVE_PROMPT.includes(rule), rule);
  });

  it('davor, the screen names and the glossary go to the model as data; the answer starts with the first word of "text"', async () => {
    const { media, seen } = live(d => d.text);
    await media.polish('und dann habe ich ich die Jeff Bench Ergebnisse', { before: 'Wir haben gestern lange gesprochen.', screenNames: ['Nordgatan', 'Outwing'] }, { mode: 'live', deviceId: 'live-data' });
    assert.equal(seen.length, 1); assert.equal(seen[0].messages[0].content, LIVE_PROMPT);
    const data = dataOf(seen[0]);
    assert.equal(data.davor, 'Wir haben gestern lange gesprochen.'); assert.equal(data.text, 'und dann habe ich ich die Jeff Bench Ergebnisse');
    assert.deepEqual(data.context, { bildschirmNamen: ['Nordgatan', 'Outwing'] }); assert(data.glossar.includes('JevBench')); assert(Array.isArray(data.woerterbuch) || typeof data.woerterbuch === 'object');
    assert.equal(seen[0].max_tokens, 900);
    // nothing on the screen / no context from an old app: no "context" key, an empty "davor"
    const bare = live(d => d.text);
    await bare.media.polish('und dann habe ich noch eine Frage', {}, { mode: 'live', deviceId: 'live-data' });
    const d2 = dataOf(bare.seen[0]); assert.equal(d2.davor, ''); assert(!('context' in d2));
  });

  it('a stutter the model took out stays out, a misheard glossary name is fixed', async () => {
    const { media } = live('und dann habe ich die JevBench Ergebnisse noch mal angeschaut und');
    const r = await media.polish('und dann habe ich ich die Jeff Bench Ergebnisse noch mal angeschaut und', { before: 'Gestern war viel los.' }, { mode: 'live', deviceId: 'live-stutter' });
    assert.equal(r.text, 'und dann habe ich die JevBench Ergebnisse noch mal angeschaut und');
    assert.deepEqual([r.changed, r.failed, r.undone, r.windows], [1, 0, 0, 1]);
    const plain = live('ich habe die Datei gestern gesehen');
    const s = await plain.media.polish('ich ich habe die Datei gestern gesehen', {}, { mode: 'live', deviceId: 'live-stutter' });
    assert.equal(s.text, 'ich habe die Datei gestern gesehen'); assert.equal(s.undone, 0); assert.equal(s.changed, 1);
  });

  it('a reworded word is undone by the guard, and the stutter removal in the same answer still counts', async () => {
    const { media } = live('wir fragen uns, warum wir das nicht früher gemacht haben');
    const r = await media.polish('wir wir fragen uns, wieso wir das nicht früher gemacht haben', {}, { mode: 'live', deviceId: 'live-guard' });
    assert.equal(r.text, 'wir fragen uns, wieso wir das nicht früher gemacht haben', '"wieso" stays, the doubled "wir" is gone');
    assert.equal(r.undone, 1); assert.equal(r.changed, 1); assert.equal(r.failed, 0);
  });

  it('a name from the screen is accepted by the guard; without the screen the same swap is undone', async () => {
    const reply = 'unser Kunde FizzVille braucht das heute noch';
    const input = 'unser Kunde Fizwil braucht das heute noch'; // too far from "FizzVille" for a near miss, close enough for a name
    const withScreen = await live(reply).media.polish(input, { screenNames: ['FizzVille'] }, { mode: 'live', deviceId: 'live-screen' });
    assert.equal(withScreen.text, reply); assert.equal(withScreen.undone, 0);
    const without = await live(reply).media.polish(input, {}, { mode: 'live', deviceId: 'live-screen' });
    assert.equal(without.text, input); assert.equal(without.undone, 1);
  });

  it('an unfaithful answer (words lost) leaves the input and counts as failed; the dictionary and proper names still apply to a good one', async () => {
    const bad = await live('Kurz.').media.polish('das ist ein langer Satz mit sehr vielen Wörtern darin und noch mehr', {}, { mode: 'live', deviceId: 'live-bad' });
    assert.deepEqual([bad.text, bad.changed, bad.failed, bad.undone], ['das ist ein langer Satz mit sehr vielen Wörtern darin und noch mehr', 0, 1, 0]);
    const good = await live(d => d.text).media.polish('wir testen Reax und Riax heute', {}, { mode: 'live', deviceId: 'live-names', dictionary: { items: [{ term: 'REAX', replace_from: ['Riax'] }] } });
    assert.equal(good.text, 'wir testen REAX und REAX heute', 'dictionary correction, then the proper spelling of a known name');
    assert.equal(good.changed, 1);
  });

  it('screen names that are not strings or too long are not sent; at most 40', async () => {
    const { media, seen } = live(d => d.text);
    await media.polish('ein kurzer Satz ohne Besonderheiten', { screenNames: ['Gut', 5, null, '', 'x'.repeat(101), ...Array.from({ length: 60 }, (_, i) => `Name${i}`)] }, { mode: 'live', deviceId: 'live-names2' });
    const names = dataOf(seen[0]).context.bildschirmNamen;
    assert.equal(names.length, 40); assert.equal(names[0], 'Gut'); assert(names.every(n => typeof n === 'string' && n && n.length <= 100));
  });
});

// ---- the routes ----
describe('device routes: caption.log, dictation text, screen names, validation', () => {
  let registry, app, base, token, deviceId, maiText = 'und dann habe ich ich die Jeff Bench Ergebnisse', liveReply = d => d.text, finalReply = d => d.diktat, maiCalls = 0;
  const sessions = [], events = [], phrases = [], chats = [];
  before(async () => {
    registry = await fakeServer((req, res, body) => {
      const u = new URL(req.url, 'http://fake');
      const send = (data, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (u.pathname === '/v1/devices' && req.method === 'POST') return send({ id: '33333333-3333-4333-8333-333333333333' });
      if (u.pathname === '/v1/devices/verify') return send({ id: '33333333-3333-4333-8333-333333333333', scopes: ['dictate', 'dictionary', 'screen', 'exists'], expires_at: new Date(Date.now() + 864e5).toISOString(), hash: body.hash });
      if (u.pathname === '/v1/dictionary') return send({ items: [{ term: 'Karpathy', replace_from: ['Karpati'] }] });
      if (u.pathname === '/v1/sessions' && req.method === 'POST') { sessions.push(body); return send({ id: (0xee0000 + sessions.length).toString(16) }); }
      if (/\/events$/.test(u.pathname)) { events.push(...body.events.map(e => ({ ...e, session: u.pathname.split('/')[3] }))); return send({ ok: true }); }
      return send({}, 404);
    });
    setEnv({ ARTIFACTS_URL: registry.url, ARTIFACTS_DESK_TOKEN: 'fake' });
    const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (String(url).includes('/audio/transcriptions')) { maiCalls++; phrases.push(body.provider?.options?.azure?.phraseList?.phrases ?? []); return Response.json({ text: maiText, usage: { seconds: 6, cost: 0.00003 } }); }
      chats.push(body);
      const data = dataOf(body);
      return answer(body.messages[0].content === LIVE_PROMPT ? liveReply(data) : finalReply(data));
    } });
    const dictate = async (_b, c) => { await c; return { text: 'Dies ist das Diktat.', sources: {}, ms: 3, providers: { mai: { ok: true, ms: 3 } }, degraded: false, merged: false, seconds: 1 }; };
    app = createApp({ deviceOptions: { media: { ...media, dictate } }, traceOptions: { flushMs: 15, firstFlushMs: 15 } });
    base = `http://127.0.0.1:${await listen(app.server)}`;
    const cookie = (await login(base)).cookie;
    const pair = await fetch(`${base}/api/device/pair`, { method: 'POST', headers: { cookie, origin: process.env.DESK_ORIGIN } });
    ({ token, deviceId } = await pair.json());
  });
  after(() => { delete process.env.DESK_CAPTION_TEXT_LOG; app.server.close(); registry.close(); });
  afterEach(() => { delete process.env.DESK_CAPTION_TEXT_LOG; });
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}), ...headers }, body });
  const captionForm = (fields = {}) => { const f = new FormData(); f.set('audio', new Blob([Buffer.alloc(32000)]), 'a.pcm'); for (const [k, v] of Object.entries(fields)) { if (Array.isArray(v)) v.forEach(x => f.append(k, x)); else f.set(k, v); } return f; };
  const polish = (body) => post('/api/device/polish', JSON.stringify(body));
  const dictateForm = (chunk) => { const f = new FormData(); f.set('audio', new Blob([wav()]), 'a.wav'); f.set('context', JSON.stringify({ process: 'p', fieldBefore: '', visibleIds: [], recentTerms: [] })); f.set('chunk', JSON.stringify(chunk)); return f; };
  const flush = async () => { app.devices.flushCaptionLog(deviceId); await app.traces.flushAll(1000); };
  const logs = (d) => events.filter(e => e.type === 'caption.log' && (d === undefined || e.data.d === d));
  const deviceEvents = (type) => events.filter(e => e.type === type);

  it('caption windows and live clean-ups of one dictation land in one caption.log event, with the words', async () => {
    const dic = 'dic-route-1';
    for (const n of [0, 1]) { const r = await post('/api/device/caption', captionForm({ dictation: dic, seq: String(n) })); assert.equal(r.status, 200); assert.equal((await r.json()).text, maiText); }
    const before = Date.now();
    liveReply = () => 'und dann habe ich die JevBench Ergebnisse';
    const r = await polish({ mode: 'live', text: maiText, dictation: dic, context: { before: 'Wir haben gestern lange gesprochen.' } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).text, 'und dann habe ich die JevBench Ergebnisse');
    const sent = dataOf(chats.at(-1)); assert.equal(sent.davor, 'Wir haben gestern lange gesprochen.'); assert.equal(sent.text, maiText);
    await flush();
    const ev = (await until(() => logs(dic)[0])).data;
    assert.equal(ev.d, dic); assert.equal(ev.items.length, 3);
    const [w0, w1, p] = ev.items;
    assert.deepEqual([w0.k, w0.d, w0.n, w1.n], ['w', dic, 0, 1]); assert.equal(w0.text, maiText); assert.equal(w0.sec, 6); assert.equal(typeof w0.ms, 'number'); assert(w0.at >= before - 5000 && w0.at <= Date.now());
    assert.deepEqual([p.k, p.d, p.ok, p.changed, p.undone], ['p', dic, true, 1, 0]);
    assert.equal(p.text, maiText); assert.equal(p.out, 'und dann habe ich die JevBench Ergebnisse'); assert.equal(p.before, 'Wir haben gestern lange gesprochen.'); assert.equal(typeof p.ms, 'number');
    assert(!JSON.stringify(boundData(ev)).includes('truncated'), 'under the event limit');
  });

  it('an old app sends neither dictation nor seq nor before: d and n are null and everything still works', async () => {
    assert.equal((await post('/api/device/caption', captionForm())).status, 200);
    assert.equal((await polish({ mode: 'live', text: 'ein ganz normaler kurzer Satz' })).status, 200);
    await flush();
    const ev = (await until(() => logs(null)[0])).data;
    assert.equal(ev.d, null); assert.deepEqual(ev.items.map(i => [i.k, i.d, i.n ?? null]), [['w', null, null], ['p', null, null]]);
    // no dictation id (an old app, or a voice session's subtitle): counts and timings only, no words
    assert(ev.items.every(i => !('text' in i) && !('out' in i) && !('before' in i)), JSON.stringify(ev.items));
  });

  it('log=0 from the app (its CaptionLog or TraceUpload is off): no words even for a dictation', async () => {
    assert.equal((await post('/api/device/caption', captionForm({ dictation: 'dic-nolog', seq: '1', log: '0' }))).status, 200);
    assert.equal((await polish({ mode: 'live', text: 'ein ganz normaler kurzer Satz', dictation: 'dic-nolog', log: false })).status, 200);
    await flush();
    const ev = (await until(() => logs('dic-nolog')[0])).data;
    assert.deepEqual(ev.items.map(i => i.k), ['w', 'p']);
    assert(ev.items.every(i => !('text' in i) && !('out' in i) && !('before' in i)), JSON.stringify(ev.items));
  });

  it('a failed or unfaithful live clean-up is logged with ok false', async () => {
    liveReply = () => 'Kurz.';
    const r = await polish({ mode: 'live', text: 'das ist ein langer Satz mit sehr vielen Wörtern darin und noch mehr', dictation: 'dic-bad' });
    assert.equal(r.status, 200); const body = await r.json(); assert.equal(body.failed, 1);
    liveReply = d => d.text;
    await flush();
    const p = (await until(() => logs('dic-bad')[0])).data.items[0];
    assert.deepEqual([p.k, p.ok, p.changed, p.undone], ['p', false, 0, 0]); assert.equal(p.out, p.text, 'the input was shown');
  });

  it('the names on his screen reach the caption phrase list (before the glossary) and the live clean-up', async () => {
    const r = await post('/api/device/screen-text', JSON.stringify({ reason: 'dictation', process: 'chrome', title: 'Angebote', text: 'Nordgatan (Lund) unser Angebot schicken?\nOppel AI (Lund) ein Angebot schicken?\nWhy: Laut Discord nutzt Oppel AI das produktiv.' }));
    assert.equal(r.status, 200); const noted = await r.json(); assert(noted.terms >= 2);
    assert.equal((await post('/api/device/caption', captionForm({ dictation: 'dic-screen', seq: '0' }))).status, 200);
    const list = phrases.at(-1);
    assert(list.includes('Nordgatan') && list.includes('Oppel AI'), list.join(' | '));
    assert(list.indexOf('Nordgatan') < list.indexOf('JevBench'), 'screen names come before the glossary names');
    assert.equal((await polish({ mode: 'live', text: 'schick das Angebot an Nordgarten', dictation: 'dic-screen' })).status, 200);
    const names = dataOf(chats.at(-1)).context.bildschirmNamen;
    assert(names.includes('Nordgatan') && names.includes('Oppel AI'), names.join(' | '));
    await flush();
  });

  it('invalid dictation, seq and context.before are a 400, valid ones are not', async () => {
    const calls = maiCalls;
    for (const dictation of ['', 'a b', 'x'.repeat(41), 'ä', 'a/b']) assert.equal((await post('/api/device/caption', captionForm({ dictation }))).status, 400, `dictation ${JSON.stringify(dictation)}`);
    assert.equal((await post('/api/device/caption', captionForm({ dictation: ['dic-a', 'dic-b'] }))).status, 400, 'two dictation fields');
    for (const seq of ['', '-1', '1.5', 'abc', '1000001', '99999999', '1e3', ' 3']) assert.equal((await post('/api/device/caption', captionForm({ dictation: 'dic-v', seq }))).status, 400, `seq ${JSON.stringify(seq)}`);
    assert.equal((await post('/api/device/caption', captionForm({ seq: ['1', '2'] }))).status, 400, 'two seq fields');
    const file = captionForm(); file.set('dictation', new Blob(['dic-v']), 'x.txt');
    assert.equal((await post('/api/device/caption', file)).status, 400, 'a file is not an id');
    assert.equal(maiCalls, calls, 'no recogniser call for a rejected request');
    for (const [dictation, seq] of [['dic-v', '0'], ['A_b.c:d-1', '1000000'], ['x'.repeat(40), '7']]) assert.equal((await post('/api/device/caption', captionForm({ dictation, seq }))).status, 200, `${dictation} ${seq}`);

    const live = { mode: 'live', text: 'ein kurzer Satz' };
    for (const dictation of ['', 'a b', 'x'.repeat(41), 5, null, {}, []]) assert.equal((await polish({ ...live, dictation })).status, 400, `polish dictation ${JSON.stringify(dictation)}`);
    for (const before of [5, 'x'.repeat(601), null, ['a'], {}]) assert.equal((await polish({ ...live, context: { before } })).status, 400, `before ${JSON.stringify(before).slice(0, 20)}`);
    assert.equal((await polish({ ...live, context: { process: 5 } })).status, 400, 'the old checks stay');
    assert.equal((await polish({ ...live, context: { fieldBefore: 'x'.repeat(501) } })).status, 400);
    assert.equal((await polish({ ...live, dictation: 'dic-ok', context: { before: 'x'.repeat(600), process: 'chrome', fieldBefore: 'x' } })).status, 200);
    assert.equal((await polish({ mode: 'final', text: 'Ein Satz.', dictation: 'dic-ok', context: { before: 'ignored' } })).status, 200, 'accepted in every mode');
    await flush();
  });

  it('dictation.result carries the chunk text and dictation.polish the final text and the dictation id (only when the body had one)', async () => {
    const ok = await post('/api/device/dictate', dictateForm({ dictationId: 'dic-res', index: 0, final: true }));
    assert.equal(ok.status, 200);
    finalReply = d => d.diktat.replace('Wir wir', 'Wir');
    assert.equal((await polish({ mode: 'final', text: 'Wir wir testen das heute.', dictation: 'dic-res' })).status, 200);
    assert.equal((await polish({ mode: 'format', text: 'Noch ein Satz ohne Kennung.' })).status, 200);
    await app.traces.flushAll(1000);
    const result = (await until(() => deviceEvents('dictation.result').find(e => e.data.dictationId === 'dic-res'))).data;
    assert.equal(result.text, 'Dies ist das Diktat.'); assert.equal(result.chars, 20);
    const fin = (await until(() => deviceEvents('dictation.polish').find(e => e.data.mode === 'final' && e.data.d === 'dic-res'))).data;
    assert.equal(fin.text, 'Wir testen das heute.'); assert.equal(fin.d, 'dic-res');
    const fmt = (await until(() => deviceEvents('dictation.polish').find(e => e.data.mode === 'format'))).data;
    assert.equal(fmt.text, 'Noch ein Satz ohne Kennung.'); assert(!('d' in fmt), 'no dictation id in the body, none in the event');
    assert(!deviceEvents('dictation.polish').some(e => e.data.mode === 'live'), 'live clean-ups go to caption.log only');
  });

  it('DESK_CAPTION_TEXT_LOG=off: caption.log keeps counts and timings, dictation events lose their text', async () => {
    process.env.DESK_CAPTION_TEXT_LOG = 'off';
    maiText = 'Geheimtext4711 sagt jemand'; liveReply = () => 'Geheimtext4711 sagt jemand heute';
    assert.equal((await post('/api/device/caption', captionForm({ dictation: 'dic-off', seq: '0' }))).status, 200);
    assert.equal((await polish({ mode: 'live', text: 'Geheimtext4711 sagt jemand', dictation: 'dic-off', context: { before: 'Davor4712' } })).status, 200);
    assert.equal((await post('/api/device/dictate', dictateForm({ dictationId: 'dic-off', index: 0, final: true }))).status, 200);
    assert.equal((await polish({ mode: 'final', text: 'Geheimtext4711 steht hier.', dictation: 'dic-off' })).status, 200);
    await flush();
    const ev = (await until(() => logs('dic-off')[0])).data;
    assert.deepEqual(ev.items.map(i => i.k), ['w', 'p']);
    for (const i of ev.items) { assert(!('text' in i) && !('out' in i) && !('before' in i), JSON.stringify(i)); assert.equal(typeof i.ms, 'number'); }
    assert.equal(ev.items[0].sec, 6); assert.equal(ev.items[1].ok, true);
    const result = (await until(() => deviceEvents('dictation.result').filter(e => e.data.dictationId === 'dic-off').at(-1))).data;
    const fin = (await until(() => deviceEvents('dictation.polish').find(e => e.data.d === 'dic-off'))).data;
    assert(!('text' in result) && !('text' in fin));
    assert.equal(fin.chars, 'Geheimtext4711 steht hier.'.length, 'the counts stay');
    assert(!JSON.stringify(events.filter(e => /dic-off/.test(JSON.stringify(e.data)))).includes('Geheimtext4711'), 'none of the words in the log');
    maiText = 'und dann habe ich ich die Jeff Bench Ergebnisse'; liveReply = d => d.text;
  });

  it('flushCaptionStats also flushes the caption log of that device', async () => {
    assert.equal((await post('/api/device/caption', captionForm({ dictation: 'dic-stats', seq: '0' }))).status, 200);
    app.devices.flushCaptionStats(deviceId);
    await app.traces.flushAll(1000);
    assert.equal((await until(() => logs('dic-stats')[0])).data.items.length, 1);
  });
});
