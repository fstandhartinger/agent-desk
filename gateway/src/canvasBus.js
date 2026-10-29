// Canvas bus (docs/CANVAS.md): single-user app, one in-memory bus. Every canvas event (pending / ready / error) from
// the text agent, the voice agents, the illustrator and Claude sessions goes through publish(); GET /api/canvas/events
// replays the last 50 from a ring (Last-Event-ID) and GET /api/canvas lists the latest ready spec per id.

const RING = 50;
const MAX_CANVASES = 20;

export function createCanvasBus({ ring = RING } = {}) {
  const entries = []; // {seq, event}
  const listeners = new Set();
  const ready = new Map(); // id -> ready event, insertion order = oldest first
  // Round 12 (critic r11 defect 2): the conversation / voice session / Claude session that wrote an id first owns it. Kept
  // here, never in the events (an owner key names a login session).
  const owners = new Map(); // id -> owner
  let seq = 0;
  let lastAt = 0;

  return {
    /**
     * event: {phase, id, kind?, title?, spec?, by, provider?, message?}. Stamps type, `at` (epoch ms, strictly
     * increasing so id + at dedupes) and the SSE sequence number. Returns the stamped event.
     */
    publish(partial, { owner } = {}) {
      lastAt = Math.max(Date.now(), lastAt + 1);
      const event = { type: 'canvas', ...partial, at: lastAt };
      for (const key of Object.keys(event)) if (event[key] === undefined) delete event[key];
      seq += 1;
      entries.push({ seq, event });
      if (entries.length > ring) entries.shift();
      if (owner && event.id && (event.phase === 'pending' || event.phase === 'ready') && !owners.has(event.id)) owners.set(event.id, owner);
      if (event.phase === 'ready' && event.spec) {
        ready.delete(event.id);
        ready.set(event.id, event);
        while (ready.size > MAX_CANVASES) { const old = ready.keys().next().value; ready.delete(old); owners.delete(old); }
      }
      for (const fn of [...listeners]) {
        try { fn(event, seq); } catch { /* a broken listener must not stop the bus */ }
      }
      return event;
    },

    /**
     * Round 10 (critic r9 F6): a drawing that was cancelled or failed for an id without a ready spec leaves nothing behind -
     * its pending / error / dropped events leave the replay ring (live listeners have them already; a reload never shows them).
     */
    forget(id) {
      for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].event.id === id && entries[i].event.phase !== 'ready') entries.splice(i, 1);
      if (!ready.has(id)) owners.delete(id);
    },

    /** Who wrote `id` first (undefined: nobody that said, e.g. an older caller). */
    ownerOf(id) {
      return owners.get(id);
    },

    /** fn(event, seq); returns the unsubscribe function. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Events newer than `sinceSeq` still in the ring: [{seq, event}]. */
    replay(sinceSeq = 0) {
      return entries.filter((e) => e.seq > sinceSeq);
    },

    /** Latest ready event per id, newest first, at most 20. */
    latest() {
      return [...ready.values()].reverse();
    },

    get seq() { return seq; },
  };
}
