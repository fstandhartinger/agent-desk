// laptop.recent: the last messages of the laptop main session from the compact mirror (start briefing fallback, 15 Nov 2026).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mainSessionId, parseDay, recent } from '../src/laptopRecent.js';

const day = (blocks) => blocks.map(([at, who, body]) => `### ${at} UTC — ${who}\n${body}\n`).join('\n');

describe('laptop.recent', () => {
  it('parses messages, drops tool-only blocks, keeps roles and UTC times', () => {
    const msgs = parseDay(day([
      ['2026-11-15 19:10', 'Florian', 'Wir rechnen mit 500 Dollar.'],
      ['2026-11-15 19:11', 'Claude', '[Werkzeug Bash: list jobs]'],
      ['2026-11-15 19:12', 'Claude', 'Notiert.\n[Werkzeug Bash: x]'],
    ]));
    assert.deepEqual(msgs, [
      { role: 'user', at: '2026-11-15T19:10:00Z', text: 'Wir rechnen mit 500 Dollar.' },
      { role: 'assistant', at: '2026-11-15T19:12:00Z', text: 'Notiert.' },
    ]);
  });

  it('reads the newest day file of the main session named in INDEX.md, last N messages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
    fs.mkdirSync(path.join(dir, 'sessions'));
    fs.writeFileSync(path.join(dir, 'INDEX.md'), 'Die Hauptsitzung des Laptop-Chief-of-Staff ist Projekt Dev-chutes, Sitzung 31036e59 (läuft).\n');
    fs.writeFileSync(path.join(dir, 'sessions', 'Dev-chutes__31036e59__2026-11-14.md'), day([['2026-11-14 10:00', 'Florian', 'alt']]));
    fs.writeFileSync(path.join(dir, 'sessions', 'Dev-chutes__31036e59__2026-11-15.md'), day(Array.from({ length: 20 }, (_, i) => ['2026-11-15 10:' + String(i).padStart(2, '0'), i % 2 ? 'Claude' : 'Florian', `Nachricht ${i}`])));
    fs.writeFileSync(path.join(dir, 'sessions', 'Other__deadbeef__2026-11-16.md'), day([['2026-11-16 09:00', 'Florian', 'andere Sitzung']]));
    const r = await recent({ limit: 3 }, { dir });
    assert.equal(r.session, 'Dev-chutes/31036e59');
    assert.equal(r.day, '2026-11-15');
    assert.deepEqual(r.messages.map((m) => m.text), ['Nachricht 17', 'Nachricht 18', 'Nachricht 19']);
    assert.equal(mainSessionId('nichts'), null);
  });

  it('fails clearly without a mirror', async () => {
    await assert.rejects(() => recent({}, { dir: path.join(os.tmpdir(), 'no-such-mirror-xyz') }), /laptop mirror not available/);
  });
});
