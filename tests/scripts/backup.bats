#!/usr/bin/env bats

# Tests for scripts/backup.sh CLI

@test "backup.sh with no args shows usage" {
  run bash scripts/backup.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "backup.sh help shows usage" {
  run bash scripts/backup.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "backup.sh invalid subcommand fails" {
  run bash scripts/backup.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "backup.sh backup with invalid service fails" {
  run bash scripts/backup.sh backup bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown service for backup"* ]]
}

@test "backup.sh list with no backups dir exits cleanly" {
  BACKUP_DIR="/tmp/hill90-test-nonexistent-$$" run bash scripts/backup.sh list
  [ "$status" -eq 0 ]
  [[ "$output" == *"No backups found"* ]]
}

@test "backup.sh prune with no backups dir exits cleanly" {
  BACKUP_DIR="/tmp/hill90-test-nonexistent-$$" run bash scripts/backup.sh prune
  [ "$status" -eq 0 ]
  [[ "$output" == *"No backups directory found"* ]]
}

@test "backup.sh restore requires service and path" {
  run bash scripts/backup.sh restore
  [ "$status" -eq 1 ]
}

@test "backup.sh sources _common.sh" {
  run grep "source.*_common.sh" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh has backup_volume helper function" {
  run grep "^backup_volume()" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh has restore_volume helper function" {
  run grep "^restore_volume()" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh infra backup includes traefik-certs volume" {
  run grep "traefik-certs" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh observability backup includes grafana-data volume" {
  run grep "grafana-data" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh default retention is 7 days" {
  run grep "DEFAULT_RETENTION_DAYS=7" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh prune rejects non-numeric retention days" {
  run bash scripts/backup.sh prune abc
  [ "$status" -eq 1 ]
  [[ "$output" == *"positive integer"* ]]
}

# ---------------------------------------------------------------------------
# deploy.sh pre-deploy backup integration tests
# ---------------------------------------------------------------------------

@test "deploy.sh calls backup.sh before stateful service deploys" {
  run grep "backup.sh.*backup" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "deploy.sh calls backup.sh before infra deploys" {
  run bash -c 'sed -n "/^cmd_infra/,/^}/p" scripts/deploy.sh | grep "backup.sh.*backup.*infra"'
  [ "$status" -eq 0 ]
}

@test "deploy.sh backup command is in dispatcher" {
  run grep "backup).*backup.sh" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "deploy.sh usage lists backup command" {
  run grep "backup.*Run pre-deploy backup" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh list for specific service shows timestamps" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/db/20260101_120000"
  mkdir -p "$tmpdir/db/20260102_120000"
  BACKUP_DIR="$tmpdir" run bash scripts/backup.sh list db
  [ "$status" -eq 0 ]
  [[ "$output" == *"20260101_120000"* ]]
  [[ "$output" == *"20260102_120000"* ]]
  rm -rf "$tmpdir"
}

@test "backup.sh list with populated backup dir lists services" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/db/20260101_120000"
  mkdir -p "$tmpdir/vault/20260102_120000"
  BACKUP_DIR="$tmpdir" run bash scripts/backup.sh list
  [ "$status" -eq 0 ]
  [[ "$output" == *"db: 1 backup(s)"* ]]
  [[ "$output" == *"vault: 1 backup(s)"* ]]
  rm -rf "$tmpdir"
}

@test "backup.sh lists supported services in help" {
  run bash scripts/backup.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"infra"* ]]
  [[ "$output" == *"observability"* ]]
}

@test "backup.sh restore with invalid path fails" {
  run bash scripts/backup.sh restore db /tmp/nonexistent-path-$$
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Regression tests for the silent SQL-dump failure and the missing app coverage.
#
# Root cause of the live incident: /etc/crontab sets
# PATH=/sbin:/bin:/usr/sbin:/usr/bin, sops lives in /usr/local/bin, so under
# cron `sops -d` was "command not found". stderr was discarded, DB_USER came
# back empty, the SQL dump was skipped with a warning, the volume tar still ran
# and the script exited 0. Three consecutive nightly backups contained a tar and
# no dump while cron reported success.
#
# These tests stub docker and sops so they run in CI without a live stack.
# ---------------------------------------------------------------------------

setup_stubs() {
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"

  cat > "$STUB_BIN/docker" <<'EOF'
#!/usr/bin/env bash
# stub: psql auth check succeeds; pg_dumpall/pg_dump emit plausible SQL
case "$*" in
  *pg_dumpall*|*pg_dump*) echo "-- PostgreSQL database dump"; echo "CREATE ROLE hill90;"; exit 0 ;;
  *psql*SELECT\ 1*)       echo "1"; exit 0 ;;
  *"volume ls"*)          echo "prod_postgres-data"; echo "prod_app-postgres-data"; exit 0 ;;
  *inspect*)              exit 0 ;;
  *run*)                  exit 0 ;;
  *)                      exit 0 ;;
