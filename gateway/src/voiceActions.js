// The two voice action tools (output_main_agent_prompt, start_agent_job). They act on Florian's desktop or start a real job with no
// click, and the model that calls them also reads untrusted screen text. So a model call alone is never enough: the tool runs only
// when Florian's OWN WORDS in this session (speech finals and typed turns, never screen/registry/marker text) contain the trigger.
import crypto from 'node:crypto';
import { redact, short } from './redact.js';
import { limits as defaultLimits } from './limits.js';
import { TEXT } from './messages.js';

export const SETTLE_MS = 2500; // no new speech for this long before anything happens
export const SETTLE_MAX_MS = 8000;
const POLL_MS = 100;
const TRIGGER_ENTRIES = 3;
const TRIGGER_AGE_MS = 3 * 60_000;
const PROMPT_DEDUPE_MS = 60_000;
const JOB_DEDUPE_MS = 3 * 60_000;
const JACCARD = 0.6;

// Case-insensitive, tolerant to speech recognition ("Men Agent", "Cloud Code").
const LECHONK = 'sandy|sandi|sendy|lechonk|le[\\s-]?chonk|lechong|le[\\s-]?chong';
export const MAIN_TRIGGER = /\b(?:main[\s-]*agent|men[\s-]?agent|hauptagent|haupt[\s-]agent|stabschef|stabs[\s-]chef|chief[\s-]+of[\s-]+staff)/i;
export const JOB_TRIGGER = new RegExp(`\\b(?:claude|cloud|clod|klaude|clode|klaud)[\\s-]*code|agent(?:en)?[\\s-]*job|\\b(?:job|session|sitzung|agent)\\b.{0,40}\\b(?:${LECHONK})|\\b(?:auf|on)\\s+(?:${LECHONK})`, 'i');
const TRIGGERS = { output_main_agent_prompt: MAIN_TRIGGER, start_agent_job: JOB_TRIGGER };
const SAY = {
  output_main_agent_prompt: '"Main Agent", "Hauptagent" oder "Stabschef"',
  start_agent_job: '"Claude Code" oder "Agent Job auf Sandy/LeChonk"',
};

