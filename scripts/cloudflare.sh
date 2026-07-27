#!/usr/bin/env bash
# Cloudflare DNS CLI — record sync and verification for hill90.com
# Usage: cloudflare.sh dns <command> [args]
#
# Replaces the DNS half of scripts/hostinger.sh. Hostinger remains the VPS host
# and the mail provider; this file only knows about DNS.
#
# ---------------------------------------------------------------------------
# SAFETY CONTRACT — read before editing
# ---------------------------------------------------------------------------
#
# This script cannot replace or delete a record it was not explicitly handed.
# That is a structural property of how it talks to Cloudflare, not a convention:
#
#   1. MANAGED_RECORDS below is the ONLY set of names this script will ever
#      write. It is a literal allowlist, not a pattern or a wildcard.
#   2. Every write goes through cf_upsert_record(), which takes one explicit
#      name and one explicit content value, and touches exactly that record.
#   3. There is NO DELETE verb anywhere in this file, and no bulk or
#      whole-zone-replacement endpoint. Cloudflare's DNS API is per-record by
#      default; there is no equivalent of a zone-wide PUT to reach for.
#   4. Updates are PATCH by record id with only the `content` field, so any
#      other attribute of an existing record — TTL, proxied state, comment —
#      is left exactly as it was.
#
# The predecessor was a whole-zone PUT that took the entire record set as its
# payload. Under JON-47 the `overwrite: true` flag was removed from it, which
# stopped it destroying the ~26 records it did not know about — among them the
# `remote` A record that is the only SSH path to the VPS, and every mail record
# (MX, SPF, DKIM, DMARC, autoconfig, autodiscover). That fix was correct, but it
# held a dangerous shape in place by convention: the endpoint remained capable of
# replacing the zone, and safety depended on a comment and a test asserting one
# flag stayed absent.
#
# The property to preserve here is stronger than "that flag is absent". It is
# that no code path can replace or delete a record it was not explicitly handed.
# tests/scripts/cloudflare.bats asserts that directly. Do not add a DELETE, and
# do not introduce an endpoint that takes a record set.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

API_BASE="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
DOMAIN="${CLOUDFLARE_DOMAIN:-hill90.com}"
SECRETS_FILE="${CLOUDFLARE_SECRETS_FILE:-${PROJECT_ROOT}/infra/secrets/prod.enc.env}"

# The complete set of records this script manages. Anything not named here is
# invisible to it — it is never read for comparison and never written.
#
# Format: <name>:<which-ip>, where which-ip is `vps` (public) or `tailscale`.
# `@` is the zone apex.
MANAGED_RECORDS=(
    "@:vps"
    "remote:tailscale"
    "vps:tailscale"
    "portainer:tailscale"
    "traefik:tailscale"
    "grafana:tailscale"
    "vault:tailscale"
)

RECORD_TTL="${CLOUDFLARE_RECORD_TTL:-3600}"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Cloudflare DNS CLI — hill90.com

Usage: cloudflare.sh dns <command> [args]

Commands:
  get                     List the managed A records as Cloudflare holds them
  sync [vps_ip] [ts_ip]   Upsert the managed A records (IPs default to SOPS)
  verify [expected_ip]    Check public DNS resolution against expected IPs

Managed records (the only records this script will ever write):
$(printf '  %s.%s\n' "${MANAGED_RECORDS[@]%%:*}" "$DOMAIN" | sed "s/^  @\./  $DOMAIN  (apex)  ./")

Environment:
  CF_DNS_API_TOKEN   Cloudflare API token, scoped to the $DOMAIN zone with
                     Zone/Zone/Read and Zone/DNS/Edit. Read from SOPS if unset.
EOF
}

# ---------------------------------------------------------------------------
# API plumbing
# ---------------------------------------------------------------------------

_token=""

ensure_api_token() {
    [[ -n "$_token" ]] && return 0

    if [[ -n "${CF_DNS_API_TOKEN:-}" ]]; then
        _token="$CF_DNS_API_TOKEN"
    else
        require_file "$SECRETS_FILE" "Secrets file"
        ensure_age_key prod
        _token=$(sops -d "$SECRETS_FILE" 2>/dev/null \
            | grep "^CF_DNS_API_TOKEN=" | cut -d '=' -f 2- || true)
    fi

    if [[ -z "$_token" ]]; then
        die "CF_DNS_API_TOKEN is not set and not present in ${SECRETS_FILE}. It is the same token Traefik uses for ACME DNS-01 — scoped to the ${DOMAIN} zone with Zone/Zone/Read and Zone/DNS/Edit."
    fi
}

