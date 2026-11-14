// The two voice action tools (output_main_agent_prompt, start_agent_job). They act on Florian's desktop or start a real job with no
// click, and the model that calls them also reads untrusted screen text. So a model call alone is never enough: the tool runs only
// when Florian's OWN WORDS in this session (speech finals and typed turns, never screen/registry/marker text) give the order.
// Main-Agent prompt: the trigger words are checked first; when they miss, a small model judges his intent in the same words (intentTrigger.js).
// start_agent_job (Florian 14 Nov 2026, board #60911: "nicht an ein Auslösewort binden, es soll einfach aus meiner Intention des Gesprochenen
// abgeleitet werden"): NO trigger word. The intent judge reads his own words (and, as labelled context, the Desk's closing sentences) and decides
// every call; the old hard words only keep the service alive while the judge is down (hardOrder).
import crypto from 'node:crypto';
import { classifyIntent, intentEnabled, intentText, lastQuestion, INTENT_KEY } from './intentTrigger.js';
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
const usable = (e, name, now) => now - e.at <= TRIGGER_AGE_MS && (!e.echo || e.echoShort) && !e.used?.[name]; // echoShort: a 1-2 word answer after a long reply (session.js) counts for the two voice actions only, never for computer control

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
// Main-Agent prompt: the hard words come first and stay instant. Only these refusals ask the model; 'used' (a word opens one action) never does. start_agent_job: no hard words, see jobIntent.
const SOFT = new Set(['no-trigger', 'means-main-agent', 'question']);
const classifierOf = (ctx) => (ctx.askIntent ? (text) => classifyIntent(text, { ask: ctx.askIntent }) : intentEnabled() ? classifyIntent : null);

// a#41d6d2 (14 Nov, Grok Voice): "Soll ich einen Agenten im Hintergrund die Regelwerks-Änderung für dich starten?" - "Ja." was refused twice, because the job judge
// never saw the question. It sees it now, but only when the QUESTION ITSELF offers to start a background agent/job (hard words below, checked before any model call):
// "Soll ich das genauer aufschlüsseln?" and every other offer never opens a job. The judge still has to say yes after that.
const OFFER_FRAME = /\b(?:soll|sollen|darf|kann|möchtest|möchten|willst|wollen|shall|should|can i|may i|want me|would you like|do you want)\b/i; // asks permission / offers
const OFFER_WHAT = new RegExp(`\\b(?:agent\\w*|jobs?|hintergrund\\w*|werkstatt|${CODE}|codex|background|worker\\w*)\\b`, 'i'); // not the bare server names: "Soll ich Sandy neu starten?" is no job
const OFFER_DO = /\b(?:start\w*|los(?:schick|leg|setz|lass)\w*|schick\w*|ansetz\w*|anleg\w*|aufsetz\w*|draufsetz\w*|beauftrag\w*|auslös\w*|ausführ\w*|erledig\w*|übernehm\w*|lass(?:en|e)|launch\w*|spin\w*|kick\w*|run)\b/i;
const OFFER_NOT = /\b(?:erklär\w*|erzähl\w*|aufschlüssel\w*|vorles\w*|zeig\w*|übergab\w*|übergeb\w*|karte\w*|vorschlag\w*|vorschläg\w*|handoff|card|show|explain|tell|how|why|what|which|wie|warum|wieso|was|wann|welche\w*|nicht|kein\w*|nie|niemals|ohne|not|never|without|oder|or|stoppen|abbrech\w*|beend\w*|stop|cancel)\b/i; // an explanation, a card, a negation or a choice is no offer he could accept with a yes
/** Does the assistant's closing question explicitly offer to start a background agent/job? Hard words only; "Soll ich dafür einen Agent Job im Hintergrund starten?" yes, "Soll ich das aufschlüsseln?" no. */
// critic: the task in the relative clause may say anything ("…, der herausfindet, warum der Build rot ist?", "…, der die Übergabe-Karte repariert?"): the exclusions judge the
// OFFER itself (the words before ", der/die/das/…"); a choice ("…, oder machst du das selbst?") is looked for in the whole question.
const offerHead = (t) => t.split(/,\s*(?:der|die|das|welche[rsmn]?|um|damit)\b/i)[0]; // not "dass": "Möchtest du, dass ich einen Hintergrund-Job anlege?" is the offer itself
const CHOICE = /\b(?:oder|or)\s+(?:lieber|soll|sollen|willst|möchtest|machst|mach|selbst|ich|du|nur|doch|erst|rather|should|do)\b/i;
export const offersJob = (q) => { const t = String(q ?? ''), head = offerHead(t); return t.length <= 300 && OFFER_FRAME.test(head) && OFFER_WHAT.test(head) && OFFER_DO.test(head) && !OFFER_NOT.test(head) && !CHOICE.test(t) && !MAIN_TRIGGER.test(t); };
// the bare yes that accepts such an offer: no negation hiding behind "starte nichts" (YES also matches "start" + any word)
const YES_NOT = /\b(?:nicht\w*|nichts|kein\w*|nein|nee|nie|niemals|ohne|noch\s+nicht|warte\w*|stopp?\w*|später|lass\s+mal|no|not|never|wait|stop)\b/i;
const acceptsOffer = (q, yes) => offersJob(q) && !YES_NOT.test(yes);

