#!/usr/bin/env bats

# h#753. cmd_prune's timestamp parse used to fail silently: a backup
# directory whose name it could not parse a date from hit a bare
# `continue` — no warning, no count, indistinguishable in the output from a
# directory correctly judged too new to prune.
#
# WHICH OF THE TWO OPPOSITE BUGS THIS ACTUALLY WAS, established rather than
# assumed: GNU `date -d` (the production host's date — Linux) rejects every
# malformed 8-digit date tested (month 13, day 30 in February, month 00)
# outright, so the pre-fix behaviour on the real deploy target was cleanly
# "retained forever", never "deleted when it shouldn't be" — a slow leak,
# not data loss. A narrower, real second finding surfaced while confirming
# that: BSD `date -j -f "%Y%m%d"` (macOS, relevant to anyone running this
# script locally) does NOT reject every invalid date the same way — "Feb
# 30" silently rolls over into a real epoch in March instead of failing,
# which would have let a directory that should never have parsed at all
# flow through to the age comparison with a wrong-but-plausible-looking
# epoch. The fix closes both: an explicit `bad` flag replaces the bare
# `continue`, and a round-trip check (parsed epoch back to YYYYMMDD, must
# equal the original name) catches the BSD rollover case specifically —
# a genuine parse always round-trips exactly.
#
# THE CHOSEN BEHAVIOUR: retain and warn loudly, not abort the whole prune
# run. This script only ever creates backup directories via
# `date +%Y%m%d_%H%M%S` (cmd_backup), so an unparseable name should never
# occur from this script's own writes — but the file's own existing
# convention for an anomaly in this same loop (a `rm -rf` that fails, two
# lines below) is exactly "warn and keep going", not "abort everything" —
# aborting the whole run over one stray directory would stop every OTHER
# service's legitimate pruning too, compounding the disk-hygiene problem
# this command exists to prevent rather than containing it to the one
# anomalous directory.
#
# Every assertion below is about what happened to the DIRECTORY on disk,
# not merely what was printed — this is deletion logic, and a message
# proves nothing about whether rm ran.

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
  OLD_TS="20200101_000000"
  mkdir -p "$BACKUPS/postgres/$OLD_TS"
  echo "dummy" > "$BACKUPS/postgres/$OLD_TS/dump.sql"
}

run_prune() {
  CTL_BACKUP_ROOT="$BACKUPS" bash -c '
    source "'"$CTL"'/harness.sh"
    cmd_prune 7
  '
}

@test "THE ASSERTION THAT MATTERS: a directory with an unparseable timestamp is RETAINED, not silently skipped without a trace" {
  # "notadate" is deliberately 8 characters — the same length as
  # YYYYMMDD — so this does NOT get caught by the cheap length check; it
  # must reach the actual date-parsing attempt and fail there, the exact
  # case #753 named.
  BAD_TS="notadate_120000"
  mkdir -p "$BACKUPS/postgres/$BAD_TS"
  echo "dummy" > "$BACKUPS/postgres/$BAD_TS/dump.sql"

  run run_prune

  # The directory itself, not just a log line: still on disk.
  [ -d "$BACKUPS/postgres/$BAD_TS" ]
  # The genuinely old, well-formed backup alongside it was still pruned —
  # this must not have aborted the whole run.
  [ ! -d "$BACKUPS/postgres/$OLD_TS" ]
  [[ "$output" == *"Could not parse a timestamp from postgres/${BAD_TS}"* ]]
  [[ "$output" == *"retaining it"* ]]
  [[ "$output" == *"Pruned 1 backup(s)"* ]]
  [[ "$output" == *"1 backup dir(s) had an unparseable timestamp"* ]]
}

