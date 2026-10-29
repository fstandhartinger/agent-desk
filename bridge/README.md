# Agent Desk bridge

LeChonk side of Agent Desk (`docs/SPEC.md`, "Bridge protocol" and "Claude Code sessions"). It dials **out** to the
gateway (`wss://desk.app.mintapis.com/bridge`), answers read-only context requests and runs Claude Code sessions.
It holds no vendor keys; the only secret is `BRIDGE_TOKEN`, and the `claude` children never see it.

| module | job |
|---|---|
| `src/bridge.js` | WS client, request dispatch, ping/pong 20 s, reconnect 1→30 s with jitter |
| `src/paths.js`, `src/ctx.js` | allowlist (lexical check first, then realpath; segment-based deny list), `ctx.core/search/read/list/decisionsToday` |
| `src/params.js` | accepted parameters of every method; the gateway contract test checks the tool definitions against it |
| `src/redact.js` | `redact()` applied to every string that leaves the bridge |
| `src/jobs.js`, `src/board.js`, `src/chats.js` | `jobs.*`, `board.*` (read-only `agent-board` relay), `chats.*` |
| `src/claude.js`, `src/events.js`, `src/prompt.js` | Claude Code sessions, stream-json normalisation, PROMPT.md |
| `src/audit.js` | `~/desk-audit/YYYY-MM-DD.jsonl` (0600) |

Claude turns write stream-json to `~/desk-sessions/<sid>/turn-N.out` and the bridge tails the file, so a running turn
keeps going and is re-attached when the bridge restarts (`KillMode=process`).

## Install (systemd --user)

```bash
cd ~/apps/agent-desk-bridge && npm ci --omit=dev
mkdir -p ~/.config/agent-desk && chmod 700 ~/.config/agent-desk
cat > ~/.config/agent-desk/bridge.env <<'ENV'
DESK_URL=wss://desk.app.mintapis.com/bridge
BRIDGE_TOKEN=<same value as the gateway's BRIDGE_TOKEN>
BRIDGE_HOST=lechonk
ENV
chmod 600 ~/.config/agent-desk/bridge.env
mkdir -p ~/.config/systemd/user && cp systemd/agent-desk-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now agent-desk-bridge
journalctl --user -u agent-desk-bridge -f
```

Adjust `ExecStart` if the checkout lives elsewhere. `loginctl enable-linger $USER` keeps the service running without a login.

## Tests

`npm test` (Node 20 or 24). The end-to-end test starts a fake gateway on a random port and makes two real Claude calls
(Sonnet, a few cents); `SKIP_REAL_CLAUDE=1 npm test` skips them.

## Notes

- Job searches (`ctx.search`, scopes `jobs`/`all`) cover the newest 40 job folders to depth 2; ripgrep over the whole
  NFS jobs tree takes minutes. Use `jobs.get` / `ctx.read` for anything older.
- `BRIDGE_HOME`, `DESK_SESSIONS_DIR`, `DESK_AUDIT_DIR`, `CLAUDE_BIN` exist for tests only.

## Second instance on Sandy (host `sandy`, 28 Oct 2026)

