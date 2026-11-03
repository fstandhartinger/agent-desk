// Durable session trace (voice + text chat): events are buffered here and shipped to the registry (Postgres, "kind session").
// The session path only calls synchronous, never-throwing methods; a registry outage costs nothing but a stdout line.
// No audio, no images, no tool results (only their size); every string goes through redact().
import { redact } from './redact.js';

export const MAX_BUFFER = 5000; // events per session kept while the registry is away; the oldest are dropped (trace.dropped)
export const MAX_EVENT_BYTES = 8192;
export const MAX_TEXT = 4096; // transcripts are kept in full up to this size
const MAX_STR = 1000; // any other string
const MAX_ARGS = 2000; // tool arguments, serialised
const BATCH = 100;
const FIRST_FLUSH_MS = 3000; // session.ready (the model name) arrives within this window
const RECENT = 200; // local ring for session_trace "current" when the registry cannot answer
const CLIENT_CAP = 3000; // client + screen-agent events accepted per session
const DEVICE_CAP = 20000; // the per-day device log lives all day and takes the app's retry queue too
const DEVICE_RESERVE = 3000; // of those, only the gateway's own events and *.error / *.failed may use the last 3000: one retry loop must not blind the day
const CHATTER = /^(?:screen\.frame|screen\.ids|mic\.)/; // dropped first once the log is half full
const REFUSED_RETRY_MS = 5 * 60_000;
const URGENT = /\.(?:error|failed)$/;
let seqBaseLast = 0;
/** Per-boot start of the seq counters of a device trace: the registry hands the same day session to every restart, and (session, source, seq) is its key. */
const nextSeqBase = () => (seqBaseLast = Math.max(Date.now() * 1000, seqBaseLast + 1_000_000)); // < 2^53 until the year 2255
export const LATE_MS = 24 * 3600_000; // a retry queue may deliver events up to a day old
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const SOURCES = new Set(['gateway', 'client', 'screen-agent']);
const TYPE_RE = /^[a-z][a-z0-9_.]{1,47}$/;
const TEXT_KEYS = new Set(['text', 'question', 'transcript']);
// a key like `bytes` names a payload only when the value is one: a number is a size (screen.frame / device.error record theirs)
const BINARY_KEYS = /^(?:audio|pcm|image|img|png|jpe?g|base64|b64|bytes|buffer|crop|context_image|screenshot|data_url|dataurl)$/i;
const RESULT_KEYS = /^(?:result|results|output|content|body)$/i;
const DATA_URI = /data:[\w/+.-]{1,60};base64,/i;
const BASE64_RUN = /[A-Za-z0-9+/_-]{400,}={0,2}/;
// a long run is only taken for base64 when it is varied (upper + lower + digit, many distinct characters): not "xxxx…", not a repeated word
const looksBinary = (s) => { const m = BASE64_RUN.exec(s); return Boolean(m) && /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /\d/.test(m[0]) && new Set(m[0].slice(0, 400)).size >= 24; };

const iso = (ms) => new Date(ms).toISOString();

/** A JSON-safe, bounded, redacted copy of `value`: no binary, no tool results, strings capped, depth capped. */
export function clean(value, key = '', depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (DATA_URI.test(value.slice(0, 200)) || looksBinary(value.slice(0, 4000))) return `[binär ausgelassen, ${value.length} Zeichen]`;
    const max = TEXT_KEYS.has(key) ? MAX_TEXT : MAX_STR;
    const cut = value.length > max ? `${value.slice(0, max)}…` : value;
    return redact(cut);
  }
  if (depth >= 4) return '[zu tief]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, key, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      if (BINARY_KEYS.test(k) && typeof v !== 'number') out[k] = `[ausgelassen${typeof v === 'string' ? `, ${v.length} Zeichen` : ''}]`;
      else if (RESULT_KEYS.test(k)) out[`${k}Chars`] = typeof v === 'string' ? v.length : JSON.stringify(v ?? null).length;
      else out[redact(k).slice(0, 60)] = clean(v, k, depth + 1);
    }
    return out;
  }
  return null;
}