esac
EOF
  chmod +x "$STUB_BIN/docker"

  cat > "$STUB_BIN/sops" <<'EOF'
#!/usr/bin/env bash
echo "DB_USER=hill90"
echo "DB_PASSWORD=stub"
exit 0
EOF
  chmod +x "$STUB_BIN/sops"
}

@test "backup db FAILS when the SQL dump cannot be taken, rather than warning" {
  setup_stubs
  # sops absent from PATH — exactly the cron condition that caused the incident.
  rm -f "$STUB_BIN/sops"
  run env PATH="$STUB_BIN:/usr/bin:/bin" \
      BACKUP_DIR="$BATS_TEST_TMPDIR/backups" DB_USER= \
      bash scripts/backup.sh backup db
  [ "$status" -ne 0 ]
  [[ "$output" != *"✓ Backup complete"* ]]
}

@test "backup db FAILS when the dump would be empty" {
  setup_stubs
  cat > "$STUB_BIN/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *pg_dumpall*|*pg_dump*) exit 0 ;;   # exits 0 but writes nothing
  *psql*SELECT\ 1*)       echo "1"; exit 0 ;;
  *)                      exit 0 ;;
esac
EOF
  chmod +x "$STUB_BIN/docker"
  run env PATH="$STUB_BIN:/usr/bin:/bin" \
      BACKUP_DIR="$BATS_TEST_TMPDIR/backups" \
      bash scripts/backup.sh backup db
  [ "$status" -ne 0 ]
}

@test "backup db resolves sops by absolute path, not only via PATH" {
  run grep -nE "/usr/local/bin/sops|command -v sops|SOPS_BIN" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh covers the app's postgres volume" {
  run grep -n "prod_app-postgres-data" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup app-db produces a real SQL dump of the tenant database, not only a tar" {
  setup_stubs
  run env PATH="$STUB_BIN:/usr/bin:/bin" \
      BACKUP_DIR="$BATS_TEST_TMPDIR/backups" APP_DB_USER=hill90 \
      bash scripts/backup.sh backup app-db
  [ "$status" -eq 0 ]
  dump="$(find "$BATS_TEST_TMPDIR/backups" -name 'app-database.sql' | head -1)"
  [ -n "$dump" ]
  [ -s "$dump" ]
}

@test "backup app-db FAILS when the tenant database cannot be dumped" {
  setup_stubs
  cat > "$STUB_BIN/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *pg_dumpall*|*pg_dump*) exit 1 ;;   # dump fails
  *psql*SELECT\ 1*)       echo "1"; exit 0 ;;
  *)                      exit 0 ;;
esac
EOF
  chmod +x "$STUB_BIN/docker"
  run env PATH="$STUB_BIN:/usr/bin:/bin" \
      BACKUP_DIR="$BATS_TEST_TMPDIR/backups" APP_DB_USER=hill90 \
      bash scripts/backup.sh backup app-db
  [ "$status" -ne 0 ]
}

