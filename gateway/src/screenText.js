// On-screen text for speech (9 Nov 2026). Florian had three cards about companies on his screen, said the name of one and the recognisers wrote a
// better-known name that sounds similar; the voice model then explained the wrong company. What is visible on his screen is the best hint for what he
// says, so the app posts the visible text (UI Automation + OCR, redacted there) when a dictation starts and while a voice session runs.
// This module turns it into (a) name-like terms for the recognisers' phrase lists and the clean-up, and (b) a "you probably heard X, the screen says Y"
// hint for the voice model. Privacy: memory only, per device, three minutes; nothing is written to disk, traced or logged except counts.
import { redact } from './redact.js';

export const SCREEN_TEXT_TTL_MS = 180_000, MAX_SCREEN_TEXT = 6000, MAX_TERMS = 60;
export const SCREEN_TEXT_REASONS = ['dictation', 'session', 'foreground'];

// Frequent German and English words and UI labels: capitalised in German or at a line start, but never a name worth a recogniser hint.
const COMMON = new Set(`der die das den dem des ein eine einen einem einer eines und oder aber auch nicht kein keine nur noch schon sehr mehr viel viele wenig alle alles jede jeder jedes
ich du er sie es wir ihr mich dich sich uns euch mein dein sein unser euer ihre ihren ihrem ihrer mir dir ihm ihn man wer was wie wo wann warum wieso welche welcher welches
ist sind war waren bin bist sein hat haben hatte hatten wird werden wurde wurden kann können konnte muss müssen soll sollen will wollen darf dürfen mag möchte
mit ohne für von vom zu zum zur bei beim nach vor über unter auf aus in im an am um durch gegen bis seit während wegen als wenn dann dass weil ob damit
hier dort da jetzt heute gestern morgen später gleich sofort immer nie oft wieder neu neue neuer neues alt alte gut gute besser beste schlecht groß klein
ja nein okay ok bitte danke dran laut agent agents agenten modell modelle model models kunde kunden hallo tschüss gern gerne genau vielleicht natürlich
senden sende gesendet ändern nicht jetzt abbrechen speichern öffnen schließen löschen bearbeiten datei ansicht hilfe einstellungen suchen suche weiter zurück
fertig start stopp ende kopieren einfügen ausschneiden drucken anmelden abmelden login logout konto profil nachricht nachrichten antwort antworten
mail post betreff anhang entwurf entwürfe gesendete papierkorb posteingang ordner seite seiten fenster tab tabs menü liste tabelle titel text bild bilder
karte karten angebot angebote kunde kunden preis preise kosten kostet test tests gespräch formular details option optionen quelle limits teams fakten
empfohlen frage fragen thema themen stand status fehler warnung hinweis info infos beispiel teil teile zeit tag tage woche monat jahr uhr minute minuten stunde stunden
montag dienstag mittwoch donnerstag freitag samstag sonntag januar februar märz april mai juni juli august september oktober november dezember
jan feb mar apr jun jul aug sep sept oct okt nov dec dez mon tue wed thu fri sat sun
the a an and or but not no yes of to in on at by for from with without as is are was were be been being have has had do does did will would can could should may might must
this that these those it its they them their there here we you your our us he she his her him i me my mine who what when where why how which
new old open close closed save delete edit file view help settings search find next back done start stop end copy paste cut print sign log out account profile message messages
reply send sent draft drafts inbox trash folder page pages window menu list table title text image images today yesterday tomorrow now later all any some more most less
home about contact pricing docs blog news share like comment comments follow following followers post posts repost quote views view
general lost found thanks man feeling good person also try rate hash you thank much whenever ready shared her well hello joined token bot has approved signed
archived chats chat tap button until details min why catch app apps web online offline`.split(/\s+/));

