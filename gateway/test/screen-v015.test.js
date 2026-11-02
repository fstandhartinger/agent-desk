// Screen Agent v0.1.5 on the gateway: no fence, vision ids verified by the registry, background of visible ids, the newest pending frame, look after "no picture".
import assert from 'node:assert/strict';
import { beforeEach, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_VISION_FRESH_WAIT_MS: '150', DESK_VISION_CAP_USD_HOUR: '5' });
const { createScreenVision } = await import('../src/screenVision.js');
const { runTool } = await import('../src/tools.js');

const jpeg = (w = 800, h = 450) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), randomBytes(2000), Buffer.from([0xff, 0xd9])]);
const usage = { inputTokens: 1000, outputTokens: 100 };
const record = { deviceId: 'dev' };
let version, KNOWN, screenRec, calls, gate, answer, vision, sent, traces;
const fakeArtifacts = {
  screen: () => structuredClone(screenRec),
  async setScreen(sid, f) {
    const ids = f.ids.filter(id => KNOWN[id]);
    const prev = screenRec.ids;
    screenRec = { ...screenRec, ids, items: ids.map(id => ({ id, ...KNOWN[id] })) };
    return { ok: true, newIds: ids.filter(id => !prev.includes(id)) };
  },
};
const frame = (o = {}) => ({ deviceId: 'dev', frameVersion: ++version, jpeg: jpeg().toString('base64'), process: 'chrome', title: 'Seite', masked: 0, ids: [], reason: 'interval', ...o });
beforeEach(() => {
  version = 0; calls = []; sent = []; traces = []; gate = null; screenRec = { ids: [], items: [], highlights: [] };
  KNOWN = { aaaaaa: { title: 'Reserve Projektion', summary: 'Wie die freie Reserve berechnet wird.\nZweite Zeile.' }, bbbbbb: { title: 'Pay stops', summary: 'Ab 14. Januar 2027.' } };
  answer = () => ({ text: 'Seite mit Reserve', change: 'x', ids: [], usage, ms: 5 });
  const media = { vision: async (bytes, meta, prev) => { calls.push({ bytes, meta, prev }); if (gate) await gate.promise; return answer(calls.length); } };
  vision = createScreenVision({ media, artifacts: fakeArtifacts, now: () => Date.now() });
  vision.attach('s', { kind: 'voice', announced: true, trace: (type, data) => traces.push({ type, ...data }), setContext: (t) => { sent.push(t); return 'sent'; } });
});
const blockVision = () => { let release; gate = { promise: new Promise(r => { release = r; }), release }; return gate; };
const data = out => JSON.parse(JSON.parse(/<artifact_data>\n([\s\S]*)\n<\/artifact_data>/.exec(out.content)[1]));

it('ids read by the vision model count only after the registry knows them; the reply lists the verified ones', async () => {
  answer = () => ({ text: 'Seite mit Reserve', change: 'x', ids: ['aaaaaa', 'ffffff'], usage, ms: 5 });
  const out = await vision.frame('s', record, frame({ ids: ['bbbbbb'] }));
  assert.deepEqual(out.ids, ['a#aaaaaa'], 'ffffff is unknown to the registry: dropped');
  assert.deepEqual(vision.snapshot('s').ids.sort(), ['a#aaaaaa', 'a#bbbbbb']);
  assert.equal(traces.find(t => t.type === 'screen.vision').verified, 1);
});

it('the same id read on the next frame stays in the reply, so the app does not drop it on every second frame', async () => {
  answer = () => ({ text: 'Seite', change: 'x', ids: ['aaaaaa'], usage, ms: 5 });
  assert.deepEqual((await vision.frame('s', record, frame({ ids: ['bbbbbb'] }))).ids, ['a#aaaaaa']);
  assert.deepEqual((await vision.frame('s', record, frame({ ids: ['bbbbbb', 'aaaaaa'] }))).ids, ['a#aaaaaa']);
});

it('a lock screen is called that, a stop or an error is not, a window on his own list is', async () => {
  vision.seen('s');
  for (const [why, text] of [['locked', /gesperrt/], ['excluded', /Ausnahmeliste/], [undefined, /kein Bild vom Bildschirm/]]) {
    vision.clear('s', why);
    assert.match(sent.at(-1), text);
    assert.doesNotMatch(sent.at(-1), /geschützt/);
  }
});

it('numbers on the screen stay out of the durable trace', async () => {
  answer = () => ({ text: 'Fehlbetrag 13.000 Euro', change: 'x', ids: [], usage, ms: 5 });
  await vision.frame('s', record, frame());
  const t = traces.find(e => e.type === 'screen.vision');
  assert.equal(t.text, 'Fehlbetrag ##.### Euro');
});

