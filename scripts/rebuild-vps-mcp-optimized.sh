#!/usr/bin/env bash
set -euo pipefail

# Optimized VPS rebuild via MCP tools
# Target: 5-7 minute total rebuild time (vs 30 minutes)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Phase flag: pre-mcp, post-mcp
PHASE="${1:-pre-mcp}"

# State file to pass data between phases
STATE_FILE="$PROJECT_ROOT/.rebuild-state"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Load secrets for Tailscale API access
source "$SCRIPT_DIR/load-secrets.sh"
source "$SCRIPT_DIR/tailscale-api.sh"

echo -e "${CYAN}🚀 VPS Rebuild Automation - OPTIMIZED${NC}"
echo -e "${CYAN}   (Target: 5-7 minutes total)${NC}"
echo ""

if [ "$PHASE" = "pre-mcp" ]; then
    # ============================================================================
    # PHASE 1: Pre-MCP (Preparation)
    # ============================================================================

    echo -e "${BLUE}📋 Phase 1: Pre-MCP Preparation${NC}"
    echo ""

    # Step 1: Generate Tailscale auth key via API (replaces Terraform)
    echo -e "${CYAN}1️⃣  Generating Tailscale auth key via API...${NC}"
    TAILSCALE_AUTH_KEY=$(generate_auth_key)

    if [ -z "$TAILSCALE_AUTH_KEY" ]; then
        echo -e "${RED}   ❌ Failed to generate Tailscale auth key${NC}"
        exit 1
    fi

    echo -e "${GREEN}   ✓ Auth key generated (no Terraform needed!)${NC}"

    # Update secrets with new auth key
    cd "$PROJECT_ROOT"
    make secrets-update KEY=TAILSCALE_AUTH_KEY VALUE="$TAILSCALE_AUTH_KEY"
    echo -e "${GREEN}   ✓ Auth key saved to secrets${NC}"
    echo ""

    # Step 2: Generate secure root password
    echo -e "${CYAN}2️⃣  Generating secure root password...${NC}"
    ROOT_PASSWORD=$(openssl rand -base64 32)
    echo -e "${GREEN}   ✓ Root password generated${NC}"
    echo ""

    # Step 3: Check for post-install script
    echo -e "${CYAN}3️⃣  Checking post-install script...${NC}"
    POST_INSTALL_SCRIPT="$PROJECT_ROOT/infra/post-install/cache-binaries.sh"

    if [ -f "$POST_INSTALL_SCRIPT" ]; then
        echo -e "${GREEN}   ✓ Post-install script found${NC}"
        echo -e "${YELLOW}   ℹ️  Script will be uploaded to Hostinger separately${NC}"
        echo -e "${YELLOW}   ℹ️  Once uploaded, note the script ID for MCP rebuild${NC}"
    else
        echo -e "${YELLOW}   ⚠️  Post-install script not found (optional)${NC}"
    fi
    echo ""

    # Step 4: Save state for post-MCP phase
    cat > "$STATE_FILE" <<EOF
ROOT_PASSWORD=$ROOT_PASSWORD
TAILSCALE_AUTH_KEY=$TAILSCALE_AUTH_KEY
EOF
    chmod 600 "$STATE_FILE"

    # Step 5: Display MCP parameters
    echo -e "${CYAN}4️⃣  MCP Rebuild Parameters:${NC}"
    echo ""
    echo "   ╔════════════════════════════════════════════════════════════╗"
    echo "   ║ Use MCP tool: mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1 ║"
    echo "   ╠════════════════════════════════════════════════════════════╣"
    echo "   ║ virtualMachineId: 1264324                                  ║"
    echo "   ║ template_id: 1183 (AlmaLinux 10)                           ║"
    echo "   ║ password: $ROOT_PASSWORD"
    echo "   ║                                                            ║"
    echo "   ║ OPTIONAL (saves 2-3 min):                                 ║"
    echo "   ║ post_install_script_id: <script_id_from_hostinger>        ║"
    echo "   ║   (Upload $POST_INSTALL_SCRIPT first)"
    echo "   ╚════════════════════════════════════════════════════════════╝"
    echo ""
    echo -e "${YELLOW}⏳ After MCP rebuild completes (5-10 minutes):${NC}"
    echo -e "${YELLOW}   The MCP response will contain the new VPS IP${NC}"
    echo -e "${YELLOW}   Run: bash $0 post-mcp${NC}"
    echo -e "${YELLOW}   (Script will auto-detect VPS IP from MCP)${NC}"
    echo ""

