import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fakeGateway } from './helpers.js';
import { syn } from './synthetic.js';

// sandbox.exec (src/sandbox.js): a read-only bubblewrap shell over the scrubbed corpus. Needs bwrap with unprivileged user
// namespaces (Sandy, Ubuntu 22.04); LeChonk (24.04) blocks them and the file skips there.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-home-'));
const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-corpus-'));
process.env.BRIDGE_HOME = home;
process.env.BRIDGE_CORPUS_DIR = corpus;
const CANARY = 'CANARY-not-a-secret-8f3a1c';
fs.mkdirSync(path.join(home, '.config'), { recursive: true });
fs.writeFileSync(path.join(home, '.config', 'dev-secrets.env'), `OPENAI_API_KEY=${CANARY}\n`);

const put = (rel, text) => { const p = path.join(corpus, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const SECRET = syn('sk-pro·j-AbCdEf0123456789xyzXYZ0123456789abcdefQQ');
put('jobs/home/flori/jobs/demo-20261101/RESULT.md.txt', '# /home/flori/jobs/demo-20261101/RESULT.md | updated 2026-11-01T10:00:00Z\n\nDie Bewertungsphase dauert 36 Stunden und kostet USD 370.\n');
put('jobs/home/flori/jobs/demo-20261101/STATE.md.txt', '# /home/flori/jobs/demo-20261101/STATE.md | updated 2026-11-01T11:00:00Z\n\n- FINAL DONE\n');
put('board/22/1.txt', '# board/22/1 | updated 2026-11-13T10:00:00Z\n\nDecision: the scoring phase takes 36 hours.\n');
put('data/table.json', JSON.stringify({ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }));
put('data/leak.txt', `# data/leak.txt | updated 2026-11-14T10:00:00Z\n\nkey ${SECRET} end\n`);

const bwrapOk = (() => {
  const r = spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--', '/usr/bin/true'], { timeout: 10_000 });
  return r.status === 0;
})();
const skip = bwrapOk ? false : 'needs bubblewrap with unprivileged user namespaces (Sandy; LeChonk blocks them)';
const hasSqlite = spawnSync('sqlite3', ['--version']).status === 0;
if (hasSqlite) execFileSync('sqlite3', [path.join(corpus, 'data', 'small.db'), 'create table t(x integer); insert into t values (1),(2),(3);']);

const sandboxMod = await import('../src/sandbox.js');
const { buildMethods, METHOD_TIMEOUT_MS, startBridge } = await import('../src/bridge.js');
const { METHOD_PARAMS } = await import('../src/params.js');
const quiet = () => {};
const sb = sandboxMod.createSandbox({ log: quiet });
const run = (command) => sb.exec({ command });
const out = async (command) => (await run(command)).output;
const envSet = (vars, fn) => async () => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const strayProcesses = (marker) => {
  const found = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(marker) && Number(pid) !== process.pid) found.push(pid); } catch { /* gone */ }
  }
  return found;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(corpus, { recursive: true, force: true }); });

// ---- registration ---------------------------------------------------------------------------------------------------------

test('sandbox.exec is registered on the Sandy bridge only, declared in METHOD_PARAMS, with a 35 s budget', () => {
  assert.ok('sandbox.exec' in buildMethods({}, 'sandy'));
  assert.ok(!('sandbox.exec' in buildMethods({}, 'lechonk')));
  assert.deepEqual(METHOD_PARAMS['sandbox.exec'], { command: 'string' });
  assert.equal(METHOD_TIMEOUT_MS['sandbox.exec'], 35_000);
  const { LIMITS } = sandboxMod;
  assert.ok(LIMITS.queueWaitMs + 3_000 + LIMITS.wallMs + 2_000 <= METHOD_TIMEOUT_MS['sandbox.exec'], 'queue wait + probe + wall clock + kill grace fit the method budget');
});

