#!/bin/bash
# Fixtures for job-secret-guard and the job-start call site (reliability N56). Runs anywhere; starts nothing
# (job-start only with --dry-run). Usage: bash ops/lechonk/test-job-secret-guard.sh
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"; G="$D/job-secret-guard"; F="$D/fixtures"
FAKE="fixture-value-$RANDOM$RANDOM"   # a would-be secret value; must never appear in any output
fail=0; n=0
check() { # name expected_exit actual_exit output [must_contain]
  n=$((n+1)); local ok=1
  [ "$2" = "$3" ] || ok=0
  [ -n "${5:-}" ] && ! grep -qF -- "$5" <<<"$4" && ok=0
  grep -qF -- "$FAKE" <<<"$4" && ok=0
  if [ $ok = 1 ]; then echo "ok   $1"; else echo "FAIL $1 (exit $3, want $2)"; echo "$4" | sed 's/^/     /'; fail=1; fi
}
run() { out=$(env -i PATH=/usr/bin:/bin "$@" 2>&1); rc=$?; }

# 1 metadata missing: started on LeChonk directly (no LECHONK_REMOTE, no keys) -> refused with a clear reason
run JOB_SECRET_GUARD_HOST=lechonk "$G" "$F/job-needs-keys"; check "missing metadata refuses" 2 $rc "$out" "not through lechonk-job"
# 2 metadata present: lechonk-job unit (LECHONK_REMOTE=1 + handed-over keys) -> allowed, silent
run JOB_SECRET_GUARD_HOST=lechonk LECHONK_REMOTE=1 GH_TOKEN="$FAKE" ELEVENLABS_API_KEY="$FAKE" "$G" "$F/job-needs-keys"
check "present metadata allows" 0 $rc "$out"; [ -z "$out" ] || { echo "FAIL present metadata is not silent"; fail=1; }
# 3 lechonk-job ran but handed over no secrets -> refused
run JOB_SECRET_GUARD_HOST=lechonk LECHONK_REMOTE=1 "$G" "$F/job-needs-keys"; check "lechonk-job without handover refuses" 2 $rc "$out" "handed over no secrets"
# 4 keys but no LECHONK_REMOTE (e.g. copied env) -> refused: only lechonk-job counts
run JOB_SECRET_GUARD_HOST=lechonk GH_TOKEN="$FAKE" "$G" "$F/job-needs-keys"; check "keys without lechonk-job refuse" 2 $rc "$out" "REFUSED"
# 5 declared no secrets
run JOB_SECRET_GUARD_HOST=lechonk "$G" "$F/job-no-keys"; check "SECRETS: none allows" 0 $rc "$out" "SECRETS: none"
run JOB_SECRET_GUARD_HOST=lechonk "$G" "$F/job-needs-keys" --no-secrets; check "--no-secrets allows" 0 $rc "$out" "--no-secrets"
# 6 Sandy: never blocks
run JOB_SECRET_GUARD_HOST=sandy "$G" "$F/job-needs-keys"; check "sandy passes" 0 $rc "$out"

# job-start call site (dry run; nothing is launched). Copy the fixture so job-start's realpath/PROMPT checks pass.
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cp -r "$F/job-needs-keys" "$T/n56-fixture-needs-keys"; cp -r "$F/job-no-keys" "$T/n56-fixture-no-keys"
JS() { out=$(env JOB_SECRET_GUARD="$G" GH_TOKEN="$FAKE" ELEVENLABS_API_KEY="$FAKE" LECHONK_REMOTE=1 bash "$D/job-start" "$@" --dry-run 2>&1); rc=$?; }
# caller's own keys and LECHONK_REMOTE do not reach a systemd --user unit, so a LeChonk start is still refused
JOB_SECRET_GUARD_HOST=lechonk JS "$T/n56-fixture-needs-keys"; check "job-start on lechonk refuses before launch" 2 $rc "$out" "Nothing was started"
grep -q '^DRY:' <<<"$out" && { echo "FAIL job-start printed a launch line after refusal"; fail=1; }
JOB_SECRET_GUARD_HOST=lechonk JS "$T/n56-fixture-no-keys"; check "job-start on lechonk allows SECRETS: none" 0 $rc "$out" "DRY:"
JOB_SECRET_GUARD_HOST=lechonk JS "$T/n56-fixture-needs-keys" --no-secrets; check "job-start --no-secrets allows" 0 $rc "$out" "DRY:"
JOB_SECRET_GUARD_HOST=sandy JS "$T/n56-fixture-needs-keys"; check "job-start on sandy unchanged" 0 $rc "$out" "DRY:"
out=$(env JOB_SECRET_GUARD=/nonexistent JOB_SECRET_GUARD_HOST=lechonk bash "$D/job-start" "$T/n56-fixture-needs-keys" --dry-run 2>&1); rc=$?
check "job-start fails closed without guard on lechonk" 2 $rc "$out" "job-secret-guard missing"
echo "$n checks, $([ $fail = 0 ] && echo all passed || echo FAILURES)"; exit $fail