/** Event data: cleaned, tool args capped, and the whole thing at most MAX_EVENT_BYTES. */
export function boundData(data) {
  const src = data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data };
  const out = clean(src);
  if (out.args !== undefined && JSON.stringify(out.args).length > MAX_ARGS) out.args = { truncated: true, preview: JSON.stringify(out.args).slice(0, 400) };
  const size = JSON.stringify(out).length;
  return size <= MAX_EVENT_BYTES ? out : { truncated: true, chars: size, preview: JSON.stringify(out).slice(0, 1000) };
}

function metaOf(data, kind) {
  const entry = data.entry && typeof data.entry === 'object' ? data.entry : {};
  const client = data.client && typeof data.client === 'object' ? data.client : {};
  return {
    kind,
    provider: data.provider ?? null, model: data.model ?? null, slug: data.slug ?? null, title: data.title ?? null,
    page_aid: entry.page_aid ?? (data.slug ? `explainer:${data.slug}` : null), card: entry.card ?? null, element: entry.element ?? null, entry: { path: entry.path ?? null, page_aid: entry.page_aid ?? null, card: entry.card ?? null, element: entry.element ?? null },
    device: client.device ?? null, client: { app: client.app ?? null, version: client.version ?? null, commit: client.commit ?? null },
    screen_ids: Array.isArray(entry.screen_ids) ? entry.screen_ids.slice(0, 20) : [],
  };
}

/** A foreign clock must not decide retention: client timestamps count only within a few minutes of the receive time. */
export function clampTs(ts, at, slackMs = 5 * 60_000) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  return new Date(Number.isFinite(t) && Math.abs(t - at) <= slackMs ? t : at).toISOString();
}

