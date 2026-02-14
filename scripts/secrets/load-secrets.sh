#!/usr/bin/env bash
# Load secrets from encrypted secrets file
# This script is sourced by other scripts to load environment variables

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SECRETS_FILE="$PROJECT_ROOT/infra/secrets/prod.enc.env"
AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$PROJECT_ROOT/infra/secrets/keys/age-prod.key}"

# Check if secrets file exists
if [[ ! -f "$SECRETS_FILE" ]]; then
    echo "ERROR: Secrets file not found: $SECRETS_FILE"
    exit 1
fi

# Check if age key exists
if [[ ! -f "$AGE_KEY_FILE" ]]; then
    echo "ERROR: Age key file not found: $AGE_KEY_FILE"
    exit 1
fi

# Export age key location for SOPS
export SOPS_AGE_KEY_FILE="$AGE_KEY_FILE"

# Decrypt and load secrets into environment
# Write to temp file to avoid bash variable expansion issues with $ in values
TEMP_FILE=$(mktemp)
trap "rm -f '$TEMP_FILE'" EXIT

sops -d "$SECRETS_FILE" | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | while IFS='=' read -r key value; do
    printf '%s=%q\n' "$key" "$value"
done > "$TEMP_FILE"

# Source the file with auto-export enabled
set -a
source "$TEMP_FILE"
set +a

rm -f "$TEMP_FILE"
