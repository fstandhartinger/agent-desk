import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syn } from './synthetic.js';

// Sandy-side bridge methods with synthetic fixtures: skills, ops, mail, discord, board handoff, deny list, method sets.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sandy-'));
const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-stubs-'));
const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mail-'));
process.env.BRIDGE_HOME = home;
process.env.BRIDGE_TOKEN = 'secret-token-for-leak-test';
const paths = await import('../src/paths.js');
const skills = await import('../src/skills.js');
const ops = await import('../src/ops.js');
const mail = await import('../src/mail.js');
const discord = await import('../src/discord.js');
const board = await import('../src/board.js');
const { buildMethods, METHOD_TIMEOUT_MS } = await import('../src/bridge.js');
const { redact } = await import('../src/redact.js');

const write = (rel, text, mode) => {
  const p = path.isAbsolute(rel) ? rel : path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, mode ? { mode } : undefined);
  return p;
};
const script = (name, body) => write(path.join(stubs, name), `#!/bin/bash\n${body}\n`, 0o755);

// ---- deny list --------------------------------------------------------------------------------------------------------

test('deny list: secrets, notify store, browser profiles, cookie DBs, git credentials, env files', () => {
  const denied = [
    '.config/dev-secrets.env', '.notify/telegram.json', '.hermes/hermes.env', '.hermes/gateway/discord.env',
    '.config/google-chrome/Default/Cookies', '.config/home-browser/Default/Login Data', 'x/chromium/Default/Web Data',
    '.mozilla/firefox/abc.default/cookies.sqlite', '.mozilla/firefox/abc.default/places.sqlite', 'any/Cookies-journal',
    '.git-credentials', '.config/agent-desk/bridge.env', '.config/foo/secrets.env', 'Dev/app/.env.local',
    '.config/Cursor/User/globalStorage/state.vscdb', 'x/key4.db', 'x/logins.json',
  ];
  for (const rel of denied) assert.equal(paths.isDenied(path.join(home, rel)), true, rel);
  const fine = ['jobs/cookie-banner-20261002/STATE.md', 'jobs/browser-extension-20261001/notes.md', 'jobs/chrome-ext-20261001/STATE.md', '.claude/skills/discord/SKILL.md', 'jobs/profile-pics-20261001/OUTPUT.md'];
  for (const rel of fine) assert.equal(paths.isDenied(path.join(home, rel)), false, rel);
});

test('deny list holds through resolveAllowed even inside allowed trees', () => {
  for (const rel of ['jobs/j1/Cookies', 'jobs/j1/dev-secrets.env', 'jobs/j1/.notify/x.md', 'jobs/j1/google-chrome/Default/notes.md', syn('jobs·/j1/·.git·-cre·dent·ials'), 'jobs/j1/places.sqlite']) {
    write(rel, 'x');
    assert.throws(() => paths.resolveAllowed(path.join(home, rel)), /not allowed or not found/, rel);
  }
  write('jobs/j1/notes.md', 'ok');
  assert.ok(paths.resolveAllowed(path.join(home, 'jobs/j1/notes.md')));
});

// ---- redaction (new patterns) -------------------------------------------------------------------------------------------

test('redact: cookies, one-time codes, reset links, env-style secrets, seed phrases, JWTs', () => {
  const cases = [
    'Set-Cookie: sessionid=abc123; Path=/',
    'Cookie: a=b; token=zzz',
    'Your verification code is 482913',
    'TAN 123456 für Ihre Überweisung',
    'PIN: 4711',
    'Einmalpasswort 556677',
    'open https://example.test/account/reset/9f8e7d6c5b4a39281706f5e4d3c2b1a0 now',
    syn('https://example.test/login?toke·n=ab·cd12·34'),
    syn('export STRI·PE_S·ECRE·T_KE·Y=wh·atev·er1'),
    'MY_SERVICE_TOKEN=abcdef',
    'password=abc',
    'seed phrase: abandon ability able about above absent absorb abstract absurd abuse access accident',
    ['eyJhbGciOiJIUzI1NiJ9', syn('eyJz·dWIi·OiIx·MjM0·NTY3·ODkw·In0'), 'abcdefghijk'].join('.'),
  ];
  for (const c of cases) {
    const out = redact(`before ${c} after`);
    assert.ok(out.includes('[REDACTED]'), `${c} -> ${out}`);
  }
  assert.equal(redact('MAX_TOKENS=4000 reicht.'), 'MAX_TOKENS=4000 reicht.');
  assert.equal(redact('Das Passwort-Feld ist leer. Code 5 ist ok. Seite 2023.'), 'Das Passwort-Feld ist leer. Code 5 ist ok. Seite 2023.');
  assert.ok(!redact('code 482913 is your pin 1234').includes('1234'));
});