/** A retry-queue timestamp: up to 24 h old it is kept and flagged `late`; anything else (future, older, garbage) is clamped like clampTs. */
export function lateTs(ts, at) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (Number.isFinite(t) && t < at - 5 * 60_000 && t >= at - LATE_MS) return { ts: new Date(t).toISOString(), late: true };
  // older than a day (a weekend's retry queue): stamped now but flagged late with its real time, never shown as a live event
  if (Number.isFinite(t) && t < at - LATE_MS) return { ts: new Date(at).toISOString(), late: true, origTs: new Date(t).toISOString() };
  return { ts: clampTs(ts, at), late: false };
}
/** The Berlin calendar day (YYYY-MM-DD) of `ms`: the registry's device session changes at Berlin midnight, so the gateway's log must too. */
export const berlinDay = (ms) => { const p = berlinParts(ms); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
/** "Geräteprotokoll 3 Nov" for the Berlin day `day` (YYYY-MM-DD). */
export const deviceLogTitle = (day) => `Geräteprotokoll ${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTraceService({ env = process.env, fetchImpl = fetch, now = Date.now, log = (line) => console.log(line), flushMs = 2000, firstFlushMs = FIRST_FLUSH_MS, chatIdleMs = 15 * 60_000 } = {}) {
  const configured = () => Boolean(env.ARTIFACTS_URL && env.ARTIFACTS_DESK_TOKEN);
  const commit = () => env.SOURCE_COMMIT || env.GIT_COMMIT || env.COOLIFY_GIT_COMMIT_SHA || null;
  const open = new Set();
  const bySid = new Map(); // sid -> Set<trace>, newest last (the device route finds a session by sid)
  const waiting = new Map(); // sid -> {events, until}: device events that came before the session
  const chats = new Map(); // conversation key -> {trace, timer}

  async function registry(path, { method = 'GET', body, timeoutMs = 3000 } = {}) {
    if (!configured()) throw Object.assign(new Error('registry not configured'), { status: 503 });
    const res = await fetchImpl(new URL(path, env.ARTIFACTS_URL), {
      method,
      headers: { authorization: `Bearer ${env.ARTIFACTS_DESK_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw Object.assign(new Error(`registry ${res.status}`), { status: res.status });
    const text = await res.text();
    if (text.length > 1_000_000) throw new Error('registry answer too large');
    return text ? JSON.parse(text) : {};
  }

  function bind(sid, trace) {
    if (!sid) return;
    const set = bySid.get(sid) ?? new Set();
    set.add(trace); bySid.set(sid, set);
    const parked = waiting.get(sid);
    if (parked) { waiting.delete(sid); clearTimeout(parked.timer); if (parked.until > now()) trace.external(parked.events, 'screen-agent'); else deviceLog(parked.deviceId, parked.events); }
  }
  function unbind(sid, trace) {
    const set = bySid.get(sid);
    if (!set) return;
    set.delete(trace);
    if (!set.size) bySid.delete(sid);
  }

  function openTrace({ provider = null, kind = 'voice', sid = null } = {}) {
    const t0 = now();
    const seqs = {};
    let buffer = [];
    let recent = [];
    let dropped = 0;
    let foreign = 0;
    let meta = null;
    let aid = null;
    let started = false;
    let closed = false;
    let fellBack = false;
    let refused = false;
    let refusedAt = 0;
    let capNoted = false;
    const cap = kind === 'device' ? DEVICE_CAP : CLIENT_CAP;
    let timer = null;
    let inflight = null;
    let turnNo = 0;
    let sent = 0;
    let fails = 0;
    let total = 0;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    if (!configured()) resolveReady({});

    const seqBase = kind === 'device' ? nextSeqBase() : 0;
    const stamp = (source, type, data, turn, ts) => {
      seqs[source] = (seqs[source] ?? seqBase) + 1;
      return { seq: seqs[source], ts: ts ?? iso(now()), source, turn: Number.isFinite(turn) ? turn : null, type, data: boundData(data) };
    };
    const push = (rec) => {
      total += 1;
      recent.push(rec);
      if (recent.length > RECENT) recent.shift();
      if (!configured()) return; // nothing to ship: only the local ring and the closing stdout line
      buffer.push(rec);
      if (buffer.length > MAX_BUFFER) { const over = buffer.length - MAX_BUFFER; buffer.splice(0, over); dropped += over; }
      if (buffer.length >= 50 && !inflight && !fails) void flush();
      else arm();
    };
    function arm() {
      if (timer || closed) return;
      timer = setTimeout(() => { timer = null; void flush(); }, fails ? Math.min(30_000, flushMs * 2 ** fails) : aid ? flushMs : firstFlushMs);
      timer.unref?.();
    }

    async function ensureSession() {
      if (aid) return aid;
      const body = { ...(meta ?? { kind, provider }), kind, gateway_commit: commit() };
      const res = await registry('/v1/sessions', { method: 'POST', body });
      if (!res?.id) throw new Error('registry returned no id');
      aid = `a#${String(res.id).replace(/^a#/, '')}`;
      resolveReady({ aid });
      return aid;
    }

    /** One flush at a time; resolves true when the buffer is empty (or there is nothing to ship), false on a registry failure. Never rejects. */
    function flush() {
      if (inflight) return inflight.then((ok) => (ok && buffer.length ? flush() : ok)); // a waiter never retries a failed attempt
      if (!configured() || (!buffer.length && aid)) return Promise.resolve(true);
      if (!meta && !closed) { arm(); return Promise.resolve(true); } // session.start not seen yet
      inflight = (async () => {
        try {
          await ensureSession();
          while (buffer.length) {
            if (dropped) { const n = dropped; dropped = 0; buffer.unshift(stamp('gateway', 'trace.dropped', { count: n })); }
            const batch = buffer.slice(0, BATCH);
            const res = await registry(`/v1/sessions/${aid.slice(2)}/events`, { method: 'POST', body: { events: batch }, timeoutMs: 5000 });
            buffer.splice(0, batch.length);
            sent += batch.length;
            // (session, source, seq) already stored: the events were NOT kept. Leave a marker in the trace instead of losing them silently.
            if (res?.duplicates > 0) { buffer.push(stamp('gateway', 'trace.duplicates', { count: res.duplicates, batch: batch.length, accepted: res.accepted ?? null })); log(`trace-duplicates ${JSON.stringify({ kind, aid, count: res.duplicates, batch: batch.length })}`); }
          }
          fails = 0;
          return true;
        } catch (err) {
          // the registry does not know this kind (yet): keep the local audit line, drop the events, stop asking until the next day
          if (kind === 'device' && !aid && err?.status >= 400 && err.status < 500 && ![401, 403, 408, 429].includes(err.status)) { refused = true; refusedAt = now(); buffer = []; closed = true; clearTimeout(timer); timer = null; open.delete(self); fallback(`kind-refused-${err.status}`); return true; }
          fails = Math.min(fails + 1, 5); if (buffer.length || !aid) arm(); return false;
        }
      })().finally(() => { inflight = null; });
      return inflight;
    }

    function fallback(reason) {
      if (fellBack) return;
      fellBack = true;
      const line = { kind, provider, aid, reason, events: total, shipped: sent, unsent: buffer.length, dropped, types: recent.slice(-40).map((r) => `${r.seq}:${r.type}`) };
      try { log(`trace-fallback ${JSON.stringify(clean(line))}`); } catch { /* stdout gone */ }
    }

    const self = {
      /** Synchronous, never throws. */
      event(type, data = {}) {
        try {
          if (closed || !TYPE_RE.test(String(type))) return;
          const { turn, ...rest } = data && typeof data === 'object' ? data : {};
          if (type === 'session.start' && !started) { started = true; meta = { ...metaOf(rest, kind), provider: rest.provider ?? provider, model: rest.model ?? null }; }
          else if (type === 'session.ready' && meta && !meta.model && typeof rest.model === 'string') meta.model = rest.model.slice(0, 100);
          push(stamp('gateway', type, rest, turn));
        } catch { /* the session must not notice */ }
      },
      /** An event the browser sent over the voice socket: {ts,type,data}. */
      client(event) {
        try {
          if (closed || !event || typeof event !== 'object' || foreign >= cap) return;
          let type = String(event.type ?? '');
          if (!type.startsWith('client.')) type = `client.${type}`;
          if (!TYPE_RE.test(type)) return;
          foreign += 1;
          push(stamp('client', type, event.data, event.data?.turn, clampTs(event.ts, now())));
        } catch { /* malformed event: the session must not notice */ }
      },
      /** Events from the Screen Agent (device route): already validated by the caller. */
      external(events, source = 'screen-agent') {
        try {
          if (closed || !SOURCES.has(source)) return;
          const reserve = kind === 'device' ? DEVICE_RESERVE : 0;
          for (const e of events) {
            // the gateway's own events and errors may use the reserve; chatter goes first once the log is half full
            const mine = source === 'gateway' || URGENT.test(e.type);
            if (foreign >= cap - (mine ? 0 : reserve) || (kind === 'device' && !mine && foreign >= cap / 2 && CHATTER.test(e.type))) {
              if (!capNoted && foreign >= cap - (mine ? 0 : reserve)) { capNoted = true; push(stamp('gateway', 'trace.capped', { foreign, cap, reserve })); }
              continue;
            }
            foreign += 1;
            push(stamp(source, e.type, e.data, e.turn, e.ts));
          }
        } catch { /* malformed event: the session must not notice */ }
      },
      flush,
      /** Flushes and ends the trace; the caller need not await it. Never rejects. */
      async close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer); timer = null;
        open.delete(self);
        if (sid) unbind(sid, self);
        let ok = await flush();
        for (let i = 0; !ok && i < 2 && configured(); i += 1) { await sleep(500); ok = await flush(); }
        if (!aid) resolveReady({});
        if (!ok || !configured()) fallback(!configured() ? 'registry-not-configured' : 'registry-unreachable');
      },
      get aid() { return aid; },
      get started() { return started; },
      get closed() { return closed; },
      get refused() { return refused; },
      get refusedAt() { return refusedAt; },
      get kind() { return kind; },
      nextTurn: () => (turnNo += 1),
      ready,
      /** The locally kept timeline (survives a registry outage). */
      recent: () => recent.slice(),
      sid,
      startedAt: t0,
    };
    open.add(self);
    if (sid) bind(sid, self);
    return self;
  }

  /** A text conversation keeps one trace across its requests; it ends after chatIdleMs of silence. */
  function chat(key, opts) {
    if (!key) return openTrace({ ...opts, kind: 'chat' });
    let entry = chats.get(key);
    if (!entry || entry.trace.closed) {
      if (chats.size >= 200) { const [oldKey, old] = chats.entries().next().value; clearTimeout(old.timer); chats.delete(oldKey); void old.trace.close(); }
      entry = { trace: openTrace({ ...opts, kind: 'chat' }), timer: null };
      chats.set(key, entry);
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { chats.delete(key); void entry.trace.close(); }, chatIdleMs);
    entry.timer.unref?.();
    return entry.trace;
  }

  /** Events with no session: one trace of kind "device" per Berlin day and device, created on the first event. */
  const devlogs = new Map(); // "deviceId:YYYY-MM-DD" -> trace
  function deviceLog(deviceId, events, source = 'screen-agent') {
    try {
      if (!deviceId || !events?.length || !SOURCES.has(source)) return false;
      const day = berlinDay(now()), key = `${deviceId}:${day}`;
      for (const [k, t] of devlogs) if (!k.endsWith(`:${day}`)) { devlogs.delete(k); void t.close(); } // yesterday's log ends with the first event of today
      let trace = devlogs.get(key);
      if (!trace) {
        if (devlogs.size >= 100) return false;
        trace = openTrace({ kind: 'device' });
        trace.event('session.start', { title: deviceLogTitle(day), client: { device: deviceId } });
        devlogs.set(key, trace);
      }
      if (trace.refused && now() - trace.refusedAt >= REFUSED_RETRY_MS) { devlogs.delete(key); return deviceLog(deviceId, events, source); } // the registry may have been migrated since
      if (trace.refused || trace.closed) return false;
      trace.external(events.map((e) => (e.late ? { ...e, data: { ...e.data, late: true, ...(e.origTs ? { origTs: e.origTs } : {}) } } : e)), source);
      return true;
    } catch { return false; /* the caller never depends on the log */ }
  }

  /** Device route: events of the Screen Agent for the voice (else chat) session of `sid`; parked for 60 s when there is none yet, then they go to the device log. */
  function attach(sid, events, { deviceId } = {}) {
    const set = bySid.get(sid);
    const traces = set ? [...set] : [];
    const target = [...traces].reverse().find((t) => t.kind === 'voice') ?? traces.at(-1);
    if (target) { target.external(events, 'screen-agent'); return true; }
    for (const [k, v] of waiting) if (v.until <= now()) expireParked(k);
    if (!waiting.has(sid) && waiting.size >= 200) { deviceLog(deviceId, events); return false; }
    const parked = waiting.get(sid) ?? { events: [], until: 0, deviceId };
    const overflow = parked.events.length + events.length - 200;
    if (overflow > 0) deviceLog(parked.deviceId ?? deviceId, [...parked.events, ...events].slice(0, overflow)); // the oldest no longer fit
    parked.events = [...parked.events, ...events].slice(-200);
    parked.until = now() + 60_000;
    parked.deviceId ??= deviceId;
    clearTimeout(parked.timer);
    parked.timer = setTimeout(() => expireParked(sid), 60_500);
    parked.timer.unref?.();
    waiting.set(sid, parked);
    return false;
  }
  function expireParked(sid) {
    const parked = waiting.get(sid);
    if (!parked) return;
    waiting.delete(sid); clearTimeout(parked.timer);
    deviceLog(parked.deviceId, parked.events);
  }

  /** SIGTERM: mark and flush every open trace (a redeploy must not lose them). */
  async function flushAll(timeoutMs = 5000) {
    const traces = [...open];
    for (const t of traces) t.event('session.interrupted', { reason: 'gateway-shutdown' });
    await Promise.race([Promise.all(traces.map((t) => t.flush())), sleep(timeoutMs)]);
    for (const t of traces) if (!t.aid) log(`trace-fallback ${JSON.stringify({ kind: t.kind, reason: 'shutdown-unflushed', events: t.recent().length })}`);
  }

  const idOf = (q) => String(q).replace(/^a#/, '');
  const arr = (r) => (Array.isArray(r) ? r : Array.isArray(r?.events) ? r.events : []);
  return {
    open: openTrace, chat, attach, deviceLog, startOf: (sid) => { const set = bySid.get(sid); return set?.size ? Math.min(...[...set].map((t) => t.startedAt)) : null; },
    flushAll, bind, unbind, registry,
    configured,
    lookup: (q, extra = '') => registry(`/v1/sessions/lookup?q=${encodeURIComponent(q)}${extra}`),
    recent: (query = '') => registry(`/v1/sessions/recent${query}`),
    remote: async (id) => {
      const [trace, diagnosis] = await Promise.all([registry(`/v1/sessions/${idOf(id)}/trace`), registry(`/v1/sessions/${idOf(id)}/diagnosis`)]);
      return { events: arr(trace), diagnosis: diagnosis?.diagnosis ?? diagnosis };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a trace: the timeline lines and the short diagnosis (also used when only the local ring is available).

const brief = (v, n = 80) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
function detail(e) {
  const d = e.data ?? {};
  if (/^transcript\./.test(e.type)) return `"${brief(d.text, 100)}"`;
  if (e.type.startsWith('tool.')) return [d.name, d.ok === false ? 'FEHLER' : '', d.ms !== undefined ? `${d.ms}ms` : '', d.chars !== undefined ? `${d.chars} Zeichen` : '', d.error ? brief(d.error, 80) : '', d.reason ? brief(d.reason, 60) : ''].filter(Boolean).join(' ');
  if (e.type === 'provider.error') return brief(d.message, 100);
  if (e.type.startsWith('watchdog.') || e.type === 'turn.unanswered') return brief(d.reason ?? d.question ?? '', 100);
  if (e.type.startsWith('session.')) return brief([d.reason, d.model, d.provider].filter(Boolean).join(' '), 60);
  const keys = Object.keys(d).slice(0, 4).map((k) => `${k}=${brief(typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k], 30)}`);
  return keys.join(' ');
}

/** The last `n` events as readable lines: "+12.3s t3 gateway tool.done search_files 340ms". */
export function timelineLines(events, n = 40) {
  const list = events.filter((e) => e.type !== 'screen.context.gone').sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || (a.seq ?? 0) - (b.seq ?? 0));
  const t0 = Date.parse(list[0]?.ts);
  return list.slice(-n).map((e) => {
    const dt = Number.isFinite(t0) && Number.isFinite(Date.parse(e.ts)) ? `+${((Date.parse(e.ts) - t0) / 1000).toFixed(1)}s` : '';
    return [dt, e.turn != null ? `t${e.turn}` : '', e.source && e.source !== 'gateway' ? e.source : '', e.type, detail(e)].filter(Boolean).join(' ');
  });
}

/** A short German diagnosis from the events themselves (fallback when the registry has none). */
export function localDiagnosis(events) {
  const count = (re) => events.filter((e) => re.test(e.type)).length;
  const notes = [];
  const unanswered = events.filter((e) => e.type === 'turn.unanswered');
  if (unanswered.length) notes.push(`${unanswered.length} Frage(n) ohne Antwort (${unanswered.map((e) => `Zug ${e.turn ?? '?'}: ${brief(e.data?.reason, 40)}`).slice(0, 3).join('; ')})`);
  if (count(/^watchdog\.no_answer$/)) notes.push(`${count(/^watchdog\.no_answer$/)}x Keine-Antwort-Wächter`);
  // a tool call of a fragment that grew into the next sentence is stale by design (turn.user.grown), no finding
  const stale = events.filter((e) => e.type === 'tool.stale' && e.data?.reason !== 'fragment superseded').length;
  if (stale) notes.push(`${stale} veraltete(s) Werkzeugergebnis(se)`);
  if (count(/^tool\.error$/)) notes.push(`${count(/^tool\.error$/)} Werkzeugfehler`);
  if (count(/^provider\.error$/)) notes.push(`${count(/^provider\.error$/)} Anbieterfehler`);
  if (count(/^mic\.mute$/)) notes.push(`Mikrofon ${count(/^mic\.mute$/)}x stummgeschaltet`);
  if (count(/^trace\.dropped$/)) notes.push('Ereignisse gingen verloren (Puffer voll)');
  return notes.length ? notes.join('. ') : 'Keine Auffälligkeiten im Verlauf.';
}

const diagnosisText = (d) => (typeof d === 'string' ? d : Array.isArray(d) ? d.map(diagnosisText).join('\n') : d && typeof d === 'object' ? (typeof d.what_happened === 'string' ? d.what_happened : typeof d.text === 'string' ? d.text : typeof d.summary === 'string' ? d.summary : JSON.stringify(d)) : '');

// ---- which session did he mean: "letzte", "davor", "10:29", "heute morgen" ----
const TZ = 'Europe/Berlin';
const DAY_MS = 86_400_000;
const berlinParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, +p.value]));
/** Epoch ms of a Berlin wall-clock time (day offset from `ms`'s Berlin date). */
function berlinAt(ms, dayOffset, hour, minute = 0) {
  const p = berlinParts(ms + dayOffset * DAY_MS);
  const guess = Date.UTC(p.year, p.month - 1, p.day, hour, minute);
  const o = berlinParts(guess);
  return guess - (Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute) - guess);
}
export const berlinClock = (ms) => new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).replace(', ', ' ');
const DAYPART = [[/\b(?:morgens?|früh|frueh)\b/i, 4, 12], [/\bvormittags?\b/i, 8, 12], [/\bmittags?\b/i, 11, 15], [/\bnachmittags?\b/i, 12, 18], [/\babends?\b/i, 17, 24], [/\bnachts?\b/i, 0, 6]];

