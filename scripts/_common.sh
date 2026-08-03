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

    local temp_file
    temp_file=$(mktemp)
    # shellcheck disable=SC2064  # Intentional early expansion of $temp_file
    trap "rm -f '$temp_file'" RETURN

    sops -d "$secrets_file" | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | while IFS='=' read -r key value; do
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

    sops -d "$secrets_file" > "$temp_file" 2>/dev/null || { rm -f "$temp_file"; trap - RETURN; return 1; }

    local role_id secret_id
    role_id=$(grep "^${role_id_var}=" "$temp_file" | cut -d= -f2-)
    secret_id=$(grep "^${secret_id_var}=" "$temp_file" | cut -d= -f2-)

    rm -f "$temp_file"
    trap - RETURN

    [ -z "$role_id" ] && return 1
    [ -z "$secret_id" ] && return 1

    docker exec -e "BAO_ADDR=http://127.0.0.1:8200" \
        -e "ROLE_ID=$role_id" -e "SECRET_ID=$secret_id" openbao \
        sh -c 'bao write -format=json auth/approle/login role_id="$ROLE_ID" secret_id="$SECRET_ID"' | \
        python3 -c "import sys,json; print(json.load(sys.stdin)['auth']['client_token'])"
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

vault_paths_for_service() {
    local service="$1"
    case "$service" in
        db)            echo "secret/shared/database" ;;
        auth)          echo "secret/shared/database secret/auth/config" ;;
        infra)         echo "secret/infra/traefik" ;;
        observability) echo "secret/observability/grafana" ;;
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

    set -a
    # shellcheck disable=SC1090
    source "$temp_file"
    set +a
    info "vault: loaded ${count} variables for ${service}, none empty"

    rm -f "$temp_file"
    trap - RETURN
}