// a#41d6d2: "Ja, dann soll er das tun." only orders something after "Kann der Desk keine Agenten starten?" and the order before it. His earlier answered sentences
// (CONTEXT_ENTRIES, still usable: <= 3 min, not echo, not used) and the closing sentence of each reply go to the judge as labelled context. No job word is required any more
// (that was a trigger word in disguise, Florian 14 Nov): the judge is told to rate only his LAST line, and the assistant's lines are never obeyed. Short latest words (<= SHORT_WORDS
// words) are the anaphoric ones that need it; contextPolicy.always (an eval seam, test/manual/intent-a41d6d2-live.mjs) shows it for every latest line.
const CONTEXT_ENTRIES = 2;
const SHORT_WORDS = 12;
export const contextPolicy = { always: false };
const isShort = (t) => String(t ?? '').length <= 120 && norm(t).split(' ').filter(Boolean).length <= SHORT_WORDS;
/** His earlier, still usable sentences right before the window (oldest first), for the job judge, when his latest words are short (or `always`). Only his own finals; the walk stops at the first unusable one. */
export function contextBefore(name, spoken, entries, now = Date.now(), { always = contextPolicy.always } = {}) {
  const last = entries.at(-1);
  if (name !== 'start_agent_job' || !last || (!always && !isShort(last.text))) return [];
  const before = [];
  for (let i = spoken.length - entries.length - 1; i >= 0 && before.length < CONTEXT_ENTRIES; i -= 1) {
    if (!usable(spoken[i], name, now)) break;
    before.unshift(spoken[i]);
  }
  return before;
}

/** {hard, entries, text, via} when the window holds his words to judge, else {hard}. via: 'offer' (the question was shown) | 'context'. The Main-Agent prompt is judged only after a soft refusal of the hard words; the job always. */
function intentCase(name, spoken, now) {
  const hard = checkTrigger(name, spoken, now);
  const job = name === 'start_agent_job';
  if (!INTENT_KEY[name] || (!job && (hard.ok || !SOFT.has(hard.why)))) return { hard };
  const entries = triggerWindow(name, spoken, now);
  // the assistant's question as context for a bare "ja": the Main-Agent prompt is typed, not sent, so any closing question. A job needs the question to offer a job (offersJob).
  // That is the only assistant text a job judge ever sees, besides the closing sentences of replies BEFORE the window, labelled as not his.
  const before = job ? contextBefore(name, spoken, entries, now) : [];
  const text = entries.length ? intentText(entries, (t) => YES.test(t), { withQuestion: true, shows: job ? acceptsOffer : undefined, before }) : '';
  const via = !text ? undefined : /^Assistent: /m.test(text) && job ? 'offer' : before.length ? 'context' : undefined;
  return text ? { hard, entries, text, via } : { hard };
}
/** Start the model call while he settles (the gate waits ~2.5 s anyway); the check after the settle reuses it when the words did not change. */
export function prefetchIntent(name, spoken, now, ctx = {}) {
  const c = intentCase(name, spoken, now), classify = classifierOf(ctx);
  if (c.text && classify) classify(c.text).catch(() => /* failed: the check after the settle will try again */ null);
}