The same code runs on Sandy with `BRIDGE_HOST=sandy` and serves a different, allowlisted method set (`buildMethods` in
`src/bridge.js`): shared read methods (`ctx.*`, `jobs.*`, `board.threads/read/search`, `chats.search/recent/read`,
`skills.list/read`, `ledger.entries`, `code.outline`) plus `discord.list/read` (home-IP Chrome, own tab, read-only),
`mail.search/read` (IMAP read-only, BODY.PEEK), `ops.run` (fixed read-only command map) and `board.handoff`
(the only write; gateway calls it only after the human's click). No Claude sessions, no login-link notifier, no audit sink.
Install: copy `bridge/` to `~/apps/agent-desk-bridge-sandy`, `npm ci --omit=dev`, install
`systemd/agent-desk-bridge-sandy.service` as `~/.config/systemd/user/agent-desk-bridge.service`, put the token in
`~/.config/agent-desk/bridge.env`, then enable. Mail passwords are read from `~/.config/dev-secrets.env` by the mail child
process only (the bridge environment never holds them). The gateway must wait >= 85 s for `discord.*`
(`METHOD_TIMEOUT_MS`).

## Secret redaction and the fragment hash file (critic round 3, 28 Oct 2026)

Every string that leaves the bridge passes `redact()` (`src/redact.js`): exact known values first, then the shape patterns
(`src/redactPatterns.js`, byte-identical with the gateway copy), then 16-char **fragments** of known values.

- **Known values** (`src/secretValues.js`, `secretSources()`): the secret stores of the host are **discovered**, not listed
  (critic round 5). The whole home directory is walked (files up to `~/a/b/c/d/e/f/<file>`, 7 levels since critic round 6). Pruned: dependency trees, VCS data,
  venvs, caches, browser profiles, `~/jevbench-sealed`, and the desk's read targets `~/jobs`, `~/.claude*/projects` and
  `~/.codex/{sessions,archived_sessions}`.
  - **A store is** any of these (code and doc extensions such as `.py`, `.js`, `.sh`, `.md`, `.service`, `.pub` and
    `known_hosts` never are): a file named `.env*`, `*.env*`, `*token*`, `*secret*`, `*passw*`, `*credential*`,
    `*api-key*`, `*.key`, `*.pem`, `id_*`, `.npmrc`, `.netrc`, `.git-credentials`, `rclone.conf`, `config.ini`, or a
    JSON auth/token/accounts file or `.claude.json`. Every file below `~/.ssh`, `~/.mcp-auth`, `~/.bittensor/wallets`,
    `~/.bonsai-autoscale`, `~/.secrets*`, `~/.antseed*`, `~/.claude*/accounts`, `~/.aws` and `~/.kube` counts too, and so
    does every file in a directory named `private`, `.private`, `secrets` or `credentials`.
  - **Rescans:** the walk takes about 0.6–1.1 s on Sandy (about 850 stores). It runs at bridge start (logged as
    `secret stores: N files found in M ms`) and again every 30 min in the background. In between, the store files and
    their directories are re-stat'ed every 5 s, so a new file next to a known store is picked up within seconds.
  - **Reading:** each file is read by kind:
    - JSON: string values of secret-looking keys, nested; wallet files without an extension too (`privateKey`,
      `secretSeed`, `secretPhrase`); `{"name": "<SECRET_NAME>", "value": …}` env lists and cookie objects.
    - netrc, git-credentials and gh hosts: the password or token part. `.npmrc`: `_authToken`.
    - PEM and OpenSSH private keys: the key body lines.
    - env: all entries, but only when the file is KEY=VALUE-shaped.
    - INI / TOML (with `[sections]`) / YAML (also `key: >-` folded values): secret-named keys only.
    - Token files: single-token lines, up to 4 kB.
    - Scripts (`#!`) are skipped.
  - **Strict stores:** outside the host's secret directories and the home root (project folders, code checkouts), only
    secret-named entries count, and only with a random-looking value (letters with digits, 12+ chars, or mixed case,
    16+). Test fixtures and config values in checkouts therefore stay out.
  - **Environment:** secret-looking names in the bridge's own environment count too.
  - **Length:** password-named values count from 8 chars, others from 12.
  - **Skipped as non-secrets:**
    - names ending in `_USER`, `_USERNAME`, `_EMAIL`, `_ENDPOINT`, `_ID`, `_HOST`, `_PORT`, `_REGION`, `_IP`, `_URI`,
      `_DATE`, `_AT`, `_TIME`, `_TYPE`, `_NAME`, `_SCOPES`, `_SUPPORTED`, `_METHODS`, `_CLASS`, and `*PUBLIC*` /
      `*PUBLISHABLE*` names
    - `*_URL` without `user:pass@`
    - config-looking values, ISO timestamps, placeholders (`<…>`, `${…}`), snake/kebab words (`client_secret_basic`) and
      plain words under 16 chars without digits
    - values that occur in the git remotes or `~/.gitconfig` (and, for the hash file, in the public repo)
- **Fragments**: salted SHA-256 hashes of every 16-char window of every value (windows of token characters with a digit
  or both letter cases). Outgoing text is scanned with a sliding window (keyed rolling-hash pre-filter, then SHA-256), so a
  cut snippet holding only part of a value is masked (about 15 ms per 200 kB).
- **Hash file** `~/.config/agent-desk/secret-windows.json` (0600, salted hashes only, never a value): built on **Sandy**
  from Sandy's secret stores, pushed to **LeChonk** (same path) so the LeChonk bridge also masks Sandy secrets that show
  up in LeChonk transcripts. Both bridges reload it when its mtime changes (checked every 5 s).
- **Push** (`src/windowSync.js`): the Sandy bridge (`BRIDGE_HOST=sandy`) checks every 5 min (and at start) whether a
  store is newer than the hash file. If the value set changed, it rebuilds the file (a digest of the whole set is kept in
  the file, so a store that was only touched, such as `~/.claude.json`, costs no rebuild and no push) and pushes it to LeChonk over the ssh alias `lechonk`
  (`BRIDGE_WINDOW_PUSH=<alias>`, `off` = rebuild only): `scp` to a `.tmp` name, then `chmod 600` + `mv`. It also pushes when
  the file differs from the last pushed one (`secret-windows.json.pushed` keeps its SHA-256) and at least every 12 h. A
  failed push is logged and retried on the next tick; it never stops the bridge. The LeChonk bridge logs
  `WARNING secret-windows.json ... old (> 24 h)` (or `missing`) at start and every 6 h.
- **Manual refresh** (e.g. before the first deploy of the push):

  ```bash
  node ~/apps/agent-desk-bridge-sandy/scripts/build-secret-windows.mjs   # prints counts only
  scp -p ~/.config/agent-desk/secret-windows.json lechonk:.config/agent-desk/secret-windows.json
  ssh lechonk chmod 600 .config/agent-desk/secret-windows.json
  ```

  From a full checkout the script also skips values that occur in the public repo (the bridge's own rebuild skips the git
  remotes and `~/.gitconfig` only).
- **Chats** (`src/chats.js`): snippets are cut from text that is already redacted (2000 chars of context around the hit),
  a cut that starts or ends mid-token drops the partial token, and lines that look like an environment dump (>= 3
  `NAME=value` pairs, `declare -x`, `os.environ` / `environ({` reprs, JSON with >= 3 UPPER_SNAKE keys, runs of >= 3
  `NAME=value` lines) are shown as `[Umgebungsvariablen ausgeblendet]`. `chats.read` renders only the requested page, the
  same way (redact, then clip).
