#!/usr/bin/env bats

# Tests for scripts/secrets.sh CLI

@test "secrets.sh with no args shows usage" {
  run bash scripts/secrets.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "secrets.sh help shows usage" {
  run bash scripts/secrets.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "secrets.sh invalid subcommand fails" {
  run bash scripts/secrets.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "secrets.sh view with no file fails gracefully" {
  run bash scripts/secrets.sh view
  [ "$status" -eq 1 ]
}

@test "secrets.sh update with missing args fails" {
  run bash scripts/secrets.sh update
  [ "$status" -eq 1 ]
}
