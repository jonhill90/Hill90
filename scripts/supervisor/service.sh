#!/usr/bin/env bash
set -euo pipefail

# This is intentionally a cutover control, not a daemon launcher. The v4
# supervisor has two LaunchAgents; leaving either loaded makes two processes
# eligible to write prompts into the architecture pane.
readonly SUPERVISOR_HOME="${HILL90_SUPERVISOR_HOME:-/Users/jon}"
readonly NEW_LABEL="com.hill90.supervisor"
readonly OLD_LABEL="com.hill90.codex-supervisor"
readonly OLD_AWAKE_LABEL="com.hill90.codex-supervisor-awake"
readonly NEW_PLIST="${HILL90_SUPERVISOR_NEW_PLIST:-${SUPERVISOR_HOME}/Library/LaunchAgents/${NEW_LABEL}.plist}"
readonly OLD_CONTROL="${HILL90_SUPERVISOR_OLD_CONTROL:-${SUPERVISOR_HOME}/.local/bin/hill90-codex-supervisor}"
readonly NEW_CONTROL="${HILL90_SUPERVISOR_NEW_CONTROL:-${SUPERVISOR_HOME}/.local/bin/hill90-supervisor}"
readonly OLD_STATE_DIR="${HILL90_SUPERVISOR_OLD_STATE_DIR:-${SUPERVISOR_HOME}/.local/state/hill90-codex-supervisor}"
readonly OLD_ENABLED="${OLD_STATE_DIR}/enabled"
readonly STATE_DIR="${HILL90_SUPERVISOR_STATE_DIR:-${SUPERVISOR_HOME}/.local/state/hill90-supervisor}"
GUI_DOMAIN="gui/$(id -u)"
readonly GUI_DOMAIN

service_loaded() {
  launchctl print "${GUI_DOMAIN}/$1" >/dev/null 2>&1
}

v4_active() {
  service_loaded "$OLD_LABEL" || service_loaded "$OLD_AWAKE_LABEL" || [[ -f "$OLD_ENABLED" ]]
}

v5_active() {
  service_loaded "$NEW_LABEL"
}

assert_v5_drained() {
  if [[ ! -f "${STATE_DIR}/ledger.sqlite3" ]]; then
    echo "blocked: cannot reconcile v5 without ${STATE_DIR}/ledger.sqlite3" >&2
    return 1
  fi
  if [[ ! -x "$NEW_CONTROL" ]]; then
    echo "blocked: cannot inspect v5 ledger; control is not executable: ${NEW_CONTROL}" >&2
    return 1
  fi

  local status
  status="$("$NEW_CONTROL" --state-dir "$STATE_DIR" status)" || {
    echo "blocked: cannot inspect v5 ledger before rollback" >&2
    return 1
  }
  if ! /usr/bin/python3 - "$status" <<'PY'
import json
import sys

state = json.loads(sys.argv[1])
open_tasks = [task["id"] for task in state["tasks"] if task["status"] not in ("complete", "failed", "cancelled")]
unacked_events = [event["key"] for event in state["events"] if event["status"] != "acked"]
if open_tasks or unacked_events:
    print("blocked: v5 ledger has undrained work", file=sys.stderr)
    if open_tasks:
        print("open tasks: " + ", ".join(open_tasks), file=sys.stderr)
    if unacked_events:
        print("unacknowledged events: " + ", ".join(unacked_events), file=sys.stderr)
    raise SystemExit(1)
PY
  then
    return 1
  fi
}

reconcile_v4() {
  if [[ ! -x "$OLD_CONTROL" ]]; then
    echo "blocked: cannot reconcile v4; control is not executable: ${OLD_CONTROL}" >&2
    return 1
  fi
  "$OLD_CONTROL" fingerprint >/dev/null

  # Preserve the prior v4 cursor rather than silently discarding it. Removing
  # the active cursor forces v4 to take a fresh canonical GitHub/Git snapshot
  # after rollback instead of assuming its pre-v5 view is still current.
  local old_cursor="${OLD_STATE_DIR}/last-delivered.sha256"
  if [[ -f "$old_cursor" ]]; then
    local archive_dir="${OLD_STATE_DIR}/rollback-archive"
    mkdir -p "$archive_dir"
    mv "$old_cursor" "${archive_dir}/last-delivered.$(date -u +%Y%m%dT%H%M%SZ).sha256"
  fi
}

start() {
  if v4_active; then
    echo "blocked: v4 supervisor is still enabled or loaded" >&2
    return 1
  fi
  if v5_active; then
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

cutover() {
  if v5_active; then
    echo "blocked: v5 supervisor is already loaded" >&2
    return 1
  fi
  if v4_active; then
    "$OLD_CONTROL" stop
  fi
  if v4_active; then
    echo "blocked: v4 supervisor is still enabled or loaded after stop" >&2
    return 1
  fi
  start
}

rollback() {
  assert_v5_drained
  stop
  if v5_active; then
    echo "blocked: v5 supervisor is still loaded" >&2
    return 1
  fi
  reconcile_v4
  "$OLD_CONTROL" start
  if ! v4_active; then
    echo "blocked: v4 supervisor did not become active after rollback" >&2
    return 1
  fi
  echo "v4 supervisor restored after drain and reconciliation"
}

status() {
  if v4_active; then
    echo "v4=active"
  else
    echo "v4=stopped"
  fi
  if v5_active; then
    echo "v5=active"
  else
    echo "v5=stopped"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  cutover) cutover ;;
  rollback) rollback ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|cutover|status|rollback}" >&2; exit 2 ;;
esac
