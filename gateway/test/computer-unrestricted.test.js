import assert from 'node:assert/strict';
import { it } from 'node:test';
delete process.env.DESK_COMPUTER_GUARDS; // this file checks the live default; every other test file runs with the older rules
const { checkComputerTrigger } = await import('../src/computer/gate.js');
const { unrestricted } = await import('../src/computer/mode.js');
it('live default: no trigger gate, only the same sentence twice is refused', () => {
  assert.equal(unrestricted(), true);
  const now = Date.now();
  for (const e of [{ text: 'Ja, schau mal, was passiert.', at: now }, { text: 'Übernimm den Computer.', at: now, echo: true }, { text: 'Kannst du das?', at: now, typed: true }, { text: 'alt', at: now - 3_600_000 }]) assert.equal(checkComputerTrigger([e], now).ok, true, e.text);
  assert.equal(checkComputerTrigger([], now).ok, true);
  assert.equal(checkComputerTrigger([{ text: 'x', at: now, used: { computer_task: true } }], now).why, 'used');
});