/**
 * What a `which` means. {kind:'last'} for "last"/"previous"/"vorherige"/"davor", {kind:'time', at} for "10:29" / "um 10 Uhr",
 * {kind:'range', from, to} for "heute morgen", "vorhin", "gestern", else {kind:'lookup'} (a#id, hex, slug). Pure; `now` in epoch ms.
 */
export function parseWhich(which, now = Date.now()) {
  const w = String(which ?? '').trim();
  if (/^(?:(?:die|der|meine|eine)\s+)?(?:(?:last|previous|prev|letzte[nrms]?|zuletzt|vorherige[nrms]?|vorige[nrms]?)(?:\s+(?:sitzung|session))?|(?:sitzung\s+)?davor|vor der aktuellen(?: sitzung)?)$/i.test(w)) return { kind: 'last' };
  if (/^(?:a\s?#\s?)?[0-9a-f]{6}$/i.test(w)) return { kind: 'lookup' };
  const clock = /(?:^|\D)([01]?\d|2[0-3])\s*[:.h]\s*([0-5]\d)(?:\D|$)/.exec(w) ?? /\b([01]?\d|2[0-3])\s*uhr\b/i.exec(w);
  if (clock) {
    let at = berlinAt(now, 0, +clock[1], +(clock[2] ?? 0));
    if (at > now + 5 * 60_000 && !/heute/i.test(w)) at -= DAY_MS; // "10:29" said at 09:00 can only mean yesterday
    if (/gestern/i.test(w)) at = berlinAt(now, -1, +clock[1], +(clock[2] ?? 0));
    return { kind: 'time', at };
  }
  if (/\b(?:vorhin|eben|gerade eben|soeben)\b/i.test(w)) return { kind: 'range', from: now - 3 * 3_600_000, to: now };
  const day = /\bvorgestern\b/i.test(w) ? -2 : /\bgestern\b/i.test(w) ? -1 : /\bheute\b|\bletzte nacht\b/i.test(w) || DAYPART.some(([re]) => re.test(w)) ? 0 : null;
  if (day === null) return { kind: 'lookup' };
  const part = DAYPART.find(([re]) => re.test(w));
  const [h0, h1] = part ? [part[1], part[2]] : [0, 24];
  return { kind: 'range', from: berlinAt(now, day, h0), to: Math.min(now, berlinAt(now, day, h1 === 24 ? 23 : h1, h1 === 24 ? 59 : 0)) };
}

const startOf = (s) => Date.parse(s.started_at ?? s.startedAt ?? s.created_at ?? '');
const idOfSession = (s) => `a#${String(s.id ?? '').replace(/^a#/, '')}`;
const candidateLine = (s) => `${idOfSession(s)} ${Number.isFinite(startOf(s)) ? berlinClock(startOf(s)) : '?'}${s.kind ? ` ${s.kind}` : ''}${s.provider ? `/${s.provider}` : ''}${s.title ? ` "${brief(s.title, 60)}"` : ''}`;

/** The sessions the registry lists for a time word, best first; null when the registry has no such list yet (old registry). */
async function findByTime(spec, service, exclude) {
  const list = spec.kind === 'time' ? `?limit=12&around=${encodeURIComponent(new Date(spec.at).toISOString())}` : `?limit=40&before=${encodeURIComponent(new Date(spec.to + 60_000).toISOString())}`;
  let rows;
  try { rows = arr(await service.recent(list)); } catch (err) { if (err.status === 404) return null; throw err; }
  const usable = rows.filter((s) => s?.id && idOfSession(s) !== exclude && (!s.kind || ['voice', 'chat', 'text'].includes(s.kind)) && Number.isFinite(startOf(s)));
  if (spec.kind === 'time') {
    const span = (s) => { const a = startOf(s), b = Date.parse(s.ended_at ?? '') || a; return spec.at >= a && spec.at <= b ? 0 : Math.min(Math.abs(spec.at - a), Math.abs(spec.at - b)); };
    return usable.sort((x, y) => span(x) - span(y));
  }
  const inside = usable.filter((s) => startOf(s) >= spec.from && startOf(s) <= spec.to).sort((x, y) => startOf(y) - startOf(x));
  return inside.length ? inside : usable.sort((x, y) => Math.abs(startOf(x) - spec.to) - Math.abs(startOf(y) - spec.to)).map((s) => Object.assign(s, { outside: true }));
}
const arr = (r) => (Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : Array.isArray(r?.sessions) ? r.sessions : Array.isArray(r?.events) ? r.events : []);

/**
 * The text of the session_trace tool / the lookup route for one session: diagnosis + the last 40 timeline lines.
 * `which`: "current" (the live trace of this conversation, flushed first), "last"/"previous" (the newest OTHER session), "10:29", "heute morgen", "vorhin", "gestern", or an a#id / hex / slug.
 */
export async function describeSession({ which = 'current', service, current, now = Date.now() }) {
  const w = String(which ?? 'current').trim() || 'current';
  let events = [];
  let diagnosis = '';
  let id = null;
  let note = '';
  if (w === 'current') {
    const trace = typeof current === 'function' ? current() : current;
    if (!trace) return 'Keine laufende Sitzung mit Trace. Frage nach "last" oder einer a#-ID.';
    await Promise.race([trace.flush(), sleep(2500)]);
    id = trace.aid;
    events = trace.recent();
    if (id && service) {
      try { const r = await service.remote(id); if (r.events.length) events = r.events; diagnosis = diagnosisText(r.diagnosis); } catch { note = ' (Registry nicht erreichbar: lokaler Verlauf)'; }
    } else if (service?.configured()) note = ' (noch nicht in der Registry: lokaler Verlauf)';
  } else {
    if (!service?.configured()) return 'Die Registry ist nicht eingerichtet; alte Sitzungen sind nicht abrufbar.';
    const running = (typeof current === 'function' ? current() : current)?.aid ?? null; // the session being spoken in is never "the last one"
    const spec = parseWhich(w, now);
    try {
      let found = null, others = [];
      if (spec.kind === 'time' || spec.kind === 'range') {
        const rows = await findByTime(spec, service, running);
        if (rows === null) return 'Die Registry kennt die Suche nach Uhrzeit noch nicht. Nimm "last" oder die a#-ID der Sitzung.';
        if (!rows.length) return `Keine Sitzung zu "${brief(w, 40)}" gefunden.`;
        found = { id: rows[0].id }; others = rows.slice(1, 4);
        note = ` (${rows[0].outside ? 'nichts im genannten Zeitraum, nächste Sitzung' : 'beste Übereinstimmung'}: ${candidateLine(rows[0])}${others.length ? `; weitere: ${others.map(candidateLine).join('; ')}` : ''})`;
      } else if (spec.kind === 'last') {
        found = await service.lookup('last', running ? `&exclude=${encodeURIComponent(running.replace(/^a#/, ''))}` : '');
        if (running && found?.id && idOfSession(found) === running) { // an old registry ignores exclude: take the newest other one from the list
          const rows = (await service.recent('?limit=6').then(arr, () => [])).filter((s) => s?.id && idOfSession(s) !== running && (!s.kind || ['voice', 'chat', 'text'].includes(s.kind)));
          found = rows[0] ? { id: rows[0].id } : null;
          if (!found) return 'Es gibt keine frühere Sitzung außer der laufenden.';
        }
      } else found = await service.lookup(w);
      id = found?.id ? `a#${String(found.id).replace(/^a#/, '')}` : null;
      if (!id) return `Keine Sitzung zu "${brief(w, 40)}" gefunden.`;
      const r = await service.remote(id);
      events = r.events; diagnosis = diagnosisText(r.diagnosis);
    } catch (err) { return err.status === 404 ? `Keine Sitzung zu "${brief(w, 40)}" gefunden.` : 'Die Registry ist gerade nicht erreichbar.'; }
  }
  if (!diagnosis) diagnosis = localDiagnosis(events);
  const lines = timelineLines(events, 40);
  return `Sitzung ${id ?? '(ohne ID)'}${note}\nDiagnose: ${diagnosis}\nVerlauf (letzte ${lines.length} von ${events.length} Ereignissen):\n${lines.join('\n')}`;
}
