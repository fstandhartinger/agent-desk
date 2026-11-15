// Records the sound of a voice session for 30 days (Florian, 15 Nov 2026, card 19712: "Ja"). Both streams, 24 kHz PCM16 mono:
// 'user' = his microphone as it reaches the vendor (silent frames, muted time and the words of a computer-control run are left out),
// 'assistant' = the voice model's speech. Chunks carry their time since the session start and go to the LeChonk bridge
// (`audio.append`, about every 10 s); at the end `audio.finish` makes one stereo Opus file there (bridge/src/audio.js). Only when the
// LeChonk bridge announces the method; a failure only stops the recording (traced), never the session.

const FLUSH_BYTES = 480_000; // ~10 s of one stream
const FLUSH_MS = 15_000;
const MAX_WAIT_BYTES = 8 * 1024 * 1024; // buffered while the session id is not known yet
const MAX_SESSION_BYTES = 350 * 1024 * 1024;

const silent = (pcm) => { for (let i = 0; i + 1 < pcm.length; i += 32) if (Math.abs(pcm.readInt16LE(i)) > 300) return false; return true; };

/**
 * createRecorder({ sink: {available(), append(params), finish(params)}, aid: () => 'a#xxxxxx'|null, now, trace, quiet: () => bool })
 * -> { push(role, pcm), stop() -> {started, bytes, file?} }
 */
export function createRecorder({ sink, aid, now = Date.now, trace = () => {}, quiet = () => false, enabled = true }) {
  const on = Boolean(enabled && sink?.available?.());
  const t0 = now();
  let pending = [];
  let pendingBytes = 0;
  let sentBytes = 0;
  let lastFlush = now();
  let failed = false;
  let full = false;
  let chain = Promise.resolve();
  let first = null; // UTC day of the first append (the bridge files it under that day)

  function flush(force = false) {
    if (!on || failed || !pending.length) return;
    const id = aid();
    if (!id) { if (pendingBytes > MAX_WAIT_BYTES) { pending = []; pendingBytes = 0; trace('audio.dropped', { reason: 'no session id yet' }); } return; }
    if (!force && pendingBytes < FLUSH_BYTES && now() - lastFlush < FLUSH_MS) return;
    const chunks = pending.map((c) => ({ role: c.role, t: c.t, pcm: c.pcm.toString('base64') }));
    sentBytes += pendingBytes;
    pending = []; pendingBytes = 0; lastFlush = now();
    first ??= new Date(now()).toISOString().slice(0, 10);
    chain = chain.then(() => sink.append({ aid: id, chunks })).then((r) => { if (r?.full && !full) { full = true; trace('audio.full', { bytes: sentBytes }); } }, (err) => { if (!failed) { failed = true; trace('audio.error', { message: String(err?.message ?? err).slice(0, 160) }); } });
  }

  return {
    get on() { return on; },
    push(role, pcm) {
      if (!on || failed || full || !pcm?.length) return;
      if (role === 'user' && (quiet() || silent(pcm))) return;
      if (sentBytes + pendingBytes + pcm.length > MAX_SESSION_BYTES) return;
      const last = pending.at(-1);
      const t = now() - t0;
      // consecutive frames of the same role are one chunk (fewer, larger parts on the bridge)
      if (last && last.role === role && last.end >= t - 60) { last.pcm = Buffer.concat([last.pcm, pcm]); last.end = t; }
      else pending.push({ role, t, end: t, pcm: Buffer.from(pcm) });
      pendingBytes += pcm.length;
      flush();
    },
    /** The rest goes out, then the bridge writes the file. Returns what the trace should say (sync); the encoding runs on. */
    stop() {
      if (!on) return { started: false };
      flush(true);
      const id = aid();
      if (!id || (!sentBytes && !pendingBytes)) return { started: false };
      chain = chain.then(() => (failed ? null : sink.finish({ aid: id }))).catch(() => null /* best effort: the bridge reports its own failure; the session is over */);
      return { started: true, bytes: sentBytes, file: `LeChonk ~/desk-audio/${first ?? new Date(now()).toISOString().slice(0, 10)}/${id.replace(/^a#/, '')}.opus`, retainDays: 30 };
    },
    /** Tests: resolves when every send so far is done. */
    settled: () => chain,
  };
}
