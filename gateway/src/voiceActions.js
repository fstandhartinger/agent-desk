// The two voice action tools (output_main_agent_prompt, start_agent_job). They act on Florian's desktop or start a real job with no
// click, and the model that calls them also reads untrusted screen text. So a model call alone is never enough: the tool runs only
// when Florian's OWN WORDS in this session (speech finals and typed turns, never screen/registry/marker text) contain the trigger.
// The trigger words are checked first; when they miss, a small model judges his intent in the same words (intentTrigger.js).
import crypto from 'node:crypto';
import { classifyIntent, intentEnabled, intentText, INTENT_KEY } from './intentTrigger.js';
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

// Case-insensitive, tolerant to speech recognition ("Mein Agent", "Cloud Code", "Clawd Code").
const SERVER = 'sandy|sandi|sendy|lechonk|le[\\s-]?chonk|lechong|le[\\s-]?chong';
const CODE = '(?:claude|claud|clawd|clawed|cloud|clod|klaude|clode|klaud|kloud|klod|klaut)[\\s-]*code';
const VSCODE = `\\b${CODE}\\b.{0,40}\\b(?:vs[\\s-]?code|visual[\\s-]studio)`; // his words: that session is the main agent, not a job
export const MAIN_TRIGGER = new RegExp(`\\b(?:main[\\s-]*agent|m[eä]i?n[\\s-]?agent|men[\\s-]?agent|haupt[\\s-]?agen[td]|stabs[\\s-]?chef|chief[\\s-]+of[\\s-]+staff)|${VSCODE}`, 'i');
const START = '(?:start|starte\\w*|los|leg\\w*|schick\\w*|lass\\w*|mach\\w*|erledig\\w*|bau\\w*|run|kick\\w*|stell\\w*)';
// A job word that is more than "Claude Code": an agent job, or a start said together with a server. "Die Session läuft auf Sandy" is not one.
const JOB_STRONG = new RegExp(`\\bagent(?:en)?[\\s-]*j[oa]b|\\b${START}\\b.{0,80}\\b(?:auf|on)\\s+(?:${SERVER})\\b|\\b(?:auf|on)\\s+(?:${SERVER})\\b.{0,80}\\b${START}\\b`, 'i');
export const JOB_TRIGGER = new RegExp(`\\b${CODE}\\b|${JOB_STRONG.source}`, 'i');
// A question about the product is no order. "Kannst du das mit Claude Code machen?" is an order, so "kann" is not in the list.
export const ABOUT = /^\s*(?:und\s+)?(?:was|wie|warum|wieso|weshalb|wann|wer|welche\w*|woher|erklär\w*|erzähl\w*)\b/i;

const TRIGGERS = { output_main_agent_prompt: MAIN_TRIGGER, start_agent_job: JOB_TRIGGER };

export const defaultClock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (t) => new Set(norm(t).split(' ').filter(Boolean));
export function jaccard(a, b) {
  const x = words(a), y = words(b);
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

// ---- the session stamp: the agent that receives a prompt learns which desk session it came from (a#624670: neither prompt named it) ----
const AID = /^a#[0-9a-f]{6}$/;
const STAMP_MS = 2000;
const previousOf = new Map(); // current a# -> previous a# (null = none): one registry lookup per session
const within = (promise, ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms, null); t.unref?.(); Promise.resolve(promise).then(resolve, () => resolve(null)).finally(() => clearTimeout(t)); });
/** `[Desk: diese Sitzung a#x, vorherige a#y; Protokoll: desk-trace a#x]`, or '' while the session has no id yet. Never throws, waits at most ~4 s. */
export async function deskStamp(ctx) {
  const trace = ctx.trace?.();
  if (!trace) return '';
  if (!AID.test(trace.aid ?? '') && trace.ready) await within(trace.ready, STAMP_MS);
  const aid = trace.aid;
  if (!AID.test(aid ?? '')) return '';
  if (!previousOf.has(aid) && ctx.traces?.configured?.()) {
    const found = await within(ctx.traces.lookup('last', `&exclude=${aid.slice(2)}`), STAMP_MS);
    const prev = found?.id ? `a#${String(found.id).replace(/^a#/, '')}` : null;
    if (found) {
      if (previousOf.size >= 50) previousOf.delete(previousOf.keys().next().value);
      previousOf.set(aid, prev && prev !== aid && AID.test(prev) ? prev : null);
    }
  }
  const prev = previousOf.get(aid);
  return `[Desk: diese Sitzung ${aid}${prev ? `, vorherige ${prev}` : ''}; Protokoll: desk-trace ${aid}]`;
}
// first, not last: the app cuts a prompt at 8000 characters and must never cut exactly the stamp
const stamped = (text, stamp) => (stamp ? `${stamp}\n${text}` : text);

