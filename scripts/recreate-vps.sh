#!/usr/bin/env bash
# Recreate VPS via API with automatic Tailscale auth key rotation
# This script handles the full rebuild workflow without manual intervention

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}VPS Rebuild Workflow${NC}"
echo ""

# Step 1: Rotate Tailscale auth key
echo -e "${BLUE}Step 1/3: Rotating Tailscale auth key...${NC}"

# Capture output and extract only the auth key (last line)
if ! OUTPUT=$(bash "$SCRIPT_DIR/tailscale-api.sh" generate-key 2>&1); then
    echo -e "${RED}ERROR: Failed to generate Tailscale auth key${NC}"
    exit 1
fi

AUTH_KEY=$(echo "$OUTPUT" | tail -1)

echo -e "${GREEN}✓ Auth key generated${NC}"

# Update secrets
echo -e "${BLUE}Updating secrets with new auth key...${NC}"
if ! bash "$SCRIPT_DIR/secrets-update.sh" infra/secrets/prod.enc.env "TAILSCALE_AUTH_KEY" "$AUTH_KEY"; then
    echo -e "${RED}ERROR: Failed to update secrets${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Secrets updated${NC}"
echo ""

# Step 2: Generate root password
echo -e "${BLUE}Step 2/3: Generating root password...${NC}"
ROOT_PASSWORD="Hill90VPS-$(openssl rand -base64 18 | tr -d '/+=')"
echo -e "${GREEN}✓ Password generated${NC}"
echo ""

# Step 3: Get post-install script ID
echo -e "${BLUE}Step 3/3: Retrieving configuration...${NC}"
POST_INSTALL_ID=$(bash "$SCRIPT_DIR/secrets-view.sh" infra/secrets/prod.enc.env HOSTINGER_POST_INSTALL_SCRIPT_ID 2>/dev/null | tail -1 | cut -d= -f2 | sed 's/\x1b\[[0-9;]*m//g')

echo -e "${GREEN}Configuration:${NC}"
echo "  Template: AlmaLinux 10 (1183)"
echo "  Post-install script: $POST_INSTALL_ID (bootstrap-ansible)"
echo "  Tailscale: Auth key rotated"
echo ""

# Step 4: Rebuild VPS
echo -e "${YELLOW}Starting VPS rebuild via Hostinger API...${NC}"
echo ""

if ! bash "$SCRIPT_DIR/hostinger-api.sh" recreate 1183 "$ROOT_PASSWORD" "$POST_INSTALL_ID"; then
    echo -e "${RED}ERROR: VPS rebuild failed${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✓ VPS rebuild initiated${NC}"
echo ""
echo -e "${YELLOW}After rebuild completes (~5 min), get new IP and run:${NC}"
echo "  make config-vps VPS_IP=<new_ip>"
echo ""
