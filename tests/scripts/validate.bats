#!/usr/bin/env bats

# Tests for scripts/validate.sh CLI

@test "validate.sh with no args defaults to all" {
  # Should attempt to run all validations
  run bash scripts/validate.sh
  # May pass or fail depending on local env, but should not show "Unknown"
  [[ "$output" != *"Unknown"* ]]
}

@test "validate.sh help shows usage" {
  run bash scripts/validate.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "validate.sh invalid subcommand fails" {
  run bash scripts/validate.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "validate.sh traefik checks traefik config" {
  run bash scripts/validate.sh traefik
  [[ "$output" == *"Traefik"* ]]
}

@test "validate.sh compose checks compose files" {
  run bash scripts/validate.sh compose
  [[ "$output" == *"Compose"* ]]
}