const out = (ok, content, extra = {}) => ({ ok, summary: short(content, 200), content: redact(content), ...extra });
const refuse = (ctx, name, reason, content) => {
  ctx.audit?.({ action: 'action.refused', detail: `${name} ${reason}` });
  ctx.trace?.()?.event?.('action.refused', { turn: ctx.voiceTurn?.turn, tool: name, reason });
  return out(false, content);
};

const YES = /^\s*(?:ja|jep|genau|ok(?:ay)?|mach(?:\s+das)?|bitte|los|yes|start(?:e)?(?:\s+\w+)?)[\s.!,]*(?:bitte|gerne|mach das)?[\s.!]*$/i;
const usable = (e, name, now) => now - e.at <= TRIGGER_AGE_MS && !e.echo && !e.used?.[name];

/**
 * The words the tool may act on: his latest sentence plus what he said before it with no answer in between (finals arrive in fragments),
 * and after a bare "ja" the sentence before it. An older mention ("was ist Claude Code?", answered) never counts, so a model that read
 * hostile screen text cannot use it. A word opens one action: used entries are marked by the gate.
 */
export function triggerWindow(name, spoken, now = Date.now()) {
  const out = [];
  for (let i = spoken.length - 1; i >= 0 && out.length < TRIGGER_ENTRIES; i -= 1) {
    const e = spoken[i];
    if (!usable(e, name, now)) break;
    if (out.length && e.answered && !YES.test(String(out[0].text ?? ''))) break;
    out.unshift(e);
  }
  return out;
}

/** Does Florian's own speech carry the trigger of this tool, as an order? {ok, entries} or {ok:false, why}. */
export function checkTrigger(name, spoken, now = Date.now()) {
  const entries = triggerWindow(name, spoken, now);
  const text = entries.map((e) => String(e.text ?? '')).join(' ');
  if (!TRIGGERS[name].test(text)) return { ok: false, why: spoken.at(-1)?.used?.[name] ? 'used' : 'no-trigger' };
  if (name === 'start_agent_job') {
    if (MAIN_TRIGGER.test(text) && !JOB_STRONG.test(text)) return { ok: false, why: 'means-main-agent' };
    const carrying = entries.map((e) => String(e.text ?? '')).filter((t) => JOB_TRIGGER.test(t));
    if (!JOB_STRONG.test(text) && (carrying.length ? carrying.every((t) => ABOUT.test(t)) : ABOUT.test(text))) return { ok: false, why: 'question' };
  }
  return { ok: true, entries };
}
export const hasTrigger = (name, spoken, now) => checkTrigger(name, spoken, now).ok;

