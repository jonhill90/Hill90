#!/bin/bash
# Safe secret updates - no corruption
# Usage: bash scripts/secrets-update.sh <secret_file> <key> <value>

set -euo pipefail

# Colors
COLOR_RESET='\033[0m'
COLOR_GREEN='\033[32m'
COLOR_YELLOW='\033[33m'
COLOR_RED='\033[31m'

# Arguments
SECRET_FILE="${1:-}"
KEY="${2:-}"
VALUE="${3:-}"

if [ -z "$SECRET_FILE" ] || [ -z "$KEY" ] || [ -z "$VALUE" ]; then
    echo -e "${COLOR_RED}Error: Missing arguments${COLOR_RESET}"
    echo "Usage: bash scripts/secrets-update.sh <secret_file> <key> <value>"
    echo ""
    echo "Example:"
    echo "  bash scripts/secrets-update.sh infra/secrets/prod.enc.env VPS_IP \"76.13.26.69\""
    exit 1
fi

if [ ! -f "$SECRET_FILE" ]; then
    echo -e "${COLOR_RED}Error: Secret file not found: $SECRET_FILE${COLOR_RESET}"
    exit 1
fi

# Ensure SOPS_AGE_KEY_FILE is set
if [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
    export SOPS_AGE_KEY_FILE="infra/secrets/keys/age-prod.key"
    echo -e "${COLOR_YELLOW}Using default age key: $SOPS_AGE_KEY_FILE${COLOR_RESET}"
fi

if [ ! -f "$SOPS_AGE_KEY_FILE" ]; then
    echo -e "${COLOR_RED}Error: Age key file not found: $SOPS_AGE_KEY_FILE${COLOR_RESET}"
    exit 1
fi

echo -e "${COLOR_YELLOW}Updating secret $KEY in $SECRET_FILE...${COLOR_RESET}"

# Backup the file first
BACKUP_FILE="${SECRET_FILE}.backup.$(date +%s)"
cp "$SECRET_FILE" "$BACKUP_FILE"
echo -e "${COLOR_YELLOW}Created backup: $BACKUP_FILE${COLOR_RESET}"

# Update the secret atomically using sops --set
# Use jq to properly escape the value for JSON
ESCAPED_VALUE=$(echo -n "$VALUE" | jq -Rs .)
if sops --set "[\"${KEY}\"] ${ESCAPED_VALUE}" "$SECRET_FILE"; then
    echo -e "${COLOR_GREEN}✓ Secret updated successfully!${COLOR_RESET}"
    echo -e "${COLOR_YELLOW}Backup saved: $BACKUP_FILE${COLOR_RESET}"

    # Clean up old backups (keep only last 5)
    BACKUP_COUNT=$(ls -1 "${SECRET_FILE}.backup."* 2>/dev/null | wc -l | tr -d ' ')
    if [ "$BACKUP_COUNT" -gt 5 ]; then
        echo -e "${COLOR_YELLOW}Cleaning up old backups (keeping last 5)...${COLOR_RESET}"
        ls -1t "${SECRET_FILE}.backup."* | tail -n +6 | xargs rm -f
        echo -e "${COLOR_GREEN}✓ Cleaned up $((BACKUP_COUNT - 5)) old backup(s)${COLOR_RESET}"
    fi
else
    echo -e "${COLOR_RED}✗ Failed to update secret${COLOR_RESET}"
    echo -e "${COLOR_YELLOW}Restoring from backup...${COLOR_RESET}"
    mv "$BACKUP_FILE" "$SECRET_FILE"
    echo -e "${COLOR_GREEN}Restored from backup${COLOR_RESET}"
    exit 1
fi
