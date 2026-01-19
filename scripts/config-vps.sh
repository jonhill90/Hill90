#!/usr/bin/env bash
set -euo pipefail

# VPS Configuration Script
# Runs Ansible bootstrap to configure a freshly rebuilt VPS
# This is IDEMPOTENT - safe to re-run if it fails

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Check arguments
if [ $# -lt 1 ]; then
    echo -e "${RED}Error: VPS_IP is required${NC}"
    echo "Usage: $0 <vps_ip>"
    exit 1
fi

VPS_IP="$1"

echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}           VPS Configuration (Ansible Bootstrap)               ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}VPS IP:${NC} $VPS_IP"
echo ""

# Load secrets for Tailscale auth key
source "$SCRIPT_DIR/load-secrets.sh"

# Step 1: Update VPS_IP in secrets
echo -e "${CYAN}[1/4] Updating VPS_IP in encrypted secrets...${NC}"
cd "$PROJECT_ROOT"
make secrets-update KEY=VPS_IP VALUE="$VPS_IP" > /dev/null 2>&1
echo -e "${GREEN}   ✓ VPS_IP updated${NC}"
echo ""

# Step 2: Run Ansible bootstrap
echo -e "${CYAN}[2/4] Running Ansible bootstrap (this may take 5-10 minutes)...${NC}"
echo -e "${YELLOW}   Installing: Docker, SOPS, age, Tailscale, SSH hardening${NC}"
echo ""

# Export Tailscale auth key for Ansible
export TAILSCALE_AUTH_KEY

# Run Ansible bootstrap-v2.yml
cd "$PROJECT_ROOT/infra/ansible"
if ansible-playbook -i "inventory/hosts.ini" \
                 -e "ansible_host=$VPS_IP" \
                 -e "ansible_user=root" \
                 -e "ansible_ssh_private_key_file=~/.ssh/remote.hill90.com" \
                 -e "ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'" \
                 playbooks/bootstrap-v2.yml; then
    echo ""
    echo -e "${GREEN}   ✓ Ansible bootstrap complete${NC}"
else
    echo ""
    echo -e "${RED}   ✗ Ansible bootstrap failed${NC}"
    echo -e "${YELLOW}   You can re-run this script to try again (it's idempotent)${NC}"
    echo -e "${YELLOW}   Command: make config-vps VPS_IP=$VPS_IP${NC}"
    exit 1
fi
echo ""

# Step 3: Get Tailscale IP from VPS
echo -e "${CYAN}[3/4] Retrieving Tailscale IP from VPS...${NC}"
TAILSCALE_IP=$(ssh -i ~/.ssh/remote.hill90.com \
                   -o StrictHostKeyChecking=no \
                   -o UserKnownHostsFile=/dev/null \
                   -o ConnectTimeout=10 \
                   deploy@"$VPS_IP" \
                   'cat /opt/hill90/.tailscale_ip' 2>/dev/null || echo "")

if [ -z "$TAILSCALE_IP" ]; then
    echo -e "${RED}   ✗ Could not retrieve Tailscale IP${NC}"
    echo -e "${YELLOW}   Please check manually and update secrets:${NC}"
    echo -e "${YELLOW}   make secrets-update KEY=TAILSCALE_IP VALUE=<ip>${NC}"
    exit 1
fi

echo -e "${GREEN}   ✓ Tailscale IP: $TAILSCALE_IP${NC}"
echo ""

# Step 4: Update TAILSCALE_IP in secrets
echo -e "${CYAN}[4/4] Updating TAILSCALE_IP in encrypted secrets...${NC}"
cd "$PROJECT_ROOT"
make secrets-update KEY=TAILSCALE_IP VALUE="$TAILSCALE_IP" > /dev/null 2>&1
echo -e "${GREEN}   ✓ TAILSCALE_IP updated${NC}"
echo ""

# Success summary
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              ✅ VPS CONFIGURATION COMPLETE!                   ║${NC}"
echo -e "${GREEN}╠═══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC} VPS Public IP:     ${CYAN}$VPS_IP${NC}"
echo -e "${GREEN}║${NC} VPS Tailscale IP:  ${CYAN}$TAILSCALE_IP${NC}"
echo -e "${GREEN}║                                                               ║${NC}"
echo -e "${GREEN}║${NC} SSH Access:                                                   ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   ${YELLOW}ssh -i ~/.ssh/remote.hill90.com deploy@$TAILSCALE_IP${NC}"
echo -e "${GREEN}║                                                               ║${NC}"
echo -e "${GREEN}║${NC} Infrastructure Ready:                                         ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   ✓ Docker, SOPS, age installed                               ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   ✓ Tailscale configured (SSH locked down)                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   ✓ Repository cloned, secrets transferred                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   ✓ Firewall configured (HTTP/HTTPS/Tailscale only)           ${GREEN}║${NC}"
echo -e "${GREEN}║                                                               ║${NC}"
echo -e "${GREEN}║${NC} ${YELLOW}⚠️  APPLICATION NOT DEPLOYED YET${NC}                              ${GREEN}║${NC}"
echo -e "${GREEN}║                                                               ║${NC}"
echo -e "${GREEN}║${NC} Next Steps:                                                   ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   1. Deploy application: ${YELLOW}make deploy${NC}"
echo -e "${GREEN}║${NC}   2. Verify health: ${YELLOW}make health${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