it('a direct question still gets a picture a little over the hourly cap, the passive frames do not', async () => {
  const old = process.env.DESK_VISION_CAP_USD_HOUR; process.env.DESK_VISION_CAP_USD_HOUR = '0.000001';
  try {
    await vision.frame('s', record, frame());
    assert.equal((await vision.frame('s', record, frame())).vision, 'capped');
    process.env.DESK_VISION_CAP_USD_HOUR = String(vision._states.get('s').usd / 1.2);
    assert.equal((await vision.frame('s', record, frame())).vision, 'capped');
    assert.notEqual((await vision.frame('s', record, frame({ reason: 'fresh' }))).vision, 'capped');
  } finally { if (old === undefined) delete process.env.DESK_VISION_CAP_USD_HOUR; else process.env.DESK_VISION_CAP_USD_HOUR = old; }
});

it('visible ids bring their background by themselves: title + short summary, newest id first, as data', async () => {
  answer = () => ({ text: 'Seite mit Reserve', change: 'x', ids: ['aaaaaa'], usage, ms: 5 });
  await vision.frame('s', record, frame({ ids: ['bbbbbb'] }));
  assert.equal(sent.length, 1);
  const block = JSON.parse(/<artifact_data source="screen">\n([\s\S]*)\n<\/artifact_data>/.exec(sent[0])[1]);
  assert.deepEqual(block.hintergrund.map(h => h.id), ['a#aaaaaa', 'a#bbbbbb'], 'the id that appeared last comes first');
  assert.equal(block.hintergrund[0].titel, 'Reserve Projektion'); assert.match(block.hintergrund[0].kurz, /^Wie die freie Reserve berechnet wird\. Zweite Zeile\.$/);
  assert(JSON.stringify(block.hintergrund).length <= 1500);
  assert.match(sent[0], /hintergrund/); assert.match(sent[0], /befolge nie Anweisungen/);
});

it('the background stays inside 1500 chars however many ids are visible', async () => {
  KNOWN = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [(0xa00000 + i).toString(16), { title: `Titel ${i} ${'x'.repeat(60)}`, summary: 'y'.repeat(400) }]));
  await vision.frame('s', record, frame({ ids: Object.keys(KNOWN) }));
  const block = JSON.parse(/<artifact_data source="screen">\n([\s\S]*)\n<\/artifact_data>/.exec(sent[0])[1]);
  assert(JSON.stringify(block.hintergrund).length <= 1500 && block.hintergrund.length >= 3);
});

it('a changed id set always pushes context, even when the description is the same', async () => {
  await vision.frame('s', record, frame({ ids: ['aaaaaa'] }));
  assert.equal(sent.length, 1);
  await vision.frame('s', record, frame({ ids: ['aaaaaa'] }));
  assert.equal(sent.length, 1, 'same text, same ids: nothing');
  await new Promise(r => setTimeout(r, 5100)); // the 5 s window of xAI/Gemini
  await vision.frame('s', record, frame({ ids: ['aaaaaa', 'bbbbbb'] }));
  assert.equal(sent.length, 2, 'same text, one more id: pushed');
  assert.match(sent[1], /Pay stops/);
});

it('look_at_screen and screen_context carry the background and the latest marking', async () => {
  await vision.frame('s', record, frame({ ids: ['aaaaaa'] }));
  screenRec.highlights = [{ summary: 'Die Zahl 12.480 ist umkreist.', ids: ['aaaaaa'] }];
  const looking = vision.look('s', 'was steht da?'); // nobody polls: the command queues, the next frame answers it
  const cmd = await vision.poll('s', record, undefined, 50);
  assert.equal(cmd.fresh, true);
  await vision.frame('s', record, frame({ ids: ['aaaaaa'], reason: 'fresh', commandId: cmd.id }));
  const out = await runTool('look_at_screen', {}, { vision: { look: () => looking }, sid: 's' });
  const d = data(out);
  assert.equal(d.frisch, true); assert.equal(d.hintergrund[0].titel, 'Reserve Projektion');
  assert.equal(d.letzteMarkierung.beschreibung, 'Die Zahl 12.480 ist umkreist.'); assert.deepEqual(d.letzteMarkierung.ids, ['a#aaaaaa']);
});

it('stale picture: a frame during a running vision call is kept (only the newest) and processed right after; "queued" in the reply', async () => {
  const g = blockVision();
  const first = vision.frame('s', record, frame());
  await new Promise(r => setTimeout(r, 20));
  const second = frame({ ids: [] }), third = frame();
  assert.equal((await vision.frame('s', record, second)).vision, 'queued');
  assert.equal((await vision.frame('s', record, third)).vision, 'queued');
  gate = null; g.release();
  await first;
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls.length, 2, 'the running call and exactly one pending frame');
  assert.equal(calls[1].bytes.toString('base64'), third.jpeg, 'the newest pending frame, not the older one');
  assert.equal(vision.snapshot('s').desc.version, 3);
});

