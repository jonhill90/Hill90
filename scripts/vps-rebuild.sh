#!/bin/bash
set -e

echo "========================================="
echo "Hill90 VPS REBUILD - DESTRUCTIVE OPERATION"
echo "========================================="
echo ""
echo "WARNING: THIS WILL DESTROY ALL DATA ON THE VPS!"
echo ""
echo "This operation will:"
echo "  - Wipe all data on the VPS"
echo "  - Delete all snapshots"
echo "  - Reinstall the operating system"
echo "  - Generate a new root password"
echo "  - VPS will be offline for ~5 minutes"
echo ""
echo "This operation is IRREVERSIBLE!"
echo ""

# Safety confirmation
read -p "Type 'REBUILD' to confirm destruction of all VPS data: " confirm

if [ "$confirm" != "REBUILD" ]; then
  echo "Rebuild cancelled. No changes made."
  exit 0
fi

echo ""
echo "Proceeding with VPS rebuild..."
echo ""

# Get VPS ID and Template ID from Terraform state
if [ ! -d "infra/terraform/hostinger" ]; then
  echo "ERROR: Terraform directory not found"
  exit 1
fi

cd infra/terraform/hostinger

if [ ! -f "terraform.tfstate" ]; then
  echo "ERROR: Terraform state not found. Has infrastructure been deployed?"
  exit 1
fi

VPS_ID=$(terraform output -raw vps_id 2>/dev/null || echo "")
TEMPLATE_ID=$(terraform output -raw template_id 2>/dev/null || echo "")

if [ -z "$VPS_ID" ] || [ -z "$TEMPLATE_ID" ]; then
  echo "ERROR: Could not retrieve VPS ID or Template ID from Terraform state"
  echo "VPS_ID: $VPS_ID"
  echo "TEMPLATE_ID: $TEMPLATE_ID"
  exit 1
fi

# Generate secure root password
ROOT_PASSWORD=$(openssl rand -base64 32)

echo "Configuration:"
echo "  VPS ID: $VPS_ID"
echo "  Template ID: $TEMPLATE_ID (AlmaLinux 9)"
echo "  Root Password: <generated>"
echo ""

echo "======================================================================"
echo "MANUAL STEP REQUIRED:"
echo "======================================================================"
echo "This script cannot directly call MCP tools."
echo "Please ask Claude Code to:"
echo ""
echo "  Rebuild VPS using:"
echo "    - virtualMachineId: $VPS_ID"
echo "    - template_id: $TEMPLATE_ID"
echo "    - password: $ROOT_PASSWORD"
echo ""
echo "Or use the following tool call in Claude Code context:"
echo ""
echo "  mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1("
echo "    virtualMachineId=$VPS_ID,"
echo "    template_id=$TEMPLATE_ID,"
echo "    password=<secure_generated_password>"
echo "  )"
echo ""
echo "======================================================================"
echo ""
echo "SAVE THIS ROOT PASSWORD (will not be shown again):"
echo "======================================================================"
echo "$ROOT_PASSWORD"
echo "======================================================================"
echo ""
echo "After rebuild completes, you will need this password to run:"
echo "  make rebuild-bootstrap ROOT_PASSWORD=<password> VPS_IP=<new_ip>"
echo ""

# Save password to temporary file for scripting
echo "$ROOT_PASSWORD" > /tmp/hill90_root_password.txt
chmod 600 /tmp/hill90_root_password.txt

echo "Root password also saved to: /tmp/hill90_root_password.txt"
echo "This file will be automatically deleted after bootstrap."
