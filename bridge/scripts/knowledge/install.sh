#!/usr/bin/env bash
# Installs the generator copy into ~/desk-knowledge/.generator and enables desk-knowledge.timer (systemd --user).
# Independent of the deployed bridge in ~/apps: the timer runs the copy, so a bridge deploy never breaks it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${DESK_KNOWLEDGE_DIR:-$HOME/desk-knowledge}"
umask 077
mkdir -p "$DIR/.generator" "$DIR/topics" "$HOME/.config/systemd/user"
chmod 700 "$DIR"
install -m 700 "$HERE/build.mjs" "$HERE/refresh.sh" "$DIR/.generator/"
install -m 644 "$HERE/../../systemd/desk-knowledge.service" "$HERE/../../systemd/desk-knowledge.timer" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now desk-knowledge.timer
systemctl --user list-timers desk-knowledge.timer --no-pager