# api_call <METHOD> <PATH> [JSON_BODY]
#
# Returns the `result` field on success. Cloudflare returns HTTP 200 with
# "success": false for application-level errors, so the status code alone is
# not a sufficient check.
api_call() {
    local method="$1" path="$2" body="${3:-}"
    ensure_api_token

    local args=(-sS -X "$method" "${API_BASE}${path}"
                -H "Authorization: Bearer ${_token}"
                -H "Content-Type: application/json")
    [[ -n "$body" ]] && args+=(--data "$body")

    local response
    response=$(curl "${args[@]}") || die "Cloudflare API request failed: ${method} ${path}"

    if [[ "$(jq -r '.success' <<<"$response")" != "true" ]]; then
        local errors
        errors=$(jq -r '[.errors[]? | "\(.code): \(.message)"] | join("; ")' <<<"$response")
        die "Cloudflare API error on ${method} ${path}: ${errors:-unknown error}"
    fi

    jq '.result' <<<"$response"
}

_zone_id=""

zone_id() {
    [[ -n "$_zone_id" ]] && { printf '%s' "$_zone_id"; return 0; }

    local result
    result=$(api_call GET "/zones?name=${DOMAIN}")

    local count
    count=$(jq 'length' <<<"$result")
    if [[ "$count" != "1" ]]; then
        die "Expected exactly one zone named ${DOMAIN}, found ${count}. Refusing to guess which zone to write to."
    fi

    _zone_id=$(jq -r '.[0].id' <<<"$result")
    printf '%s' "$_zone_id"
}

# fqdn_for <name> — the apex is the bare domain, everything else is a subdomain
fqdn_for() {
    if [[ "$1" == "@" ]]; then printf '%s' "$DOMAIN"; else printf '%s.%s' "$1" "$DOMAIN"; fi
}

# find_a_record <fqdn> — echoes "<record_id> <content>" or nothing.
#
# Filters by exact name AND type=A so a CNAME or TXT at the same name is never
# mistaken for the record being managed.
find_a_record() {
    local fqdn="$1" result count
    result=$(api_call GET "/zones/$(zone_id)/dns_records?type=A&name=${fqdn}")

    count=$(jq 'length' <<<"$result")
    [[ "$count" == "0" ]] && return 0

    # Two A records at one name is a legitimate Cloudflare configuration
    # (round-robin). This script has no way to know which one the rebuild meant,
    # so it stops rather than picking one.
    if [[ "$count" != "1" ]]; then
        die "Found ${count} A records for ${fqdn}. Refusing to guess which to update — resolve this in the Cloudflare dashboard first."
    fi

    jq -r '.[0] | "\(.id) \(.content)"' <<<"$result"
}

