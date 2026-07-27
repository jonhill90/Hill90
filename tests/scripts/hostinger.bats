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

@test "hostinger.sh no longer implements DNS" {
  # hill90.com moved to Cloudflare. The DNS half lives in scripts/cloudflare.sh;
  # Hostinger remains the VPS host and the mail provider.
  run bash -c 'grep -E "^dns_(get|sync|verify|reset|update|delete|validate|snapshot)\(\)" scripts/hostinger.sh'
  [ "$status" -ne 0 ]
}

@test "hostinger.sh dns subcommand points at cloudflare.sh" {
  run bash scripts/hostinger.sh dns sync
  [ "$status" -eq 1 ]
  [[ "$output" == *"cloudflare.sh"* ]]
}

@test "hostinger.sh retains the VPS commands vps.sh depends on" {
  # scripts/vps.sh shells out to these for a rebuild. Losing any one breaks
  # recovery of a dead box.
  for fn in vps_get vps_recreate vps_action vps_wait_action; do
    run grep -E "^${fn}\(\)" scripts/hostinger.sh
    [ "$status" -eq 0 ]
  done
}