@test "backup.sh verifies artifacts are non-empty before reporting success" {
  run grep -nE "verify_artifacts|assert_non_empty" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "a successful db backup produces a non-empty dump and exits 0" {
  setup_stubs
  run env PATH="$STUB_BIN:/usr/bin:/bin" \
      BACKUP_DIR="$BATS_TEST_TMPDIR/backups" \
      bash scripts/backup.sh backup db
  [ "$status" -eq 0 ]
  dump="$(find "$BATS_TEST_TMPDIR/backups" -name 'database.sql' | head -1)"
  [ -n "$dump" ]
  [ -s "$dump" ]
}

@test "backup-all continues past a failing service and still exits non-zero" {
  setup_stubs
  # The tenant container is PRESENT but its dump fails. This used to induce the
  # failure by making `inspect app-postgres` exit 1, but app-postgres was retired on
  # 2026-07-30 and an absent container is now a legitimate no-op — that stub would
  # test nothing. A present-but-undumpable container is still a real failure, so the
  # property under test here (keep going, then exit non-zero) is unchanged.
  cat > "$STUB_BIN/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *exec\ app-postgres*pg_dumpall*) exit 1 ;;         # tenant dump fails
  *pg_dumpall*|*pg_dump*)  echo "-- dump"; echo "CREATE ROLE hill90;"; exit 0 ;;
  *psql*SELECT\ 1*)        echo "1"; exit 0 ;;
  *)                       exit 0 ;;
esac
EOF
  chmod +x "$STUB_BIN/docker"
  run env PATH="$STUB_BIN:/usr/bin:/bin" \
      BACKUP_DIR="$BATS_TEST_TMPDIR/backups" \
      bash scripts/backup.sh backup-all
  # Fails overall...
  [ "$status" -ne 0 ]
  [[ "$output" == *"app-db"* ]]
  # ...but the platform database was still backed up.
  dump="$(find "$BATS_TEST_TMPDIR/backups" -name 'database.sql' | head -1)"
  [ -n "$dump" ]
  [ -s "$dump" ]
}

# ---------------------------------------------------------------------------
# app-postgres was RETIRED on 2026-07-30. The tenant's databases now live on the
# platform Postgres, so the `db` target's pg_dumpall already contains hill90_akm,
# hill90_api and hill90_litellm. What `app-db` must NOT do is die because a
# container it no longer needs is absent: `backup all` would report FAILED every
# night for data that is in fact backed up, and a backup job that cries wolf is
# how a real failure gets ignored.
#
# The retained volume is the part that is genuinely app-db's own, and only while
# it exists. So: absent container plus absent volume is a no-op that says why;
# absent container plus present volume still tars it.
# ---------------------------------------------------------------------------

@test "backup app-db does not fail merely because the retired container is gone" {
  setup_stubs
  cat > "$STUB_BIN/docker" <<'EOF'
#!/usr/bin/env bash
# Quote nothing in these patterns. A `case` pattern is matched literally, so
# *"inspect app-postgres"* looks for the quote characters themselves, never
# matches, and the container silently appears PRESENT — which is how the first
# version of this test passed against a deliberately neutered guard.
case "$*" in
  *inspect\ app-postgres*) exit 1 ;;   # retired: container absent
  *volume\ ls*)            exit 0 ;;   # and its volume already reviewed away
  *)                       exit 0 ;;
esac
EOF
  chmod +x "$STUB_BIN/docker"
  run env PATH="$STUB_BIN:/usr/bin:/bin" \
      BACKUP_DIR="$BATS_TEST_TMPDIR/backups" \
      bash scripts/backup.sh backup app-db
  [ "$status" -eq 0 ]
  [[ "$output" == *"retired"* ]]
}