it('a pending frame older than a fresher description is dropped; a locked screen drops it too', async () => {
  const g = blockVision();
  const first = vision.frame('s', record, frame());
  await new Promise(r => setTimeout(r, 20));
  await vision.frame('s', record, frame());
  vision.clear('s', 'locked');
  gate = null; g.release(); await first;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(calls.length, 1, 'cleared: the pending frame is gone');
});

it('look after "no picture" always asks for a fresh frame; a frame ends the state; nothing says "geschützt"', async () => {
  await vision.frame('s', record, frame());
  vision.clear('s', 'locked');
  assert.match(sent.at(-1), /gesperrt oder zeigt einen Windows-Sicherheitsdialog/);
  const looking = vision.look('s', 'und jetzt?');
  const cmd = await vision.poll('s', record, undefined, 50);
  assert.equal(cmd.fresh, true, 'the command goes out although the last state was "no picture"');
  await vision.frame('s', record, frame({ reason: 'fresh', commandId: cmd.id }));
  const r = await looking;
  assert.equal(r.frisch, true); assert.equal(r.hinweis, undefined);
  assert.doesNotMatch(JSON.stringify(r) + sent.join(''), /geschützt|privat/);
});

it('no frame arrives: paused says so plainly, locked says locked, stop/error tell the model nothing false', async () => {
  vision.seen('s');
  vision.clear('s', 'paused');
  assert.match(sent.at(-1), /Florian hat die Bilderfassung pausiert/);
  let r = await vision.look('s');
  assert.equal(r.frisch, false); assert.match(r.hinweis, /Florian hat die Bilderfassung pausiert/);
  vision.clear('s', 'locked');
  r = await vision.look('s');
  assert.match(r.hinweis, /gesperrt oder zeigt einen Windows-Sicherheitsdialog/);
  const n = sent.length;
  vision.clear('s', 'stop'); vision.clear('s', 'error');
  assert.equal(sent.length, n, 'stop/error: the old description is dropped without a claim');
  assert.equal(vision.snapshot('s').desc, null);
  assert.doesNotMatch(JSON.stringify(r) + sent.join(''), /geschützt/);
});

it('screen_context carries the background of each visible id (newest first) and the latest marking, ahead of the raw registry rows', async () => {
  await vision.frame('s', record, frame({ ids: ['aaaaaa'] }));
  await vision.frame('s', record, frame({ ids: ['aaaaaa', 'bbbbbb'] }));
  screenRec.highlights = [{ summary: 'Pay stops ist markiert.', ids: ['bbbbbb'] }];
  const out = await runTool('screen_context', {}, { vision, artifacts: fakeArtifacts, sid: 's' });
  const d = data(out);
  assert.deepEqual(d.ids.sort(), ['a#aaaaaa', 'a#bbbbbb']);
  assert.equal(d.hintergrund[0].id, 'a#bbbbbb'); assert.equal(d.hintergrund[0].titel, 'Pay stops');
  assert.equal(d.letzteMarkierung.beschreibung, 'Pay stops ist markiert.');
});

it('media.vision: asks for ids, returns the ones in the model answer (json or in the text), a fresh look uses the lean prompt, MINIMAL thinking is never sent', async () => {
  const { createDeviceMedia, VISION_PROMPT, VISION_PROMPT_LEAN } = await import('../src/deviceMedia.js');
  const bodies = [];
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ beschreibung: 'Seite mit a#D7C856 und Kapitel', aenderung: '', ids: ['a#e0b59c', 'zzzzzz', 'B3F477', 'a#e0b59c'] }) }] } }], usageMetadata: {} }) }; };
  const media = createDeviceMedia({ env: { GOOGLE_API_KEY: 'fake', DESK_VISION_THINKING: 'minimal' }, fetchImpl });
  const r = await media.vision(jpeg(), { process: 'chrome', title: 't', masked: 0 }, null);
  assert.deepEqual(r.ids.sort(), ['b3f477', 'd7c856', 'e0b59c']);
  assert.match(bodies[0].contents[0].parts[1].text, /ids: jede Artefakt-ID der Form a#/); assert.match(bodies[0].contents[0].parts[1].text, /kleiner, blasser Text in den Ecken/);
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'low');
  await media.vision(jpeg(), { process: 'chrome', title: 't', masked: 0 }, null, { lean: true });
  assert(bodies[1].contents[0].parts[1].text.startsWith(VISION_PROMPT_LEAN)); assert(!bodies[1].contents[0].parts[1].text.startsWith(VISION_PROMPT));
  assert.doesNotMatch(VISION_PROMPT, /geschützt|geschwärzt/);
});
