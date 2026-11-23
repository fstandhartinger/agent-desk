import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCardOpeningAudio, compressPauses, spokenText, decodePcm, encodeWav, trimSilence, plausibleLength, transcriptCoverage, openingChain } from '../src/cardOpeningAudio.js';
import { cardOpening } from '../src/cardStartup.js';

const RATE = 24000;
/** silence, `seconds` of a loud tone, silence */
function take(seconds, { lead = 0.5, tail = 0.8 } = {}) {
  const n = Math.round((lead + seconds + tail) * RATE), pcm = new Int16Array(n);
  for (let i = Math.round(lead * RATE); i < Math.round((lead + seconds) * RATE); i++) pcm[i] = Math.round(8000 * Math.sin(i / 7));
  return { rate: RATE, pcm };
}
const settle = async (svc) => { for (let i = 0; i < 50 && !svc.idle(); i++) await new Promise((r) => setTimeout(r, 2)); };
const TEXT = 'Hosting-Budget für Sandy. Offen. Was brauchst du?';

test('wav round trip, silence trim keeps a short head pad', () => {
  const t = trimSilence(take(2));
  const secs = t.pcm.length / RATE;
  assert.ok(secs > 2 && secs < 2.3, `trimmed ${secs}`);
  const back = decodePcm(encodeWav(t));
  assert.equal(back.rate, RATE);
  assert.deepEqual(Array.from(back.pcm.slice(0, 50)), Array.from(t.pcm.slice(0, 50)));
  assert.equal(decodePcm(Buffer.from(new Int16Array([1, 2, 3]).buffer), 24000).pcm.length, 3, 'raw L16 is accepted too');
  assert.equal(trimSilence({ rate: RATE, pcm: new Int16Array(RATE) }).pcm.length, 0);
});

test('long pauses inside a take shrink to 0.3 s; speech and short pauses stay untouched', () => {
  const a = take(1, { lead: 0, tail: 0 }), b = take(1, { lead: 1.5, tail: 0 }), c = take(1, { lead: 0.2, tail: 0 });
  const joined = new Int16Array(a.pcm.length + b.pcm.length + c.pcm.length);
  joined.set(a.pcm, 0); joined.set(b.pcm, a.pcm.length); joined.set(c.pcm, a.pcm.length + b.pcm.length);
  const out = compressPauses({ rate: RATE, pcm: joined });
  const secs = out.pcm.length / RATE;
  assert.ok(Math.abs(secs - 3.5) < 0.03, `3 s speech + 0.3 s + 0.2 s pauses, got ${secs}`);
  const same = take(1, { lead: 0, tail: 0 });
  assert.equal(compressPauses(same).pcm, same.pcm, 'nothing to cut: same buffer');
});

test('plausibility and content checks', () => {
  assert.ok(plausibleLength(TEXT, 2.8));
  assert.ok(!plausibleLength(TEXT, 0.2), 'empty take');
  assert.ok(!plausibleLength(TEXT, 30), 'run-on take');
  assert.equal(transcriptCoverage(TEXT, 'Hosting Budget für Sandy, offen. Was brauchst du?'), 1);
  assert.ok(transcriptCoverage(TEXT, 'Was brauchst du?') < 0.6);
  assert.ok(transcriptCoverage('Karpo Duo. Offen. Was brauchst du?', 'Karpos Duo, offen, was brauchst du') >= 0.8, 'misheard name endings pass');
});

test('pronunciation table: JevBench is spoken Dschevbench, other words untouched', () => {
  assert.equal(spokenText('JevBench Release. Offen. Was brauchst du?'), 'Dschevbench Release. Offen. Was brauchst du?');
  assert.equal(spokenText('JevBenchs und MyJevBench'), 'Dschevbenchs und MyJevBench');
});

test('chain from env: default C3 then A2, off disables', () => {
  assert.deepEqual(openingChain({}), ['C3', 'A2']);
  assert.deepEqual(openingChain({ DESK_OPENING_VOICES: 'A2' }), ['A2']);
  assert.deepEqual(openingChain({ DESK_OPENING_VOICES: 'off' }), []);
  assert.deepEqual(openingChain({ DESK_OPENING_VOICES: 'nope' }), ['C3', 'A2']);
});

