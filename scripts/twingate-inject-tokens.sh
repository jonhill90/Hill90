#!/bin/bash
set -e

echo "========================================="
echo "Twingate Token Injection"
echo "========================================="
echo ""

# Get Twingate tokens from Terraform output
if [ ! -d "infra/terraform/twingate" ]; then
  echo "ERROR: Twingate Terraform directory not found"
  exit 1
fi

cd infra/terraform/twingate

if [ ! -f "terraform.tfstate" ]; then
  echo "ERROR: Twingate Terraform state not found. Has Terraform been applied?"
  exit 1
fi

echo "Retrieving Twingate tokens from Terraform..."

TWINGATE_ACCESS_TOKEN=$(terraform output -raw access_token 2>/dev/null || echo "")
TWINGATE_REFRESH_TOKEN=$(terraform output -raw refresh_token 2>/dev/null || echo "")
TWINGATE_NETWORK=$(terraform output -raw network_name 2>/dev/null || echo "")

if [ -z "$TWINGATE_ACCESS_TOKEN" ] || [ -z "$TWINGATE_REFRESH_TOKEN" ]; then
  echo "ERROR: Could not retrieve Twingate tokens from Terraform state"
  exit 1
fi

echo "Retrieved tokens successfully"
echo "  Network: $TWINGATE_NETWORK"
echo "  Access Token: ${TWINGATE_ACCESS_TOKEN:0:20}..."
echo "  Refresh Token: ${TWINGATE_REFRESH_TOKEN:0:20}..."
echo ""

# Go back to project root
cd ../../..

# Update encrypted secrets
SECRETS_FILE="infra/secrets/prod.enc.env"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "ERROR: Encrypted secrets file not found at $SECRETS_FILE"
  exit 1
fi

echo "Updating encrypted secrets..."

# Decrypt secrets
sops -d "$SECRETS_FILE" > /tmp/prod.dec.env

# Update Twingate tokens
sed -i.tmp "s|TWINGATE_ACCESS_TOKEN=.*|TWINGATE_ACCESS_TOKEN=$TWINGATE_ACCESS_TOKEN|" /tmp/prod.dec.env
sed -i.tmp "s|TWINGATE_REFRESH_TOKEN=.*|TWINGATE_REFRESH_TOKEN=$TWINGATE_REFRESH_TOKEN|" /tmp/prod.dec.env
sed -i.tmp "s|TWINGATE_NETWORK=.*|TWINGATE_NETWORK=$TWINGATE_NETWORK|" /tmp/prod.dec.env
rm -f /tmp/prod.dec.env.tmp

# Re-encrypt secrets
sops -e /tmp/prod.dec.env > "$SECRETS_FILE"

# Clean up decrypted secrets
rm -f /tmp/prod.dec.env

echo ""
echo "========================================="
echo "Twingate tokens injected successfully!"
echo "========================================="
echo ""
echo "Tokens have been encrypted and saved to: $SECRETS_FILE"
echo "You can now deploy with: make deploy"
