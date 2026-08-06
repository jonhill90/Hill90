#!/usr/bin/env bash
# Shared functions for Hill90 CLI scripts
# Source this file: source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

# Colors (exported for scripts that source this file)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
# shellcheck disable=SC2034
CYAN='\033[0;36m'
# shellcheck disable=SC2034
BOLD='\033[1m'
NC='\033[0m'

# Resolve project root from this file's location
COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$COMMON_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

die() {
    echo -e "${RED}ERROR: $*${NC}" >&2
    exit 1
}

warn() {
    echo -e "${YELLOW}WARNING: $*${NC}" >&2
}

info() {
    echo -e "${BLUE}$*${NC}" >&2
}

success() {
    echo -e "${GREEN}$*${NC}" >&2
}

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

require_file() {
    local file="$1"
    local label="${2:-$file}"
    [[ -f "$file" ]] || die "$label not found: $file"
}

require_command() {
    local cmd="$1"
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd is not installed"
}

# ---------------------------------------------------------------------------
# SOPS / age helpers
# ---------------------------------------------------------------------------

ensure_age_key() {
    local env="${1:-prod}"
    if [[ -z "${SOPS_AGE_KEY_FILE:-}" ]]; then
        export SOPS_AGE_KEY_FILE="$PROJECT_ROOT/infra/secrets/keys/age-${env}.key"
    fi
    require_file "$SOPS_AGE_KEY_FILE" "Age key"
}

# ---------------------------------------------------------------------------
# Secret loading (sourceable — injects env vars into caller's shell)
# ---------------------------------------------------------------------------

load_secrets() {
    local secrets_file="${1:-$PROJECT_ROOT/infra/secrets/prod.enc.env}"
    local age_key="${SOPS_AGE_KEY_FILE:-$PROJECT_ROOT/infra/secrets/keys/age-prod.key}"

    require_file "$secrets_file" "Secrets file"
    require_file "$age_key" "Age key file"

    export SOPS_AGE_KEY_FILE="$age_key"

    # Split declaration from assignment on purpose: `local decrypted=$(...)`
    # would discard sops's own exit status — `local` returns its own status,
    # and this function is sourced into callers with neither `set -e` nor
    # `pipefail` (it's a library; that's the caller's choice, not this
    # file's), so nothing downstream would catch it either. This is the
    # widest-reaching instance of the pipeline-exit-status shape in this
    # repo: `decrypted` holds the ENTIRE decrypted secrets store, not one
    # value the way minio.sh's secret_for() does, so a masked failure here
    # means every caller of load_secrets silently loads nothing rather than
    # one script missing one key.
    local decrypted
    if ! decrypted=$(sops -d "$secrets_file"); then
        die "could not decrypt ${secrets_file} — check the age key at ${age_key}"
    fi

    local temp_file
    temp_file=$(mktemp)
    # shellcheck disable=SC2064  # Intentional early expansion of $temp_file
    trap "rm -f '$temp_file'" RETURN

    # Never echo $decrypted — it is the whole store. Only ever piped.
    printf '%s' "$decrypted" | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | while IFS='=' read -r key value; do
        printf '%s=%q\n' "$key" "$value"
    done > "$temp_file"

    set -a
    # shellcheck disable=SC1090  # Dynamic source of decrypted secrets
    source "$temp_file"
    set +a

    rm -f "$temp_file"
}

# Resolve ONE value: the environment first, then the encrypted store.
#
# Deliberately narrower than load_secrets. Several code paths need a single
# non-sensitive value — a role name, a container user — while running outside
# any secret environment: `deploy.sh verify db` is invoked as a bare
# `ssh ... deploy.sh verify db`, and cmd_service's auth precondition runs before
# secrets are loaded. Pulling the entire store into those processes to read one
# username would be the wrong trade.
#
# Prints nothing and returns 1 when the value cannot be resolved, so callers can
# decide between dying and stating an assumption out loud. What they must NOT do
# is silently substitute a literal — see docs/runbooks/deployment.md, "Secrets
# and the shells that do not have them".
secret_value() {
    local var="$1" env="${2:-prod}" value="${!1:-}"
    if [ -n "$value" ]; then printf '%s' "$value"; return 0; fi

    local file="$PROJECT_ROOT/infra/secrets/${env}.enc.env"
    [ -f "$file" ] || return 1
    [ -f "${SOPS_AGE_KEY_FILE:-$PROJECT_ROOT/infra/secrets/keys/age-${env}.key}" ] || return 1
    export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$PROJECT_ROOT/infra/secrets/keys/age-${env}.key}"

    value=$(sops -d "$file" 2>/dev/null | sed -n "s/^${var}=//p" | head -1)
    [ -n "$value" ] || return 1
    printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# Vault (OpenBao) helpers — vault-first secret loading for deploy