@test "CONTROL, THE OLD BUG REPRODUCED: before this fix, the same input left no trace at all" {
  # Runs the ORIGINAL cmd_prune (pre-fix) against the identical fixture, to
  # prove this test suite would have caught the regression rather than
  # passing for an unrelated reason. Reconstructs the old body inline
  # rather than checking out history, since the shape (bare `continue`,
  # no warn, no counter) is what's being proven absent-of-detection, not
  # any particular git revision.
  cat > "$CTL/harness_old.sh" <<'HARNESS'
#!/usr/bin/env bash
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
BACKUP_ROOT="${CTL_BACKUP_ROOT}"
DEFAULT_RETENTION_DAYS=7

cmd_prune_old() {
    local retention_days="${1:-$DEFAULT_RETENTION_DAYS}"
    local pruned=0
    for svc_dir in "$BACKUP_ROOT"/*/; do
        [ -d "$svc_dir" ] || continue
        local svc
        svc="$(basename "$svc_dir")"
        for backup_dir in "$svc_dir"/*/; do
            [ -d "$backup_dir" ] || continue
            local ts
            ts="$(basename "$backup_dir")"
            local backup_date="${ts%%_*}"
            if [ ${#backup_date} -ne 8 ]; then
                continue
            fi
            local cutoff_epoch
            cutoff_epoch="$(date -d "-${retention_days} days" +%s 2>/dev/null || date -v "-${retention_days}d" +%s 2>/dev/null)" || continue
            local backup_epoch
            backup_epoch="$(date -d "${backup_date:0:4}-${backup_date:4:2}-${backup_date:6:2}" +%s 2>/dev/null || date -j -f "%Y%m%d" "$backup_date" +%s 2>/dev/null)" || continue
            if [ "$backup_epoch" -lt "$cutoff_epoch" ]; then
                if rm -rf "$backup_dir"; then
                    pruned=$((pruned + 1))
                fi
            fi
        done
    done
    echo "✓ Pruned ${pruned} backup(s)"
}
HARNESS

  BAD_TS="notadate_120000"
  mkdir -p "$BACKUPS/postgres/$BAD_TS"
  echo "dummy" > "$BACKUPS/postgres/$BAD_TS/dump.sql"

  run_prune_old() {
    CTL_BACKUP_ROOT="$BACKUPS" bash -c '
      source "'"$CTL"'/harness_old.sh"
      cmd_prune_old 7
    '
  }
  run run_prune_old

  # The directory survives here too (confirming the "safe direction"
  # finding) — but with NOTHING in the output naming it, which is the
  # actual defect: an operator has no way to tell "retained because too
  # new" from "retained because unparseable" from this output alone.
  [ -d "$BACKUPS/postgres/$BAD_TS" ]
  [[ "$output" != *"Could not parse"* ]]
  [[ "$output" != *"unparseable"* ]]
}

@test "CONTROL: a well-formed, genuinely old backup is still pruned exactly as before" {
  run run_prune
  [ ! -d "$BACKUPS/postgres/$OLD_TS" ]
  [[ "$output" == *"Pruned 1 backup(s)"* ]]
  [[ "$output" != *"unparseable"* ]]
}

@test "CONTROL: a well-formed, genuinely recent backup is left alone and not counted" {
  NEW_TS="$(date -u +%Y%m%d)_120000"
  mkdir -p "$BACKUPS/postgres/$NEW_TS"
  echo "dummy" > "$BACKUPS/postgres/$NEW_TS/dump.sql"
  run run_prune
  [ -d "$BACKUPS/postgres/$NEW_TS" ]
  [[ "$output" == *"Pruned 1 backup(s)"* ]]
  [[ "$output" != *"unparseable"* ]]
}

@test "THE BSD ROLLOVER CASE: a structurally-8-digit but calendar-invalid date (Feb 30) is retained, not silently treated as a valid epoch" {
  # This is the second, narrower finding: BSD `date -j -f "%Y%m%d"`
  # accepts "20260230" (Feb 30 — does not exist) and silently rolls it
  # into March rather than failing, which the round-trip check exists to
  # catch. On GNU date this input is already rejected outright at the
  # parse step, so this test proves the round-trip is a no-op there and
  # the actual protection on whichever `date` is present either way.
  BAD_TS="20260230_000000"
  mkdir -p "$BACKUPS/postgres/$BAD_TS"
  echo "dummy" > "$BACKUPS/postgres/$BAD_TS/dump.sql"

  run run_prune

  [ -d "$BACKUPS/postgres/$BAD_TS" ]
  [[ "$output" == *"Could not parse a timestamp from postgres/${BAD_TS}"* ]]
}
