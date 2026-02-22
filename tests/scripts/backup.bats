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

@test "backup.sh lists supported services in help" {
  run bash scripts/backup.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"db"* ]]
  [[ "$output" == *"minio"* ]]
  [[ "$output" == *"infra"* ]]
  [[ "$output" == *"observability"* ]]
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

@test "backup.sh restore with invalid path fails" {
  run bash scripts/backup.sh restore db /tmp/nonexistent-path-$$
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Backup script structure tests
# ---------------------------------------------------------------------------

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

@test "backup.sh db backup uses pg_dumpall" {
  run grep "pg_dumpall" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh uses DB_USER variable not hardcoded postgres" {
  # pg_dumpall and psql should use $DB_USER, not -U postgres
  run grep -E 'pg_dumpall|psql' scripts/backup.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *'$DB_USER'* ]]
  [[ "$output" != *'-U postgres'* ]]
}

@test "backup.sh db backup includes postgres-data volume" {
  run grep "postgres-data" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh minio backup includes minio-data volume" {
  run grep "minio-data" scripts/backup.sh
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

@test "backup.sh list with populated backup dir lists services" {
  local tmpdir
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/db/20260101_120000"
  mkdir -p "$tmpdir/minio/20260102_120000"
  BACKUP_DIR="$tmpdir" run bash scripts/backup.sh list
  [ "$status" -eq 0 ]
  [[ "$output" == *"db: 1 backup(s)"* ]]
  [[ "$output" == *"minio: 1 backup(s)"* ]]
  rm -rf "$tmpdir"
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

@test "deploy.sh maps auth backup to db (auth data lives in postgres)" {
  # The code block sets backup_target="db" when service is "auth"
  run bash -c 'sed -n "/backup_target/,/fi/p" scripts/deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"auth"'* ]]
  [[ "$output" == *'backup_target="db"'* ]]
}

@test "deploy.sh backup command is in dispatcher" {
  run grep "backup).*backup.sh" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

@test "deploy.sh usage lists backup command" {
  run grep "backup.*Run pre-deploy backup" scripts/deploy.sh
  [ "$status" -eq 0 ]
}