test('the bubblewrap line is pinned: only /usr, /etc/alternatives and the corpus are bound', () => {
  assert.deepEqual(sandboxMod.bwrapArgs('/some/corpus'), [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'HOME', '/tmp',
    '--ro-bind', '/usr', '/usr', '--tmpfs', '/usr/local',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--ro-bind', '/etc/alternatives', '/etc/alternatives',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
    '--ro-bind', '/some/corpus', '/data', '--chdir', '/data', '--',
  ]);
});

// ---- input and availability -------------------------------------------------------------------------------------------------

test('input: NUL, too long, empty and non-string commands are refused; exactly 2,000 characters pass', { skip }, async () => {
  await assert.rejects(run('echo a\0b'), /NUL/);
  await assert.rejects(run('x'.repeat(2001)), /too long/);
  await assert.rejects(run('   \n '), /empty/);
  await assert.rejects(sb.exec({ command: 42 }), /must be a string/);
  await assert.rejects(sb.exec({}), /must be a string/);
  const r = await run(`echo ok #${'x'.repeat(2000 - 'echo ok #'.length)}`);
  assert.equal(r.output, 'ok\n');
});

test('refuses early and clearly when bwrap or the corpus is missing', envSet({ BRIDGE_SANDBOX_BWRAP: '/nonexistent/bwrap' }, async () => {
  await assert.rejects(run('echo hi'), /bubblewrap \(bwrap\) is not installed/);
}));
test('refuses early when the corpus directory is missing or empty', async () => {
  const old = process.env.BRIDGE_CORPUS_DIR;
  try {
    process.env.BRIDGE_CORPUS_DIR = path.join(os.tmpdir(), 'sbx-does-not-exist');
    await assert.rejects(run('echo hi'), /corpus copy is missing or empty/);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-empty-'));
    process.env.BRIDGE_CORPUS_DIR = empty;
    await assert.rejects(run('echo hi'), /corpus copy is missing or empty/);
    fs.rmSync(empty, { recursive: true });
  } finally { process.env.BRIDGE_CORPUS_DIR = old; }
});

// ---- what the command can do ------------------------------------------------------------------------------------------------

