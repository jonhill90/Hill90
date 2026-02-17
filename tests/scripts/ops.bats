#!/usr/bin/env bats

# Tests for scripts/ops.sh CLI

@test "ops.sh with no args shows usage" {
  run bash scripts/ops.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "ops.sh help shows usage" {
  run bash scripts/ops.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "ops.sh invalid subcommand fails" {
  run bash scripts/ops.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

# ---------------------------------------------------------------------------
# MinIO ops tests
# ---------------------------------------------------------------------------

@test "ops.sh backup includes minio-data volume" {
  run bash -c 'sed -n "/^cmd_backup/,/^}/p" scripts/ops.sh | grep "minio-data"'
  [ "$status" -eq 0 ]
}

@test "ops.sh health checks MinIO via docker inspect (not exec)" {
  # Uses Docker health status, not container-internal probes
  run bash -c 'sed -n "/Checking MinIO/,/^fi$/p" scripts/ops.sh | grep "docker inspect"'
  [ "$status" -eq 0 ]
}

@test "ops.sh health sets all_healthy=false when MinIO is stopped" {
  # The stopped/crashed branch must set all_healthy=false
  run bash -c 'sed -n "/Checking MinIO/,/^    fi$/p" scripts/ops.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"Stopped/crashed"* ]]
  [[ "$output" == *"all_healthy=false"* ]]
}