test('render: C3 first, cached by text, served synchronously; failures fall back to A2', async () => {
  const calls = [];
  const svc = createCardOpeningAudio({ log: () => {}, transcribe: async () => TEXT, synth: async (code, text) => { calls.push(code); if (text.startsWith('Kaputt') && code === 'C3') throw new Error('http-500'); return take(2.6); } });
  assert.equal(svc.get(TEXT), null);
  assert.equal(svc.want(TEXT), true);
  assert.equal(svc.want(TEXT), false, 'queued once');
  await settle(svc);
  const hit = svc.get(TEXT);
  assert.equal(hit.voice, 'C3');
  assert.ok(hit.durationMs > 2500 && hit.durationMs < 2900);
  assert.equal(Buffer.from(hit.data, 'base64').toString('ascii', 0, 4), 'RIFF');
  assert.equal(svc.want(TEXT), false, 'cached lines are not rendered again');
  svc.want('Kaputt. Offen. Was brauchst du?');
  await settle(svc);
  assert.equal(svc.get('Kaputt. Offen. Was brauchst du?').voice, 'A2');
  assert.deepEqual(calls, ['C3', 'C3', 'C3', 'A2']);
});

test('a take that drops words is rejected; a line that fails everywhere waits before the next try', async () => {
  let t = 0;
  const logs = [];
  const svc = createCardOpeningAudio({ now: () => t, log: (l) => logs.push(JSON.parse(l)), transcribe: async () => 'brauchst du', synth: async () => take(2.6) });
  svc.want(TEXT);
  await settle(svc);
  assert.equal(svc.get(TEXT), null);
  assert.equal(svc.want(TEXT), false, 'retry later, not in a loop');
  t += 31 * 60_000;
  assert.equal(svc.want(TEXT), true);
  await settle(svc);
  const failed = logs.find((l) => l.msg === 'card-opening.render.failed');
  assert.match(failed.reason, /content-/);
  assert.ok(!JSON.stringify(logs).includes('Hosting'), 'logs never carry the card text');
});

test('missing keys: no retry storm, null transcript keeps the length check alone', async () => {
  const svc = createCardOpeningAudio({ env: {}, log: () => {}, transcribe: async () => null, fetchImpl: async () => { throw new Error('no network in tests'); } });
  svc.want(TEXT);
  await settle(svc);
  assert.equal(svc.get(TEXT), null);
  assert.equal(svc.stats.failures, 1);
});

test('daily cap stops renders', async () => {
  const svc = createCardOpeningAudio({ log: () => {}, dailyRenders: 1, transcribe: async () => null, synth: async () => take(2.4) });
  svc.want('Eins. Offen. Was brauchst du?'); svc.want('Zwei. Offen. Was brauchst du?');
  await settle(svc);
  assert.ok(svc.get('Eins. Offen. Was brauchst du?'));
  assert.equal(svc.get('Zwei. Offen. Was brauchst du?'), null);
});

test('poll pre-renders the opening line of the newest cards from the Sandy bridge', async () => {
  const hub = new EventEmitter();
  hub.hostsFor = () => ['sandy'];
  const asked = [];
  hub.call = async (method, params, opts) => { asked.push([method, params, opts.host]); return { cards: [{ id: '20300', aid: 'abc123', title: 'Hosting-Budget', status: 'erledigt' }, { id: '20299', title: '' }] }; };
  const svc = createCardOpeningAudio({ hub, log: () => {}, transcribe: async () => null, synth: async () => take(2.2) });
  await svc.poll();
  await settle(svc);
  assert.deepEqual(asked, [['notify.cardSummaries', { limit: 30 }, 'sandy']]);
  const line = cardOpening({ id: '20300', title: 'Hosting-Budget', status: 'erledigt' });
  assert.equal(line, 'Hosting-Budget. Erledigt. Was brauchst du?');
  assert.ok(svc.get(line));
  assert.equal(svc.size(), 1, 'cards without a title are skipped');
  hub.hostsFor = () => [];
  asked.length = 0;
  await svc.poll();
  assert.equal(asked.length, 0, 'no Sandy bridge, no call');
});
