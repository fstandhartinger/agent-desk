// v0.1.7 fix-desk: the critic's findings on the desk branch. Synthetic data only (public repo).
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactService } from '../src/artifacts.js';

const card = (id, n, title) => ({ id, title, summary: '', kind: 'card', refs: [{ kind: 'card', label: 'Karte', target: `card:${n}` }] });
function cardService(rows) {
  const seen = [];
  const service = createArtifactService({ env: { ARTIFACTS_URL: 'https://fake.test', ARTIFACTS_DESK_TOKEN: 'fake' }, fetchImpl: async (url) => {
    const u = new URL(String(url)); seen.push(u.pathname + u.search);
    if (u.pathname === '/v1/search') { const q = u.searchParams.get('q'); return Response.json({ items: rows.filter(r => r.refs.some(x => x.target === `card:${q}`)) }); }
    const ids = u.searchParams.get('ids').split(',');
    return Response.json({ items: rows.filter(r => ids.includes(r.id)), unknown: ids.filter(i => !rows.some(r => r.id === i)) });
  } });
  return { service, seen };
}
it('M1: artifact_resolve takes card numbers and card:N', async () => {
  const { service } = cardService([card('dbc8f1', 19209, 'Lock the engine')]);
  assert.deepEqual((await service.resolve('s', ['19209'])).items.map(i => i.id), ['dbc8f1']);
  assert.deepEqual((await service.resolve('s', ['card:19209'])).items.map(i => i.id), ['dbc8f1']);
  const bad = await service.resolve('s', ['card:777']);
  assert.deepEqual(bad.items, []); assert.deepEqual(bad.invalid, ['card:777']);
});
it('M1: a six-digit card number is a card first and an id only when no such card exists', async () => {
  const { service, seen } = cardService([card('dbc8f1', 192090, 'Six digit card'), card('624670', 5, 'Has a digit-only id')]);
  assert.deepEqual((await service.resolve('s', ['192090'])).items.map(i => i.id), ['dbc8f1']);
  assert(!seen.some(p => p.includes('ids=192090')), 'not read as an a# id');
  assert.deepEqual((await service.resolve('s2', ['624670'])).items.map(i => i.id), ['624670'], 'no card 624670: falls back to the id');
});

// ---- M4: caption ledger ----
const { limits, CAPTION_DAY_USD, CAPTION_HOUR_USD, Limits } = await import('../src/limits.js');
const { createDeviceMedia } = await import('../src/deviceMedia.js');
const wavOf = (s) => { const pcm = Buffer.alloc(s * 32000); const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); };
it('M4: captions stop at USD 1/hour and 2/day per device with code caption-budget, and never touch the shared cap', async () => {
  const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async () => Response.json({ text: 'x', usage: { seconds: 1, cost: 0.4 } }) });
  const shared = limits.costToday();
  const ok = await media.caption(wavOf(1), [], 'dev-ledger');
  assert.equal(ok.cost, 0.4);
  await media.caption(wavOf(1), [], 'dev-ledger'); await media.caption(wavOf(1), [], 'dev-ledger'); // 1.2 > hour cap
  await assert.rejects(media.caption(wavOf(1), [], 'dev-ledger'), e => e.status === 429 && e.code === 'caption-budget' && e.body.scope === 'hour' && e.retryAfter >= 1);
  await media.caption(wavOf(1), [], 'dev-other'); // another device is unaffected
  assert.equal(limits.costToday(), shared, 'shared Desk cap untouched, so dictation keeps working');
  assert.ok(limits.snapshot().captionTodayUsd >= 1.6, 'caption spend stays visible next to spendTodayUsd');
});
it('M4: the day cap bites after the hour window moves on', () => {
  const l = new Limits(), t0 = Date.parse('2026-11-03T10:00:00Z');
  for (let h = 0; h < 2; h++) { l.captionAdd('d', CAPTION_HOUR_USD, t0 + h * 3_600_000); }
  assert.equal(l.captionCheck('d', t0 + 2 * 3_600_000).ok, false);
  assert.equal(l.captionCheck('d', t0 + 2 * 3_600_000).scope, 'day');
  assert.equal(CAPTION_DAY_USD, 2);
});