// ---- skills -----------------------------------------------------------------------------------------------------------

test('skills.list / skills.read: names validated, files restricted, symlinked skills work, traversal refused', async () => {
  write('.agents/skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: Does demo things. api_key=supersecretvalue1\n---\n# Demo\nBody');
  write('.agents/skills/demo-skill/references/guide.md', 'guide text');
  write('.agents/skills/demo-skill/secret-notes.md', 'not listed');
  write('.agents/skills/other/SKILL.md', '---\nname: other\ndescription: Something else\n---\nx');
  fs.mkdirSync(path.join(home, '.claude/skills'), { recursive: true });
  fs.symlinkSync(path.join(home, '.agents/skills/demo-skill'), path.join(home, '.claude/skills/demo-skill'));
  fs.symlinkSync(path.join(home, '.agents/skills/other'), path.join(home, '.claude/skills/other'));
  fs.symlinkSync('/etc', path.join(home, '.claude/skills/evil'));
  const l = await skills.list({});
  assert.deepEqual(l.skills.map((s) => s.name), ['demo-skill', 'other']);
  assert.ok(!JSON.stringify(l).includes('supersecretvalue1'));
  assert.deepEqual((await skills.list({ query: 'else' })).skills.map((s) => s.name), ['other']);
  const r = await skills.read({ name: 'demo-skill' });
  assert.match(r.text, /# Demo/);
  assert.deepEqual(r.references, ['guide.md']);
  assert.equal((await skills.read({ name: 'demo-skill', file: 'references/guide.md' })).text, 'guide text');
  for (const bad of [
    { name: '../other' }, { name: 'evil' }, { name: 'demo-skill', file: 'secret-notes.md' }, { name: 'demo-skill', file: '../other/SKILL.md' },
    { name: 'demo-skill', file: 'references/../../other/SKILL.md' }, { name: 'demo-skill', file: '/etc/passwd' }, { name: '' }, { name: 'a/b' }, { name: 'nope' },
  ]) await assert.rejects(skills.read(bad), /not allowed|file must|not found/, JSON.stringify(bad));
});

// ---- ops --------------------------------------------------------------------------------------------------------------

test('ops: fixed id -> argv map, unknown ids refused, no shell metacharacters ever reach an argv', () => {
  assert.deepEqual(Object.keys(ops.COMMANDS).sort(), ['asks_open', 'board_threads', 'disk', 'jobs_running', 'quota_status', 'sched_list']);
  for (const id of Object.keys(ops.COMMANDS)) {
    const argv = ops.buildArgv(id);
    assert.ok(path.isAbsolute(argv[0]), id);
    for (const word of ['send', 'delete', 'post', 'inbox', 'read', 'done', 'cancel', 'add', 'kill', 'stop', 'rm']) assert.ok(!argv.slice(1).includes(word), `${id} contains ${word}`);
  }
  for (const bad of ['rm -rf /', 'quota_status; id', '', undefined, null, 5, '__proto__', 'constructor', 'toString', 'quota_status ']) {
    assert.throws(() => ops.buildArgv(bad), /unknown command/, String(bad));
  }
});

test('ops.run: runs the mapped stub with a minimal environment, redacts, truncates', async () => {
  script('quota-pace', syn('echo "args:$* name:$AGENT_BOARD_NAME token:${BRI·DGE_TOKEN:-none}"; echo "api_key=abcdefghijkl"; head -c 20000 /dev/zero | tr "\\0" x'));
  process.env.BRIDGE_OPS_BIN_QUOTA_PACE = path.join(stubs, 'quota-pace');
  const r = await ops.run({ command: 'quota_status' });
  assert.match(r.text, /^args:status name:desk:bridge token:none/);
  assert.ok(!r.text.includes('abcdefghijkl'));
  assert.ok(r.text.length <= 8 * 1024 && r.truncated);
  await assert.rejects(ops.run({ command: 'quota_status --all' }), /unknown command/);
});

// ---- mail -------------------------------------------------------------------------------------------------------------

function setupMail() {
  fs.copyFileSync(new URL('./fixtures/fake_mail_tool.py', import.meta.url), path.join(mailDir, 'mail_tool.py'));
  write(path.join(mailDir, 'accounts.json'), JSON.stringify({ acme: { label: 'Acme', pass_env: 'FAKE_MAIL_PW', user: 'me@example.test' }, other: { label: 'Other', pass_env: 'FAKE_MAIL_PW2', user: 'o@example.test' } }));
  write(path.join(mailDir, 'dev-secrets.env'), 'export FAKE_MAIL_PW="pw-value"\nUNRELATED_SECRET=nope\n', 0o600);
  Object.assign(process.env, { BRIDGE_MAIL_DIR: mailDir, MAIL_TOOL_PATH: path.join(mailDir, 'mail_tool.py'), BRIDGE_MAIL_SECRETS: path.join(mailDir, 'dev-secrets.env') });
  fs.rmSync(path.join(mailDir, 'imap.log'), { force: true });
}
const imapLog = () => fs.readFileSync(path.join(mailDir, 'imap.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('mail argv builders only know list / search / read and cannot produce send, delete, junk, purge', () => {
  setupMail();
  const FORBIDDEN = ['send', 'delete', 'junk', 'purge', 'check', 'folders', 'accounts', '--expunge', '--attach', '--to', '--body'];
  const probes = [
    { account: 'acme', query: 'invoice', folder: 'INBOX', limit: 5 },
    { account: 'acme', query: 'send --to evil@example.test --body x', folder: 'INBOX' },
    { account: 'acme', query: '--expunge', limit: 'many' },
    { account: 'acme', query: 'x\ndelete 1 2 3' },
    { account: 'acme' },
  ];
  for (const p of probes) {
    const argv = mail.buildSearchArgv(p);
    const sub = argv[2];
    assert.ok(sub === 'list' || sub === 'search', sub);
    assert.equal(argv[0], '-I');
    for (const a of argv.slice(3)) assert.ok(a === p.account || a.startsWith('--folder=') || a.startsWith('--limit=') || a.startsWith('--text='), `loose arg ${a}`);
    for (const a of argv.slice(3).filter((x) => !x.startsWith('--text='))) assert.ok(!FORBIDDEN.includes(a), a);
    assert.ok(!argv.some((a) => /^--(?!folder=|limit=|text=)/.test(a)), JSON.stringify(argv));
    assert.ok(!argv.some((a) => a.includes('\n')));
  }
  const rd = mail.buildReadArgv({ account: 'acme', uid: '42', folder: 'INBOX' });
  assert.deepEqual([rd[0], ...rd.slice(2)], ['-I', 'acme', '42', '--folder=INBOX']);
  for (const bad of ['1; send', '-1', '1 2', '', 'abc', undefined]) assert.throws(() => mail.buildReadArgv({ account: 'acme', uid: bad }), /uid must be numeric/);
  for (const f of ['../x', '-bad', 'a;b', 'x'.repeat(80)]) assert.throws(() => mail.buildSearchArgv({ account: 'acme', folder: f }), /invalid folder/);
});

test('mail.search lists newest first, per account, with an unknown account refused', async () => {
  setupMail();
  const r = await mail.search({ account: 'acme', limit: 2 });
  assert.deepEqual(r.messages.map((m) => m.uid), ['9', '7']);
  assert.equal(r.messages[0].account, 'acme');
  assert.ok(r.messages[0].subject.includes('[REDACTED]'), r.messages[0].subject); // "verification code 123456" in a subject
  const q = await mail.search({ account: 'acme', query: 'matching' });
  assert.equal(q.messages.length, 1);
  const log = imapLog();
  assert.ok(log.some((l) => l[0] === 'cli' && l[1] === 'search' && l.includes('--text=matching')));
  await assert.rejects(mail.search({ account: 'nobody' }), /unknown account/);
  await assert.rejects(mail.search({ account: 'acme; rm' }), /unknown account/);
});

test('mail.read: EXAMINE + BODY.PEEK only (never marks seen), body redacted, attachments by name, no secrets in the child env', async () => {
  setupMail();
  const r = await mail.read({ account: 'acme', uid: '7' });
  assert.equal(r.subject, 'Hello synthetic');
  assert.match(r.body, /Plain body/);
  assert.ok(!r.body.includes('482913') && !r.body.includes('abc123def'), r.body);
  assert.deepEqual(r.attachments, ['invoice.pdf']);
  const log = imapLog();
  const sel = log.find((l) => l[0] === 'select');
  assert.equal(sel[2], true, 'folder must be opened read-only (EXAMINE)');
  const cmds = log.filter((l) => l[0] === 'uid');
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0][1], 'fetch');
  assert.match(cmds[0][3], /BODY\.PEEK\[\]/);
  assert.ok(!log.some((l) => l[0] === 'uid' && /store|copy|expunge/i.test(String(l[1]))));
  assert.ok(!cmds.some((c) => /RFC822(?!\.)|BODY\[/.test(c[3].replace(/BODY\.PEEK\[/g, ''))), 'plain RFC822 / BODY[] would set \\Seen');
  const login = log.find((l) => l[0] === 'login');
  assert.deepEqual(login.slice(1), ['pw-present', 'token-clean']);
  await assert.rejects(mail.read({ account: 'acme', uid: 'x' }), /uid must be numeric/);
});

test('mail.read truncates bodies at 20k characters', async () => {
  setupMail();
  const tool = fs.readFileSync(path.join(mailDir, 'mail_tool.py'), 'utf8').replace('m.set_content("Plain body.', 'm.set_content("Y" * 30000 + "Plain body.');
  fs.writeFileSync(path.join(mailDir, 'mail_tool.py'), tool);
  const r = await mail.read({ account: 'acme', uid: '7' });
  assert.ok(r.body.length <= 20000 && r.truncated);
});

// ---- discord ----------------------------------------------------------------------------------------------------------

test('discord channel validation', () => {
  for (const ok of ['@me/123456789012345678', '700000000000000001/700000000000000002']) assert.equal(discord.validateChannel(ok), ok);
  for (const bad of ['', '@me', '@me/12', '12345/6789', '@me/123456789012345678/extra', 'x/123456789012345678', '../123456789012345678/123456789012345678', '@me/123456789012345678\n', 'https://discord.com/channels/@me/123456789012345678', '@me/12345678901234567a', undefined]) {
    assert.throws(() => discord.validateChannel(bad), /channel must look like/, String(bad));
  }
});

test('discord steps: always a new own tab, only new_page / sleep / evaluate_script / close_page, never type or click', () => {
  const ALLOWED = new Set(['new_page', 'sleep', 'evaluate_script', 'close_page']);
  for (const steps of [discord.buildReadSteps('@me/123456789012345678', 500), discord.buildListSteps()]) {
    assert.deepEqual(steps.map((s) => s[0]), ['new_page', 'sleep', 'evaluate_script', 'close_page']);
    assert.ok(steps.every((s) => ALLOWED.has(s[0])));
    assert.equal(steps[0][1].url.startsWith('https://discord.com/channels/'), true);
    assert.equal(steps[2][1].pageId, '@new');
    assert.equal(steps[3][1].pageId, '@new');
    assert.ok(!/click\(|\.value\s*=|dispatchEvent|submit|keydown|execCommand|fetch\(|XMLHttpRequest|location\s*=|\.send\(/.test(steps[2][1].function));
  }
  assert.match(discord.buildReadSteps('@me/123456789012345678', 500)[2][1].function, /slice\(-50\)/);
  assert.match(discord.buildReadSteps('@me/123456789012345678', 7)[2][1].function, /slice\(-7\)/);
});

test('discord.read / list run the stub tool with a private 0600 step file, remove it afterwards, return redacted messages', async () => {
  const rows = [{ author: 'Alice', time: '2026-10-01T10:00:00.000Z', text: 'hello token=abcdefghijklmnop' }, { author: 'Bob', time: '2026-10-01T10:01:00.000Z', text: 'second' }];
  const chans = [{ channel: '@me/123456789012345678', label: 'Alice Example' }, { channel: '../evil', label: 'x' }];
  script('home-browser-call', `
f="\${1#@}"
cp "$f" "${stubs}/steps.copy"; stat -c %a "$f" > "${stubs}/steps.mode"; stat -c %a "$(dirname "$f")" > "${stubs}/dir.mode"; echo "$f" > "${stubs}/steps.path"
echo "$HOME_BROWSER_SESSION_WAIT" > "${stubs}/wait"
if grep -q '@me/",' "$f" || grep -q 'channels/@me"' "$f"; then
  echo '=== evaluate_script'; cat "${stubs}/list.out"
else
  echo '=== evaluate_script'; cat "${stubs}/read.out"
fi`);
  write(path.join(stubs, 'read.out'), `${JSON.stringify(JSON.stringify(rows))}\n`);
  write(path.join(stubs, 'list.out'), `${JSON.stringify(JSON.stringify(chans))}\n`);
  process.env.BRIDGE_DISCORD_BIN = path.join(stubs, 'home-browser-call');
  const r = await discord.read({ channel: '@me/123456789012345678', limit: 5 });
  assert.deepEqual(r.messages.map((m) => m.author), ['Alice', 'Bob']);
  assert.ok(!r.messages[0].text.includes('abcdefghijklmnop'));
  assert.equal(fs.readFileSync(path.join(stubs, 'steps.mode'), 'utf8').trim(), '600');
  assert.equal(fs.readFileSync(path.join(stubs, 'dir.mode'), 'utf8').trim(), '700');
  assert.ok(!fs.existsSync(fs.readFileSync(path.join(stubs, 'steps.path'), 'utf8').trim()), 'temp step file must be removed');
  const steps = JSON.parse(fs.readFileSync(path.join(stubs, 'steps.copy'), 'utf8'));
  assert.deepEqual(steps.map((s) => s[0]), ['new_page', 'sleep', 'evaluate_script', 'close_page']);
  assert.ok(Number(fs.readFileSync(path.join(stubs, 'wait'), 'utf8')) <= 60, 'a busy Chrome must fail fast, not wait 20 minutes');
  const l = await discord.list();
  assert.deepEqual(l.channels, [{ channel: '@me/123456789012345678', label: 'Alice Example' }]);
  await assert.rejects(discord.read({ channel: 'nonsense' }), /channel must look like/);
});

test('discord calls are serialized', async () => {
  script('home-browser-call-slow', `f="\${1#@}"; echo "start $$ $(date +%s%N)" >> "${stubs}/order.log"; sleep 0.3; echo "end $$ $(date +%s%N)" >> "${stubs}/order.log"; echo '=== evaluate_script'; cat "${stubs}/read.out"`);
  process.env.BRIDGE_DISCORD_BIN = path.join(stubs, 'home-browser-call-slow');
  await Promise.all([discord.read({ channel: '@me/123456789012345678' }), discord.read({ channel: '@me/123456789012345679' }), discord.read({ channel: '@me/123456789012345680' })]);
  const kinds = fs.readFileSync(path.join(stubs, 'order.log'), 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
  assert.deepEqual(kinds, ['start', 'end', 'start', 'end', 'start', 'end']);
});

// ---- board.handoff ----------------------------------------------------------------------------------------------------

function boardStub(missingThread) {
  const log = path.join(stubs, 'board.log');
  fs.rmSync(log, { force: true });
  const marker = path.join(stubs, 'thread-missing');
  fs.rmSync(marker, { force: true });
  if (missingThread) fs.writeFileSync(marker, '1');
  script('agent-board', `
printf '%s\\n' "$(node -e 'console.log(JSON.stringify({args: process.argv.slice(1), name: process.env.AGENT_BOARD_NAME}))' -- "$@")" >> "${log}"
case " $* " in
  *" post "*) if [ -f "${marker}" ]; then echo "agent-board: No thread matches 'Agent Desk handoffs'." >&2; exit 2; fi; echo "Posted entry #4242 to thread #9 Agent Desk handoffs." ;;
  *" new "*) rm -f "${marker}"; echo "Created thread #10 with entry #4243." ;;
  *) echo "#1 thread" ;;
esac`);
  process.env.BRIDGE_BOARD_BIN = path.join(stubs, 'agent-board');
  return () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('board.handoff posts ONE handoff entry as agent-desk to @cos-deputy-opus with the confirmed prefix', async () => {
  fs.rmSync(path.join(home, '.cache'), { recursive: true, force: true });
  const calls = boardStub(false);
  const r = await board.handoff({ title: 'Pruefe den Explainer', task: 'Bitte die Seite pruefen.\nZweite Zeile.', why: 'Florian hat es bestaetigt' });
  assert.deepEqual(r, { id: 4242, thread: 'Agent Desk handoffs' });
  const [c] = calls();
  assert.equal(calls().length, 1);
  assert.deepEqual(c.args.slice(0, 7), ['--as', 'agent-desk', 'post', '--kind', 'handoff', '--to', '@cos-deputy-opus']);
  assert.equal(c.args[7], 'Agent Desk handoffs');
  assert.ok(c.args[8].startsWith('Auftrag von Florian (Agent Desk, bestätigt)\n\n**Pruefe den Explainer**\n\nBitte die Seite pruefen.'));
  assert.match(c.args[8], /Warum: Florian hat es bestaetigt$/);
  assert.equal(c.name, 'agent-desk');
  assert.ok(!c.args.includes('--laptop-only'));
});

test('board.handoff creates the thread when it is missing, validates sizes, redacts secrets', async () => {
  fs.rmSync(path.join(home, '.cache'), { recursive: true, force: true });
  const calls = boardStub(true);
  const r = await board.handoff({ title: 'T', task: syn('password=hun·ter2hunter2 do it') });
  assert.equal(r.id, 4243);
  const c = calls();
  assert.equal(c.length, 2);
  assert.equal(c[1].args[2], 'new');
  assert.ok(!JSON.stringify(c).includes('hunter2'));
  await assert.rejects(board.handoff({ title: 'x'.repeat(121), task: 'y' }), /title required/);
  await assert.rejects(board.handoff({ title: 'x', task: 'y'.repeat(4001) }), /task required/);
  await assert.rejects(board.handoff({ title: '', task: 'y' }), /title required/);
  await assert.rejects(board.handoff({ title: 'x', task: '' }), /task required/);
  assert.equal(board.handoffText({ title: 'a', task: 'b' }), 'Auftrag von Florian (Agent Desk, bestätigt)\n\n**a**\n\nb');
});

test('board.handoff is limited to 10 per day inside the bridge as well', async () => {
  fs.rmSync(path.join(home, '.cache'), { recursive: true, force: true });
  const calls = boardStub(false);
  for (let i = 0; i < 10; i += 1) await board.handoff({ title: `t${i}`, task: 'do' });
  await assert.rejects(board.handoff({ title: 'eleventh', task: 'do' }), /limit reached/);
  assert.equal(calls().length, 10);
});

// ---- method sets per host -----------------------------------------------------------------------------------------------

test('host method sets: Sandy serves its allowlist only, host-specific methods stay on their host', () => {
  const sandy = Object.keys(buildMethods({}, 'sandy'));
  const lechonk = Object.keys(buildMethods({}, 'lechonk'));
  for (const m of ['discord.list', 'discord.read', 'mail.search', 'mail.read', 'ops.run', 'board.handoff', 'chats.search', 'chats.read', 'skills.list', 'skills.read', 'board.threads', 'ctx.search']) assert.ok(sandy.includes(m), m);
  for (const m of ['claude.start', 'claude.send', 'claude.stop', 'notify.loginLink', 'audit.append']) assert.ok(!sandy.includes(m), `sandy serves ${m}`);
  for (const m of ['discord.list', 'discord.read', 'mail.search', 'mail.read', 'ops.run', 'board.handoff']) assert.ok(!lechonk.includes(m), `lechonk serves ${m}`);
  for (const m of ['chats.read', 'skills.list', 'skills.read', 'claude.start']) assert.ok(lechonk.includes(m), m);
  assert.ok(METHOD_TIMEOUT_MS['discord.read'] >= 70_000);
  // the only write on any host
  const writers = [...sandy, ...lechonk].filter((m) => /handoff|send|post|delete|write|stop|start|append|loginLink/.test(m));
  assert.deepEqual([...new Set(writers)].sort(), ['audit.append', 'board.handoff', 'claude.send', 'claude.start', 'claude.stop', 'notify.loginLink']);
});

test('Sandy unit file pins BRIDGE_HOST=sandy, a memory cap and restarts, and contains no secrets', () => {
  const unit = fs.readFileSync(new URL('../systemd/agent-desk-bridge-sandy.service', import.meta.url), 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/bin\/env BRIDGE_HOST=sandy /m);
  assert.match(unit, /^MemoryMax=/m);
  assert.match(unit, /^Restart=always/m);
  assert.match(unit, /^EnvironmentFile=%h\/\.config\/agent-desk\/bridge\.env/m);
  assert.ok(!/BRIDGE_TOKEN\s*=/.test(unit));
});
