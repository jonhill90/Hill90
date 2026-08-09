#!/usr/bin/env bash
set -euo pipefail

readonly NEW_LABEL="com.hill90.supervisor"
readonly OLD_LABEL="com.hill90.codex-supervisor"
readonly NEW_PLIST="/Users/jon/Library/LaunchAgents/${NEW_LABEL}.plist"
readonly OLD_CONTROL="/Users/jon/.local/bin/hill90-codex-supervisor"
readonly OLD_ENABLED="/Users/jon/.local/state/hill90-codex-supervisor/enabled"
readonly STATE_DIR="/Users/jon/.local/state/hill90-supervisor"
GUI_DOMAIN="gui/$(id -u)"
readonly GUI_DOMAIN

start() {
  if launchctl print "${GUI_DOMAIN}/${OLD_LABEL}" >/dev/null 2>&1 || [[ -f "$OLD_ENABLED" ]]; then
    echo "blocked: v4 supervisor is still enabled or loaded" >&2
    return 1
  fi
  if launchctl print "${GUI_DOMAIN}/${NEW_LABEL}" >/dev/null 2>&1; then
    echo "v5 supervisor already loaded"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  launchctl bootstrap "$GUI_DOMAIN" "$NEW_PLIST"
  launchctl enable "${GUI_DOMAIN}/${NEW_LABEL}"
  launchctl kickstart "${GUI_DOMAIN}/${NEW_LABEL}"
  echo "v5 supervisor started"
}

stop() {
  launchctl bootout "${GUI_DOMAIN}/${NEW_LABEL}" 2>/dev/null || true
  echo "v5 supervisor stopped"
}

rollback() {
  stop
  if launchctl print "${GUI_DOMAIN}/${NEW_LABEL}" >/dev/null 2>&1; then
    echo "blocked: v5 supervisor is still loaded" >&2
    return 1
  fi
  "$OLD_CONTROL" start
  echo "v4 supervisor restored"
}

status() {
  if launchctl print "${GUI_DOMAIN}/${OLD_LABEL}" >/dev/null 2>&1 || [[ -f "$OLD_ENABLED" ]]; then
    echo "v4=active"
  else
    echo "v4=stopped"
  fi
  if launchctl print "${GUI_DOMAIN}/${NEW_LABEL}" >/dev/null 2>&1; then
    echo "v5=active"
  else
    echo "v5=stopped"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  rollback) rollback ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|status|rollback}" >&2; exit 2 ;;
esac