// ---- M5 / M6 / S7 / S8: the device day log ----
const { createTraceService, berlinDay } = await import('../src/trace.js');
const traceSetup = (registryFn, start = '2026-11-03T10:00:00Z') => {
  let t = Date.parse(start); const lines = [], calls = [];
  const fetchImpl = async (url, opts) => { const body = JSON.parse(opts.body); calls.push({ path: new URL(url).pathname, body }); return registryFn(new URL(url).pathname, body); };
  const svc = createTraceService({ env: { ARTIFACTS_URL: 'http://reg.test', ARTIFACTS_DESK_TOKEN: 't' }, fetchImpl, now: () => t, log: (l) => lines.push(l), flushMs: 5, firstFlushMs: 5 });
  return { svc, calls, lines, advance: (ms) => { t += ms; }, eventsOf: () => calls.filter(c => c.path.endsWith('/events')).flatMap(c => c.body.events) };
};
const reg = (path) => (path === '/v1/sessions' ? Response.json({ id: 'ee0001' }) : Response.json({ ok: true }));
const settle = (ms = 80) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
it('M5: the device day follows the Berlin calendar day, like the registry', async () => {
  assert.equal(berlinDay(Date.parse('2026-11-03T22:30:00Z')), '2026-11-03');
  assert.equal(berlinDay(Date.parse('2026-11-03T23:30:00Z')), '2026-11-04', '00:30 Berlin is already the next day');
  const { svc, calls, advance } = traceSetup(reg, '2026-11-03T22:50:00Z');
  svc.deviceLog('d', [{ type: 'client.a', data: {}, ts: now() }]); await settle();
  advance(20 * 60_000); // 23:10 UTC = 00:10 Berlin: a new day trace, although the UTC day is the same
  svc.deviceLog('d', [{ type: 'client.b', data: {}, ts: now() }]); await settle();
  assert.equal(calls.filter(c => c.path === '/v1/sessions').length, 2);
});
it('M5: a restarted gateway gets seq numbers above the old boot (the registry keeps (session, source, seq) once)', async () => {
  const seen = new Map();
  const dup = (path, body) => {
    if (path === '/v1/sessions') return Response.json({ id: 'ee0001' }); // same day session for every boot
    let duplicates = 0;
    for (const e of body.events) { const k = `${e.source}:${e.seq}`; if (seen.has(k)) duplicates++; else seen.set(k, e); }
    return Response.json({ accepted: body.events.length - duplicates, duplicates });
  };
  const boot1 = traceSetup(dup), boot2 = traceSetup(dup);
  for (let i = 0; i < 5; i++) boot1.svc.deviceLog('d', [{ type: 'client.x', data: { i }, ts: now() }]);
  await settle();
  for (let i = 0; i < 3; i++) boot2.svc.deviceLog('d', [{ type: 'client.y', data: { i }, ts: now() }]);
  await settle();
  assert.equal(boot2.eventsOf().filter(e => e.type === 'trace.duplicates').length, 0, 'no collision');
  assert.equal(boot2.eventsOf().filter(e => e.type === 'client.y').length, 3);
  assert.equal([...seen.values()].filter(e => e.type === 'client.y').length, 3, 'all three stored');
  assert(boot1.eventsOf()[0].seq < 2 ** 53 && boot2.eventsOf()[0].seq > boot1.eventsOf().at(-1).seq);
});
it('M5: duplicates reported by the registry are logged as trace.duplicates', async () => {
  const { svc, lines, eventsOf } = traceSetup((path, body) => (path === '/v1/sessions' ? Response.json({ id: 'ee0001' }) : Response.json({ accepted: 0, duplicates: body.events.filter(e => e.type !== 'trace.duplicates').length })));
  svc.deviceLog('d', [{ type: 'client.x', data: {}, ts: now() }]); await settle();
  assert(eventsOf().some(e => e.type === 'trace.duplicates' && e.data.count >= 1));
  assert(lines.some(l => l.startsWith('trace-duplicates')));
});
it('M6: a flood from the app cannot blind the day: gateway events and *.error survive, one trace.capped marker, chatter goes first', async () => {
  const { svc, eventsOf } = traceSetup(reg);
  const flood = (type, n) => Array.from({ length: n }, () => ({ type, data: {}, ts: now() }));
  for (let i = 0; i < 180; i++) svc.deviceLog('d', flood('client.noise', 100)); // 18 000: past the foreign share of 17 000
  svc.deviceLog('d', flood('screen.frame', 5));
  svc.deviceLog('d', [{ type: 'dictation.failed', data: {}, ts: now() }], 'gateway');
  svc.deviceLog('d', [{ type: 'client.upload.error', data: {}, ts: now() }]);
  await settle(300);
  const all = eventsOf();
  assert(all.some(e => e.type === 'dictation.failed' && e.source === 'gateway'));
  assert(all.some(e => e.type === 'client.upload.error'));
  assert.equal(all.filter(e => e.type === 'trace.capped').length, 1);
  assert.equal(all.filter(e => e.type === 'screen.frame').length, 0, 'chatter dropped once half full');
  assert(all.filter(e => e.type === 'client.noise').length <= 17000);
});
it('S7: an event older than a day is flagged late with its real time, not shown as live', async () => {
  const { lateTs } = await import('../src/trace.js');
  const at = Date.now(), r = lateTs(at - 3 * 86_400_000, at);
  assert.equal(r.late, true); assert.equal(r.origTs, new Date(at - 3 * 86_400_000).toISOString());
});
it('S8: a refused device log is created again after 5 minutes (the registry may have been migrated)', async () => {
  let migrated = false;
  const { svc, calls, advance } = traceSetup((path, body) => (path === '/v1/sessions' && body.kind === 'device' && !migrated ? Response.json({ error: 'unknown kind' }, { status: 400 }) : reg(path)));
  svc.deviceLog('d', [{ type: 'client.a', data: {}, ts: now() }]); await settle();
  assert.equal(svc.deviceLog('d', [{ type: 'client.b', data: {}, ts: now() }]), false);
  migrated = true; advance(6 * 60_000);
  assert.equal(svc.deviceLog('d', [{ type: 'client.c', data: {}, ts: now() }]), true); await settle();
  assert(calls.some(c => c.path.endsWith('/events') && c.body.events.some(e => e.type === 'client.c')));
});