# ---------------------------------------------------------------------------

vault_available() {
    docker exec -e "BAO_ADDR=http://127.0.0.1:8200" openbao \
        bao status -format=json 2>/dev/null | \
        python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if not d.get('sealed',True) else 1)" 2>/dev/null
}

# Three failure modes used to `return 1` indistinguishably — h#791 sat
# undiagnosable for days because of it. deploy.sh's call sites redirected this
# function's entire output (both streams) to /dev/null, so whichever of the
# three fired, the operator saw the same sentence: "OpenBao available but
# login failed... falling back to SOPS". For the decrypt case that sentence is
# actively wrong — it names OpenBao when OpenBao was never contacted.
#
# Fix: a short, credential-free reason on stderr, and a DISTINCT return code
# per cause, so a caller that wants to tell them apart can. Stdout carries
# ONLY the token on success, exactly as before — callers that do
# `token=$(vault_login ...)` are unaffected.
#
#   2 = sops decrypt failed                  — nothing to do with OpenBao
#   3 = AppRole credentials missing/empty    — permanent/structural, no request sent
#   4 = OpenBao rejected the login, or the response could not be parsed
#
# CREDENTIAL SAFETY, checked rather than assumed. OpenBao's own rejection text
# for a bad AppRole login is the fixed string "invalid role or secret ID" —
# confirmed against a real rejection captured in
# docs/decisions/approle-rejection-2026-08-01.md, not a submitted value
# interpolated into a template — so surfacing OpenBao's own error line cannot
# echo role_id/secret_id back. role_id and secret_id themselves are never
# printed by this function on any path, and neither is the token except on
# genuine success, on stdout, exactly as it always was.
# tests/scripts/vault-login-diagnostics.bats asserts this directly rather than
# trusting the reasoning above.
vault_login() {
    local service="$1"
    local secrets_file="${2:-$PROJECT_ROOT/infra/secrets/prod.enc.env}"
    local svc_upper
    svc_upper=$(echo "$service" | tr '[:lower:]' '[:upper:]')
    local role_id_var="VAULT_${svc_upper}_ROLE_ID"
    local secret_id_var="VAULT_${svc_upper}_SECRET_ID"

    local temp_file
    temp_file=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f '$temp_file'" RETURN

    if ! sops -d "$secrets_file" > "$temp_file" 2>/dev/null; then
        rm -f "$temp_file"; trap - RETURN
        echo "vault_login: sops decrypt failed for ${secrets_file} — check the age key, not OpenBao" >&2
        return 2
    fi

    local role_id secret_id
    role_id=$(grep "^${role_id_var}=" "$temp_file" | cut -d= -f2-)
    secret_id=$(grep "^${secret_id_var}=" "$temp_file" | cut -d= -f2-)

    rm -f "$temp_file"
    trap - RETURN

    if [ -z "$role_id" ] || [ -z "$secret_id" ]; then
        echo "vault_login: AppRole credentials missing for ${service} (${role_id_var}/${secret_id_var} not set in ${secrets_file}) — no request was sent" >&2
        return 3
    fi

    local response rc
    response=$(docker exec -e "BAO_ADDR=http://127.0.0.1:8200" \
        -e "ROLE_ID=$role_id" -e "SECRET_ID=$secret_id" openbao \
        sh -c 'bao write -format=json auth/approle/login role_id="$ROLE_ID" secret_id="$SECRET_ID"' 2>&1)
    rc=$?

    if [ "$rc" -ne 0 ]; then
        local reason
        reason=$(printf '%s' "$response" | grep -oE '\* .*' | head -1)
        echo "vault_login: OpenBao rejected login for ${service}: ${reason:-request failed (exit ${rc})}" >&2
        return 4
    fi

    printf '%s' "$response" | python3 -c "import sys,json; print(json.load(sys.stdin)['auth']['client_token'])" 2>/dev/null || {
        echo "vault_login: OpenBao login for ${service} succeeded but the response could not be parsed" >&2
        return 4
    }
}

