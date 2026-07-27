#!/usr/bin/env bash
# Render the Traefik static configuration from its template.
#
# Reads ACME_CA_SERVER from the environment and writes
# platform/edge/traefik.yml.tmpl -> platform/edge/traefik.generated.yml
#
# WHY THIS EXISTS
#
# Traefik's three static-configuration sources — a file, CLI flags, and
# environment variables — are, per the v2.11 docs, "mutually exclusive (i.e. you
# can use only one at the same time)". docker-compose.infra.yml mounts a config
# file, so the CLI flags it also passed were interpolated by Compose and then
# discarded by Traefik. ACME_CA_SERVER did nothing. Nobody could point issuance
# at the staging CA, and the staging default in the compose file was equally
# inert. Rendering the value into the file is what makes the variable real.
#
# WHY THERE IS NO DEFAULT
#
# Both defaults are dangerous in opposite directions:
#
#   - Staging (what the compose file used to default to): any deploy run
#     without secrets loaded silently replaces every certificate with an
#     untrusted one. Browsers hard-fail. Recovery is expensive — Traefik will
#     not reissue a certificate it considers valid, so it means clearing
#     root-owned ACME stores inside a Docker volume, and acme-dns.json holds
#     all four DNS-01 certificates in one file.
#   - Production: an unconfigured environment burns real rate limits — 50
#     certificates per registered domain per week, 5 failed validations per
#     hostname per hour.
#
# A deploy that stops is strictly better than either. So: required, no default.
#
# This is a separate script rather than a function in deploy.sh because the
# SOPS path runs its deploy inside `sops exec-env '<command>'`, which is a new
# shell — a bash function defined in deploy.sh would not exist there.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

TEMPLATE="${TRAEFIK_CONFIG_TEMPLATE:-${PROJECT_ROOT}/platform/edge/traefik.yml.tmpl}"
OUTPUT="${TRAEFIK_CONFIG_OUTPUT:-${PROJECT_ROOT}/platform/edge/traefik.generated.yml}"

[ -f "$TEMPLATE" ] || die "Traefik config template missing: $TEMPLATE"

if [ -z "${ACME_CA_SERVER:-}" ]; then
    die "ACME_CA_SERVER is not set. Refusing to render the Traefik config.

  It selects the ACME certificate authority and has no default on purpose:
    - a staging default would replace every certificate with an untrusted one
      on any deploy run without secrets loaded;
    - a production default would burn real rate limits from an unconfigured
      environment.

  Load secrets before deploying (SOPS or vault), or set it explicitly:
    ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory"
fi

case "$ACME_CA_SERVER" in
    https://*/directory) ;;
    *) die "ACME_CA_SERVER does not look like an ACME directory URL: ${ACME_CA_SERVER}" ;;
esac

# Be loud about staging. An intentional staging deploy is fine; an accidental
# one must not pass unremarked, because the damage is immediate and total.
case "$ACME_CA_SERVER" in
    *acme-staging*)
        warn "ACME_CA_SERVER points at Let's Encrypt STAGING."
        warn "Certificates issued now will be UNTRUSTED by every browser."
        warn "Recovery requires clearing the ACME stores — Traefik will not"
        warn "reissue a certificate it considers valid. See docs/architecture/certificates.md."
        ;;
    *)
        info "ACME CA: ${ACME_CA_SERVER}"
        ;;
esac

mkdir -p "$(dirname "$OUTPUT")"
sed "s|\${ACME_CA_SERVER}|${ACME_CA_SERVER}|g" "$TEMPLATE" > "$OUTPUT" \
    || die "Failed to render $OUTPUT"

# A leftover placeholder means the template grew a variable nothing substitutes.
# Fail rather than mount a config Traefik will misread — silently ignoring an
# unresolved value is the exact class of bug this script exists to remove.
#
# Comment lines are excluded: the template's own header documents `${VAR}` while
# explaining that Traefik does not interpolate it, and that prose is not a
# placeholder. Only configuration lines are checked.
if grep -v '^[[:space:]]*#' "$OUTPUT" | grep -q '\${'; then
    grep -vn '^[[:space:]]*#' "$OUTPUT" | grep '\${' >&2
    rm -f "$OUTPUT"
    die "Unsubstituted placeholders remain after rendering (shown above)"
fi

[ -s "$OUTPUT" ] || die "Rendered Traefik config is empty: $OUTPUT"

success "✓ Rendered $(basename "$OUTPUT") (CA: ${ACME_CA_SERVER})"
