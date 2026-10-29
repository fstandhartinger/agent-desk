#!/usr/bin/env bash
# Daily desk-knowledge refresh (run by desk-knowledge.timer). Only writes ~/desk-knowledge.
set -euo pipefail
DIR="${DESK_KNOWLEDGE_DIR:-$HOME/desk-knowledge}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
{
  printf '%s ' "$(date -u +%FT%TZ)"
  /usr/bin/node "$HERE/build.mjs" --dir "$DIR"
} >> "$DIR/.refresh.log" 2>&1
tail -n 200 "$DIR/.refresh.log" > "$DIR/.refresh.log.tmp" && mv "$DIR/.refresh.log.tmp" "$DIR/.refresh.log"