# cf_upsert_record <fqdn> <ipv4>
#
# The ONLY write path in this script. Touches exactly the one record named by
# $fqdn: PATCHes it by id if it exists, creates it if it does not. Never
# deletes, and never touches any other record.
cf_upsert_record() {
    local fqdn="$1" content="$2"
    local existing record_id current

    existing=$(find_a_record "$fqdn")

    if [[ -z "$existing" ]]; then
        # proxied:false is explicit. Cloudflare cannot proxy SMTP, the mail
        # records must resolve directly, and the Tailscale hosts resolve into
        # 100.64.0.0/10 which is not routable for a proxy to reach. Every record
        # in this zone is dns-only by design.
        api_call POST "/zones/$(zone_id)/dns_records" \
            "$(jq -nc --arg n "$fqdn" --arg c "$content" --argjson t "$RECORD_TTL" \
                '{type:"A", name:$n, content:$c, ttl:$t, proxied:false}')" > /dev/null
        success "  created ${fqdn} -> ${content}"
        return 0
    fi

    record_id="${existing%% *}"
    current="${existing#* }"

    if [[ "$current" == "$content" ]]; then
        info "  ${fqdn} -> ${content} (unchanged)"
        return 0
    fi

    # PATCH with content only. TTL, proxied state and any comment on the
    # existing record are deliberately not sent, so they are preserved.
    api_call PATCH "/zones/$(zone_id)/dns_records/${record_id}" \
        "$(jq -nc --arg c "$content" '{content:$c}')" > /dev/null
    success "  updated ${fqdn} -> ${content} (was ${current})"
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

secret_value() {
    sops -d "$SECRETS_FILE" 2>/dev/null | grep "^${1}=" | cut -d '=' -f 2- | tr -d '"' || true
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

dns_get() {
    echo "Managed A records for ${DOMAIN}:" >&2
    local entry name fqdn existing
    for entry in "${MANAGED_RECORDS[@]}"; do
        name="${entry%%:*}"
        fqdn=$(fqdn_for "$name")
        existing=$(find_a_record "$fqdn")
        if [[ -z "$existing" ]]; then
            warn "  ${fqdn} -> (no record)"
        else
            echo "  ${fqdn} -> ${existing#* }" >&2
        fi
    done
}

dns_sync() {
    local vps_ip="${1:-}" tailscale_ip="${2:-}"

    [[ -z "$vps_ip" ]] && vps_ip=$(secret_value VPS_IP)
    [[ -z "$tailscale_ip" ]] && tailscale_ip=$(secret_value TAILSCALE_IP)

    [[ -n "$vps_ip" ]] || die "VPS_IP not supplied and not found in ${SECRETS_FILE}"
    [[ -n "$tailscale_ip" ]] || die "TAILSCALE_IP not supplied and not found in ${SECRETS_FILE}"

    info "Syncing DNS A records for ${DOMAIN}"
    info "  Public IP:    ${vps_ip}"
    info "  Tailscale IP: ${tailscale_ip}"
    echo "" >&2

    local entry name which content
    for entry in "${MANAGED_RECORDS[@]}"; do
        name="${entry%%:*}"
        which="${entry##*:}"
        case "$which" in
            vps)       content="$vps_ip" ;;
            tailscale) content="$tailscale_ip" ;;
            *)         die "Unknown IP selector '${which}' for record '${name}'" ;;
        esac
        cf_upsert_record "$(fqdn_for "$name")" "$content"
    done

    echo "" >&2
    success "DNS sync complete — ${#MANAGED_RECORDS[@]} records checked, nothing else in the zone touched."
}

dns_verify() {
    local expected_ip="${1:-}"
    local all_correct=true

    [[ -z "$expected_ip" ]] && expected_ip=$(secret_value VPS_IP)
    local tailscale_ip
    tailscale_ip=$(secret_value TAILSCALE_IP)

    info "Verifying public DNS resolution for ${DOMAIN}"
    echo "" >&2

    local entry name which fqdn expected resolved
    for entry in "${MANAGED_RECORDS[@]}"; do
        name="${entry%%:*}"
        which="${entry##*:}"
        fqdn=$(fqdn_for "$name")
        case "$which" in
            vps)       expected="$expected_ip" ;;
            tailscale) expected="$tailscale_ip" ;;
        esac

        resolved=$(dig +short "$fqdn" A 2>/dev/null | head -n1)

        if [[ -z "$resolved" ]]; then
            warn "  ${fqdn} -> (no record)"
            all_correct=false
        elif [[ -z "$expected" ]]; then
            info "  ${fqdn} -> ${resolved}"
        elif [[ "$resolved" == "$expected" ]]; then
            success "  ${fqdn} -> ${resolved}"
        else
            warn "  ${fqdn} -> ${resolved} (expected ${expected})"
            all_correct=false
        fi
    done

    echo "" >&2
    if [[ "$all_correct" == "true" ]]; then
        success "All managed records resolve as expected."
        return 0
    fi
    warn "Some records do not match. Propagation can take a few minutes after a sync."
    return 1
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

main() {
    local service="${1:-}"
    [[ -n "$service" ]] && shift || true

    case "$service" in
        dns)
            local command="${1:-}"
            [[ -n "$command" ]] && shift || true
            case "$command" in
                get)    dns_get "$@" ;;
                sync)   dns_sync "$@" ;;
                verify) dns_verify "$@" ;;
                *)      usage; exit 1 ;;
            esac
            ;;
        help|--help|-h) usage ;;
        *) usage; exit 1 ;;
    esac
}

main "$@"
