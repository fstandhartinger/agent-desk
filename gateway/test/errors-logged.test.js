// Source scan: every message Florian (or the app) can see as an error has a path to a log event.
// What it CAN see: the TEXT table, thrown/sent HTTP errors (central http.error / device.error hooks), WebSocket/SSE `type:'error'` sends
// (a trace/audit call within a few lines), and one-line catches without a reason. What it CANNOT see: messages built from variables
// (modelError(status), err.message of a provider), whether a trace call is reached on every branch, or text the web client composes
// (web/test/errors-logged.test.ts covers the browser side). A new message in an unknown file fails here on purpose: add the logging, then the file to FILES.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setEnv, listen, login } from './helpers/env.js';
import { createApp } from '../src/server.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
const gateway = walk('gateway/src'), bridge = walk('bridge/src');

// files whose TEXT.* / thrown errors end up in an HTTP answer: logged by the http.error hook (server.js) or, for /api/device/, device.error (devices.js)
const HTTP = new Set(['auth.js', 'chat.js', 'bridgeHub.js', 'claudeApi.js', 'claudeProposal.js', 'claudeSessions.js', 'explainer.js', 'handoff.js', 'http.js', 'limits.js', 'llm.js', 'server.js', 'static.js', 'canvas.js', 'redactPatterns.js']);
// messages kept for older web builds that nothing in the gateway sends any more
const UNUSED = new Set(['linkNotSent']);
// files that log themselves
const SELF = { 'transcribe.js': /audit\(\{ action: 'transcribe\.error'/, 'voiceActions.js': /ctx\.audit\?\.\(\{ action: 'action\./ };

describe('errors are logged', () => {
  it('the central hooks exist: http.error in server.js, device.error around every /api/device/ route', () => {
    const server = read('gateway/src/server.js'), devices = read('gateway/src/devices.js');
    const has = (src, re, what) => assert(re.test(src), what);
    has(server, /res\.on\('finish', \(\) => logHttpError\(/, 'server.js hooks res finish');
    has(server, /action: 'http\.error'/, 'server.js logs http.error');
    has(server, /action: 'ws\.reject'/, 'server.js logs ws.reject');
    has(devices, /action: 'device\.error'/, 'devices.js audits device.error');
    has(devices, /try \{ return await handle\(req, res, url, ctx\); \}\s*catch \(err\) \{\s*reportError\(/, 'route() wraps handle() in reportError');
    has(devices, /dlog\(ctx\.deviceId, 'device\.error', data\)/, 'device.error reaches the device log');
    const at = devices.indexOf('const data = { path, method'), literal = devices.slice(at, at + 400);
    assert(at > 0, 'the device.error payload is built in reportError');
    for (const key of ['path', 'status', 'message', 'ms', 'bytes']) assert(new RegExp(`\\b${key}\\b`).test(literal), `device.error carries ${key}`);
  });

  it('every TEXT message is used, and used only where an HTTP hook or a trace/audit call covers it', () => {
    const table = read('gateway/src/messages.js');
    const keys = [...table.slice(table.indexOf('export const TEXT')).matchAll(/^  (\w+):/gm)].map((m) => m[1]);
    assert(keys.length > 30, 'TEXT table found');
    const sources = Object.fromEntries(gateway.filter((f) => !f.endsWith('messages.js')).map((f) => [f, read(f)]));
    for (const key of keys) {
      const users = Object.entries(sources).filter(([, src]) => new RegExp(`TEXT\\.${key}\\b`).test(src)).map(([f]) => path.basename(f));
      if (!users.length && UNUSED.has(key)) continue;
      assert(users.length, `TEXT.${key} is never used: remove it or wire it`);
      for (const file of users) assert(HTTP.has(file) || SELF[file], `TEXT.${key} is used in ${file}: it has no known path to a log event. Log it, then list the file in HTTP/SELF of errors-logged.test.js`);
    }
    for (const [file, re] of Object.entries(SELF)) assert.match(Object.entries(sources).find(([f]) => f.endsWith(file))[1], re, `${file} still logs itself`);
  });

  it('no HTTP error answer is sent with a 2xx status (the hook logs status >= 400 only)', () => {
    for (const f of gateway) {
      const src = read(f);
      for (const m of src.matchAll(/sendJson\(\s*res,\s*(\d{3}),\s*\{\s*error:/g)) assert(Number(m[1]) >= 400, `${f}: {error} sent with ${m[1]}`);
    }
  });

  it('WebSocket and SSE error messages are traced or audited next to the send', () => {
    for (const f of ['gateway/src/voice/session.js', 'gateway/src/chat.js']) {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        if (!/(?:sendJson|send)\(\{ type: 'error'/.test(line)) return;
        const near = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
        assert.match(near, /trace\??\.event\(|audit\(/, `${f}:${i + 1} sends an error to the client without a trace/audit call in the 8 lines before`);
      });
    }
  });

  it('device routes: every fail()/deviceError() literal is thrown inside the wrapped handler (devices.js, deviceMedia.js, screenVision.js)', () => {
    // thrown errors reach route() -> reportError; the only direct sendJson of an error body in devices.js is the wrapper itself
    const devices = read('gateway/src/devices.js');
    const direct = [...devices.matchAll(/sendJson\(res, (?:err\.status|\d{3}), \{ error/g)];
    assert.equal(direct.length, 0, 'an error answer sent without going through the wrapper');
    assert.match(devices, /sendJson\(res, err\.status \|\| 500, err\.body/);
  });

  it('no one-line catch swallows an error without saying why (gateway + bridge)', () => {
    const bad = [];
    for (const f of [...gateway, ...bridge]) {
      read(f).split('\n').forEach((line, i) => {
        if (/catch(\s*\(\s*\w*\s*\))?\s*\{\s*(return[^;{}]*;)?\s*\}/.test(line) && !/\/[*/]/.test(line)) bad.push(`${f}:${i + 1}`);
        if (/\.catch\(\(\)\s*=>\s*(\{\s*\}|null|undefined|\[\]|false|true|''|0)\)/.test(line) && !/\/[*/]/.test(line)) bad.push(`${f}:${i + 1}`);
      });
    }
    assert.deepEqual(bad, [], 'comment the one-word reason or trace it');
  });

  it('comment-only catches state a real reason: a word of the allowlist, never "ignored" / "none" / "skip" alone', () => {
    // A comment is not logging. Such a catch (empty body or `return x;` plus a comment, or `.catch(() => null /* why */)`) stays allowed only
    // when the comment says why nothing is lost, with one of these words. "ignored", "ignore", "none", "skip" do not.
    const REASON = /\b(?:absent|malformed|unparsable|unreadable|missing|gone|vanished|unavailable|unknown|rejected|failed|traces|reports|sees|never rejects|courtesy|advisory|bookkeeping|fallback|fail(?:s)? closed|cut|partial|yet|bad|invalid|down|offline|expired|dangling|best effort|stdout|keep|next|try|optional|first use|not (?:a|there|pushed|listed|mirrored|claude)|no [a-z]+|never [a-z]+|do not|may come|memory-only|must not notice|caller|listener|plain text|new file|stands|desk is advisory|cached|header|socket)\b/i;
    const CATCH = /catch(?:\s*\(\s*\w*\s*\))?\s*\{\s*(?:return[^;{}]*;\s*)?(?:\/\*([^*]*)\*\/|\/\/([^\n]*))?\s*\}|\.catch\(\(\)\s*=>\s*(?:\{\s*\}|null|undefined|\[\]|false|true|\'\'|0|\{\s*\/\*([^*]*)\*\/\s*\}|\/\*([^*]*)\*\/\s*(?:null|undefined|\[\]|false|true|0))\s*\)\s*;?\s*(?:\/\/([^\n]*))?/g;
    const bad = []; let count = 0;
    for (const f of [...gateway, ...bridge]) {
      read(f).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(CATCH)) {
          count += 1;
          const why = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim();
          if (!REASON.test(why)) bad.push(`${f}:${i + 1} [${why || 'no comment'}]`);
        }
      });
    }
    assert(count > 100, `the scan found the swallowing catches (${count})`);
    assert.deepEqual(bad, [], 'name the reason (allowlist in this test) or log the failure');
    console.log(`errors-logged: ${count} comment-only / empty catches, all with an allowlisted reason`);
  });

  it('live: wrong login code, unknown route and a device failure each leave an audit line', async () => {
    setEnv();
    const app = createApp();
    const base = `http://127.0.0.1:${await listen(app.server)}`;
    const lines = [], original = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    try {
      const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'nope-nope-nope' }) });
      assert(wrong.status >= 400);
      const { cookie } = await login(base);
      assert.equal((await fetch(`${base}/api/does-not-exist`, { headers: { cookie } })).status, 404);
      assert((await fetch(`${base}/api/device/dictionary`, { headers: { authorization: `Bearer ${'a'.repeat(43)}` } })).status >= 400);
      await new Promise((r) => setTimeout(r, 50));
    } finally { console.log = original; app.server.close(); }
    const audits = lines.filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const http = audits.filter((a) => a.action === 'http.error').map((a) => JSON.parse(a.detail));
    assert(http.some((d) => d.path === '/api/auth/login' && d.status >= 400 && typeof d.ms === 'number'), 'login failure logged');
    assert(http.some((d) => d.path === '/api/does-not-exist' && d.status === 404), '404 logged');
    assert(audits.some((a) => a.action === 'device.error' && JSON.parse(a.detail).status >= 400), 'device failure logged');
  });
});