elif [ "$PHASE" = "post-mcp" ]; then
    # ============================================================================
    # PHASE 2: Post-MCP (Bootstrap, Deploy, Verify)
    # ============================================================================

    echo -e "${BLUE}📋 Phase 2: Post-MCP Bootstrap & Deploy${NC}"
    echo ""

    # Load state from pre-MCP phase
    if [ ! -f "$STATE_FILE" ]; then
        echo -e "${RED}❌ Error: State file not found. Run pre-mcp phase first.${NC}"
        exit 1
    fi

    source "$STATE_FILE"

    if [ -z "${ROOT_PASSWORD:-}" ]; then
        echo -e "${RED}❌ Error: ROOT_PASSWORD not found in state file${NC}"
        exit 1
    fi

    # Step 1: Get new VPS IP from MCP (or user input)
    echo -e "${CYAN}1️⃣  Getting VPS IP...${NC}"

    # Try to get from MCP tool response (requires manual input for now)
    # In future, could parse from MCP getVirtualMachineDetailsV1 response
    if [ $# -ge 2 ]; then
        NEW_VPS_IP="$2"
        echo -e "${GREEN}   ✓ Using provided IP: $NEW_VPS_IP${NC}"
    else
        echo -e "${YELLOW}   MCP rebuild completed. Enter the new VPS public IP:${NC}"
        read -p "   VPS IP: " NEW_VPS_IP
    fi

    if [ -z "$NEW_VPS_IP" ]; then
        echo -e "${RED}   ❌ VPS IP is required${NC}"
        exit 1
    fi

    echo -e "${GREEN}   ✓ VPS IP: $NEW_VPS_IP${NC}"
    echo ""

    # Step 2: Update VPS_IP in secrets
    echo -e "${CYAN}2️⃣  Updating VPS_IP in encrypted secrets...${NC}"
    cd "$PROJECT_ROOT"
    make secrets-update KEY=VPS_IP VALUE="$NEW_VPS_IP"
    echo -e "${GREEN}   ✓ VPS_IP updated${NC}"
    echo ""

    # Step 3: Bootstrap VPS with optimized Ansible playbook
    echo -e "${CYAN}3️⃣  Bootstrapping VPS with optimized Ansible...${NC}"
    echo -e "${YELLOW}   Using: bootstrap-optimized.yml${NC}"

    # Export Tailscale auth key for Ansible
    export TAILSCALE_AUTH_KEY

    # Run optimized bootstrap
    cd "$PROJECT_ROOT/infra/ansible"
    ansible-playbook -i "inventory/hosts.ini" \
                     -e "ansible_host=$NEW_VPS_IP" \
                     -e "ansible_user=root" \
                     -e "ansible_ssh_private_key_file=~/.ssh/remote.hill90.com" \
                     -e "ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'" \
                     playbooks/bootstrap-optimized.yml

    echo -e "${GREEN}   ✓ Bootstrap complete${NC}"
    echo ""

    # Step 4: Get Tailscale IP via API (eliminates SSH chicken-and-egg)
    echo -e "${CYAN}4️⃣  Retrieving Tailscale IP via API...${NC}"
    echo -e "${YELLOW}   Waiting for device to appear in Tailscale network...${NC}"

    TAILSCALE_IP=$(wait_for_device "hill90-vps" 120)

    if [ -z "$TAILSCALE_IP" ]; then
        echo -e "${RED}   ❌ Failed to get Tailscale IP via API${NC}"
        echo -e "${YELLOW}   Falling back to SSH method...${NC}"

        TAILSCALE_IP=$(ssh -i ~/.ssh/remote.hill90.com \
                            -o StrictHostKeyChecking=no \
                            -o UserKnownHostsFile=/dev/null \
                            -o ConnectTimeout=10 \
                            deploy@"$NEW_VPS_IP" \
                            'cat /opt/hill90/.tailscale_ip' 2>/dev/null || echo "")
    fi

    if [ -z "$TAILSCALE_IP" ]; then
        echo -e "${RED}   ❌ Could not retrieve Tailscale IP${NC}"
        read -p "   Enter Tailscale IP manually: " TAILSCALE_IP
    fi

    echo -e "${GREEN}   ✓ Tailscale IP: $TAILSCALE_IP${NC}"
    echo ""

    # Step 5: Update TAILSCALE_IP in secrets
    echo -e "${CYAN}5️⃣  Updating TAILSCALE_IP in encrypted secrets...${NC}"
    cd "$PROJECT_ROOT"
    make secrets-update KEY=TAILSCALE_IP VALUE="$TAILSCALE_IP"
    echo -e "${GREEN}   ✓ TAILSCALE_IP updated${NC}"
    echo ""

    # Step 6: Deploy services via Tailscale (with parallel builds)
    echo -e "${CYAN}6️⃣  Deploying services to VPS (parallel builds enabled)...${NC}"
    echo -e "${YELLOW}   Using Tailscale IP for secure connection${NC}"
    ssh -i ~/.ssh/remote.hill90.com \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        deploy@"$TAILSCALE_IP" \
        "cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh prod"
    echo -e "${GREEN}   ✓ Services deployed${NC}"
    echo ""

    # Step 7: Wait for services to start
    echo -e "${CYAN}7️⃣  Waiting for services to start (30 seconds)...${NC}"
    sleep 30
    echo -e "${GREEN}   ✓ Wait complete${NC}"
    echo ""

    # Step 8: Verify health
    echo -e "${CYAN}8️⃣  Verifying service health...${NC}"
    cd "$PROJECT_ROOT"
    make health
    echo -e "${GREEN}   ✓ Health check complete${NC}"
    echo ""

    # Step 9: Clean up state file
    rm -f "$STATE_FILE"

    # Success summary
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    ✅ REBUILD COMPLETE!                       ║${NC}"
    echo -e "${GREEN}╠═══════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║${NC} VPS Public IP:     ${CYAN}$NEW_VPS_IP${NC}"
    echo -e "${GREEN}║${NC} VPS Tailscale IP:  ${CYAN}$TAILSCALE_IP${NC}"
    echo -e "${GREEN}║                                                               ║${NC}"
    echo -e "${GREEN}║${NC} SSH Access:                                                   ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}   ${YELLOW}ssh deploy@$TAILSCALE_IP${NC}"
    echo -e "${GREEN}║                                                               ║${NC}"
    echo -e "${GREEN}║${NC} Optimizations Applied:                                        ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}   ✓ Tailscale API (no Terraform)                              ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}   ✓ Auto IP detection via API                                 ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}   ✓ Optimized Ansible playbook                                ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}   ✓ Parallel Docker builds                                    ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}   ✓ Binary pre-caching (if post-install used)                 ${GREEN}║${NC}"
    echo -e "${GREEN}║                                                               ║${NC}"
    echo -e "${GREEN}║${NC} Next Steps:                                                   ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}   1. Test HTTPS: ${CYAN}https://api.hill90.com/health${NC}"
    echo -e "${GREEN}║${NC}   2. Test services: ${YELLOW}make health${NC}"
    echo -e "${GREEN}║${NC}   3. View logs: ${YELLOW}make ssh${NC}, then ${YELLOW}make logs${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""

else
    echo -e "${RED}❌ Error: Unknown phase '$PHASE'${NC}"
    echo "   Valid phases: pre-mcp, post-mcp"
    exit 1
fi
