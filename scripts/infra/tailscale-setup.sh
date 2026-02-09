#!/bin/bash
set -euo pipefail

echo "========================================="
echo "Tailscale Infrastructure Setup"
echo "========================================="
echo ""

# Paths
TERRAFORM_DIR="infra/terraform/tailscale"
SECRETS_FILE="infra/secrets/prod.enc.env"
AGE_KEY="infra/secrets/keys/age-prod.key"

# Check prerequisites
if [ ! -f "$AGE_KEY" ]; then
    echo "ERROR: Age key not found at $AGE_KEY"
    exit 1
fi

if [ ! -f "${TERRAFORM_DIR}/terraform.tfvars" ]; then
    echo "ERROR: terraform.tfvars not found"
    echo "Create ${TERRAFORM_DIR}/terraform.tfvars with:"
    echo "  tailscale_api_key = \"tskey-api-...\""
    echo "  tailscale_tailnet = \"your-tailnet-id\""
    exit 1
fi

# Step 1: Initialize Terraform
echo "Step 1/4: Initializing Terraform..."
cd "$TERRAFORM_DIR"
terraform init -upgrade > /dev/null 2>&1
echo "  ✓ Terraform initialized"

# Step 2: Apply Terraform configuration
echo "Step 2/4: Generating Tailscale auth key..."
terraform apply -auto-approve > /dev/null 2>&1
echo "  ✓ Auth key generated"

# Step 3: Extract auth key
echo "Step 3/4: Extracting auth key..."
AUTH_KEY=$(terraform output -raw vps_auth_key)
AUTH_KEY_ID=$(terraform output -raw auth_key_id)
echo "  ✓ Auth key ID: $AUTH_KEY_ID"
echo "  ✓ Expiry: 90 days"

# Step 4: Store in encrypted secrets
echo "Step 4/4: Storing in encrypted secrets..."
cd /Users/jon/source/repos/Personal/Hill90
export SOPS_AGE_KEY_FILE="$AGE_KEY"
sops --set '["TAILSCALE_AUTH_KEY"] "'"$AUTH_KEY"'"' "$SECRETS_FILE"

# Verify
STORED_KEY=$(sops -d --extract '["TAILSCALE_AUTH_KEY"]' "$SECRETS_FILE")
if [ "$STORED_KEY" = "$AUTH_KEY" ]; then
    echo "  ✓ Auth key stored successfully"
else
    echo "  ✗ ERROR: Auth key verification failed"
    exit 1
fi

echo ""
echo "========================================="
echo "Tailscale Setup Complete!"
echo "========================================="
echo ""
echo "Auth Key ID: $AUTH_KEY_ID"
echo "Expiry: 90 days from now"
echo ""
echo "The auth key is now stored in encrypted secrets."
echo "Bootstrap script will use it automatically during VPS rebuild."
echo ""
echo "Next steps:"
echo "  1. Rebuild VPS via MCP"
echo "  2. make rebuild-bootstrap VPS_IP=<ip> ROOT_PASSWORD=<pw>"
echo "  3. Tailscale will be configured automatically!"
echo ""
