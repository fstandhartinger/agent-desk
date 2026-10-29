// discord.list / discord.read for Sandy: READ-ONLY views of Discord through the home-IP Chrome (CDP 9334) via
// ~/bin/home-browser-call. Rules (Florian's job-safety: another job may be composing in an existing Discord tab):
//  - ALWAYS a new tab of our own (new_page ... close_page); never navigate_page on an existing tab,
//  - only new_page + sleep + evaluate_script (fixed DOM-reading functions) + close_page; never type, click, press, fill,
//  - private temp dir (0700) and step file (0600), removed afterwards; one call at a time; 70 s timeout;
//  - home-browser-call's own locks are respected (HOME_BROWSER_SESSION_WAIT is short, so a busy Chrome gives a clean error).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { redact } from './redact.js';

const bin = () => process.env.BRIDGE_DISCORD_BIN || path.join(process.env.BRIDGE_HOME || os.homedir(), 'bin', 'home-browser-call');
const TIMEOUT_MS = 70_000;
const MAX_MESSAGES = 50;
export const CHANNEL_RE = /^(@me|\d{15,22})\/\d{15,22}$/;

export function validateChannel(channel) {
  const c = String(channel ?? '');
  if (!CHANNEL_RE.test(c)) throw new Error('channel must look like "@me/<id>" or "<guild>/<channel>" (numeric ids)');
  return c;
}

const readJs = (n) => `() => { const items=[...document.querySelectorAll('li[id^="chat-messages-"]')]; let last=''; const out=[]; for (const li of items){ const a=li.querySelector('[id^="message-username-"]'); if(a) last=a.innerText.replace(/\\n/g,' '); const t=li.querySelector('time'); const c=li.querySelector('[id^="message-content-"]'); out.push({author:last,time:t?t.getAttribute('datetime'):'',text:c?c.innerText:''}); } return JSON.stringify(out.slice(-${n})); }`;
const LIST_JS = '() => JSON.stringify([...document.querySelectorAll(\'a[href^="/channels/@me/"]\')].slice(0,16).map(a=>({channel:"@me/"+a.getAttribute("href").split("/").pop(),label:(a.getAttribute("aria-label")||a.innerText||"").replace(/\\s+/g," ").slice(0,120)})))';

/** Pure step builders (tested): exactly new_page, sleep, evaluate_script, close_page. */
export function buildReadSteps(channel, limit) {
  const n = Math.min(MAX_MESSAGES, Math.max(1, Math.trunc(Number(limit)) || 20));
  return [
    ['new_page', { url: `https://discord.com/channels/${validateChannel(channel)}` }],
    ['sleep', 12],
    ['evaluate_script', { pageId: '@new', function: readJs(n) }],
    ['close_page', { pageId: '@new' }],
  ];
}
export function buildListSteps() {
  return [
    ['new_page', { url: 'https://discord.com/channels/@me' }],
    ['sleep', 14],
    ['evaluate_script', { pageId: '@new', function: LIST_JS }],
    ['close_page', { pageId: '@new' }],
  ];
}

let chain = Promise.resolve();
/** One Discord call at a time inside this process (home-browser-call additionally flocks across processes). */
function serialized(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

function runSteps(steps) {
  return serialized(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-discord-'));
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'steps.json');
    fs.writeFileSync(file, JSON.stringify(steps), { mode: 0o600 });
    try {
      const stdout = await new Promise((resolve, reject) => {
        const env = { PATH: `${path.join(os.homedir(), 'bin')}:/usr/local/bin:/usr/bin:/bin`, HOME: process.env.BRIDGE_HOME || os.homedir(), LANG: 'C.UTF-8', HOME_BROWSER_SESSION_WAIT: '30' };
        if (process.env.DISPLAY) env.DISPLAY = process.env.DISPLAY;
        execFile(bin(), [`@${file}`, '20000'], { env, timeout: TIMEOUT_MS, killSignal: 'SIGINT', maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
          if (err && !out) return reject(new Error(redact(`discord read failed: ${(String(errOut).trim().split('\n').pop() || err.message).slice(0, 200)}`)));
          resolve(String(out));
        });
      });
      // evaluate_script prints the returned string as a JSON string on its own line
      for (const line of stdout.split('\n')) {
        const l = line.trim();
        if (!l.startsWith('"')) continue;
        try { return JSON.parse(JSON.parse(l)); } catch { /* next candidate */ }
      }
      throw new Error('discord page returned nothing readable (not logged in, or the page did not load)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

export async function list() {
  const rows = await runSteps(buildListSteps());
  return { channels: (Array.isArray(rows) ? rows : []).filter((r) => CHANNEL_RE.test(String(r.channel))).map((r) => ({ channel: r.channel, label: redact(String(r.label ?? '')) })) };
}

export async function read({ channel, limit = 20 } = {}) {
  const c = validateChannel(channel);
  const rows = await runSteps(buildReadSteps(c, limit));
  const messages = (Array.isArray(rows) ? rows : []).slice(-MAX_MESSAGES).map((m) => ({
    author: redact(String(m.author ?? '')).slice(0, 80),
    time: String(m.time ?? '').slice(0, 40),
    text: redact(String(m.text ?? '')).slice(0, 2000),
  }));
  return { channel: c, messages };
}
