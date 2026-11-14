// LIVE end-to-end check of the gate (voiceActions.js checkTriggerOrIntent -> intentTrigger.js -> the real model) on the two refused turns of a#41d6d2 (14 Nov 2026)
// and on the unrelated-offer / complaint negatives. Needs OPENROUTER_API_KEY in the env; prints no secret.  node test/manual/intent-a41d6d2-live.mjs [repeats=3]
import { checkTriggerOrIntent } from '../../src/voiceActions.js';
import { intentEnabled, resetIntent } from '../../src/intentTrigger.js';

if (!intentEnabled()) { console.error('intent fallback off (OPENROUTER_API_KEY missing or DESK_INTENT_TRIGGER=off)'); process.exit(2); }
const NOW = Date.now();
const e = (text, ago, o = {}) => ({ text, at: NOW - ago, ...o });
const T10 = 'Ja, genau. Äh, bitte löse sofort eine Änderung dieser Regel aus. Das habe ich anders gemeint, als es nun aktuell aufgeschrieben ist.';
const OFFER = 'Soll ich einen Agenten im Hintergrund die Regelwerks-Änderung für dich starten?';
const lead = () => [e(T10, 60_000, { answered: true, asked: 'Der Desk kann Regeln selbst nicht umschreiben.' }), e('Kann der Desk keine Agenten starten?', 45_000, { answered: true, asked: 'Doch, das kann er.' })];
const CASES = [
  ['t12 "Ja, dann soll er das tun."', [...lead(), e('Ja, dann soll er das tun.', 1000)], true],
  ['t13 "Ja." after the offer', [...lead(), e('Ja, dann soll er das tun.', 20_000, { answered: true, asked: OFFER }), e('Ja.', 1000)], true],
  ['"Ja." after an unrelated offer (the question is never shown)', [e('Wie viel kostet das im Monat?', 20_000, { answered: true, asked: 'Etwa 7.200 Euro. Soll ich das genauer aufschlüsseln?' }), e('Ja.', 1000)], false],
  ['"Ja." after a complaint', [e('Der Job ist schon wieder nicht gestartet, das nervt.', 20_000, { answered: true, asked: 'Das tut mir leid.' }), e('Ja.', 1000)], false],
  ['"Ja, dann soll er das erklären."', [...lead(), e('Ja, dann soll er das erklären.', 1000)], false],
  ['"Kann der Desk keine Agenten starten?" alone', [e('Kann der Desk keine Agenten starten?', 1000)], false],
  ['"Nein, lass mal." after the offer', [...lead(), e('Ja, dann soll er das tun.', 20_000, { answered: true, asked: OFFER }), e('Nein, lass mal.', 1000)], false],
  ['"Ja." after an offer of the Main Agent', [e('Die Zahlen stimmen nicht.', 20_000, { answered: true, asked: 'Soll ich das als Prompt an deinen Main Agent tippen?' }), e('Ja.', 1000)], false],
  ['older answered mention + "Ja, mach das."', [e('Was ist Claude Code?', 60_000, { answered: true, asked: 'Ein Programmierassistent.' }), e('Ja, mach das.', 1000)], false],
];
const repeats = Math.max(1, Number(process.argv[2] ?? 3));
let bad = 0;
for (const [label, spoken, want] of CASES) {
  let yes = 0;
  for (let r = 0; r < repeats; r += 1) {
    resetIntent();
    const v = await checkTriggerOrIntent('start_agent_job', spoken.map((x) => ({ ...x })), NOW, {});
    if (v.ok) yes += 1;
  }
  const ok = want ? yes === repeats : yes === 0;
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: opens a job ${yes}/${repeats} (want ${want ? 'always' : 'never'})`);
}
process.exit(bad ? 1 : 0);