@test "backup app-db still fails when the container IS present but undumpable" {
  setup_stubs
  cat > "$STUB_BIN/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *pg_dumpall*|*pg_dump*) exit 1 ;;
  *psql*SELECT\ 1*)       echo "1"; exit 0 ;;
  *)                      exit 0 ;;
esac
EOF
  chmod +x "$STUB_BIN/docker"
  run env PATH="$STUB_BIN:/usr/bin:/bin" \
      BACKUP_DIR="$BATS_TEST_TMPDIR/backups" APP_DB_USER=hill90 \
      bash scripts/backup.sh backup app-db
  [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# backup_volume() / restore_volume() used to report success unconditionally,
# regardless of whether the underlying `docker run`/tar actually succeeded —
# `echo` was the next unconditional statement after each, and echo never
# fails. Under `backup-all` specifically this was live, not dormant: every
# multi-volume caller wraps the call in `|| true`, and cmd_backup_all wraps
# the whole chain in `if ( cmd_backup "$svc" )`, a subshell-as-if-condition
# that suppresses errexit transitively underneath it — so a failed tar for
# ANY of six targets (including prod_minio-data, the one volume this file's
# own comments call irreplaceable) silently reported "✓ Saved" and never
# turned the run red.
#
# These use REAL docker volumes rather than the stub above: the stub's bare
# `*run*) exit 0 ;;` never actually writes a file, which is realistic for
# testing the SQL-dump paths (those write via redirected stdout, not through
# the container) but cannot exercise backup_volume's own real success/failure
# path, which depends on whether `docker run ... tar czf ...` genuinely wrote
# something. A small, real, throwaway volume is fast and faithful.
# ---------------------------------------------------------------------------

BACKUP_VOLUME_FUNCS() {
  sed -n '/^backup_volume() {/,/^}/p; /^# Restore a named Docker volume/,/^}/p' "$1"
}

setup_real_volume() {
  TEST_VOL="bats-backup-vol-$$"
  docker volume create "$TEST_VOL" >/dev/null
  docker run --rm -v "${TEST_VOL}:/data" alpine sh -c "echo real > /data/f.txt" >/dev/null
}

teardown_real_volume() {
  docker volume rm "$TEST_VOL" >/dev/null 2>&1 || true
}

@test "REAL DOCKER: backup_volume succeeds and creates a real, non-empty archive" {
  command -v docker >/dev/null || skip "docker not available"
  setup_real_volume
  FUNCS="$BATS_TEST_TMPDIR/funcs.sh"
  BACKUP_VOLUME_FUNCS "$PWD/scripts/backup.sh" > "$FUNCS"
  dest="$BATS_TEST_TMPDIR/vol.tar.gz"
  run bash -c "warn() { echo \"WARN: \$*\" >&2; }; source '$FUNCS'; backup_volume '$TEST_VOL' '$dest'"
  teardown_real_volume
  [ "$status" -eq 0 ]
  [[ "$output" == *"✓ Saved"* ]]
  [ -s "$dest" ]
}

@test "THE ASSERTION THAT MATTERS: backup_volume FAILS (not '✓ Saved') when the tar genuinely cannot write" {
  command -v docker >/dev/null || skip "docker not available"
  setup_real_volume
  FUNCS="$BATS_TEST_TMPDIR/funcs.sh"
  BACKUP_VOLUME_FUNCS "$PWD/scripts/backup.sh" > "$FUNCS"
  # NOT chmod 555 on the parent — that denies a normal user, but
  # backup_volume writes via `docker run` as root inside the container, and
  # root ignores directory permission bits. Verified directly (not assumed):
  # a container writing into a bind-mounted, chmod-555 host directory
  # succeeds when run as root on real Linux (GitHub Actions' own runner —
  # macOS Docker Desktop's bind-mount layer masked this locally, which is
  # exactly how this got past local testing). CI caught this: the test
  # passed 555 as "unwritable," root wrote through it anyway, and the
  # assertion that the write must fail was the thing that was wrong.
  #
  # A destination that is ALREADY A DIRECTORY denies the write regardless of
  # uid — `tar czf` on an existing directory fails EISDIR for root exactly
  # as it does for anyone else. Verified against the real alpine image this
  # function uses, as root: `tar: can't open '...': Is a directory`, exit 1.
  ro_dir="$BATS_TEST_TMPDIR/readonly"
  mkdir -p "$ro_dir"
  dest="$ro_dir/vol.tar.gz"
  mkdir -p "$dest"
  # Evidence, not assumption: what uid actually performs the write, on
  # THIS run, in THIS environment. Printed unconditionally so it's in every
  # CI log next to the assertion it explains, not just asserted about here.
  echo "# outer shell uid: $(id -u)" >&3
  echo "# container write uid: $(docker run --rm alpine id -u)" >&3
  run bash -c "warn() { echo \"WARN: \$*\" >&2; }; source '$FUNCS'; backup_volume '$TEST_VOL' '$dest'"
  teardown_real_volume
  [ "$status" -ne 0 ]
  [[ "$output" != *"✓ Saved"* ]]
  [[ "$output" == *"FAILED"* ]]
}

@test "CONTROL: the OLD backup_volume shape would have reported success on the same real failure (regression guard)" {
  # Not a test of the new function — a permanent record that the bug was
  # real, using the exact real failure the fixed version now catches.
  #
  # Same fix as the assertion test above, same reason: chmod 555 does not
  # stop root, and this container writes as root. A pre-existing directory
  # at the destination path denies the write for root just as it does for
  # anyone else.
  command -v docker >/dev/null || skip "docker not available"
  setup_real_volume
  ro_dir="$BATS_TEST_TMPDIR/readonly-old"
  mkdir -p "$ro_dir"
  dest="$ro_dir/vol.tar.gz"
  mkdir -p "$dest"
  OLD_FUNC="$BATS_TEST_TMPDIR/old_backup_volume.sh"
  cat > "$OLD_FUNC" <<'OLD'
backup_volume_old() {
    local volume="$1"; local dest_file="$2"
    docker run --rm -v "${volume}:/data:ro" -v "$(dirname "$dest_file"):/backup" \
        alpine tar czf "/backup/$(basename "$dest_file")" -C /data .
    echo "  ✓ Saved to $dest_file"
}
OLD
  run bash -c "source '$OLD_FUNC'; backup_volume_old '$TEST_VOL' '$dest'"
  teardown_real_volume
  [ "$status" -eq 0 ]
  [[ "$output" == *"✓ Saved"* ]]
  # The tar genuinely failed (EISDIR) — this is the false pass.
}

@test "REAL DOCKER: restore_volume FAILS loud (not '✓ Restored') on a genuinely corrupt archive" {
  command -v docker >/dev/null || skip "docker not available"
  setup_real_volume
  FUNCS="$BATS_TEST_TMPDIR/funcs.sh"
  BACKUP_VOLUME_FUNCS "$PWD/scripts/backup.sh" > "$FUNCS"
  bad="$BATS_TEST_TMPDIR/corrupt.tar.gz"
  echo "not a valid tar" > "$bad"
  run bash -c "die() { echo \"ERROR: \$*\" >&2; exit 1; }; source '$FUNCS'; restore_volume '$TEST_VOL' '$bad'"
  teardown_real_volume
  [ "$status" -ne 0 ]
  [[ "$output" != *"✓ Restored"* ]]
  [[ "$output" == *"FAILED to restore"* ]]
}

@test "observability restore refuses when neither archive is present, rather than reporting complete" {
  mkdir -p "$BATS_TEST_TMPDIR/empty-dir"
  run env BACKUP_DIR="$BATS_TEST_TMPDIR/backups" \
      bash scripts/backup.sh restore observability "$BATS_TEST_TMPDIR/empty-dir"
  [ "$status" -ne 0 ]
  [[ "$output" != *"Restore complete"* ]]
}