test('reads corpus files: cwd is /data, layout visible, exit code and stderr come back', { skip }, async () => {
  const r = await run('pwd; rg -l Bewertungsphase; cat board/22/1.txt | head -1; echo oops >&2; exit 3');
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
  assert.equal(r.truncated, false);
  assert.ok(r.ms >= 0 && r.ms < 5000, `${r.ms} ms`);
  assert.match(r.output, /^\/data\n/);
  assert.match(r.output, /jobs\/home\/flori\/jobs\/demo-20261101\/RESULT\.md\.txt/);
  assert.match(r.output, /# board\/22\/1 \| updated 2026-11-13/);
  assert.match(r.output, /oops/);
  assert.deepEqual(Object.keys(r).sort(), ['exitCode', 'ms', 'output', 'timedOut', 'truncated']);
});

test('the tools: python3 -I, rg, jq, sqlite3 -readonly, awk, sed, find, sort work on files in /data', { skip }, async () => {
  assert.equal(await out('python3 -I -c "import os; print(sum(len(f) for _,_,f in os.walk(\'.\')))"'), hasSqlite ? '6\n' : '5\n'); // the five text/json files, plus the sqlite db when the host has sqlite3
  assert.equal(await out('rg -c "36 Stunden" jobs | head -1'), 'jobs/home/flori/jobs/demo-20261101/RESULT.md.txt:1\n');
  assert.equal(await out('jq -c "[.rows[].a] | add" data/table.json'), '6\n');
  assert.equal(await out('awk "BEGIN{print 6*7}"'), '42\n');
  assert.equal(await out('echo "b a" | sed "s/b/c/" | tr " " "\\n" | sort | tr "\\n" ","'), 'a,c,');
  assert.equal(await out('find jobs -name "STATE.md.txt" | wc -l'), '1\n');
  assert.equal(await out('python3 -I -c "import json; print(len(json.load(open(\'data/table.json\'))[\'rows\']))"'), '3\n');
  if (hasSqlite) assert.equal(await out('sqlite3 -readonly data/small.db "select sum(x) from t"'), '6\n');
  const tools = (await out('for t in rg jq sqlite3 python3 awk gawk sed grep find xargs sort uniq wc head tail cut tr perl git tar gzip diff column comm join paste od xxd base64 nl fold rev tac shuf date seq stat du ls cat bash sh; do command -v $t >/dev/null && printf "%s " $t; done')).trim().split(' ');
  for (const t of ['rg', 'jq', 'sqlite3', 'python3', 'awk', 'sed', 'grep', 'find', 'xargs', 'sort', 'uniq', 'wc', 'head', 'tail', 'cut', 'tr', 'bash']) assert.ok(tools.includes(t), `${t} in the sandbox`);
  console.log(`# tools in the sandbox: ${tools.join(' ')}`);
});

test('read-only: /data cannot be changed, /tmp is a private scratch space that does not persist', { skip }, async () => {
  const r = await run('touch /data/new.txt; echo "rc1=$?"; echo x > /data/board/22/1.txt; echo "rc2=$?"; rm /data/board/22/1.txt; echo "rc3=$?"; mkdir /data/d; echo "rc4=$?"; cat /data/board/22/1.txt | head -1');
  assert.match(r.output, /rc1=1/);
  assert.match(r.output, /rc2=1/);
  assert.match(r.output, /rc3=1/);
  assert.match(r.output, /rc4=1/);
  assert.match(r.output, /# board\/22\/1/);
  assert.equal(await out('echo scratch > /tmp/a.txt && cat /tmp/a.txt'), 'scratch\n');
  assert.equal(await out('ls /tmp | wc -l'), '0\n');
  assert.equal(await out('touch /usr/x 2>&1 | head -1; echo done'), 'touch: cannot touch \'/usr/x\': Read-only file system\ndone\n');
  assert.ok(fs.existsSync(path.join(corpus, 'board/22/1.txt')), 'the corpus on the host is untouched');
});

test('no network: loopback listeners of the host, /dev/tcp, DNS and raw sockets are all unreachable', { skip }, async () => {
  const server = net.createServer((s) => s.end('host-secret')).listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const { port } = server.address();
  try {
    const py = `import socket
for host, p in (("127.0.0.1", ${port}), ("1.1.1.1", 53)):
    s = socket.socket(); s.settimeout(2)
    try:
        s.connect((host, p)); print("CONNECTED", host)
    except OSError as e:
        print("blocked", host, e.errno)
try:
    socket.getaddrinfo("example.com", 80); print("DNS-OK")
except OSError as e:
    print("no-dns")
`;
    const o = await out(`python3 -I -c '${py}'`);
    assert.doesNotMatch(o, /CONNECTED|DNS-OK/);
    assert.match(o, /blocked 127\.0\.0\.1/);
    assert.match(o, /no-dns/);
    const t = await run('(exec 3<>/dev/tcp/1.1.1.1/53) 2>&1; echo "rc=$?"; cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d " " | tr "\\n" ","');
    assert.match(t.output, /Network is unreachable/);
    assert.match(t.output, /rc=1/);
    assert.match(t.output, /lo,?$/); // only a loopback device that is down, nothing of the host
  } finally { server.close(); }
});

test('the host is invisible: no /home, no real home, no /run/user, no /var, own process table, own init', { skip }, async () => {
  const r = await run(`ls -A /home /run/user /var 2>&1 | wc -l; (ls -A /run; ls -A /tmp) | wc -l; echo "HOME=$HOME"; test -e ${JSON.stringify(home)} && echo HOME-VISIBLE; test -e /proc/${process.pid} && echo HOST-PID-VISIBLE; find / -path /proc -prune -o -name dev-secrets.env -print 2>/dev/null | head -3; ls /proc | grep -c '^[0-9]'; tr '\\0' ' ' < /proc/1/cmdline | cut -c1-24; echo; ls /etc; ls -A /usr/local | wc -l; ls /sys 2>&1 | head -1`);
  assert.doesNotMatch(r.output, /HOME-VISIBLE|HOST-PID-VISIBLE|dev-secrets/);
  const lines = r.output.split('\n');
  assert.equal(lines[0], '3', 'ls of /home, /run/user, /var: three "No such file" errors and nothing else');
  assert.equal(lines[1], '0', '/run and /tmp are empty');
  assert.equal(lines[2], 'HOME=/tmp');
  const procCount = Number(lines.find((l, i) => i > 2 && /^\d+$/.test(l)));
  assert.ok(procCount > 0 && procCount < 12, `${procCount} processes visible in /proc`);
  assert.match(r.output, /\n\S*bwrap --unshare\n/, '/proc/1 is bwrap\'s own init');
  assert.match(r.output, /\nalternatives\n0\nls: cannot access '\/sys'/);
});

test('the environment is empty: the bridge token and the bridge\'s variables never reach the command', { skip }, envSet({ BRIDGE_TOKEN: 'tok-do-not-leak-1234567', BRIDGE_SECRET_PROBE: 'probe-value-xyz' }, async () => {
  const r = await run('env | sort | tr "\\n" ";"; echo; tr "\\0" ";" < /proc/self/environ | head -c 300');
  assert.doesNotMatch(r.output, /tok-do-not-leak|probe-value|BRIDGE_/);
  assert.match(r.output, /HOME=\/tmp/);
  assert.match(r.output, /LANG=C\.UTF-8/);
  assert.match(r.output, /PATH=\/usr\/bin:\/bin/);
}));

test('abstract unix sockets of the host are unreachable (own network namespace), host path sockets do not exist', { skip }, async () => {
  const name = `\0sbx-abstract-${process.pid}`;
  let hits = 0;
  const server = net.createServer((s) => { hits += 1; s.end('hello'); }).listen(name);
  await new Promise((r) => server.on('listening', r));
  const sock = path.join(os.tmpdir(), `sbx-${process.pid}.sock`);
  const pathServer = net.createServer((s) => { hits += 1; s.end('hello'); }).listen(sock);
  await new Promise((r) => pathServer.on('listening', r));
  try {
    // sanity: the host's own socket answers
    const reply = await new Promise((resolve, reject) => { const c = net.connect(name); c.on('data', (d) => resolve(String(d))); c.on('error', reject); });
    assert.equal(reply, 'hello');
    const before = hits;
    const py = `import socket
for addr in ("\\0sbx-abstract-${process.pid}", ${JSON.stringify(sock)}):
    s = socket.socket(socket.AF_UNIX); s.settimeout(2)
    try:
        s.connect(addr); print("CONNECTED")
    except OSError as e:
        print("unreachable", e.errno)
`;
    const o = await out(`python3 -I -c '${py}'`);
    assert.doesNotMatch(o, /CONNECTED/);
    assert.equal((o.match(/unreachable/g) || []).length, 2);
    assert.equal(hits, before, 'the host servers saw no connection from the sandbox');
  } finally { server.close(); pathServer.close(); fs.rmSync(sock, { force: true }); }
});

// ---- limits ------------------------------------------------------------------------------------------------------------------

test('limits really apply: the scope on Sandy (read back from the cgroup), else prlimit', { skip }, async () => {
  const mode = await sandboxMod.limitsMode();
  console.log(`# limits mode on this host: ${mode}`);
  assert.ok(['scope', 'prlimit'].includes(mode));
  if (mode === 'scope') assert.equal(process.platform, 'linux');
});

for (const mode of ['scope', 'prlimit']) {
  test(`${mode}: a process bomb is capped at 64 tasks, killed at the wall clock, leaves nothing behind, the bridge stays usable`, { skip, timeout: 60_000 }, envSet({ BRIDGE_SANDBOX_LIMITS: mode, BRIDGE_SANDBOX_WALL_MS: '5000' }, async () => {
    const marker = `SBXBOMB${mode}${process.pid}`;
    const forks = await run(`: ${marker}; python3 -I -c 'import os, time
ok = fail = 0
for i in range(300):
    try:
        pid = os.fork()
    except OSError:
        fail += 1
        continue
    if pid == 0:
        time.sleep(30)
        os._exit(0)
    ok += 1
print("forked", ok, "refused", fail, flush=True)
time.sleep(30)'`);
    const m = /forked (\d+) refused (\d+)/.exec(forks.output);
    assert.ok(m, forks.output);
    assert.ok(Number(m[1]) <= 64, `forked ${m[1]} children, limit is 64 tasks`);
    assert.ok(Number(m[2]) > 100, `${m[2]} forks refused`);
    assert.equal(forks.timedOut, true, `forks run: ${JSON.stringify(forks)}`);
    assert.ok(forks.ms < 6500, `${forks.ms} ms`);
    // the classic bomb with a parent that stays alive: capped by the task limit, killed by the wall clock
    const bomb = await run(`: ${marker}b; :(){ :|:& };: ; sleep 30`);
    // ended by the wall clock, or earlier by the output cap: the refused forks print "retry: Resource temporarily unavailable" by the thousand
    assert.ok(bomb.timedOut || bomb.truncated, `bomb run: ${JSON.stringify(bomb).slice(0, 300)}`);
    assert.ok(bomb.ms < 6500, `${bomb.ms} ms`);
    // without a waiting parent the shell exits at once, and with it the namespace's init: every descendant dies with it
    const orphan = await run(`: ${marker}c; :(){ :|:& };:`);
    assert.equal(orphan.timedOut, false, `orphan run: ${JSON.stringify(orphan)}`);
    assert.ok(orphan.ms < 3000, `${orphan.ms} ms`);
    await sleep(1200);
    assert.deepEqual(strayProcesses(marker), [], 'no process of the sandbox survived');
    const alive = await run('echo alive');
    assert.equal(alive.output, 'alive\n', `alive run: ${JSON.stringify(alive)}`);
    assert.ok(alive.ms < 3000, `alive took ${alive.ms} ms`);
  }));

  test(`${mode}: a memory hog is stopped (2 GB against a 1 GB limit)`, { skip, timeout: 60_000 }, envSet({ BRIDGE_SANDBOX_LIMITS: mode, BRIDGE_SANDBOX_WALL_MS: '15000' }, async () => {
    const r = await run('python3 -I -c "x = b\'x\' * (2 * 1024**3); print(\'allocated\', len(x))"');
    assert.doesNotMatch(r.output, /allocated/);
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.ok((await run('echo alive')).output === 'alive\n');
  }));
}

test('an infinite loop is killed at the 20 s wall clock (the real value), exit code 124', { skip, timeout: 60_000 }, async () => {
  const marker = `SBXLOOP${process.pid}`;
  const r = await run(`: ${marker}; while :; do :; done`);
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, 124);
  assert.ok(r.ms >= 19_800 && r.ms < 21_500, `${r.ms} ms`);
  await sleep(800);
  assert.deepEqual(strayProcesses(marker), []);
  assert.equal((await run('echo alive')).output, 'alive\n');
});

test('output cap: 50,000 bytes, a cut marker, the command is stopped (yes does not run on)', { skip }, async () => {
  const marker = `SBXYES${process.pid}`;
  const y = await run(`: ${marker}; yes`);
  assert.equal(y.truncated, true);
  assert.equal(y.timedOut, false);
  assert.ok(y.ms < 3000, `${y.ms} ms`);
  assert.ok(Buffer.byteLength(y.output) <= 50_000 + 80, `${Buffer.byteLength(y.output)} bytes`);
  assert.ok(Buffer.byteLength(y.output) > 49_900);
  assert.match(y.output, /\[output cut at 50000 bytes; the command was stopped\]$/);
  await sleep(500);
  assert.deepEqual(strayProcesses(marker), []);
  const e = await run('head -c 120000 /dev/zero | tr "\\0" a; echo done');
  assert.equal(e.truncated, true);
  // exactly under the cap is not truncated
  const ok = await run('head -c 49999 /dev/zero | tr "\\0" b');
  assert.equal(ok.truncated, false);
  assert.equal(ok.output.length, 49_999);
  // a multi-byte character cut by the cap is dropped, not returned as a replacement character
  const u = await run('python3 -I -c "print(\'ä\' * 40000)"');
  assert.equal(u.truncated, true);
  assert.doesNotMatch(u.output, /�/);
  // stderr counts too
  const s = await run('head -c 80000 /dev/zero | tr "\\0" c >&2');
  assert.equal(s.truncated, true);
});

// ---- queue and rate limit -----------------------------------------------------------------------------------------------------

test('one run at a time: two more wait their turn, the fourth is refused as busy', { skip, timeout: 60_000 }, async () => {
  const t0 = Date.now();
  const calls = [1, 2, 3, 4].map((n) => run(`sleep 1; echo run${n}`).then((r) => ({ n, ok: true, r }), (e) => ({ n, ok: false, e })));
  const results = await Promise.all(calls);
  const refused = results.filter((x) => !x.ok);
  const done = results.filter((x) => x.ok);
  assert.equal(refused.length, 1);
  assert.match(refused[0].e.message, /sandbox busy: 1 command running and 2 waiting/);
  assert.deepEqual(done.map((x) => x.r.output.trim()).sort(), ['run1', 'run2', 'run3']);
  assert.ok(Date.now() - t0 >= 3000, 'the three accepted runs executed one after another');
  assert.deepEqual(sb.status(), { active: false, waiting: 0, runsLastHour: sb.status().runsLastHour });
});

test('a queued command gives up after the queue wait instead of overrunning the method budget', { skip, timeout: 60_000 }, envSet({ BRIDGE_SANDBOX_QUEUE_WAIT_MS: '700' }, async () => {
  const first = run('sleep 2; echo first');
  await sleep(150);
  await assert.rejects(run('echo second'), /sandbox busy: waited 1 s/);
  assert.equal((await first).output, 'first\n');
  assert.equal((await run('echo third')).output, 'third\n', 'the queue is clean afterwards');
}));

test('rate limit: at most N runs per hour, then a clear refusal (N = 120 by default, lowered here)', { skip }, envSet({ BRIDGE_SANDBOX_PER_HOUR: '3' }, async () => {
  const own = sandboxMod.createSandbox({ log: quiet });
  for (let i = 0; i < 3; i += 1) assert.equal((await own.exec({ command: `echo ${i}` })).output, `${i}\n`);
  await assert.rejects(own.exec({ command: 'echo 4' }), /sandbox rate limit: 3 runs per hour reached; try again in about \d+ min/);
  assert.equal(own.status().runsLastHour, 3);
  assert.equal(sandboxMod.LIMITS.perHour, 120);
  // refused calls (bad input, busy, rate limited) do not use up the budget
  await assert.rejects(own.exec({ command: '' }), /empty/);
  assert.equal(own.status().runsLastHour, 3);
}));

// ---- through the bridge ----------------------------------------------------------------------------------------------------------

test('through the Sandy bridge: the result is redacted like every other result, errors arrive as errors', { skip }, async () => {
  const gw = await fakeGateway();
  const bridge = startBridge({ url: gw.url, token: 'test-token-not-secret', host: 'sandy' });
  try {
    await gw.connected;
    assert.ok(gw.hello.caps.includes('sandbox.exec'));
    const r = await gw.call('sandbox.exec', { command: 'cat data/leak.txt' });
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.output, new RegExp(SECRET.slice(-24)), 'the secret-shaped value is masked on its way out');
    assert.match(r.output, /key .*end/);
    await assert.rejects(gw.call('sandbox.exec', { command: 'x\0y' }), /NUL/);
    await assert.rejects(gw.call('sandbox.exec', {}), /must be a string/);
  } finally { bridge.close(); await gw.close(); }
});
