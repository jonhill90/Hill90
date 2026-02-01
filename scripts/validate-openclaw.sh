#!/bin/bash
# Validate OpenClaw enhanced container configuration

set -e

ENV=${1:-prod}

echo "Validating OpenClaw enhanced configuration..."

# Check enhanced build script exists
if [ ! -f "scripts/build-openclaw-enhanced.sh" ]; then
  echo "✗ OpenClaw enhanced build script not found"
  exit 1
fi

# Check Dockerfile exists
if [ ! -f "platform/openclaw/Dockerfile" ]; then
  echo "✗ OpenClaw Dockerfile not found"
  exit 1
fi

# Check SSH directory structure
if [ ! -d "infra/secrets/openclaw-ssh" ]; then
  echo "✗ OpenClaw SSH directory not found"
  exit 1
fi

# Check Ansible playbook exists
if [ ! -f "infra/ansible/playbooks/11-openclaw-ssh.yml" ]; then
  echo "✗ OpenClaw SSH Ansible playbook not found"
  exit 1
fi

# Check required secrets
SECRETS_FILE="infra/secrets/${ENV}.enc.env"
REQUIRED_SECRETS=(
  "OPENCLAW_GATEWAY_TOKEN"
  "ANTHROPIC_API_KEY"
)

for secret in "${REQUIRED_SECRETS[@]}"; do
  if ! sops -d "$SECRETS_FILE" 2>/dev/null | grep -q "^${secret}="; then
    echo "✗ Missing required secret: $secret"
    exit 1
  fi
done

echo "✓ OpenClaw enhanced configuration valid"
