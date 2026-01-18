#!/bin/bash
set -e

echo "========================================="
echo "Hill90 VPS Snapshot Creation"
echo "========================================="
echo ""
echo "WARNING: Hostinger allows only ONE snapshot per VPS."
echo "Creating a new snapshot will overwrite any existing snapshot."
echo ""

# Get VPS ID from Terraform state
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

if [ -z "$VPS_ID" ]; then
  echo "ERROR: Could not retrieve VPS ID from Terraform state"
  echo "Please ensure Terraform has been initialized and applied."
  exit 1
fi

echo "VPS ID: $VPS_ID"
echo ""
echo "This script requires Claude Code with Hostinger MCP integration."
echo "Please run this via: make snapshot"
echo ""
echo "The following MCP tool will be called:"
echo "  mcp__MCP_DOCKER__VPS_createSnapshotV1"
echo "  Parameters: virtualMachineId=$VPS_ID"
echo ""
echo "IMPORTANT: Snapshot creation can take several minutes."
echo "           The VPS will remain online during this process."
echo ""

read -p "Proceed with snapshot creation? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
  echo "Snapshot creation cancelled."
  exit 0
fi

echo ""
echo "======================================================================"
echo "MANUAL STEP REQUIRED:"
echo "======================================================================"
echo "This script cannot directly call MCP tools."
echo "Please ask Claude Code to:"
echo ""
echo "  Create a VPS snapshot using virtualMachineId: $VPS_ID"
echo ""
echo "Or use the following tool call in Claude Code context:"
echo ""
echo "  mcp__MCP_DOCKER__VPS_createSnapshotV1(virtualMachineId=$VPS_ID)"
echo ""
echo "======================================================================"
