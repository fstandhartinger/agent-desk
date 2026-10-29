import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactDeep } from './redact.js';

const dir = () => process.env.DESK_AUDIT_DIR || path.join(os.homedir(), 'desk-audit');

export async function append(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('audit entry must be an object');
  await fs.promises.mkdir(dir(), { recursive: true, mode: 0o700 });
  const day = new Date().toISOString().slice(0, 10);
  const line = JSON.stringify(redactDeep({ ts: new Date().toISOString(), ...entry })) + '\n';
  await fs.promises.appendFile(path.join(dir(), `${day}.jsonl`), line, { mode: 0o600 });
  return { ok: true };
}