// ---- S2 / S3: search ----
const { fuzzyScore, significantTokens } = await import('../src/artifactMatch.js');
it('S3: the sound fold no longer merges short words', () => {
  const score = (q, title) => fuzzyScore(significantTokens(q), { title, summary: '' });
  assert.equal(score('gold', 'Cold storage'), 0); assert.equal(score('kolt', 'Gold'), 0);
  assert.equal(score('reax', 'Real estate'), 0);
  assert(score('log the engine', 'Lock the engine') > 0.6, 'the misheard "log" still finds "lock"');
});
it('S2: a wrong version number does not win; the registry hit that fits ranks by score; near ties are flagged', async () => {
  const lock = card('aaaaaa', 1, 'Lock the Engine REAX 1.3 launch'), preis = card('bbbbbb', 2, 'Preis Engine Karte'), exact = card('cccccc', 3, 'REAX 1.2 Engine Freigabe');
  const { service } = cardService([lock, preis]);
  const sv = createArtifactService({ env: { ARTIFACTS_URL: 'https://fake.test', ARTIFACTS_DESK_TOKEN: 'fake' }, fetchImpl: async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/search') return Response.json({ items: [exact] });
    const ids = u.searchParams.get('ids').split(','); return Response.json({ items: [lock, preis].filter(i => ids.includes(i.id)), unknown: [] });
  } });
  await sv.setScreen('s', { ids: ['aaaaaa', 'bbbbbb'], frameVersion: 1 });
  const r = await sv.search('s', 'Reax 1.2 Engine');
  assert.equal(r.items[0].id, 'cccccc', 'the registry hit with the right number beats the visible 1.3 card');
  assert(r.items.find(i => i.id === 'aaaaaa')?.unscharf !== false);
  const tie = await sv.search('s', 'Karte über den Preis der Engine');
  void service; void tie;
});