// ---- start_agent_job: the judge decides; this is what happens when it cannot (no key, kill switch, timeout, junk) ----
// Only an order that was clear by the old hard rule stays valid: JOB_STRONG (an agent job, or a start together with a server) in an IMPERATIVE that opens his latest sentence ("Starte einen
// Agent Job auf Sandy, der ..."), no question word first, no negation, no quote/screen/report marker, no "wenn/könnte/irgendwann/morgen". Measured offline on the four eval sets: 0 of 334 negative windows
// accepted (the old hard rule accepted 46: reports, quotes of screen text, plans), 7 of 106 positives. Everything else is "unchecked": the Desk says so and offers the card; a bare "ja" to an offer is not enough without the judge.
// critic: a NEW job only: "starte …", or another order verb directly followed by "einen/ein/nen/neuen" ("Lass einen Agenten …", "Setz einen Job auf …"); "Stell den Agent Job ab", "Schick mir den Link zum Agent Job", "Lass uns über den Agent Job reden" are no start
const ORDER_FIRST = new RegExp(`^\\s*(?:(?:ja|okay|ok|also|dann|bitte|äh+m?|ähm|und|jetzt|gut|na)[\\s,.!]+)*(?:start\\w*|spin|launch|(?:${START}|setz\\w*|erstell\\w*|wirf)\\s+(?:(?:mal|bitte|jetzt|noch|gleich|sofort)\\s+)*(?:einen|ein|nen|neuen|eine)\\b)`, 'i');
const NOT_AN_ORDER = /\b(?:da\s+steht|steht|stehen|stand|bildschirm|screen|terminal|anleitung|zitat\w*|zitier\w*|vorles\w*|vorgelesen|lese|liest|sagt|sagte|schreibt|laut|wenn|falls|sollte|könnte\w*|würde\w*|wäre\w*|vielleicht|irgendwann|eventuell|ob|morgen|erst|bloß)\b/i;
/** Is this window an unambiguous order by the old hard rule? Used only while the judge gives no verdict. A negation or quote marker anywhere in his unanswered words refuses it; the order itself starts a fragment. */
export function hardOrder(entries) {
  const fresh = (entries ?? []).filter((e, i) => !e.answered || i === entries.length - 1); // an earlier answered sentence is over; his latest counts even when the Desk's reply final arrived before this tool call (session.js)
  if (!fresh.length) return false;
  const all = fresh.map((e) => String(e.text ?? '')).join(' ');
  if (YES_NOT.test(all) || NOT_AN_ORDER.test(all)) return false;
  return fresh.some((e, k) => ORDER_FIRST.test(String(e.text ?? '')) && !ABOUT.test(String(e.text ?? '')) && JOB_STRONG.test(fresh.slice(k).map((x) => String(x.text ?? '')).join(' ')));
}
const verdictOf = (v) => (!v || typeof v !== 'object' ? 'none' : v.agent_job === true ? 'yes' : v.agent_ask === true ? 'ask' : 'no');
async function jobIntent(spoken, now, ctx) {
  const c = intentCase('start_agent_job', spoken, now), classify = classifierOf(ctx);
  if (!c.entries?.length) return { ok: false, why: spoken.at(-1)?.used?.start_agent_job ? 'used' : 'unclear' }; // nothing of his to judge: the Desk asks
  const t0 = Date.now();
  const verdict = classify ? await classify(c.text).catch(() => /* failed: no verdict, the narrow fallback below decides */ null) : null;
  const v = verdictOf(verdict), fallback = v === 'none' && hardOrder(c.entries);
  ctx.trace?.()?.event?.('action.intent', { turn: ctx.voiceTurn?.turn, tool: 'start_agent_job', hard: c.hard.ok ? 'ok' : c.hard.why, verdict: v, ms: Date.now() - t0, ...(c.via ? { via: c.via } : {}), ...(fallback ? { fallback: 'hard-order' } : {}) });
  ctx.audit?.({ action: 'action.intent', detail: `start_agent_job hard=${c.hard.ok ? 'ok' : c.hard.why} verdict=${v}${c.via ? ` via=${c.via}` : ''}${fallback ? ' fallback=hard-order' : ''}` });
  if (v === 'yes' || fallback) return { ok: true, entries: c.entries, intent: true };
  // only the WORDING of the refusal is chosen here, never the decision: a bare yes after a question of the Desk that talked about an agent/job (but was not the canonical offer, so the judge never saw it
  // as one) gets the question asked again in the canonical form instead of "answer normally"; the loop ends because the canonical question reaches the judge
  const [last, before] = [c.entries.at(-1), c.entries.at(-2)];
  const yesToAgentTalk = v === 'no' && before && YES.test(String(last.text ?? '')) && OFFER_WHAT.test(lastQuestion(before.asked));
  return { ok: false, why: v === 'ask' || yesToAgentTalk ? 'unclear' : v === 'no' ? 'not-a-job' : 'unchecked' };
}