// ---- intent fallback (Florian 10 Nov, a#41ec11: "es muss nur meine Intention erkannt werden") ----
// The hard words come first and stay instant. Only these refusals ask the model; 'used' (a word opens one action) never does.
const SOFT = new Set(['no-trigger', 'means-main-agent', 'question']);
const classifierOf = (ctx) => (ctx.askIntent ? (text) => classifyIntent(text, { ask: ctx.askIntent }) : intentEnabled() ? classifyIntent : null);
/** {hard, entries, text} when the hard rule refused softly and the window holds his words to judge, else {hard}. */
function intentCase(name, spoken, now) {
  const hard = checkTrigger(name, spoken, now);
  if (hard.ok || !SOFT.has(hard.why) || !INTENT_KEY[name]) return { hard };
  const entries = triggerWindow(name, spoken, now);
  // the assistant's question as context for a bare "ja" only where nothing runs unseen: the Main-Agent prompt is typed, not sent. A job needs his own words (critic SHOULD 3).
  const text = entries.length ? intentText(entries, (t) => YES.test(t), { withQuestion: name === 'output_main_agent_prompt' }) : '';
  return text ? { hard, entries, text } : { hard };
}
/** Start the model call while he settles (the gate waits ~2.5 s anyway); the check after the settle reuses it when the words did not change. */
export function prefetchIntent(name, spoken, now, ctx = {}) {
  const c = intentCase(name, spoken, now), classify = classifierOf(ctx);
  if (c.text && classify) classify(c.text).catch(() => /* failed: the check after the settle will try again */ null);
}
/** The hard rule, then his intent: {ok:true, entries, intent?} or the hard rule's refusal. Never throws. */
export async function checkTriggerOrIntent(name, spoken, now, ctx = {}) {
  const c = intentCase(name, spoken, now), classify = classifierOf(ctx);
  if (!c.text || !classify) return c.hard;
  const t0 = Date.now();
  const verdict = await classify(c.text).catch(() => /* failed: fail closed, traced below as verdict none */ null);
  const yes = verdict?.[INTENT_KEY[name]] === true;
  ctx.trace?.()?.event?.('action.intent', { turn: ctx.voiceTurn?.turn, tool: name, hard: c.hard.why, verdict: verdict ? (yes ? 'yes' : 'no') : 'none', ms: Date.now() - t0 });
  ctx.audit?.({ action: 'action.intent', detail: `${name} hard=${c.hard.why} verdict=${verdict ? (yes ? 'yes' : 'no') : 'none'}` });
  return yes ? { ok: true, entries: c.entries, intent: true } : c.hard;
}
export const release = (g, name) => { for (const e of g.entries ?? []) if (e.used) delete e.used[name]; };

/**
 * The shared gate. {ok:true, spoken} when the tool may act now, else a ready {ok:false} tool result.
 * Order: voice session -> not a fragment's / an old question's call -> settle (he may still be talking) -> trigger in his words.
 */
export async function gate(name, ctx, clock, check = null, extraSay = {}, { settleMs } = {}) {
  const raw = ctx.voiceTurn;
  const intentful = !check && Boolean(INTENT_KEY[name]); // the two voice actions; computer_task keeps its own stricter check
  check ??= (spoken, now) => (INTENT_KEY[name] ? checkTriggerOrIntent(name, spoken, now, ctx) : checkTrigger(name, spoken, now));
  // settleMs (computer_task in the unrestricted mode): he watches and a longer sentence extends the run, so the start waits only this long after his last sound instead of SETTLE_MS (trace a#ba7990: 2.5 s before anything moved)
  const vt = raw && settleMs != null && raw.sinceSpeech ? { ...raw, speaking: () => raw.sinceSpeech() < settleMs } : raw;
  if (!vt) return { refused: refuse(ctx, name, 'no-voice', 'Dieses Werkzeug gibt es nur in einem Sprachgespräch. Es ist nichts passiert.') };
  if (vt.fromFragment || vt.oldChain) return { refused: refuse(ctx, name, vt.fromFragment ? 'fragment' : 'old-chain', 'Nichts passiert: dieser Aufruf gehörte zu einem Satzfetzen oder einer früheren Frage. Rufe das Werkzeug nach Florians Satz erneut auf, wenn es noch gilt.') };
  const prefetch = () => { if (intentful) prefetchIntent(name, vt.spoken(), clock.now(), ctx); };
  if (!vt.awaitingFinal?.()) prefetch(); // xAI: while the final of this call is due, the window lacks the sentence (critic: one wasted call)
  let epoch = vt.epoch();
  const t0 = clock.now();
  const heard = () => vt.spoken().at(-1)?.at; // a sentence that grows while we wait keeps the epoch but makes the task out of date
  let before = heard();
  // xAI can call a tool before the transcript of the same sentence arrives: that first final belongs to this call
  let finalDue = Boolean(vt.awaitingFinal?.());
  while (vt.speaking() || vt.awaitingFinal?.()) {
    if (finalDue && !vt.awaitingFinal()) { finalDue = false; epoch = vt.epoch(); before = heard(); prefetch(); continue; }
    if (vt.epoch() !== epoch && !finalDue) break;
    if (heard() !== before && !finalDue) break;
    if (clock.now() - t0 >= SETTLE_MAX_MS) break;
    await clock.sleep(POLL_MS);
  }
  if (finalDue && !vt.awaitingFinal?.()) { finalDue = false; epoch = vt.epoch(); before = heard(); prefetch(); }
  if (vt.epoch() !== epoch || heard() !== before || vt.speaking() || vt.awaitingFinal?.()) return { refused: refuse(ctx, name, 'still-speaking', 'Nichts passiert: Florian spricht noch; rufe das Werkzeug nach seinem Satz erneut auf, wenn es noch gilt.') };
  const spoken = vt.spoken();
  const verdict = await check(spoken, clock.now());
  // the check may have waited for the intent model: a new sound in that time ("nein, warte") wins, even before its transcript (critic MUST 2)
  if (vt.epoch() !== epoch || heard() !== before || vt.speaking() || vt.awaitingFinal?.()) return { refused: refuse(ctx, name, 'still-speaking', 'Nichts passiert: Florian spricht noch; rufe das Werkzeug nach seinem Satz erneut auf, wenn es noch gilt.') };
  // and a second call of the same tool on the same sentence waited too: the first one that resumes marks the words, the other is refused (critic MUST 1)
  if (verdict.ok && verdict.entries?.some((e) => e.used?.[name])) return { refused: refuse(ctx, name, 'used', 'Für diesen Satz ist das schon passiert; kein zweites Mal. Sag nur einen kurzen Satz.') };
  if (!verdict.ok) {
    const say = {
      'no-trigger': 'Nichts passiert: das hat Florian in seinem letzten Satz nicht so gesagt. Frage ihn in einem kurzen Satz, ob das jetzt passieren soll, ohne den Werkzeugnamen zu nennen; erst sein eigener Satz löst es aus.',
      'means-main-agent': 'Nichts gestartet: Florian meint seinen Main Agent, die Claude-Code-Sitzung in VS Code. Rufe stattdessen output_main_agent_prompt auf.',
      used: 'Für diesen Satz ist das schon passiert; kein zweites Mal. Sag nur einen kurzen Satz.',
      question: 'Nichts gestartet: das war eine Frage über Claude Code, kein Auftrag. Beantworte sie.',
    };
    return { refused: refuse(ctx, name, verdict.why, extraSay[verdict.why] ?? say[verdict.why] ?? 'Nichts passiert.') };
  }
  for (const e of verdict.entries) e.used = { ...e.used, [name]: true };
  return { ok: true, spoken, vt, entries: verdict.entries, text: verdict.text };
}