const defaultClock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (t) => new Set(norm(t).split(' ').filter(Boolean));
export function jaccard(a, b) {
  const x = words(a), y = words(b);
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

const out = (ok, content, extra = {}) => ({ ok, summary: short(content, 200), content: redact(content), ...extra });
const refuse = (ctx, name, reason, content) => {
  ctx.audit?.({ action: 'action.refused', detail: `${name} ${reason}` });
  ctx.trace?.()?.event?.('action.refused', { turn: ctx.voiceTurn?.turn, tool: name, reason });
  return out(false, content);
};

/** Does Florian's own speech (the last 3 entries, none older than 3 minutes) carry the trigger of this tool? */
export function hasTrigger(name, spoken, now = Date.now()) {
  const re = TRIGGERS[name];
  const window = spoken.filter((e) => now - e.at <= TRIGGER_AGE_MS).slice(-TRIGGER_ENTRIES).map((e) => String(e.text ?? ''));
  return window.some((t) => re.test(t)) || re.test(window.join(' ')); // finals arrive in fragments: "Claude" / "Code" may be two entries
}

/**
 * The shared gate. {ok:true, spoken} when the tool may act now, else a ready {ok:false} tool result.
 * Order: voice session -> not a fragment's / an old question's call -> settle (he may still be talking) -> trigger in his words.
 */
async function gate(name, ctx, clock) {
  const vt = ctx.voiceTurn;
  if (!vt) return { refused: refuse(ctx, name, 'no-voice', 'Dieses Werkzeug gibt es nur in einem Sprachgespräch. Es ist nichts passiert.') };
  if (vt.fromFragment || vt.oldChain) return { refused: refuse(ctx, name, vt.fromFragment ? 'fragment' : 'old-chain', 'Nichts passiert: dieser Aufruf gehörte zu einem Satzfetzen oder einer früheren Frage. Rufe das Werkzeug nach Florians Satz erneut auf, wenn es noch gilt.') };
  const epoch = vt.epoch(), t0 = clock.now();
  while (vt.speaking()) {
    if (vt.epoch() !== epoch || clock.now() - t0 >= SETTLE_MAX_MS) break;
    await clock.sleep(POLL_MS);
  }
  if (vt.epoch() !== epoch || vt.speaking()) return { refused: refuse(ctx, name, 'still-speaking', 'Nichts passiert: Florian spricht noch; rufe das Werkzeug nach seinem Satz erneut auf, wenn es noch gilt.') };
  const spoken = vt.spoken();
  if (!hasTrigger(name, spoken, clock.now())) {
    return { refused: refuse(ctx, name, 'no-trigger', `Nichts passiert: Florian hat dafür kein Auslösewort gesagt. Frage ihn in einem kurzen Satz, ob das jetzt passieren soll; sagt er ${SAY[name]}, klappt der nächste Aufruf.`) };
  }
  return { ok: true, spoken, vt };
}

// ---- what was done recently in a session (dedupe); an entry is kept while its action is pending ----
const recent = new Map();
function recall(kind, sid, windowMs, now) {
  const list = (recent.get(`${kind}:${sid}`) ?? []).filter((e) => now - e.at < windowMs);
  recent.set(`${kind}:${sid}`, list);
  return list;
}
const remember = (kind, sid, entry) => { recent.get(`${kind}:${sid}`).push(entry); return entry; };
const forget = (kind, sid, entry) => { const l = recent.get(`${kind}:${sid}`), i = l ? l.indexOf(entry) : -1; if (i >= 0) l.splice(i, 1); };
/** Tests: forget all dedupe state. */
export const resetActions = () => recent.clear();

// ---- output_main_agent_prompt ----
const PROMPT_FAIL = {
  'no-device': 'kein Screen Agent verbunden',
  'no-app': 'der Screen Agent hat nicht reagiert, vielleicht eine alte Version',
  'no-window': 'kein VS-Code-Fenster gefunden',
  'no-foreground': 'VS Code ließ sich nicht in den Vordergrund holen',
  'no-field': 'das Eingabefeld von Claude Code wurde nicht gefunden',
  'wrong-focus': 'der Fokus lag woanders',
  interrupted: 'Florian hat dazwischen etwas anderes gemacht',
  busy: 'der Screen Agent war beschäftigt',
  'no-session': 'keine aktive Sitzung',
  timeout: 'keine Rückmeldung vom Screen Agent, unklar ob etwas getippt wurde',
};

async function mainPrompt({ text }, ctx, clock) {
  const g = await gate('output_main_agent_prompt', ctx, clock);
  if (g.refused) return g.refused;
  const body = String(text ?? '').trim();
  if (!body || body.length > 8000) return out(false, 'Der Text muss 1 bis 8000 Zeichen lang sein. Nichts passiert.');
  const sid = ctx.sid ?? 'desk', now = clock.now();
  const key = norm(body);
  if (recall('prompt', sid, PROMPT_DEDUPE_MS, now).some((e) => e.key === key)) return out(true, 'Der Prompt steht schon im Eingabefeld (schon eingetippt), nichts Neues gesendet. Sag nur einen kurzen Satz.');
  if (!ctx.vision?.command) return out(false, 'Nicht eingetippt (kein Screen Agent verbunden). Sag das Florian in einem Satz.');
  const mine = remember('prompt', sid, { key, at: now });
  const clean = redact(body);
  let res;
  try { res = await ctx.vision.command(sid, { type: 'main-agent-prompt', text: clean }); } catch (err) { res = { delivered: false, code: 'no-app', error: String(err?.message ?? err) }; }
  const typed = res.delivered && res.state === 'done' && (res.code === 'typed' || res.code === 'typed-unverified');
  if (!typed) forget('prompt', sid, mine); // a failed attempt may be repeated
  const code = res.code ?? 'no-app';
  const aid = ctx.trace?.()?.aid;
  ctx.trace?.()?.event?.('action.main_prompt', { turn: ctx.voiceTurn.turn, id: res.id, chars: body.length, code, delivered: Boolean(res.delivered), landed: res.landed ?? null });
  ctx.audit?.({ action: 'action.main_prompt', detail: `${aid ?? 'a#?'} chars=${body.length} code=${code} delivered=${Boolean(res.delivered)}` });
  if (typed) {
    return out(true, code === 'typed'
      ? 'Der Prompt steht im Eingabefeld, nicht abgeschickt. Sag nur einen kurzen Satz.'
      : 'Der Prompt wurde ins Eingabefeld getippt, ließ sich aber nicht zurücklesen; Florian soll kurz nachsehen. Nicht abgeschickt. Sag nur einen kurzen Satz.');
  }
  const why = PROMPT_FAIL[code] ?? 'unbekannter Fehler';
  const appShows = res.delivered && code !== 'timeout';
  // the app cannot show the text (none connected / too old / silent): the desk page does, with a copy button
  return out(false, `Nicht eingetippt (${why}). ${appShows ? 'Der Screen Agent zeigt den Text selbst mit Kopieren-Knopf. ' : 'Der Text steht Florian im Desk zum Kopieren bereit. '}Sag das Florian in einem Satz.`, appShows ? {} : { event: { type: 'main_agent_prompt', text: clean } });
}

// ---- start_agent_job ----
const CARD_WORD = { sent: 'gesendet', queued: 'unterwegs', pending: 'unterwegs', 'not-sent': 'nicht gesendet' };

async function agentJob({ title, prompt, host }, ctx, clock) {
  const g = await gate('start_agent_job', ctx, clock);
  if (g.refused) return g.refused;
  const t = String(title ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const p = String(prompt ?? '').trim();
  if (!t || !p) return out(false, 'Titel und Auftrag dürfen nicht leer sein. Nichts gestartet.');
  const sid = ctx.sid ?? 'desk', now = clock.now();
  const twin = recall('job', sid, JOB_DEDUPE_MS, now).find((e) => norm(e.title) === norm(t) || jaccard(e.prompt, p) >= JACCARD);
  if (twin) {
    ctx.trace?.()?.event?.('action.agent_job', { turn: g.vt.turn, id: twin.requestId, name: twin.name ?? null, host: twin.host, card: twin.card ?? null, duplicate: true });
    return out(true, `Der Job läuft schon${twin.name ? ` (${twin.name})` : ' (wird gerade gestartet)'}; kein zweiter gestartet. Korrekturen schickt Florian per Antwort auf die Telegram-Karte. Sag nur einen kurzen Satz.`);
  }
  const verdict = (ctx.limits ?? defaultLimits).check(sid, 'agentJob');
  if (!verdict.ok) return refuse(ctx, 'start_agent_job', 'limit', `Nichts gestartet: ${verdict.reason}. Sag das Florian in einem Satz.`);
  if (!ctx.hub?.call) return out(false, 'Nichts gestartet: keine Verbindung zur Werkstatt. Sag das Florian in einem Satz.');
  const requestId = crypto.randomUUID();
  const entry = remember('job', sid, { title: t, prompt: p, requestId, host: host ?? 'auto', at: now });
  const traced = ctx.trace?.();
  const aid = /^a#[0-9a-f]{6}$/.test(traced?.aid ?? '') ? traced.aid : undefined;
  let res;
  try {
    res = await ctx.hub.call('job.start', { requestId, title: t, prompt: p, spoken: g.spoken.slice(-6).map((e) => String(e.text).slice(0, 2000)), host: host ?? 'auto', ...(aid ? { aid } : {}), provider: /^[a-z0-9]{1,16}$/i.test(g.vt.provider ?? '') ? g.vt.provider : undefined }, { host: 'sandy' });
  } catch (err) {
    const msg = String(err?.message ?? err);
    const unclear = msg === TEXT.bridgeSlow; // the job may well have started
    if (!unclear) forget('job', sid, entry);
    ctx.audit?.({ action: 'action.agent_job', detail: `${aid ?? 'a#?'} title=${t} failed: ${msg.slice(0, 80)}` });
    traced?.event?.('action.agent_job', { turn: g.vt.turn, id: requestId, name: null, host: host ?? 'auto', card: null, duplicate: false, failed: true });
    if (unclear) return out(false, 'Unklar, ob der Job gestartet wurde (die Werkstatt hat nicht rechtzeitig geantwortet). Starte nicht nochmal; sag Florian in einem Satz, er soll auf die Telegram-Karte achten.');
    return out(false, `Der Job wurde nicht gestartet (${/^limit$/.test(msg) ? 'Tageslimit der Werkstatt erreicht' : /offline|getrennt/.test(msg) ? 'die Werkstatt auf Sandy ist offline' : short(msg, 80)}). Sag das Florian in einem Satz.`);
  }
  const name = typeof res?.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(res.name) ? res.name : null;
  if (!name) { forget('job', sid, entry); return out(false, 'Der Job wurde nicht bestätigt. Sag das Florian in einem Satz.'); }
  entry.name = name; entry.card = res.card;
  ctx.audit?.({ action: 'action.agent_job', detail: `${aid ?? 'a#?'} ${name} title=${t} host=${res.host ?? host ?? 'auto'} card=${res.card ?? '-'}` });
  traced?.event?.('action.agent_job', { turn: g.vt.turn, id: requestId, name, host: res.host ?? host ?? 'auto', card: res.card ?? null, duplicate: false });
  return out(true, `Job ${name} läuft. Karte: ${CARD_WORD[res.card] ?? 'unterwegs'}. Sag nur einen kurzen Satz.`);
}

export async function runVoiceAction(name, args, ctx, clock = ctx.clock ?? defaultClock) {
  return name === 'output_main_agent_prompt' ? mainPrompt(args, ctx, clock) : agentJob(args, ctx, clock);
}
