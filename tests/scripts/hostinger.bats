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

# ---------------------------------------------------------------------------
# MinIO DNS tests
# ---------------------------------------------------------------------------

@test "hostinger.sh dns_sync pair loop includes storage with tailscale_ip" {
  # Verify storage is in the sync pair loop (not just anywhere in the file)
  run bash -c 'sed -n "/^dns_sync/,/^}/p" scripts/hostinger.sh | grep "storage"'
  [ "$status" -eq 0 ]
  [[ "$output" == *"tailscale_ip"* ]]
}

@test "hostinger.sh dns_sync zone payload includes storage record" {
  run bash -c 'sed -n "/^dns_sync/,/^}/p" scripts/hostinger.sh | grep "storage.*\\\$ts"'
  [ "$status" -eq 0 ]
}

@test "hostinger.sh dns_verify includes storage domain" {
  run bash -c 'sed -n "/^dns_verify/,/^}/p" scripts/hostinger.sh | grep "storage"'
  [ "$status" -eq 0 ]
}

@test "hostinger.sh dns_verify has failure tracking and non-zero return" {
  run bash -c 'sed -n "/^dns_verify/,/^}/p" scripts/hostinger.sh | grep "all_correct=true"'
  [ "$status" -eq 0 ]
  run bash -c 'sed -n "/^dns_verify/,/^}/p" scripts/hostinger.sh | grep "return 1"'
  [ "$status" -eq 0 ]
}

@test "hostinger.sh dns_verify does NOT check www (CNAME, not managed by dns_sync)" {
  run bash -c 'sed -n "/^dns_verify/,/^}/p" scripts/hostinger.sh | grep "www"'
  [ "$status" -eq 1 ]
}
