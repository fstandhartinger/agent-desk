// computer_task: the voice tool that opens a computer run (item F). Behind the same settle logic as the two voice actions, but the trigger is
// stricter (gate.js): his ONE latest spoken final, verbatim. The model's own `goal` is logged only; the loop never sees it.
import { gate, release, defaultClock } from '../voiceActions.js';
import { redact, short } from '../redact.js';
import { checkComputerTrigger } from './gate.js';

const out = (ok, content, extra = {}) => ({ ok, summary: short(content, 200), content: redact(content), ...extra });
const SAY = {
  'no-trigger': 'Nichts passiert: Florian hat in seinem letzten Satz nicht darum gebeten, den Computer zu übernehmen oder etwas zu klicken, zu öffnen oder zu tippen. Frage ihn in einem kurzen Satz, ob du den Computer steuern sollst; erst sein eigener Satz löst es aus.',
  typed: 'Nichts passiert: getippter Text löst die Computer-Steuerung nie aus. Florian muss es sagen.',
  echo: 'Nichts passiert: das war dein eigenes Echo, nicht Florian.',
  old: 'Nichts passiert: Florians Satz ist zu lange her. Frage ihn kurz, ob du den Computer steuern sollst.',
  used: 'Für diesen Satz ist das schon passiert; kein zweites Mal. Sag nur einen kurzen Satz.',
  question: 'Nichts passiert: das war eine Frage, kein Auftrag. Beantworte sie.',
};

export async function computerTask({ goal }, ctx, clock = ctx.clock ?? defaultClock) {
  const g = await gate('computer_task', ctx, clock, checkComputerTrigger, SAY);
  if (g.refused) return g.refused;
  if (!ctx.computer?.begin) return release(g, 'computer_task'), out(false, 'Die Computer-Steuerung ist in diesem Kontext nicht verfügbar. Nichts passiert.');
  const r = await ctx.computer.begin(ctx.sid ?? 'desk', { text: g.text, goalArg: goal });
  if (!r.ok) release(g, 'computer_task'); // a refused start may be asked for again
  return out(r.ok, r.text);
}
