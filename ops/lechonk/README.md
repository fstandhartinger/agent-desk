# LeChonk job start guard (reliability N56, 3 Nov 2026)

A job started on LeChonk gets its secrets only through Sandy's `~/bin/lechonk-job`. It hands them over in a 0600
tmpfs file that the unit sources and deletes, and it sets `LECHONK_REMOTE=1`. A desk session on LeChonk once ran
`~/bin/job-start` locally. The job started with no keys and failed late: no ElevenLabs or OpenRouter (#41594, #41608).

- `job-secret-guard <jobdir> [--no-secrets]` checks its own environment. It exits 0 on hosts other than LeChonk,
  when the secret handover is present (`LECHONK_REMOTE=1` and at least one handed-over key), or when the job
  declares `SECRETS: none` in PROMPT.md or gets `--no-secrets`. Otherwise it exits 2 with a clear message that
  says how to start the job instead. It prints only variable names, never values.
- `job-start` is the copy installed as `~/bin/job-start`. On LeChonk it runs the guard with exactly the unit's
  environment before `systemd-run`, so it refuses before anything launches. If the guard is missing on LeChonk,
  `job-start` fails closed. On Sandy nothing changes.
- `bash ops/lechonk/test-job-secret-guard.sh` runs 12 fixture checks for missing and present metadata. It starts
  nothing; `job-start` runs only with `--dry-run`.

Install on LeChonk: `install -m 0755 ops/lechonk/job-secret-guard ~/bin/ && install -m 0775 ops/lechonk/job-start ~/bin/`.
The same two files are safe on Sandy, where the guard is a no-op. Installing them there keeps a later ~/bin parity copy
from dropping the guard.
