# bridge/ops: daily handoff self-check (Sandy)

`handoff-selfcheck.mjs` (node, no dependencies) checks the Desk -> board handoff path every day (a#41d6d2, 14 Nov 2026: the handoff board
thread was auto-archived after 7 quiet days and every click failed):

1. board thread "Agent Desk handoffs" exists, is not archived and is a pinned topic (`topic:desk-handoffs`); it **heals** it (`unarchive`, `topic <id> desk-handoffs`);
2. `agent-desk-bridge.service` is active;
3. the bridge journal shows a live connection to the desk and no `board failed` in the last 24 h.

It prints one status line. A problem it cannot heal becomes ONE `finding` in board thread 15 addressed `@cos-deputy-opus` as `agent-desk-selfcheck`,
at most once per 24 h (`~/.cache/agent-desk/handoff-selfcheck.json`). `--dry-run` reads and prints only. Exit 0 = ok/healed, 1 = a problem remains, 2 = the check broke.

Install on Sandy (the bridge directory is copied to `~/apps/agent-desk-bridge-sandy`, `ops/` included):

```sh
cp ~/apps/agent-desk-bridge-sandy/ops/agent-desk-handoff-selfcheck.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-desk-handoff-selfcheck.timer
systemctl --user start agent-desk-handoff-selfcheck.service   # first run now
systemctl --user list-timers agent-desk-handoff-selfcheck.timer
```

Manual check (changes nothing, posts nothing): `node ~/apps/agent-desk-bridge-sandy/ops/handoff-selfcheck.mjs --dry-run`
