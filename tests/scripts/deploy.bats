#!/usr/bin/env bats

# Tests for scripts/deploy.sh CLI

@test "deploy.sh with no args shows usage" {
  run bash scripts/deploy.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "deploy.sh help shows usage" {
  run bash scripts/deploy.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "deploy.sh invalid subcommand fails" {
  run bash scripts/deploy.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "deploy.sh infra requires compose file" {
  run bash scripts/deploy.sh infra nonexistent-env
  [ "$status" -eq 1 ]
  [[ "$output" == *"not found"* ]] || [[ "$output" == *"Error"* ]]
}

@test "deploy.sh all checks for infrastructure network" {
  # When no docker network exists, deploy all should fail with helpful message
  run bash scripts/deploy.sh all nonexistent-env
  [ "$status" -eq 1 ]
}
