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
