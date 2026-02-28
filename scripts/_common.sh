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

vault_read_kv() {
    local token="$1"
    local path="$2"
    docker exec -e "BAO_ADDR=http://127.0.0.1:8200" -e "BAO_TOKEN=$token" openbao \
        bao kv get -format=json "$path" 2>/dev/null | \
        python3 -c "
import sys, json, shlex
data = json.load(sys.stdin)['data']['data']
for k, v in data.items():
    print(f'{k}={shlex.quote(str(v))}')
"
}

vault_paths_for_service() {
    local service="$1"
    case "$service" in
        db)            echo "secret/shared/database" ;;
        api)           echo "secret/shared/database secret/api/config secret/knowledge/config secret/shared/model-router" ;;
        ai)            echo "secret/shared/database secret/ai/config secret/shared/model-router" ;;
        auth)          echo "secret/shared/database secret/auth/config" ;;
        ui)            echo "secret/ui/config" ;;
        minio)         echo "secret/minio/config" ;;
        infra)         echo "secret/infra/traefik secret/infra/dns-manager" ;;
        observability) echo "secret/observability/grafana" ;;
        knowledge)     echo "secret/knowledge/config" ;;
        *)             echo "" ;;
    esac
}

vault_load_secrets() {
    local service="$1"
    local secrets_file="${2:-$PROJECT_ROOT/infra/secrets/prod.enc.env}"

    local paths
    paths=$(vault_paths_for_service "$service")
    [ -z "$paths" ] && return 0

    local token
    token=$(vault_login "$service" "$secrets_file") || return 1

    local temp_file
    temp_file=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f '$temp_file'" RETURN

    for path in $paths; do
        vault_read_kv "$token" "$path" >> "$temp_file"
    done

    set -a
    # shellcheck disable=SC1090
    source "$temp_file"
    set +a

    rm -f "$temp_file"
    trap - RETURN
}
