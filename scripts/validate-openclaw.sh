#!/bin/bash
# Validate OpenClaw service configuration

set -e

ENV=${1:-prod}

echo "Validating OpenClaw configuration..."

# Check build script exists
if [ ! -f "scripts/build-openclaw.sh" ]; then
  echo "✗ OpenClaw build script not found"
  exit 1
fi

# Check required secrets
SECRETS_FILE="infra/secrets/${ENV}.enc.env"
REQUIRED_SECRETS=(
  "OPENCLAW_GATEWAY_TOKEN"
  "CLAUDE_AI_SESSION_KEY"
  "CLAUDE_WEB_SESSION_KEY"
  "CLAUDE_WEB_COOKIE"
)

for secret in "${REQUIRED_SECRETS[@]}"; do
  if ! sops -d "$SECRETS_FILE" | grep -q "^${secret}="; then
    echo "✗ Missing required secret: $secret"
    exit 1
  fi
done

echo "✓ OpenClaw configuration valid"
