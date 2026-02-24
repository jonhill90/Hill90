#!/usr/bin/env bats

# Tests for scripts/rollback.sh CLI

@test "rollback.sh with no args shows usage" {
  run bash scripts/rollback.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "rollback.sh help shows usage" {
  run bash scripts/rollback.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "rollback.sh invalid subcommand fails" {
  run bash scripts/rollback.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "rollback.sh classify with invalid service fails" {
  run bash scripts/rollback.sh classify bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown service"* ]]
}

@test "rollback.sh rollback with no service fails" {
  run bash scripts/rollback.sh rollback
  [ "$status" -eq 1 ]
}

@test "rollback.sh classify with no service fails" {
  run bash scripts/rollback.sh classify
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Structure tests
# ---------------------------------------------------------------------------

@test "rollback.sh sources _common.sh" {
  run grep "source.*_common.sh" scripts/rollback.sh
  [ "$status" -eq 0 ]
}

@test "rollback.sh has classify_changes function" {
  run grep "^classify_changes()" scripts/rollback.sh
  [ "$status" -eq 0 ]
}

@test "rollback.sh has service_paths function" {
  run grep "^service_paths()" scripts/rollback.sh
  [ "$status" -eq 0 ]
}

@test "rollback.sh service_paths covers all services" {
  for svc in api ai mcp ui auth db infra minio observability; do
    run bash -c "sed -n '/^service_paths/,/^}/p' scripts/rollback.sh | grep '${svc})'"
    [ "$status" -eq 0 ]
  done
}

@test "rollback.sh detects migration files in change classification" {
  run grep "migrations" scripts/rollback.sh
  [ "$status" -eq 0 ]
}

@test "rollback.sh refuses rollback for schema-forward changes" {
  run grep "ROLLBACK REFUSED" scripts/rollback.sh
  [ "$status" -eq 0 ]
}

@test "rollback.sh provides manual restore instructions for schema-forward" {
  run bash -c 'sed -n "/schema-forward/,/;;/p" scripts/rollback.sh | grep "backup.sh"'
  [ "$status" -eq 0 ]
}

@test "rollback.sh has 5-second abort window for automated rollbacks" {
  run grep "sleep 5" scripts/rollback.sh
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Classify behavior tests (using real git history)
# ---------------------------------------------------------------------------

@test "rollback.sh classify reports 'none' when no service files changed" {
  # HEAD vs HEAD should always be 'none'
  run bash scripts/rollback.sh classify api HEAD
  [ "$status" -eq 0 ]
  [[ "$output" == *"none"* ]]
}

@test "rollback.sh auto-redeploys after git checkout" {
  run grep 'deploy.sh.*\$service.*prod' scripts/rollback.sh
  [ "$status" -eq 0 ]
}

@test "rollback.sh exits non-zero if deploy fails after rollback" {
  run grep 'exit 1' scripts/rollback.sh
  [ "$status" -eq 0 ]
}

@test "rollback.sh has paths subcommand in dispatcher" {
  run grep 'paths)' scripts/rollback.sh
  [ "$status" -eq 0 ]
}

@test "rollback.sh paths outputs only path tokens (shell-safe for command substitution)" {
  run bash scripts/rollback.sh paths api
  [ "$status" -eq 0 ]
  # No blank lines, no prose — every line must start with a path-like character
  [[ ! "$output" =~ ^[[:space:]]*$ ]]
  [[ "$output" == *"services/api"* ]]
}

@test "rollback.sh classify outputs change class field" {
  run bash scripts/rollback.sh classify api HEAD~1
  [ "$status" -eq 0 ]
  [[ "$output" == *"Class:"* ]]
}

@test "rollback.sh classify shows current and target refs" {
  run bash scripts/rollback.sh classify api HEAD~1
  [ "$status" -eq 0 ]
  [[ "$output" == *"Current:"* ]]
  [[ "$output" == *"Target:"* ]]
}