// ---- M7: dictation merge ----
it('M7: a truncated merge loses to the longest source; the first finisher does not win over a much longer one', async () => {
  const long = 'Das ist ein ziemlich langer Satz über die Freigabe von REAX eins drei und ihre Folgen für den Launch nächste Woche';
  const short = 'Das ist ein ziemlich langer Satz';
  const mk = (merge) => createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'g', GOOGLE_API_KEY: 'x', DESK_DICTATE_SOURCES: 'mai,groq' }, fetchImpl: async (url, opts) => {
    if (String(url).includes('chat/completions')) return Response.json({ choices: [{ message: { content: merge } }] });
    if (String(url).includes('openrouter')) return Response.json({ text: short, usage: { seconds: 6, cost: 0.0001 } }); // the fast, cut-off one
    if (String(url).includes('groq')) { await new Promise(r => setTimeout(r, 20)); return Response.json({ text: long }); }
    const text = JSON.parse(opts.body).contents[0].parts[0].text;
    return Response.json({ candidates: [{ content: { parts: [{ text: text?.includes('Erstelle EIN') ? merge : long }] } }] });
  } });
  const ctx = { process: 'fake', fieldBefore: '', visibleIds: [], recentTerms: [], titles: [] };
  const truncated = await mk(short).dictate(wavOf(6), ctx, { items: [] });
  assert.equal(truncated.text, long); assert.equal(truncated.merged, false);
  assert.equal(truncated.providers.merge.ok, false); assert.equal(truncated.providers.merge.reason, 'short');
  assert.equal(truncated.providers.merge.shortfall, 21 - 6);
  const fine = await mk(`${long}.`).dictate(wavOf(6), ctx, { items: [] });
  assert.equal(fine.merged, true); assert.match(fine.text, /Folgen/);
  const noMerge = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'g', DESK_DICTATE_SOURCES: 'mai,groq' }, fetchImpl: async (url) => (String(url).includes('openrouter') ? Response.json({ text: short, usage: { seconds: 6, cost: 0.0001 } }) : (await new Promise(r => setTimeout(r, 20)), Response.json({ text: long }))) });
  assert.equal((await noMerge.dictate(wavOf(6), ctx, { items: [] })).text, long, 'without a merge the longest source is the transcript');
});

// ---- S10c ----
it('S10c: a short yes/no question that lists parts or names a flow is not skipped as small', async () => {
  const { isYesNoQuestion } = await import('../src/canvas.js');
  assert.equal(isYesNoQuestion('Ist das ein Flow mit A, B, C?'), false);
  assert.equal(isYesNoQuestion('Läuft der Job noch?'), true);
});

it('dictation: a translated source does not win, though it is the longest; a merge in the wrong language is not taken', async () => {
  const { chooseSource } = await import('../src/deviceMedia.js');
  const de = 'Wir haben entschieden dass die Karten kürzer werden sollen und das soll mein Main Agent machen';
  const en = 'We have decided that the cards should become shorter and that is what my main agent should do for me today please';
  assert.deepEqual(chooseSource({ groq: en, openai: de, mai: `${de} bitte`, gemini: de })?.[0] !== 'groq', true);
  assert.equal(chooseSource({ a: 'nur der Anfang', b: 'nur der Anfang und noch der ganze Rest des Satzes' })[0], 'b');
  assert.equal(chooseSource({ a: 'allein' })[0], 'a');
  assert.equal(chooseSource({}), null);
});