# Read one KV v2 path. NON-ZERO if the path cannot be read for ANY reason.
#
# THIS FUNCTION CAUSED A PRODUCTION OUTAGE ON 2026-08-03 by succeeding quietly.
# It sent stderr to /dev/null and piped into python, so the pipeline's exit
# status was python's — and python exits 0 after printing nothing when its input
# is empty. A 403, a missing path and a genuinely empty secret were therefore
# indistinguishable from a successful read, all reported as success.
#
# Downstream that meant `vault_load_secrets` exported NOTHING and returned 0, the
# SOPS fallback never fired because nothing had failed, and Keycloak deployed with
# KC_BOOTSTRAP_ADMIN_PASSWORD empty. It then refused to boot with
# "bootstrap-admin-username available only when bootstrap admin password is set"
# and auth.hill90.com 404d for 20 minutes.
#
# The rule this encodes: EMPTY IS NOT SUCCESS. Vault being unreachable is not the
# only way the vault path can fail to produce a secret, and it was the only one
# being handled.
vault_read_kv() {
    local token="$1"
    local path="$2"
    # Token via the ENVIRONMENT, not argv — `-e NAME` with no value passes it
    # through, where `-e NAME=value` would put the token in the docker CLI's
    # command line for any local user to read with `ps`. Same reasoning as
    # scripts/keycloak.sh's kc_login and scripts/vault.sh's bao_exec_env.
    local raw
    raw=$(BAO_TOKEN="$token" docker exec -e "BAO_ADDR=http://127.0.0.1:8200" -e BAO_TOKEN openbao \
        bao kv get -format=json "$path" 2>&1) || {
        warn "vault: cannot read ${path} — $(printf '%s' "$raw" | grep -oE '\* .*' | head -1)"
        return 1
    }

    # Parse separately from the read so a JSON shape change is not read as an
    # empty secret. python exits non-zero on a shape it does not recognise, and
    # that status is now the function's.
    printf '%s' "$raw" | python3 -c "
import sys, json, shlex
try:
    data = json.load(sys.stdin)['data']['data']
except Exception as e:
    sys.stderr.write(f'unparseable response: {e}\n')
    sys.exit(1)
if not data:
    sys.stderr.write('path exists but holds no keys\n')
    sys.exit(1)
for k, v in data.items():
    print(f'{k}={shlex.quote(str(v))}')
" || {
        warn "vault: ${path} did not yield usable data"
        return 1
    }
}

# What each service must have NON-EMPTY in its environment after a vault load.
#
# THIS IS THE HOLE THE EMPTY-VALUE GUARD DOES NOT COVER, and the distinction is
# the whole point. #651 made vault_load_secrets refuse when a value vault RETURNS
# is blank. It cannot refuse a variable vault never returns at all — an absent
# key is not an empty value, it is simply missing, and compose then substitutes
# the empty string.
#
# That is exactly what happened on 2026-08-03: secret/observability/grafana held
# one key, GRAFANA_OIDC_CLIENT_SECRET was ABSENT rather than blank, and the guard
# reported "loaded 1 variables for observability, none empty" — true, and
# useless. Grafana started with an empty OIDC secret and SSO broke.
#
# So presence is asserted against a DECLARED list rather than inferred from what
# arrived. check_vault_covers_compose.py keeps this list honest against the
# compose files and pre-up hooks, so it cannot silently under-declare.
vault_required_vars_for_service() {
    local service="$1"
    case "$service" in
        db)            echo "DB_USER DB_PASSWORD" ;;
        auth)          echo "DB_USER DB_PASSWORD KC_ADMIN_USERNAME KC_ADMIN_PASSWORD VAULT_OIDC_CLIENT_SECRET" ;;
        infra)         echo "TRAEFIK_ADMIN_PASSWORD_HASH ACME_EMAIL ACME_CA_SERVER CF_DNS_API_TOKEN" ;;
        observability) echo "GRAFANA_ADMIN_PASSWORD GRAFANA_OIDC_CLIENT_SECRET SMTP_PASSWORD ACME_EMAIL" ;;
        *)             echo "" ;;
    esac
}