// ---- what was done recently in a session (dedupe); an entry is kept while its action is pending ----
const recent = new Map();
function recall(kind, sid, windowMs, now) {
  const list = (recent.get(`${kind}:${sid}`) ?? []).filter((e) => now - e.at < windowMs);
  recent.set(`${kind}:${sid}`, list);
  return list;
}
// nothing of a finished session stays in memory (the entries hold prompt text)
const sweep = (now) => { for (const [k, l] of recent) if (!l.some((e) => now - e.at < JOB_DEDUPE_MS)) recent.delete(k); };
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

// During a computer run and for 5 minutes after it, these two tools would need the app's confirm (code on the overlay). That confirm exists only for
// computer actions, so here they stay closed: text the loop could have influenced must not reach a prompt box or start a job unconfirmed.
const guardedOut = (g, ctx, name) => { release(g, name); return refuse(ctx, name, 'computer-guard', 'Nichts passiert: während einer Computer-Steuerung und fünf Minuten danach sind Prompts an den Main Agent und neue Jobs gesperrt. Sag Florian in einem Satz, dass er es danach noch einmal sagen kann.'); };

async function mainPrompt({ text }, ctx, clock) {
  const g = await gate('output_main_agent_prompt', ctx, clock);
  if (g.refused) return g.refused;
  if (ctx.computer?.guarded?.(ctx.sid ?? 'desk')) return guardedOut(g, ctx, 'output_main_agent_prompt');
  const body = String(text ?? '').trim();
  if (!body || body.length > 8000) return release(g, 'output_main_agent_prompt'), out(false, 'Der Text muss 1 bis 8000 Zeichen lang sein. Nichts passiert.');
  const sid = ctx.sid ?? 'desk', now = clock.now();
  const key = norm(body);
  sweep(now);
  if (recall('prompt', sid, PROMPT_DEDUPE_MS, now).some((e) => e.key === key)) return release(g, 'output_main_agent_prompt'), out(true, 'Der Prompt steht schon im Eingabefeld (schon eingetippt), nichts Neues gesendet. Sag nur einen kurzen Satz.');
  if (!ctx.vision?.command) return release(g, 'output_main_agent_prompt'), out(false, 'Nicht eingetippt (kein Screen Agent verbunden). Sag das Florian in einem Satz.');
  const mine = remember('prompt', sid, { key, at: now });
  const clean = stamped(redact(body), await deskStamp(ctx)); // the stamp is no part of the 8000 characters nor of the duplicate check
  let res;
  try { res = await ctx.vision.command(sid, { type: 'main-agent-prompt', text: clean }); } catch (err) { res = { delivered: false, code: 'no-app', error: String(err?.message ?? err) }; }
  const typed = res.delivered && res.state === 'done' && (res.code === 'typed' || res.code === 'typed-unverified');
  const unclear = res.code === 'timeout'; // it may have landed: typing it again could double it
  if (!typed && !unclear) { forget('prompt', sid, mine); release(g, 'output_main_agent_prompt'); } // a failed attempt may be repeated
  const code = res.code ?? 'no-app';
  const aid = ctx.trace?.()?.aid;
  ctx.trace?.()?.event?.('action.main_prompt', { turn: ctx.voiceTurn.turn, id: res.id, chars: body.length, code, delivered: Boolean(res.delivered), landed: res.landed ?? null });
  ctx.audit?.({ action: 'action.main_prompt', detail: `${aid ?? 'a#?'} chars=${body.length} code=${code} delivered=${Boolean(res.delivered)}` });
  if (typed) {
    return out(true, code === 'typed'
      ? 'Der Prompt steht im Eingabefeld, nicht abgeschickt. Sag nur einen kurzen Satz.'
      : 'Der Prompt wurde ins Eingabefeld getippt, ließ sich aber nicht zurücklesen; Florian soll kurz nachsehen. Nicht abgeschickt. Sag nur einen kurzen Satz.');
  }
  if (unclear) return out(false, 'Unklar, ob der Prompt angekommen ist (keine Rückmeldung vom Screen Agent). Tippe ihn NICHT nochmal; sag Florian in einem Satz, er soll ins Eingabefeld schauen.');
  const why = PROMPT_FAIL[code] ?? 'unbekannter Fehler';
  const appShows = Boolean(res.delivered);
  // the app cannot show the text (none connected / too old / silent): the desk page does, with a copy button
  return out(false, `Nicht eingetippt (${why}). ${appShows ? 'Der Screen Agent zeigt den Text selbst mit Kopieren-Knopf. ' : 'Der Text steht Florian im Desk zum Kopieren bereit. '}Sag das Florian in einem Satz.`, appShows ? {} : { event: { type: 'main_agent_prompt', text: clean } });
}

