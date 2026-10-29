// Mint a Telegram login link for Florian: `node scripts/login-link.mjs [hours]` with DESK_SESSION_SECRET in the env
// (LeChonk: `set -a; . ~/.config/agent-desk/secrets.env; set +a`). Prints the URL only.
import { mintLoginLink } from '../src/auth.js';

const hours = Number(process.argv[2] ?? 24);
if (!process.env.DESK_SESSION_SECRET) throw new Error('DESK_SESSION_SECRET is not set');
console.log(`${process.env.DESK_ORIGIN ?? 'https://desk.app.mintapis.com'}/#k=${mintLoginLink(hours * 3600_000)}`);