vault_paths_for_service() {
    local service="$1"
    case "$service" in
        db)            echo "secret/shared/database" ;;
        auth)          echo "secret/shared/database secret/auth/config" ;;
        infra)         echo "secret/infra/traefik" ;;
        observability) echo "secret/observability/grafana" ;;
        # h#711: "sync" is not a deployable stack — vault_load_secrets is
        # never called with it (deploy.sh only ever passes an actual compose
        # stack name), so this entry exists purely so
        # vault-approle-real-read-test.sh exercises a genuine read for the
        # sync AppRole too, instead of silently reporting "declares no vault
        # paths — nothing to read" for the one role this issue is about.
        # secret/shared/database is not sync-specific; it's simply a real,
        # already-seeded path policy-sync's read-all-of-secret/* grant covers.
        sync)          echo "secret/shared/database" ;;
        *)             echo "" ;;
    esac
}

vault_load_secrets() {
    local service="$1"
    local secrets_file="${2:-$PROJECT_ROOT/infra/secrets/prod.enc.env}"

    local paths
    paths=$(vault_paths_for_service "$service")
    # NO DECLARED PATHS IS NOT A SUCCESSFUL LOAD.
    #
    # This used to `return 0`, which is the same silent-empty bug that took auth
    # down on 2026-08-03, one level up: the caller's vault branch then continued
    # to `docker compose` with an entirely empty environment. Every service not
    # listed in vault_paths_for_service — minio, ui, and anything added later —
    # takes this path on every single deploy.
    #
    # minio survived it only because docker-compose.minio.yml writes
    # `${MINIO_ROOT_USER:?...}`, so compose failed and tripped the fallback. That
    # is a second guard doing the first guard's job, and not every compose file
    # has one. Fail here instead: vault holds nothing for this service, so SOPS
    # is the correct source and the fallback is the correct route to it.
    if [ -z "$paths" ]; then
        info "vault: ${service} declares no vault paths — using SOPS"
        return 1
    fi

    local token
    token=$(vault_login "$service" "$secrets_file") || return 1

    local temp_file
    temp_file=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f '$temp_file'" RETURN

    # A path this service DECLARES it needs and cannot read is a failure, not a
    # zero-length contribution. Returning non-zero here is what makes the caller
    # fall back to SOPS — the fallback exists in both deploy paths and was simply
    # never reached, because nothing ever failed.
    for path in $paths; do
        vault_read_kv "$token" "$path" >> "$temp_file" || {
            warn "vault: ${service} declares ${path} but it could not be read — falling back to SOPS"
            return 1
        }
    done

    # THE GENERIC EMPTY-VALUE GUARD.
    #
    # deploy.sh had one of these for TRAEFIK_ADMIN_PASSWORD_HASH on the infra path
    # only — somebody learned this lesson once, for one variable, in one branch.
    # The generic service path had none, which is why an empty KC_ADMIN_PASSWORD
    # reached Keycloak on 2026-08-03. Checking one known variable per service does
    # not scale and does not generalise: this asserts that NOTHING vault hands
    # back is empty, whatever it is called.
    #
    # An empty value in vault is never a legitimate deploy input here. If one is
    # ever wanted, it belongs in SOPS as an explicit empty, not arriving silently
    # from a gap in the store.
    local empty_keys=()
    local line key
    while IFS= read -r line; do
        case "$line" in ''|'#'*) continue ;; esac
        key="${line%%=*}"
        # The values are shlex-quoted, so an empty one is exactly '' or "".
        case "${line#*=}" in
            "''"|'""'|'') empty_keys+=("$key") ;;
        esac
    done < "$temp_file"

    if [ ${#empty_keys[@]} -gt 0 ]; then
        warn "vault: ${service} — these resolved EMPTY from OpenBao: ${empty_keys[*]}"
        warn "vault: refusing to deploy an empty credential; falling back to SOPS"
        return 1
    fi

    local count
    count=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$temp_file" 2>/dev/null || echo 0)
    if [ "$count" -eq 0 ]; then
        warn "vault: ${service} — the declared paths yielded no variables at all; falling back to SOPS"
        return 1
    fi

    # THE COMPLETENESS GUARD — presence, not just non-emptiness.
    #
    # Checked BEFORE `source`, so a deploy can never proceed on a partial load.
    # The empty-value guard above asks "is anything vault gave us blank?"; this
    # asks "did vault give us everything this service needs?". The 2026-08-03
    # Grafana outage passed the first and would have failed this one.
    local missing_vars=() required
    required=$(vault_required_vars_for_service "$service")
    for key in $required; do
        if ! grep -qE "^${key}=" "$temp_file"; then
            missing_vars+=("${key}(absent)")
        fi
    done

    if [ ${#missing_vars[@]} -gt 0 ]; then
        warn "vault: ${service} — OpenBao did not supply: ${missing_vars[*]}"
        warn "vault: these are declared required for ${service}; deploying now would"
        warn "vault: substitute the EMPTY STRING for each. Falling back to SOPS."
        warn "vault: fix by seeding them — see vault_required_vars_for_service in scripts/_common.sh"
        return 1
    fi

    set -a
    # shellcheck disable=SC1090
    source "$temp_file"
    set +a
    info "vault: loaded ${count} variables for ${service}, none empty, all ${service} requirements present"

    rm -f "$temp_file"
    trap - RETURN
}

# ---------------------------------------------------------------------------
# Disk: builder cache
# ---------------------------------------------------------------------------

# h#811: the build cache grew 9.3GB -> 41.9GB in six days (4.5x), then to
# 49.7GB within another ~10 hours, and node_exporter's own 7-day history
# shows the growth ACCELERATING — the last 3 of those 7 days alone consumed
# 32 of the 39 GiB the whole week lost, roughly 10.7 GiB/day against a 5.4
# GiB/day six-day average. docs/decisions/disk-capacity.md's "note it, don't
# act" rested on the OLD number (9.3GB) and a naive extrapolation of the
# THEN-current rate to "a year of plausible growth" — at the rate actually
# observed since, 149 GiB of headroom is on the order of two weeks, not a
# year.
#
# `docker builder prune` only, never `docker system prune` — this repo's own
# check_destructive_commands.sh bans the latter for good reason (it also
# reaps images and volumes; builder cache is the one store here that is pure
# rebuild convenience with no data of its own). `--keep-storage`, not an
# age filter: the growth this issue is about is RATE-driven (more builds,
# more cache, regardless of any single entry's age), so a size ceiling
# bounds the worst case on every call; an age-based filter (the disk-capacity
# doc's own original suggestion, `--filter until=168h`) would let cache keep
# growing for up to a week before the oldest entries qualify for removal,
# which is exactly the shape that let this reach 49.7GB unnoticed.
#
# 15GB target: "active" (non-reclaimable) cache measured at ~2.6GB when this
# was written (49.7GB total, 47.12GB reclaimable) — 15GB leaves roughly 5-6x
# that as working room for cross-build cache hits across every image this
# host builds, while still bounding worst-case growth to a fraction of what
# reaching 41.9GB uncontrolled took.
#
# NEVER FATAL. A prune that blocks or fails a deploy over housekeeping would
# be a worse trade than the disk problem itself — this warns and continues,
# always, whatever `docker builder prune` does.
#
# CALLED FROM THE BUILD PATHS THEMSELVES (cmd_service in deploy.sh, and the
# agentbox image build workflow in hill90-app), not from a new schedule.
# Growth here is proportional to build activity, not to time — the same
# proportionality disk-capacity.md's own growth section already established
# for a different store (deploy-triggered backups) — so hooking the exact
# events that create cache is a tighter, simpler feedback loop than a
# schedule decoupled from what actually causes the growth, and needs no new
# GH Actions/Tailscale/watchdog plumbing to add.
prune_builder_cache() {
    local keep="${1:-15GB}"
    local before after
    before=$(docker system df --format '{{.Type}}: {{.Size}} ({{.Reclaimable}} reclaimable)' 2>/dev/null | grep '^Build Cache' || echo "Build Cache: unknown")
    info "builder cache before prune: ${before}"

    if ! docker builder prune --keep-storage "$keep" --force >/dev/null 2>&1; then
        warn "docker builder prune failed — continuing, this is housekeeping, not the deploy"
        return 0
    fi

    after=$(docker system df --format '{{.Type}}: {{.Size}} ({{.Reclaimable}} reclaimable)' 2>/dev/null | grep '^Build Cache' || echo "Build Cache: unknown")
    info "builder cache after prune (kept up to ${keep}): ${after}"
}