/** The hard rule, then his intent: {ok:true, entries, intent?} or the refusal. Never throws. Job: the judge only (jobIntent). */
export async function checkTriggerOrIntent(name, spoken, now, ctx = {}) {
  if (name === 'start_agent_job') return jobIntent(spoken, now, ctx);
  const c = intentCase(name, spoken, now), classify = classifierOf(ctx);
  if (!c.text || !classify) return c.hard;
  const t0 = Date.now();
  const verdict = await classify(c.text).catch(() => /* failed: fail closed, traced below as verdict none */ null);
  const yes = verdict?.[INTENT_KEY[name]] === true;
  ctx.trace?.()?.event?.('action.intent', { turn: ctx.voiceTurn?.turn, tool: name, hard: c.hard.why, verdict: verdict ? (yes ? 'yes' : 'no') : 'none', ms: Date.now() - t0, ...(c.via ? { via: c.via } : {}) });
  ctx.audit?.({ action: 'action.intent', detail: `${name} hard=${c.hard.why} verdict=${verdict ? (yes ? 'yes' : 'no') : 'none'}${c.via ? ` via=${c.via}` : ''}` });
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
  const checkFrom = clock.now();
  const verdict = await check(spoken, checkFrom);
  // the check may have waited for the intent model: a new sound in that time ("nein, warte") wins, even before its transcript (critic MUST 2)
  // sinceSpeech: any sound since the check began, independent of how the model timeout compares with AWAIT_FINAL_MS (critic 2 NIT)
  if (vt.epoch() !== epoch || heard() !== before || vt.speaking() || vt.awaitingFinal?.() || (vt.sinceSpeech && vt.sinceSpeech() < clock.now() - checkFrom)) return { refused: refuse(ctx, name, 'still-speaking', 'Nichts passiert: Florian spricht noch; rufe das Werkzeug nach seinem Satz erneut auf, wenn es noch gilt.') };
  // and a second call of the same tool on the same sentence waited too: the first one that resumes marks the words, the other is refused (critic MUST 1)
  // its outcome is still open (it may fail and release), so this one must not claim it happened (critic 2 SHOULD 1)
  if (verdict.ok && verdict.entries?.some((e) => e.used?.[name])) return { refused: refuse(ctx, name, 'parallel', 'Hier nichts getan: ein anderer Aufruf desselben Werkzeugs für diesen Satz läuft schon. Richte dich nach dessen Ergebnis und sag Florian nur das.') };
  if (!verdict.ok) {
    const say = {
      'no-trigger': 'Nichts passiert: das hat Florian in seinem letzten Satz nicht so gesagt. Frage ihn in einem kurzen Satz, ob das jetzt passieren soll, ohne den Werkzeugnamen zu nennen; sein Ja auf diese Frage oder sein eigener Satz löst es aus.',
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
const guardedOut = (g, ctx, name) => { release(g, name); return refuse(ctx, name, 'computer-guard', 'Nichts passiert: während einer Computer-Steuerung und fünf Minuten danach sind Prompts an den Main Agent und neue Jobs gesperrt. Sag Florian in EINEM Satz, warum (Sicherheitssperre nach der Computer-Steuerung) und dass er es nach den fünf Minuten noch einmal sagen kann.'); };

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
// a#41d6d2 (14 Nov): the model got "Nichts passiert" twice and told Florian only "Das hat nicht geklappt". Florian's decision the same day (board #60911): no trigger word, his intention decides, and when it is
// unclear the Desk ASKS one short question instead of refusing. Three outcomes, three texts. Echo trap (voice/session.js echoOf): a sentence of his that is >= 80 % made of words the agent said in the last 20 s
// is NOT his word. The question is the way without that risk: offersJob() lets exactly that question through to the judge, and his "Ja" to it cannot be an echo unless the same reply contained "Ja" (hence the hint).
const JOB_UNCLEAR = 'Nichts gestartet: ob Florian jetzt einen Hintergrund-Agenten will, ist nicht klar. Frage ihn EINE kurze Frage, genau so und mit der Aufgabe in wenigen Worten: „Soll ich einen Agenten im Hintergrund starten, der …?“ Ohne „Ja“ oder „Genau“ in derselben Antwort und ohne „oder“; sein Ja darauf startet den Job. Erkläre nichts weiter. Ruf das Werkzeug erst wieder auf, wenn Florian danach etwas Neues gesagt hat. Hast du diese Frage schon gestellt und es ging trotzdem nicht, bitte ihn stattdessen um den Auftrag in eigenen Worten.';
const JOB_NOT = 'Nichts gestartet: das war kein Auftrag für einen Hintergrund-Agenten (eine Frage, ein Bericht, ein Zitat, eine Verneinung oder etwas, das du selbst tun kannst). Antworte Florian normal darauf und biete keinen Agenten an. Ruf das Werkzeug erst wieder auf, wenn er danach etwas Neues gesagt hat; wollte er doch einen Agenten, sagt er es noch einmal in eigenen Worten.';
const JOB_UNCHECKED = 'Nichts gestartet: die Prüfung von Florians Auftrag ist gerade nicht erreichbar, deshalb ist unklar, ob er einen Hintergrund-Agenten wollte. Sag ihm das in EINEM Satz und zeige ihm die Übergabe-Karte zum Antippen (handoff_propose), oder er wiederholt den Auftrag ausdrücklich in eigenen Worten. Diktiere keinen Satz zum Nachsprechen. Ruf das Werkzeug erst wieder auf, wenn er danach etwas Neues gesagt hat.';
const CARD_WORD = { sent: 'gesendet', queued: 'unterwegs', pending: 'unterwegs', 'not-sent': 'nicht gesendet' };

async function agentJob({ title, prompt, host }, ctx, clock) {
  const g = await gate('start_agent_job', ctx, clock, null, { unclear: JOB_UNCLEAR, 'not-a-job': JOB_NOT, unchecked: JOB_UNCHECKED });
  if (g.refused) return g.refused;
  if (ctx.computer?.guarded?.(ctx.sid ?? 'desk')) return guardedOut(g, ctx, 'start_agent_job');
  const t = String(title ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const p = String(prompt ?? '').trim();
  if (!t || !p) return release(g, 'start_agent_job'), out(false, 'Titel und Auftrag dürfen nicht leer sein. Nichts gestartet; rufe das Werkzeug mit beidem noch einmal auf.');
  const stampedPrompt = stamped(p, await deskStamp(ctx)); // the only await before the checks below: nothing can change between the limit check and job.start
  const sid = ctx.sid ?? 'desk', now = clock.now();
  sweep(now);
  // the same title alone does not make a twin: "Check disk" two minutes later can be a different task
  const twin = recall('job', sid, JOB_DEDUPE_MS, now).find((e) => jaccard(e.prompt, p) >= JACCARD || (norm(e.title) === norm(t) && jaccard(e.prompt, p) >= 0.3));
  if (twin) {
    ctx.trace?.()?.event?.('action.agent_job', { turn: g.vt.turn, id: twin.requestId, name: twin.name ?? null, host: twin.host, card: twin.card ?? null, duplicate: true });
    return out(true, `Der Job läuft schon${twin.name ? ` (${twin.name})` : ' (wird gerade gestartet)'}; kein zweiter gestartet. Korrekturen schickt Florian per Antwort auf die Telegram-Karte. Sag nur einen kurzen Satz.`);
  }
  if (!ctx.hub?.call) return release(g, 'start_agent_job'), out(false, 'Nichts gestartet: keine Verbindung zur Werkstatt. Sag Florian in EINEM Satz, dass die Werkstatt gerade nicht erreichbar ist und er es später noch einmal sagen kann.');
  const verdict = (ctx.limits ?? defaultLimits).check(sid, 'agentJob');
  if (!verdict.ok) return release(g, 'start_agent_job'), refuse(ctx, 'start_agent_job', 'limit', `Nichts gestartet: ${verdict.reason}. Sag Florian in EINEM Satz warum und dass er den Auftrag später noch einmal geben kann.`);
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
    return out(false, `Der Job wurde nicht gestartet (${/^limit$/.test(msg) ? 'Stunden- oder Tageslimit der Werkstatt erreicht' : /offline|getrennt/.test(msg) ? 'die Werkstatt auf Sandy ist offline' : /unknown method/.test(msg) ? 'die Sandy-Werkstatt kennt das Werkzeug noch nicht' : 'die Werkstatt hat den Start abgelehnt'}). Sag Florian in EINEM Satz warum und dass er es später noch einmal sagen kann.`);
  }
  const name = typeof res?.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(res.name) ? res.name : null;
  if (!name) { forget('job', sid, entry); release(g, 'start_agent_job'); return out(false, 'Der Job wurde nicht bestätigt. Sag Florian in EINEM Satz, dass die Werkstatt den Start nicht bestätigt hat und er auf die Telegram-Karte achten soll, bevor er es nochmal sagt.'); }
  entry.name = name; entry.card = res.card;
  ctx.audit?.({ action: 'action.agent_job', detail: `${aid ?? 'a#?'} ${name} title=${t} host=${res.host ?? host ?? 'auto'} card=${res.card ?? '-'}` });
  traced?.event?.('action.agent_job', { turn: g.vt.turn, id: requestId, name, host: res.host ?? host ?? 'auto', card: res.card ?? null, duplicate: false });
  return out(true, `Job ${name} läuft. Karte: ${CARD_WORD[res.card] ?? 'unterwegs'}. Sag nur einen kurzen Satz.`);
}

export async function runVoiceAction(name, args, ctx, clock = ctx.clock ?? defaultClock) {
  return name === 'output_main_agent_prompt' ? mainPrompt(args, ctx, clock) : agentJob(args, ctx, clock);
}
