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

# ACME_REQUIRE_PRODUCTION turns an intention into an enforced assertion.
#
# The CA value comes from the secrets store — vault first, SOPS as fallback —
# and BOTH override anything the caller exported. `sops exec-env` and the
# `set -a; source` in _common.sh replace a caller-set ACME_CA_SERVER outright.
# So a deploy path that "sets production" on its command line is not actually
# choosing anything; it is stating a hope. If the stored value were staging,
# the deploy would render staging and the caller could not stop it.
#
# Callers that must not issue staging certificates set ACME_REQUIRE_PRODUCTION=1
# and this refuses to render instead. That is a check the secrets store cannot
# silently override, because it is not a secret.
if [ "${ACME_REQUIRE_PRODUCTION:-0}" = "1" ]; then
    case "$ACME_CA_SERVER" in
        *acme-staging*)
            die "ACME_REQUIRE_PRODUCTION=1 but the configured CA is STAGING:
    ${ACME_CA_SERVER}

  This deploy path must not issue untrusted certificates. The value comes from
  the secrets store (vault secret/infra/traefik, or SOPS as fallback) and
  overrides anything exported by the caller, so fix it at the source:
    make secrets-view KEY=ACME_CA_SERVER
    make secrets-update KEY=ACME_CA_SERVER VALUE=https://acme-v02.api.letsencrypt.org/directory
  and reseed vault if it is the active path (bash scripts/vault.sh seed)."
            ;;
    esac
fi

# Be loud about staging. An intentional staging deploy is fine; an accidental
# one must not pass unremarked, because the damage is immediate and total.
case "$ACME_CA_SERVER" in
    *acme-staging*)
        warn "ACME_CA_SERVER points at Let's Encrypt STAGING."
        warn "Certificates issued now will be UNTRUSTED by every browser."
        warn "Recovery requires clearing the ACME stores — Traefik will not"
        warn "reissue a certificate it considers valid. See docs/architecture/certificates.md."
        ;;
    https://acme-v02.api.letsencrypt.org/directory)
        info "ACME CA: Let's Encrypt production"
        ;;
    *)
        # Not an allowlist — ZeroSSL, Buypass and internal CAs are legitimate.
        # But an unrecognised CA reaching here is worth saying out loud, since
        # the URL check above only validates shape.
        warn "ACME CA is not Let's Encrypt: ${ACME_CA_SERVER}"
        warn "Proceeding, but confirm this is intended."
        ;;
esac

# A previous failed deploy can leave a DIRECTORY at the output path: Docker
# creates one when a bind-mount source is missing. Traefik then gets a directory
# at /etc/traefik/traefik.yml and refuses to start, and every subsequent deploy
# fails here for a confusing reason. Clear it explicitly and say so.
if [ -d "$OUTPUT" ]; then
    warn "Removing a directory left at $OUTPUT (Docker creates one when a bind-mount source is missing)."
    rmdir "$OUTPUT" 2>/dev/null || die "Could not remove directory $OUTPUT — remove it by hand and re-run."
fi

# Render atomically. Writing straight to $OUTPUT truncates it before sed runs,
# so a mid-render failure would destroy a previously good config and leave a
# zero-byte file that compose would happily mount.
mkdir -p "$(dirname "$OUTPUT")"
TMP_OUT="$(mktemp "${OUTPUT}.XXXXXX")"
cleanup_tmp() { rm -f "$TMP_OUT"; }
trap cleanup_tmp EXIT

sed "s|\${ACME_CA_SERVER}|${ACME_CA_SERVER}|g" "$TEMPLATE" > "$TMP_OUT" \
    || die "Failed to render Traefik config"

# A leftover placeholder means the template grew a variable nothing substitutes.
# Fail rather than mount a config Traefik will misread — silently ignoring an
# unresolved value is the exact class of bug this script exists to remove.
#
# Comment lines are excluded: the template's own header documents `${VAR}` while
# explaining that Traefik does not interpolate it, and that prose is not a
# placeholder. Only configuration lines are checked.
if grep -v '^[[:space:]]*#' "$TMP_OUT" | grep -q '\${'; then
    grep -vn '^[[:space:]]*#' "$TMP_OUT" | grep '\${' >&2
    die "Unsubstituted placeholders remain after rendering (shown above)"
fi

[ -s "$TMP_OUT" ] || die "Rendered Traefik config is empty"

# Sanity-check the result before it becomes the mounted file.
if command -v python3 >/dev/null 2>&1; then
    python3 -c "import sys,yaml; yaml.safe_load(open(sys.argv[1]))" "$TMP_OUT" 2>/dev/null \
        || die "Rendered Traefik config is not valid YAML"
fi

resolvers_with_ca=$(grep -cF "caServer: ${ACME_CA_SERVER}" "$TMP_OUT" || true)
[ "$resolvers_with_ca" -ge 1 ] || die "Rendered config contains no caServer — the template lost its placeholder"

chmod 0644 "$TMP_OUT"
mv -f "$TMP_OUT" "$OUTPUT"
trap - EXIT

success "✓ Rendered $(basename "$OUTPUT") — ${resolvers_with_ca} resolver(s), CA: ${ACME_CA_SERVER}"
