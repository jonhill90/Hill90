#!/bin/bash
# View a specific secret value
# Usage: bash scripts/secrets-view.sh <secret_file> <key>

set -euo pipefail

# Colors
COLOR_RESET='\033[0m'
COLOR_GREEN='\033[32m'
COLOR_YELLOW='\033[33m'
COLOR_RED='\033[31m'

# Arguments
SECRET_FILE="${1:-}"
KEY="${2:-}"

if [ -z "$SECRET_FILE" ]; then
    echo -e "${COLOR_RED}Error: Missing secret file${COLOR_RESET}"
    echo "Usage: bash scripts/secrets-view.sh <secret_file> [key]"
    echo ""
    echo "Examples:"
    echo "  bash scripts/secrets-view.sh infra/secrets/prod.enc.env           # View all secrets"
    echo "  bash scripts/secrets-view.sh infra/secrets/prod.enc.env VPS_IP    # View specific secret"
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

if [ -z "$KEY" ]; then
    # View all secrets
    echo -e "${COLOR_YELLOW}Viewing all secrets from $SECRET_FILE:${COLOR_RESET}"
    echo ""
    sops -d "$SECRET_FILE" | grep -v "^#" | grep -v "^$"
else
    # View specific secret
    echo -e "${COLOR_YELLOW}Viewing secret $KEY from $SECRET_FILE:${COLOR_RESET}"
    echo ""
    VALUE=$(sops -d --extract "[\"${KEY}\"]" "$SECRET_FILE" 2>/dev/null || echo "")
    if [ -z "$VALUE" ]; then
        echo -e "${COLOR_RED}✗ Secret not found: $KEY${COLOR_RESET}"
        exit 1
    else
        echo -e "${COLOR_GREEN}$KEY=${VALUE}${COLOR_RESET}"
    fi
fi