// trailing punctuation of a token, cut by a loop: a `+$` regex is quadratic on a long run of dots (redos tests)
const TAIL = ".'’-";
const trimTail = (t) => { let e = t.length; while (e > 0 && TAIL.includes(t[e - 1])) e -= 1; return t.slice(0, e); };
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’.&+#@-]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu;
const isCap = (t) => /^\p{Lu}[\p{Ll}'’-]{2,}$/u.test(t);
const isAllCaps = (t) => /^\p{Lu}{2,6}$/u.test(t);
const isShaped = (t) => /\p{Ll}\p{Lu}/u.test(t) // inner capital: JevBench, OpenRouter
  || (/\p{L}/u.test(t) && /\p{N}/u.test(t) && t.length >= 3) // letters and digits: s1-pro, SN92, GPT-6
  || /^[\p{L}\p{N}-]{2,}\.(?:io|ai|com|co|de|net|org|dev|app|eu)$/iu.test(t); // a domain
const GERMAN_NOUN = /(?:ung|ungen|heit|keit|schaft|tion|tionen|chen|nis|nisse|tät|ismus|ieren|lich|isch|bar)$/u;
const common = (t) => COMMON.has(t.toLowerCase());

/**
 * Name-like terms of a screen text, best first, at most `max`: brand and product names, people, acronyms, domains, model ids. German capitalises every noun,
 * so a capital alone is weak: shape (inner capital, digits, domain), a run of capitalised words, a following "(...)" or a repeat makes a term.
 */
export function screenTerms(text, { max = MAX_TERMS } = {}) {
  const score = new Map(), spell = new Map();
  const bump = (term, points) => {
    const t = term.replace(/\s+/g, ' ').trim();
    if (t.length < 2 || t.length > 40 || /^\d+$/.test(t)) return;
    const k = t.toLowerCase();
    if (!spell.has(k)) spell.set(k, t);
    score.set(k, (score.get(k) ?? 0) + points);
  };
  for (const line of String(text ?? '').slice(0, MAX_SCREEN_TEXT * 2).split(/\r?\n/).slice(0, 400)) {
    const toks = [...line.matchAll(TOKEN)].map((m) => ({ t: trimTail(m[0].replace(/^[@#]+/, '')), i: m.index, end: m.index + m[0].length })).filter((x) => x.t);
    let run = [];
    const flush = () => {
      // a run of two or three name words is one name ("Hugging Face", "Opnar AI", "Claude Code"); all-common runs are headings or labels ("DU BIST DRAN")
      if (run.length >= 2 && run.length <= 3 && !run.every((x) => common(x.t) || isAllCaps(x.t)) && !common(run[0].t)) bump(run.map((x) => x.t).join(' '), 4 + run.length);
      run = [];
    };
    toks.forEach((x, n) => {
      const between = n ? line.slice(toks[n - 1].end, x.i) : '';
      if (n && !/^ $/.test(between)) flush(); // punctuation or a gap ends a name
      const nameWord = isCap(x.t) || isShaped(x.t) || (isAllCaps(x.t) && run.length > 0) || (/^\d+(?:\.\d+)?$/.test(x.t) && run.length > 0);
      if (nameWord) run.push(x); else flush();
      const after = line.slice(x.end, x.end + 2);
      if (isShaped(x.t)) bump(x.t, 5);
      else if (isAllCaps(x.t) && !common(x.t) && x.t.length >= 3) bump(x.t, 1);
      else if (isCap(x.t) && !common(x.t)) bump(x.t, (n > 0 ? 1 : 0.5) + (/^ \(/.test(after) ? 2 : 0) - (GERMAN_NOUN.test(x.t) ? 1 : 0));
      // a name inside a German compound ("FizzVille-Zwilling", "Opnar-Karte"): the name part on its own is what he says
      if (x.t.includes('-')) for (const part of x.t.split('-')) if (part.length >= 4 && /\p{Ll}\p{Lu}/u.test(part)) bump(part, 5);
    });
    flush();
  }
  return [...score.entries()].filter(([, s]) => s >= 1).sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => spell.get(k));
}

// ---- "heard X, the screen says Y" ----
const sound = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 's').replace(/[^a-z0-9]/g, '')
  .replace(/ph/g, 'f').replace(/w/g, 'f').replace(/ck/g, 'k').replace(/c(?=[aou]|$)/g, 'k').replace(/th/g, 't').replace(/y/g, 'i').replace(/v/g, 'f').replace(/z/g, 's').replace(/ie/g, 'i').replace(/(.)\1+/g, '$1');
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = keep; }
  }
  return row[b.length];
}
/** 0..1: how alike two terms sound (letters only, common German/English spelling variants folded). */
export function soundsLike(a, b) {
  const x = sound(a), y = sound(b);
  if (!x || !y) return 0;
  return 1 - distance(x, y) / Math.max(x.length, y.length);
}
/**
 * Pairs {heard, screen}: a word (or two or three words in a row) of his recognised sentence that is NOT on the screen but sounds like a name that is.
 * "OpenAI" heard, "Opnar AI" on screen. Same first sound, at least 5 letters, similarity >= 0.7; the same spelling is no pair.
 */
export function heardLikeScreen(heard, terms, { min = 0.7 } = {}) {
  const words = (String(heard ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []).map(trimTail);
  const plain = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const onScreen = new Set(terms.map(plain)); // spelled the same = heard right; sounding the same but spelled differently ("Netty Gate") is exactly the case
  const said = ` ${words.map(plain).filter(Boolean).join(' ')} `;
  const out = [], used = new Set();
  for (const term of terms) {
    const key = sound(term);
    if (key.length < 5) continue;
    // he said the name itself (the recogniser wrote it right): no hint, also not for "<name> und" that merely sounds like the name
    if (said.includes(` ${term.split(/\s+/).map(plain).filter(Boolean).join(' ')} `)) continue;
    let best = null;
    for (let n = 1; n <= 3; n += 1) for (let i = 0; i + n <= words.length; i += 1) {
      const span = words.slice(i, i + n).join(' '), k = sound(span);
      if (n > 1 && words.slice(i, i + n).some((w) => w.length >= 4 && onScreen.has(plain(w)))) continue; // a word of the span IS a name on the screen, heard right: the words next to it are ordinary speech
      if (k.length < 5 || k[0] !== key[0] || onScreen.has(plain(span))) continue;
      const ps = plain(span), pt = plain(term);
      if (ps.startsWith(pt) || pt.startsWith(ps)) continue; // an inflected form or a compound of the word on screen ("Agenten" for "Agent") is no mishearing
      // a misheard name is written as a name: at least one word with a capital (or a digit) that is no everyday word. "Wie viele" or "wissen will" stay ordinary speech.
      if (!words.slice(i, i + n).some((w) => /^[\p{Lu}\p{N}]/u.test(w) && !COMMON.has(w.toLowerCase()))) continue;
      const s = soundsLike(span, term);
      if (s >= min && (!best || s > best.s)) best = { heard: span, screen: term, s };
    }
    if (best && !used.has(best.heard.toLowerCase())) { used.add(best.heard.toLowerCase()); out.push({ heard: best.heard, screen: best.screen, score: Number(best.s.toFixed(2)) }); }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
/** The sentence for the voice model (data-shaped, German), or '' when nothing on screen sounds like what was heard. */
export function hearingHint(heard, terms) {
  const pairs = heardLikeScreen(heard, terms);
  if (!pairs.length) return '';
  return `[Hinweis vom Desk, nicht von Florian: Die Spracherkennung hat vermutlich einen Namen verhört. Auf Florians Bildschirm steht ${pairs.map((p) => `"${p.screen}" (erkannt wurde "${p.heard}")`).join(', ')}. Er meint sehr wahrscheinlich den Namen vom Bildschirm: antworte dazu, ohne nachzufragen und ohne den Hörfehler zu erwähnen.]`;
}

/** Validated body of POST /api/device/screen-text; throws a plain Error with .status 400 on a wrong shape. */
export function screenTextBody(body) {
  const bad = () => Object.assign(new Error('Ungültiger Bildschirmtext.'), { status: 400 });
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !['reason', 'process', 'title', 'text', 'frameVersion'].includes(k))) throw bad();
  const { reason, process: proc = '', title = '', text, frameVersion } = body;
  if (!SCREEN_TEXT_REASONS.includes(reason) || typeof proc !== 'string' || proc.length > 100 || typeof title !== 'string' || title.length > 200 || typeof text !== 'string' || text.length > MAX_SCREEN_TEXT + 200 || (frameVersion !== undefined && !(Number.isSafeInteger(frameVersion) && frameVersion >= 0))) throw bad();
  return { reason, process: proc, title, text: text.slice(0, MAX_SCREEN_TEXT) };
}

/** Per device: the newest screen text's terms, kept for ttlMs in memory. */
export function createScreenText({ now = Date.now, ttlMs = SCREEN_TEXT_TTL_MS, maxDevices = 50 } = {}) {
  const byDevice = new Map(); // deviceId -> {terms, at, reason, chars}
  function note(deviceId, body) {
    const clean = screenTextBody(body);
    // the app redacts before sending; the gateway redacts again, so a key that slipped through never reaches a recogniser prompt
    const terms = screenTerms(redact(`${clean.title}\n${clean.text}`));
    if (!byDevice.has(deviceId) && byDevice.size >= maxDevices) byDevice.delete(byDevice.keys().next().value);
    byDevice.set(deviceId, { terms, at: now(), reason: clean.reason, chars: clean.text.length });
    return { ok: true, terms: terms.length, chars: clean.text.length, reason: clean.reason };
  }
  /** Fresh terms of a device (best first), or [] when nothing arrived in the last ttlMs. */
  function terms(deviceId, max = MAX_TERMS) {
    const e = byDevice.get(deviceId);
    if (!e) return [];
    if (now() - e.at > ttlMs) { byDevice.delete(deviceId); return []; }
    return e.terms.slice(0, max);
  }
  const age = (deviceId) => { const e = byDevice.get(deviceId); return e ? now() - e.at : null; };
  return { note, terms, age, clear: (deviceId) => byDevice.delete(deviceId), _byDevice: byDevice };
}
