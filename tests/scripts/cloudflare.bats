#!/usr/bin/env bats

# Tests for scripts/cloudflare.sh — DNS record sync against the Cloudflare API.

# ---------------------------------------------------------------------------
# Basic CLI
# ---------------------------------------------------------------------------

@test "cloudflare.sh with no args shows usage" {
  run bash scripts/cloudflare.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "cloudflare.sh help shows usage" {
  run bash scripts/cloudflare.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "cloudflare.sh invalid service fails" {
  run bash scripts/cloudflare.sh notaservice
  [ "$status" -eq 1 ]
}

@test "cloudflare.sh dns with invalid command fails" {
  run bash scripts/cloudflare.sh dns notacommand
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Safety contract (carries forward the intent of hostinger.bats:72, JON-47)
#
# The old dns_sync posted the whole record set to a zone-wide PUT. Removing
# `overwrite: true` stopped it destroying the records it did not know about,
# but left an endpoint that was still capable of replacing the zone. The
# property asserted here is the stronger one: no code path can replace or
# delete a record it was not explicitly handed.
# ---------------------------------------------------------------------------

@test "cloudflare.sh never issues a DELETE" {
  # Deleting a record is not something a VPS rebuild ever needs to do. If a
  # DELETE appears here, the blast radius of a bug in this script grows from
  # "wrong IP on a managed record" to "record gone".
  run bash -c 'grep -nE "DELETE" scripts/cloudflare.sh | grep -v "^[0-9]*:#" | grep -v "never issues"'
  [ "$status" -ne 0 ]
}

@test "cloudflare.sh has no whole-zone or bulk write endpoint" {
  # The Hostinger predecessor wrote PUT /zones/{domain} with the full record
  # set as payload. Cloudflare's per-record API has no such endpoint, and this
  # script must not grow one (e.g. /dns_records/batch).
  run bash -c 'grep -nE "dns_records/batch|PUT \"?/zones/[^/]*\"?$|api_call PUT \"/zones/\$\(zone_id\)\"" scripts/cloudflare.sh'
  [ "$status" -ne 0 ]
}

@test "every write goes through cf_upsert_record" {
  # POST and PATCH must appear only inside cf_upsert_record. Any other write
  # site would bypass the explicit-name discipline.
  local writes_outside
  writes_outside=$(awk '
    /^cf_upsert_record\(\)/ {infunc=1}
    infunc && /^}/ {infunc=0; next}
    !infunc && /api_call (POST|PATCH)/ {print NR": "$0}
  ' scripts/cloudflare.sh)
  [ -z "$writes_outside" ]
}

@test "cf_upsert_record updates by explicit record id, not by name match" {
  # PATCH must target /dns_records/${record_id}. Patching by name would let a
  # server-side ambiguity decide which record gets written.
  run grep -E 'api_call PATCH "/zones/\$\(zone_id\)/dns_records/\$\{record_id\}"' scripts/cloudflare.sh
  [ "$status" -eq 0 ]
}

@test "cf_upsert_record sends only content on update, preserving other fields" {
  # Sending ttl or proxied on PATCH would silently reset attributes the rebuild
  # was never asked to change.
  run bash -c "sed -n '/^cf_upsert_record/,/^}\$/p' scripts/cloudflare.sh | grep -A2 'api_call PATCH' | grep 'jq -nc'"
  [ "$status" -eq 0 ]
  [[ "$output" == *'{content:$c}'* ]]
}

@test "record lookup filters on type=A and exact name" {
  # Without type=A, a CNAME or TXT at the same name could be matched and then
  # patched with an IPv4 address.
  run grep -E 'dns_records\?type=A&name=' scripts/cloudflare.sh
  [ "$status" -eq 0 ]
}

@test "ambiguous lookups abort rather than picking a record" {
  run bash -c "sed -n '/^find_a_record/,/^}\$/p' scripts/cloudflare.sh | grep -c 'Refusing to guess'"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

@test "zone lookup aborts unless exactly one zone matches" {
  run bash -c "sed -n '/^zone_id/,/^}\$/p' scripts/cloudflare.sh | grep 'Refusing to guess which zone'"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Managed record set
# ---------------------------------------------------------------------------

@test "MANAGED_RECORDS is a literal allowlist with no wildcards" {
  run bash -c "sed -n '/^MANAGED_RECORDS=(/,/^)\$/p' scripts/cloudflare.sh | grep -E '\\*|\\\$\\{|\\\$\\('"
  [ "$status" -ne 0 ]
}

@test "MANAGED_RECORDS covers the records a VPS rebuild changes" {
  # These are the names the old hostinger.sh dns_sync maintained. Dropping one
  # silently means that host stops resolving after a rebuild.
  for name in "@" "remote" "vps" "portainer" "traefik" "grafana" "vault"; do
    run bash -c "sed -n '/^MANAGED_RECORDS=(/,/^)\$/p' scripts/cloudflare.sh | grep -F '\"${name}:'"
    [ "$status" -eq 0 ]
  done
}

@test "dns_sync manages the remote record that SSH depends on" {
  # Public SSH is locked down; remote.hill90.com on the Tailscale IP is the
  # only way back into the box. Same assertion the Hostinger suite carried.
  run bash -c "sed -n '/^MANAGED_RECORDS=(/,/^)\$/p' scripts/cloudflare.sh | grep -F '\"remote:tailscale\"'"
  [ "$status" -eq 0 ]
}

@test "apex maps to the public IP and admin hosts map to Tailscale" {
  run bash -c "sed -n '/^MANAGED_RECORDS=(/,/^)\$/p' scripts/cloudflare.sh | grep -F '\"@:vps\"'"
  [ "$status" -eq 0 ]
  for name in portainer traefik grafana vault; do
    run bash -c "sed -n '/^MANAGED_RECORDS=(/,/^)\$/p' scripts/cloudflare.sh | grep -F '\"${name}:tailscale\"'"
    [ "$status" -eq 0 ]
  done
}

@test "MANAGED_RECORDS does not include mail, www, docs or other zone records" {
  # The zone has ~33 record groups. Anything not managed here must be invisible
  # to this script — never compared, never written.
  for name in www docs mx autoconfig autodiscover _dmarc; do
    run bash -c "sed -n '/^MANAGED_RECORDS=(/,/^)\$/p' scripts/cloudflare.sh | grep -F '\"${name}:'"
    [ "$status" -ne 0 ]
  done
}

# ---------------------------------------------------------------------------
# Credential and proxy posture
# ---------------------------------------------------------------------------

@test "cloudflare.sh reuses CF_DNS_API_TOKEN rather than a second credential" {
  run grep -c "CF_DNS_API_TOKEN" scripts/cloudflare.sh
  [ "$status" -eq 0 ]
  [ "$output" -ge 2 ]
  # No separate Cloudflare credential mechanism.
  run bash -c 'grep -E "CF_API_KEY|CF_API_EMAIL|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL" scripts/cloudflare.sh'
  [ "$status" -ne 0 ]
}

@test "created records are explicitly dns-only" {
  # Cloudflare cannot proxy SMTP and the Tailscale hosts resolve into
  # 100.64.0.0/10, which a proxy cannot reach. Every record in this zone is
  # dns-only by design.
  run bash -c "sed -n '/^cf_upsert_record/,/^}\$/p' scripts/cloudflare.sh | grep 'proxied:false'"
  [ "$status" -eq 0 ]
}

@test "API errors are detected from the success field, not the status code" {
  # Cloudflare returns HTTP 200 with "success": false for application errors.
  run bash -c "sed -n '/^api_call/,/^}\$/p' scripts/cloudflare.sh | grep -F '.success'"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Caller wiring
# ---------------------------------------------------------------------------

@test "Makefile dns targets call cloudflare.sh, not hostinger.sh" {
  run bash -c 'grep -E "^\s+@?bash scripts/hostinger.sh dns" Makefile'
  [ "$status" -ne 0 ]
  run bash -c 'grep -c "scripts/cloudflare.sh dns" Makefile'
  [ "$status" -eq 0 ]
  [ "$output" -ge 3 ]
}

@test "config-vps workflow syncs DNS through cloudflare.sh" {
  run bash -c 'grep "scripts/hostinger.sh dns" .github/workflows/config-vps.yml'
  [ "$status" -ne 0 ]
  run bash -c 'grep "scripts/cloudflare.sh dns sync" .github/workflows/config-vps.yml'
  [ "$status" -eq 0 ]
}

@test "hostinger.sh retains VPS management and no longer does DNS" {
  # Hostinger is still the VPS host. vps.sh depends on these.
  for cmd in vps_get vps_recreate vps_wait_action; do
    run grep -E "^${cmd}\(\)" scripts/hostinger.sh
    [ "$status" -eq 0 ]
  done
  # The DNS half is gone.
  run bash -c 'grep -E "^dns_(sync|verify|get|reset|update|delete)\(\)" scripts/hostinger.sh'
  [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Parity with the declared record set (ported from hostinger.bats, JON-47 era)
# ---------------------------------------------------------------------------

@test "MANAGED_RECORDS and infra/dns/hill90.com.json describe the same records" {
  # Two sources describing the zone that can disagree is how a host silently
  # stops being managed. They must stay in lockstep.
  run bash -c '
    managed=$(sed -n "/^MANAGED_RECORDS=(/,/^)$/p" scripts/cloudflare.sh \
      | grep -oE "\"[a-z@]+:" | tr -d "\":" | sort -u)
    declared=$(python3 -c "
import json
print(chr(10).join(sorted(r[\"name\"] for r in json.load(open(\"infra/dns/hill90.com.json\"))[\"records\"])))")
    [ "$managed" = "$declared" ]'
  [ "$status" -eq 0 ]
}

@test "infra/dns/hill90.com.json has no app-era hostnames" {
  run python3 -c "
import json,sys
names={r['name'] for r in json.load(open('infra/dns/hill90.com.json'))['records']}
sys.exit(1 if names & {'api','ai','auth','storage','litellm','openclaw','admin'} else 0)"
  [ "$status" -eq 0 ]
}
