// The sound of a voice session for 30 days (Florian 15 Nov 2026, card 19712): recorder.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../src/voice/recorder.js';

const loud = (n = 960) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i += 2) b.writeInt16LE(i % 4 ? 4000 : -4000, i); return b; };
const sinkOf = (available = true) => { const calls = []; return { calls, available: () => available, append: async (p) => { calls.push(['append', p]); return { ok: true }; }, finish: async (p) => { calls.push(['finish', p]); return { ok: true }; } }; };

test('records both roles with times, skips silence and quiet (computer) speech, waits for the session id, finishes once', async () => {
  let t = 1_000_000, id = null, quiet = false;
  const sink = sinkOf();
  const r = createRecorder({ sink, aid: () => id, now: () => t, quiet: () => quiet });
  assert.equal(r.on, true);
  r.push('user', Buffer.alloc(960)); // silence: never recorded
  r.push('user', loud()); t += 20; r.push('user', loud()); // one chunk
  t += 1000; r.push('assistant', loud(4800));
  quiet = true; t += 500; r.push('user', loud()); quiet = false; // words of a computer run: out
  assert.equal(sink.calls.length, 0); // no id yet: buffered
  id = 'a#abc123';
  const out = r.stop();
  await r.settled();
  const appends = sink.calls.filter(([k]) => k === 'append');
  const chunks = appends.flatMap(([, p]) => p.chunks);
  assert.deepEqual(chunks.map((c) => [c.role, c.t]), [['user', 0], ['assistant', 1020]]);
  assert.equal(Buffer.from(chunks[0].pcm, 'base64').length, 1920);
  assert.deepEqual(sink.calls.at(-1), ['finish', { aid: 'a#abc123' }]);
  assert.equal(out.started, true);
  assert.match(out.file, /^LeChonk ~\/desk-audio\/\d{4}-\d{2}-\d{2}\/abc123\.opus$/);
});

test('off without the LeChonk method or when switched off; a failing bridge stops only the recording', async () => {
  assert.equal(createRecorder({ sink: sinkOf(false), aid: () => 'a#abc123' }).on, false);
  assert.equal(createRecorder({ sink: sinkOf(true), aid: () => 'a#abc123', enabled: false }).on, false);
  assert.equal(createRecorder({ sink: undefined, aid: () => 'a#abc123' }).on, false);
  const events = [];
  const bad = { available: () => true, append: async () => { throw new Error('bridge offline'); }, finish: async () => ({}) };
  const r = createRecorder({ sink: bad, aid: () => 'a#abc123', trace: (type, d) => events.push({ type, ...d }) });
  r.push('assistant', loud(600_000));
  await r.settled();
  assert.ok(events.some((e) => e.type === 'audio.error'));
  r.push('assistant', loud(600_000)); // ignored after a failure
  assert.doesNotThrow(() => r.stop());
});
