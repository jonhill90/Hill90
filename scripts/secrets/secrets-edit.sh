#!/bin/bash
# Edit encrypted secrets with SOPS

set -e

ENV=${1:-prod}
SECRETS_FILE="infra/secrets/${ENV}.enc.env"
AGE_KEY="infra/secrets/keys/age-${ENV}.key"

if [ ! -f "$SECRETS_FILE" ]; then
    echo "Error: Secrets file not found: $SECRETS_FILE"
    exit 1
fi

if [ ! -f "$AGE_KEY" ]; then
    echo "Error: Age key not found: $AGE_KEY"
    echo "Run: make secrets-init"
    exit 1
fi

export SOPS_AGE_KEY_FILE="$AGE_KEY"
sops "$SECRETS_FILE"
