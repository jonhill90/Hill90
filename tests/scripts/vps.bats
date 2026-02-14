#!/usr/bin/env bats

# Tests for scripts/vps.sh CLI

@test "vps.sh with no args shows usage" {
  run bash scripts/vps.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "vps.sh help shows usage" {
  run bash scripts/vps.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "vps.sh invalid subcommand fails" {
  run bash scripts/vps.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "vps.sh config without IP fails" {
  run bash scripts/vps.sh config
  [ "$status" -eq 1 ]
  [[ "$output" == *"required"* ]] || [[ "$output" == *"Usage"* ]]
}
