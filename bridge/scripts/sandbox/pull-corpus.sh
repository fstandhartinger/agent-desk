#!/usr/bin/env bash
# Pulls the scrubbed corpus for sandbox.exec from LeChonk (run hourly on Sandy by desk-corpus-pull.timer).
#
#   scripts/sandbox/pull-corpus.sh        env: DESK_CORPUS_DIR, DESK_CORPUS_SRC, DESK_CORPUS_KEEP, DESK_CORPUS_RETRY_SLEEP (tests only)
#
# LeChonk's scripts/map/export-corpus.mjs writes ~/desk-knowledge/corpus/ (one scrubbed text file per indexed document).
# Here it lands in a new generation directory next to the others:
#
#   ~/.local/share/desk-corpus      -> symlink to the current generation (what `ls` and the sandbox's /data show)
#   ~/.local/share/desk-corpus.gen/gen-<UTC timestamp, ns>/...     the generations (the newest 3, and every one younger than 10 min, are kept)
#
# A generation is rsynced completely into gen-*.partial first (unchanged files are hard links of the previous generation, so
# only what changed travels and costs disk), checked, renamed, and only then does the symlink move (an atomic rename). A command
# that is running in the sandbox keeps the generation it started with: bridge/src/sandbox.js binds the symlink's TARGET and
# generations are deleted only when they are old. A failed pull changes nothing; the sandbox goes on with the last good copy.
set -uo pipefail
LINK="${DESK_CORPUS_DIR:-$HOME/.local/share/desk-corpus}"
GENS="${LINK}.gen"
SRC="${DESK_CORPUS_SRC:-lechonk:desk-knowledge/corpus/}"
KEEP="${DESK_CORPUS_KEEP:-3}"
RETRY_SLEEP="${DESK_CORPUS_RETRY_SLEEP:-20}"
umask 077

log() { printf '%s pull-corpus: %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { log "FAILED: $*"; [ -n "${STAGE:-}" ] && rm -rf "$STAGE"; exit 1; }

mkdir -p "$GENS" && chmod 700 "$GENS" || fail "cannot create $GENS"
exec 9>"$GENS/.pull.lock"
flock -n 9 || { log "another pull is running"; exit 0; }

# a plain directory from an earlier manual rsync becomes the first generation
if [ -d "$LINK" ] && [ ! -L "$LINK" ]; then
  mv "$LINK" "$GENS/gen-migrated-$(date -u +%Y%m%dT%H%M%SZ)" || fail "cannot move the existing $LINK away"
fi

PREV=""
[ -e "$LINK" ] && PREV="$(readlink -f "$LINK")"
GEN="gen-$(date -u +%Y%m%dT%H%M%S%NZ)" # nanoseconds: unique and sortable, two quick pulls never collide
STAGE="$GENS/$GEN.partial"
rm -rf "$STAGE"
mkdir -m 700 "$STAGE" || fail "cannot create $STAGE"

t0=$SECONDS
attempt=0
while :; do
  rsync -a --delete --timeout=120 ${PREV:+--link-dest="$PREV"} -e 'ssh -o BatchMode=yes -o ConnectTimeout=15' "$SRC" "$STAGE/"
  rc=$?
  [ "$rc" -eq 0 ] && break
  attempt=$((attempt + 1))
  [ "$attempt" -ge 3 ] && fail "rsync from $SRC failed (exit $rc) after $attempt tries"
  log "rsync exit $rc, retrying in $RETRY_SLEEP s (the exporter swaps its tree in two renames; 24 = files vanished)"
  sleep "$RETRY_SLEEP"
done

[ -s "$STAGE/.corpus-meta.json" ] || fail "the pulled tree has no .corpus-meta.json (not a corpus export?)"
NEW_FILES="$(find "$STAGE" -type f | wc -l)"
[ "$NEW_FILES" -gt 0 ] || fail "the pulled tree is empty"
if [ -n "$PREV" ] && [ -d "$PREV" ]; then
  OLD_FILES="$(find "$PREV" -type f | wc -l)"
  if [ "$OLD_FILES" -ge 1000 ] && [ $((NEW_FILES * 2)) -lt "$OLD_FILES" ]; then
    fail "the new copy has $NEW_FILES files, the current one $OLD_FILES (less than half): keeping the current one"
  fi
fi

mv "$STAGE" "$GENS/$GEN" || fail "cannot rename $STAGE"
STAGE=""
touch "$GENS/$GEN" # rsync -a gave the directory the source's mtime; the 10-minute rule below needs the time of this pull
ln -sfn "$GENS/$GEN" "$LINK.tmp" && mv -T "$LINK.tmp" "$LINK" || fail "cannot move the symlink $LINK"

# keep the newest $KEEP generations and anything younger than 10 minutes; remove interrupted .partial copies of earlier runs
n=0
for d in $(ls -1d "$GENS"/gen-* 2>/dev/null | sort -r); do
  case "$d" in *.partial) [ "$d" = "$GENS/$GEN.partial" ] || rm -rf "$d"; continue ;; esac
  n=$((n + 1))
  [ "$n" -le "$KEEP" ] && continue
  [ -n "$(find "$d" -maxdepth 0 -mmin -10 2>/dev/null)" ] && continue
  rm -rf "$d"
done

log "ok $GEN: $NEW_FILES files, $(du -sh "$GENS/$GEN" | cut -f1), $((SECONDS - t0)) s"
