#!/usr/bin/env bats

# Tests for scripts/hostinger.sh CLI
# Note: hostinger.sh is moved from scripts/infra/ to scripts/
# API calls are NOT tested here (would require real API key)

@test "hostinger.sh with no args shows usage" {
  run bash scripts/hostinger.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]] || [[ "$output" == *"Hostinger CLI"* ]]
}

@test "hostinger.sh help shows usage" {
  run bash scripts/hostinger.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]] || [[ "$output" == *"VPS Commands"* ]]
}

@test "hostinger.sh invalid service fails" {
  run bash scripts/hostinger.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}
