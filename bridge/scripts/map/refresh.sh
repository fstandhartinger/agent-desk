#!/usr/bin/env bash
# Map refresh (run by desk-map.timer every 15 minutes, LeChonk). Writes only ~/desk-knowledge/map.
# Runs build.mjs from the deployed bridge checkout (~/apps/agent-desk-bridge/scripts/map/), so a bridge deploy updates the builder.
set -uo pipefail
DIR="${DESK_MAP_DIR:-$HOME/desk-knowledge/map}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${DESK_MAP_NODE:-$(command -v node)}"
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
# one refresh at a time (the builder has its own lock too; this one also keeps the log lines apart)
exec 9>"$DIR/.refresh.lock"
flock -n 9 || { echo "another map refresh is running"; exit 0; }
status=0
{
  printf '%s ' "$(date -u +%FT%TZ)"
  "$NODE" "$HERE/build.mjs" --dir "$DIR" --quiet
} >> "$DIR/.refresh.log" 2>&1 || status=$?
tail -n 200 "$DIR/.refresh.log" > "$DIR/.refresh.log.tmp" && mv "$DIR/.refresh.log.tmp" "$DIR/.refresh.log"
exit "$status"
