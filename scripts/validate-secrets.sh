#!/bin/bash
# Validate secrets configuration

set -e

ENV=${1:-prod}
SECRETS_FILE="infra/secrets/${ENV}.enc.env"
AGE_KEY="infra/secrets/keys/age-${ENV}.key"

echo "================================"
echo "Secrets Validation"
echo "================================"
echo ""

all_valid=true

# Check age key exists
echo -n "Checking age key ($AGE_KEY)... "
if [ -f "$AGE_KEY" ]; then
  echo "✓"
else
  echo "✗ Not found: $AGE_KEY"
  all_valid=false
  echo ""
  echo "================================"
  echo "✗ Cannot proceed without age key"
  echo "================================"
  exit 1
fi

# Check SOPS is installed
echo -n "Checking SOPS installation... "
if command -v sops >/dev/null 2>&1; then
  echo "✓"
else
  echo "✗ SOPS not installed"
  all_valid=false
  echo ""
  echo "================================"
  echo "✗ Install SOPS: brew install sops"
  echo "================================"
  exit 1
fi

# Check secrets file exists
echo -n "Checking secrets file ($SECRETS_FILE)... "
if [ -f "$SECRETS_FILE" ]; then
  echo "✓"
else
  echo "✗ Not found: $SECRETS_FILE"
  all_valid=false
  echo ""
  echo "================================"
  echo "✗ Secrets file missing"
  echo "================================"
  exit 1
fi

# Check SOPS can decrypt
echo -n "Testing SOPS decryption... "
export SOPS_AGE_KEY_FILE="$AGE_KEY"
if sops -d "$SECRETS_FILE" > /dev/null 2>&1; then
  echo "✓"
else
  echo "✗ Cannot decrypt secrets"
  all_valid=false
  echo ""
  echo "================================"
  echo "✗ SOPS decryption failed"
  echo "  Check age key is correct"
  echo "================================"
  exit 1
fi

# Define required secrets
REQUIRED_SECRETS=(
  "VPS_IP"
  "VPS_HOST"
  "DB_USER"
  "DB_PASSWORD"
  "DB_NAME"
  "JWT_SECRET"
  "ACME_EMAIL"
  "ACME_CA_SERVER"
)

# Define optional secrets (warning only)
OPTIONAL_SECRETS=(
  "ANTHROPIC_API_KEY"
  "OPENAI_API_KEY"
  "JWT_PRIVATE_KEY"
  "JWT_PUBLIC_KEY"
)

echo ""
echo "Checking required secrets:"
for secret in "${REQUIRED_SECRETS[@]}"; do
  echo -n "  $secret... "
  if sops -d "$SECRETS_FILE" 2>/dev/null | grep -q "^${secret}="; then
    echo "✓"
  else
    echo "✗ Missing"
    all_valid=false
  fi
done

echo ""
echo "Checking optional secrets (warnings only):"
for secret in "${OPTIONAL_SECRETS[@]}"; do
  echo -n "  $secret... "
  if sops -d "$SECRETS_FILE" 2>/dev/null | grep -q "^${secret}="; then
    echo "✓"
  else
    echo "⚠ Missing (optional)"
  fi
done

echo ""
echo "================================"
if [ "$all_valid" = true ]; then
  echo "✓ All required secrets present"
  echo "================================"
  exit 0
else
  echo "✗ Some required secrets are missing"
  echo ""
  echo "Update secrets:"
  echo "  make secrets-edit"
  echo "  OR"
  echo "  make secrets-update KEY=<key> VALUE=<value>"
  echo "================================"
  exit 1
fi
