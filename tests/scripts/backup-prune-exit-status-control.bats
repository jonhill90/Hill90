#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/backup.sh's cmd_prune().
#
# The old code ran `rm -rf "$backup_dir"` and unconditionally incremented
# `pruned`, so a removal that failed (permissions, a mount gone read-only,
# a file locked by another process) was still reported as pruned — an
# operator reading "Pruned 1 backup(s)" had no way to know the backup was
# still on disk. This extracts the REAL cmd_prune from the real file and
# forces a real rm failure (a read-only parent directory, so `rm -rf`
# cannot unlink the entry) rather than a mocked one.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL"
  cp "$ROOT/scripts/backup.sh" "$CTL/backup.sh"
  cp "$ROOT/scripts/_common.sh" "$CTL/_common.sh"

  cat > "$CTL/harness.sh" <<'HARNESS'
#!/usr/bin/env bash
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
BACKUP_ROOT="${CTL_BACKUP_ROOT}"
DEFAULT_RETENTION_DAYS=7
HARNESS
  sed -n '/^cmd_prune() {/,/^}/p' "$CTL/backup.sh" >> "$CTL/harness.sh"

  BACKUPS="$CTL/backups"
  # A timestamp comfortably older than any retention window this suite uses.
  OLD_TS="20200101_000000"
  mkdir -p "$BACKUPS/postgres/$OLD_TS"
  echo "dummy" > "$BACKUPS/postgres/$OLD_TS/dump.sql"
}

teardown() {
  # rm -rf below would itself fail on the read-only dir bats' own cleanup
  # relies on, so always leave it writable behind us.
  chmod 755 "$BACKUPS/postgres" 2>/dev/null || true
}

run_prune() {
  CTL_BACKUP_ROOT="$BACKUPS" bash -c '
    source "'"$CTL"'/harness.sh"
    cmd_prune 7
  '
}

@test "THE ASSERTION THAT MATTERS: a removal that actually fails is not counted as pruned" {
  # No write permission on the containing directory means rm cannot unlink
  # the timestamp directory entry, even though the directory itself is
  # otherwise removable — a real, reproducible rm -rf failure, not a stub.
  chmod 555 "$BACKUPS/postgres"
  run run_prune
  [ -d "$BACKUPS/postgres/$OLD_TS" ]
  [[ "$output" == *"failed to remove"* ]]
  [[ "$output" == *"Pruned 0 backup(s)"* ]]
}

@test "CONTROL: a removal that succeeds is counted as pruned and the directory is gone" {
  run run_prune
  [ ! -d "$BACKUPS/postgres/$OLD_TS" ]
  [[ "$output" == *"Pruned 1 backup(s)"* ]]
  [[ "$output" != *"failed to remove"* ]]
}

@test "CONTROL: a backup newer than the retention window is left alone and not counted" {
  NEW_TS="$(date -u +%Y%m%d)_120000"
  mkdir -p "$BACKUPS/postgres/$NEW_TS"
  echo "dummy" > "$BACKUPS/postgres/$NEW_TS/dump.sql"
  run run_prune
  [ -d "$BACKUPS/postgres/$NEW_TS" ]
  [[ "$output" == *"Pruned 1 backup(s)"* ]]
}