// ---- start_agent_job ----
// a bare "ja" to the assistant's question never starts a job, so asking for one would loop (a#41ec11 t10/t11): ask for his own sentence
const JOB_NO_TRIGGER = 'Nichts passiert: aus Florians eigenen Worten geht nicht hervor, dass jetzt ein Agent im Hintergrund etwas erledigen soll. Frag ihn in einem kurzen Satz, ob und was im Hintergrund laufen soll; ein bloßes Ja startet keinen Job, sein eigener Satz schon.';
const CARD_WORD = { sent: 'gesendet', queued: 'unterwegs', pending: 'unterwegs', 'not-sent': 'nicht gesendet' };

async function agentJob({ title, prompt, host }, ctx, clock) {
  const g = await gate('start_agent_job', ctx, clock, null, { 'no-trigger': JOB_NO_TRIGGER });
  if (g.refused) return g.refused;
  if (ctx.computer?.guarded?.(ctx.sid ?? 'desk')) return guardedOut(g, ctx, 'start_agent_job');
  const t = String(title ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const p = String(prompt ?? '').trim();
  if (!t || !p) return release(g, 'start_agent_job'), out(false, 'Titel und Auftrag dürfen nicht leer sein. Nichts gestartet.');
  const stampedPrompt = stamped(p, await deskStamp(ctx)); // the only await before the checks below: nothing can change between the limit check and job.start
  const sid = ctx.sid ?? 'desk', now = clock.now();
  sweep(now);
  // the same title alone does not make a twin: "Check disk" two minutes later can be a different task
  const twin = recall('job', sid, JOB_DEDUPE_MS, now).find((e) => jaccard(e.prompt, p) >= JACCARD || (norm(e.title) === norm(t) && jaccard(e.prompt, p) >= 0.3));
  if (twin) {
    ctx.trace?.()?.event?.('action.agent_job', { turn: g.vt.turn, id: twin.requestId, name: twin.name ?? null, host: twin.host, card: twin.card ?? null, duplicate: true });
    return out(true, `Der Job läuft schon${twin.name ? ` (${twin.name})` : ' (wird gerade gestartet)'}; kein zweiter gestartet. Korrekturen schickt Florian per Antwort auf die Telegram-Karte. Sag nur einen kurzen Satz.`);
  }
  if (!ctx.hub?.call) return release(g, 'start_agent_job'), out(false, 'Nichts gestartet: keine Verbindung zur Werkstatt. Sag das Florian in einem Satz.');
  const verdict = (ctx.limits ?? defaultLimits).check(sid, 'agentJob');
  if (!verdict.ok) return release(g, 'start_agent_job'), refuse(ctx, 'start_agent_job', 'limit', `Nichts gestartet: ${verdict.reason}. Sag das Florian in einem Satz.`);
  const requestId = crypto.randomUUID();
  const entry = remember('job', sid, { title: t, prompt: p, requestId, host: host ?? 'auto', at: now });
  const traced = ctx.trace?.();
  const aid = /^a#[0-9a-f]{6}$/.test(traced?.aid ?? '') ? traced.aid : undefined;
  let res;
  try {
    res = await ctx.hub.call('job.start', { requestId, title: t, prompt: stampedPrompt, spoken: g.spoken.slice(-6).map((e) => String(e.text).slice(0, 2000)), host: host ?? 'auto', ...(aid ? { aid } : {}), provider: /^[a-z0-9]{1,16}$/i.test(g.vt.provider ?? '') ? g.vt.provider : undefined }, { host: 'sandy' });
  } catch (err) {
    const msg = String(err?.message ?? err);
    const unclear = msg === TEXT.bridgeSlow || msg === 'unclear'; // the job may well have started
    if (!unclear) { forget('job', sid, entry); release(g, 'start_agent_job'); }
    ctx.audit?.({ action: 'action.agent_job', detail: `${aid ?? 'a#?'} title=${t} failed: ${msg.slice(0, 80)}` });
    traced?.event?.('action.agent_job', { turn: g.vt.turn, id: requestId, name: null, host: host ?? 'auto', card: null, duplicate: false, failed: true });
    if (unclear) return out(false, 'Unklar, ob der Job gestartet wurde (die Werkstatt hat nicht rechtzeitig geantwortet). Starte nicht nochmal; sag Florian in einem Satz, er soll auf die Telegram-Karte achten.');
    return out(false, `Der Job wurde nicht gestartet (${/^limit$/.test(msg) ? 'Stunden- oder Tageslimit der Werkstatt erreicht' : /offline|getrennt/.test(msg) ? 'die Werkstatt auf Sandy ist offline' : /unknown method/.test(msg) ? 'die Sandy-Werkstatt kennt das Werkzeug noch nicht' : 'die Werkstatt hat den Start abgelehnt'}). Sag das Florian in einem Satz.`);
  }
  const name = typeof res?.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(res.name) ? res.name : null;
  if (!name) { forget('job', sid, entry); release(g, 'start_agent_job'); return out(false, 'Der Job wurde nicht bestätigt. Sag das Florian in einem Satz.'); }
  entry.name = name; entry.card = res.card;
  ctx.audit?.({ action: 'action.agent_job', detail: `${aid ?? 'a#?'} ${name} title=${t} host=${res.host ?? host ?? 'auto'} card=${res.card ?? '-'}` });
  traced?.event?.('action.agent_job', { turn: g.vt.turn, id: requestId, name, host: res.host ?? host ?? 'auto', card: res.card ?? null, duplicate: false });
  return out(true, `Job ${name} läuft. Karte: ${CARD_WORD[res.card] ?? 'unterwegs'}. Sag nur einen kurzen Satz.`);
}

export async function runVoiceAction(name, args, ctx, clock = ctx.clock ?? defaultClock) {
  return name === 'output_main_agent_prompt' ? mainPrompt(args, ctx, clock) : agentJob(args, ctx, clock);
}
