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
const SOURCES = new Set(['gateway', 'client', 'screen-agent']);
const TYPE_RE = /^[a-z][a-z0-9_.]{1,47}$/;
const TEXT_KEYS = new Set(['text', 'question', 'transcript']);
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
      if (BINARY_KEYS.test(k)) out[k] = `[ausgelassen${typeof v === 'string' ? `, ${v.length} Zeichen` : ''}]`;
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
    if (parked) { waiting.delete(sid); if (parked.until > now()) trace.external(parked.events, 'screen-agent'); }
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
    let timer = null;
    let inflight = null;
    let turnNo = 0;
    let sent = 0;
    let fails = 0;
    let total = 0;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    if (!configured()) resolveReady({});

    const stamp = (source, type, data, turn, ts) => {
      seqs[source] = (seqs[source] ?? 0) + 1;
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
            await registry(`/v1/sessions/${aid.slice(2)}/events`, { method: 'POST', body: { events: batch }, timeoutMs: 5000 });
            buffer.splice(0, batch.length);
            sent += batch.length;
          }
          fails = 0;
          return true;
        } catch { fails = Math.min(fails + 1, 5); if (buffer.length || !aid) arm(); return false; }
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
          if (closed || !event || typeof event !== 'object' || foreign >= CLIENT_CAP) return;
          let type = String(event.type ?? '');
          if (!type.startsWith('client.')) type = `client.${type}`;
          if (!TYPE_RE.test(type)) return;
          foreign += 1;
          push(stamp('client', type, event.data, event.data?.turn, clampTs(event.ts, now())));
        } catch { /* ignore */ }
      },
      /** Events from the Screen Agent (device route): already validated by the caller. */
      external(events, source = 'screen-agent') {
        try {
          if (closed || !SOURCES.has(source)) return;
          for (const e of events) {
            if (foreign >= CLIENT_CAP) break;
            foreign += 1;
            push(stamp(source, e.type, e.data, e.turn, e.ts));
          }
        } catch { /* ignore */ }
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

  /** Device route: events of the Screen Agent for the voice (else chat) session of `sid`; parked for 60 s when there is none yet. */
  function attach(sid, events) {
    const set = bySid.get(sid);
    const traces = set ? [...set] : [];
    const target = [...traces].reverse().find((t) => t.kind === 'voice') ?? traces.at(-1);
    if (target) { target.external(events, 'screen-agent'); return true; }
    for (const [k, v] of waiting) if (v.until <= now()) waiting.delete(k);
    if (!waiting.has(sid) && waiting.size >= 200) return false;
    const parked = waiting.get(sid) ?? { events: [], until: 0 };
    parked.events = [...parked.events, ...events].slice(-200);
    parked.until = now() + 60_000;
    waiting.set(sid, parked);
    return false;
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
    open: openTrace, chat, attach, flushAll, bind, unbind, registry,
    configured,
    lookup: (q) => registry(`/v1/sessions/lookup?q=${encodeURIComponent(q)}`),
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
  const list = events.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || (a.seq ?? 0) - (b.seq ?? 0));
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

/**
 * The text of the session_trace tool / the lookup route for one session: diagnosis + the last 40 timeline lines.
 * `which`: "current" (the live trace of this conversation, flushed first), "last", or an a#id / hex / slug.
 */
export async function describeSession({ which = 'current', service, current }) {
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
    try {
      const found = await service.lookup(w);
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
