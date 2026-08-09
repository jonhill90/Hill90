#!/usr/bin/env bats

# The v4 supervisor has a second awake LaunchAgent. Starting v5 while that
# companion is loaded leaves two prompt writers active. Rollback is equally
# unsafe if v5 has undrained ledger work that v4 cannot reconcile.

setup() {
  ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  HOME_ROOT="$BATS_TEST_TMPDIR/home"
  BIN_DIR="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$HOME_ROOT" "$BIN_DIR"
  export HILL90_SUPERVISOR_HOME="$HOME_ROOT"
  export PATH="$BIN_DIR:$PATH"

  cat > "$BIN_DIR/launchctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$LAUNCHCTL_LOG"
if [[ "$1" == "print" && "$2" == *"${LOADED_LABEL:-nothing}" ]]; then
  exit 0
fi
exit 1
SH
  chmod +x "$BIN_DIR/launchctl"
  export LAUNCHCTL_LOG="$BATS_TEST_TMPDIR/launchctl.log"
}

@test "v5's singleton guard covers v4's awake companion LaunchAgent" {
  export LOADED_LABEL="com.hill90.codex-supervisor-awake"

  run bash "$ROOT/scripts/supervisor/service.sh" start

  [ "$status" -eq 1 ]
  [[ "$output" == *"v4 supervisor is still enabled or loaded"* ]]
  ! grep -q "bootstrap" "$LAUNCHCTL_LOG"
}

@test "rollback has an explicit drain check before restarting v4" {
  state_dir="$HOME_ROOT/.local/state/hill90-supervisor"
  old_control="$BATS_TEST_TMPDIR/old-control"
  new_control="$BATS_TEST_TMPDIR/new-control"
  mkdir -p "$state_dir"
  touch "$state_dir/ledger.sqlite3"
  cat > "$new_control" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"tasks":[{"id":"review-1","status":"accepted"}],"events":[]}'
SH
  cat > "$old_control" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$OLD_CONTROL_LOG"
SH
  chmod +x "$new_control" "$old_control"
  export HILL90_SUPERVISOR_NEW_CONTROL="$new_control"
  export HILL90_SUPERVISOR_OLD_CONTROL="$old_control"
  export OLD_CONTROL_LOG="$BATS_TEST_TMPDIR/old-control.log"

  run bash "$ROOT/scripts/supervisor/service.sh" rollback

  [ "$status" -eq 1 ]
  [[ "$output" == *"v5 ledger has undrained work"* ]]
  [ ! -e "$OLD_CONTROL_LOG" ]
}
