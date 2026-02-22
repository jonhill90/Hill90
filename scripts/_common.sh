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
