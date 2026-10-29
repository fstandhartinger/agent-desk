import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { redact } from './redact.js';

// notify.loginLink: sends the desk login link to Florian through the central notify command (docs/CANVAS.md "Login UX gap").
// The gateway signs the link; the bridge only delivers it. BRIDGE_NOTIFY_BIN lets tests substitute a fake script.

const URL_RE = /^https:\/\/desk\.app\.mintapis\.com\/[^\s"'`<>\\]*$/;
const notifyBin = () => process.env.BRIDGE_NOTIFY_BIN || path.join(os.homedir(), 'bin', 'notify');

// CANVAS.md words this card in German, but notify rejects German prose ("rewrite the body in plain English") and
// requires a result sentence after "Worum geht's:"; this wording passes `notify now --dry-run --requested`.
export const loginCard = (url) => `✅ ERLEDIGT\nWorum geht's: Your Agent Desk login link (desk.app.mintapis.com) is ready to open.\n${url}\nValid for 24 h, 3 uses.`;

export async function loginLink({ url } = {}) {
  if (typeof url !== 'string' || url.length > 600 || !URL_RE.test(url)) throw new Error('url must be an https://desk.app.mintapis.com/ link');
  const args = ['now', '--requested', loginCard(url)];
  return new Promise((resolve) => {
    execFile(notifyBin(), args, { timeout: 25_000, env: { ...process.env, AGENT_BOARD_NAME: 'desk:bridge' }, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // The link is a secret: it never goes back into the detail text.
      const clean = (s) => redact(String(s ?? '')).replaceAll(url, '[link]').trim().slice(-300);
      const out = clean(`${stdout}\n${stderr}`) || clean(err?.message);
      if (!err) return resolve({ sent: true, detail: out || 'sent' });
      resolve({ sent: false, detail: out || 'notify failed', ...(typeof err.code === 'number' ? { exit: err.code } : {}) });
    });
  });
}
