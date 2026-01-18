#!/usr/bin/env bash
set -euo pipefail

# Automated VPS rebuild via MCP tools
# This script coordinates the full VPS rebuild process

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Phase flag: pre-mcp, post-mcp
PHASE="${1:-pre-mcp}"

# State file to pass data between phases
STATE_FILE="$PROJECT_ROOT/.rebuild-state"

echo "🚀 VPS Rebuild Automation (Phase: $PHASE)"
echo ""

if [ "$PHASE" = "pre-mcp" ]; then
    # ============================================================================
    # PHASE 1: Pre-MCP (Preparation)
    # ============================================================================

    echo "📋 Phase 1: Pre-MCP Preparation"
    echo ""

    # Step 1: Ensure Tailscale auth key is current
    echo "1️⃣  Ensuring Tailscale auth key is ready..."
    cd "$PROJECT_ROOT"
    make tailscale-setup
    echo "   ✓ Tailscale auth key ready"
    echo ""

    # Step 2: Generate secure root password
    echo "2️⃣  Generating secure root password..."
    ROOT_PASSWORD=$(openssl rand -base64 32)
    echo "   ✓ Root password generated"
    echo ""

    # Step 3: Save state for post-MCP phase
    echo "ROOT_PASSWORD=$ROOT_PASSWORD" > "$STATE_FILE"
    chmod 600 "$STATE_FILE"

    # Step 4: Display MCP parameters
    echo "3️⃣  MCP Rebuild Parameters:"
    echo ""
    echo "   ╔════════════════════════════════════════════════════════════╗"
    echo "   ║ Use MCP tool: mcp__MCP_DOCKER__VPS_recreateVirtualMachineV1 ║"
    echo "   ╠════════════════════════════════════════════════════════════╣"
    echo "   ║ virtualMachineId: 1264324                                  ║"
    echo "   ║ template_id: 1183 (AlmaLinux 10)                           ║"
    echo "   ║ password: $ROOT_PASSWORD"
    echo "   ╚════════════════════════════════════════════════════════════╝"
    echo ""
    echo "⏳ After MCP rebuild completes (5-10 minutes):"
    echo "   1. Extract new VPS public IP from MCP response"
    echo "   2. Run: bash $0 post-mcp <NEW_VPS_IP>"
    echo ""

elif [ "$PHASE" = "post-mcp" ]; then
    # ============================================================================
    # PHASE 2: Post-MCP (Bootstrap, Deploy, Verify)
    # ============================================================================

    echo "📋 Phase 2: Post-MCP Bootstrap & Deploy"
    echo ""

    # Validate arguments
    if [ $# -lt 2 ]; then
        echo "❌ Error: Missing VPS IP argument"
        echo "   Usage: $0 post-mcp <NEW_VPS_IP>"
        exit 1
    fi

    NEW_VPS_IP="$2"

    # Load state from pre-MCP phase
    if [ ! -f "$STATE_FILE" ]; then
        echo "❌ Error: State file not found. Run pre-mcp phase first."
        exit 1
    fi

    source "$STATE_FILE"

    if [ -z "${ROOT_PASSWORD:-}" ]; then
        echo "❌ Error: ROOT_PASSWORD not found in state file"
        exit 1
    fi

    echo "📌 VPS IP: $NEW_VPS_IP"
    echo "🔐 Using root password from pre-mcp phase"
    echo ""

    # Step 1: Update VPS_IP in secrets
    echo "1️⃣  Updating VPS_IP in encrypted secrets..."
    cd "$PROJECT_ROOT"
    make secrets-update KEY=VPS_IP VALUE="$NEW_VPS_IP"
    echo "   ✓ VPS_IP updated to: $NEW_VPS_IP"
    echo ""

    # Step 2: Bootstrap VPS with Ansible
    echo "2️⃣  Bootstrapping VPS with Ansible..."
    make rebuild-bootstrap VPS_IP="$NEW_VPS_IP" ROOT_PASSWORD="$ROOT_PASSWORD"
    echo "   ✓ Bootstrap complete"
    echo ""

    # Step 3: Get Tailscale IP from VPS
    echo "3️⃣  Retrieving Tailscale IP from VPS..."
    TAILSCALE_IP=$(ssh -i ~/.ssh/remote.hill90.com \
                        -o StrictHostKeyChecking=no \
                        -o UserKnownHostsFile=/dev/null \
                        -o ConnectTimeout=10 \
                        deploy@"$NEW_VPS_IP" \
                        'cat /opt/hill90/.tailscale_ip' 2>/dev/null || echo "")

    if [ -z "$TAILSCALE_IP" ]; then
        echo "   ⚠️  Could not retrieve Tailscale IP automatically"
        echo "   Please check manually: ssh deploy@$NEW_VPS_IP 'cat /opt/hill90/.tailscale_ip'"
        echo ""
        read -p "   Enter Tailscale IP manually: " TAILSCALE_IP
    fi

    echo "   ✓ Tailscale IP: $TAILSCALE_IP"
    echo ""

    # Step 4: Update TAILSCALE_IP in secrets
    echo "4️⃣  Updating TAILSCALE_IP in encrypted secrets..."
    make secrets-update KEY=TAILSCALE_IP VALUE="$TAILSCALE_IP"
    echo "   ✓ TAILSCALE_IP updated to: $TAILSCALE_IP"
    echo ""

    # Step 5: Deploy services via Tailscale
    echo "5️⃣  Deploying services to VPS..."
    echo "   (Using Tailscale IP for secure connection)"
    ssh -i ~/.ssh/remote.hill90.com \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        deploy@"$TAILSCALE_IP" \
        "cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh prod"
    echo "   ✓ Services deployed"
    echo ""

    # Step 6: Wait for services to start
    echo "6️⃣  Waiting for services to start (30 seconds)..."
    sleep 30
    echo "   ✓ Wait complete"
    echo ""

    # Step 7: Verify health
    echo "7️⃣  Verifying service health..."
    cd "$PROJECT_ROOT"
    make health
    echo "   ✓ Health check complete"
    echo ""

    # Step 8: Clean up state file
    rm -f "$STATE_FILE"

    # Success summary
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║                    ✅ REBUILD COMPLETE!                       ║"
    echo "╠═══════════════════════════════════════════════════════════════╣"
    echo "║ VPS Public IP:     $NEW_VPS_IP"
    echo "║ VPS Tailscale IP:  $TAILSCALE_IP"
    echo "║                                                               ║"
    echo "║ SSH Access:                                                   ║"
    echo "║   ssh deploy@$TAILSCALE_IP"
    echo "║                                                               ║"
    echo "║ Next Steps:                                                   ║"
    echo "║   1. Test HTTPS: https://api.hill90.com/health                ║"
    echo "║   2. Test services: make health                               ║"
    echo "║   3. View logs: make ssh, then make logs                      ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo ""

else
    echo "❌ Error: Unknown phase '$PHASE'"
    echo "   Valid phases: pre-mcp, post-mcp"
    exit 1
fi
