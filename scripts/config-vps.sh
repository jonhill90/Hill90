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

# Load secrets only if not already set (e.g., from GitHub Actions)
if [[ -z "${TAILSCALE_AUTH_KEY:-}" ]]; then
    source "$SCRIPT_DIR/load-secrets.sh"
fi

# Step 1: Run Ansible bootstrap
echo -e "${CYAN}[1/3] Running Ansible bootstrap (this may take 5-10 minutes)...${NC}"
echo -e "${YELLOW}   Installing: Docker, SOPS, age, Tailscale, SSH hardening${NC}"
echo -e "${YELLOW}   Deploying: Traefik, Portainer (Tailscale-only access)${NC}"
echo ""

# Export Tailscale auth key for Ansible
export TAILSCALE_AUTH_KEY

# Get secrets from encrypted file
echo -e "${CYAN}Loading secrets from encrypted file...${NC}"
TRAEFIK_ADMIN_PASSWORD_HASH=$(cd "$PROJECT_ROOT" && sops -d --extract '["TRAEFIK_ADMIN_PASSWORD_HASH"]' infra/secrets/prod.enc.env)
HOSTINGER_API_KEY=$(cd "$PROJECT_ROOT" && sops -d --extract '["HOSTINGER_API_KEY"]' infra/secrets/prod.enc.env)

# Check if TAILSCALE_IP is available in secrets (for re-runs after SSH lockdown)
EXISTING_TAILSCALE_IP=$(cd "$PROJECT_ROOT" && sops -d --extract '["TAILSCALE_IP"]' infra/secrets/prod.enc.env 2>/dev/null || echo "")

# Use Tailscale IP if available (SSH is locked down), otherwise use public IP (initial bootstrap)
if [ -n "$EXISTING_TAILSCALE_IP" ]; then
    ANSIBLE_HOST="$EXISTING_TAILSCALE_IP"
    echo -e "${YELLOW}Using Tailscale IP for SSH (public SSH is locked down): $ANSIBLE_HOST${NC}"
else
    ANSIBLE_HOST="$VPS_IP"
    echo -e "${YELLOW}Using public IP for SSH (initial bootstrap): $ANSIBLE_HOST${NC}"
fi
echo ""

# Run Ansible bootstrap and capture output to extract Tailscale IP
cd "$PROJECT_ROOT/infra/ansible"
ANSIBLE_OUTPUT=$(mktemp)
if ansible-playbook -i "inventory/hosts.yml" \
                 -e "ansible_host=$ANSIBLE_HOST" \
                 -e "ansible_user=root" \
                 -e "ansible_ssh_private_key_file=~/.ssh/remote.hill90.com" \
                 -e "ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'" \
                 -e "traefik_admin_password_hash=$TRAEFIK_ADMIN_PASSWORD_HASH" \
                 -e "hostinger_api_key=$HOSTINGER_API_KEY" \
                 playbooks/bootstrap.yml 2>&1 | tee "$ANSIBLE_OUTPUT"; then
    echo ""
    echo -e "${GREEN}   ✓ Ansible bootstrap complete${NC}"
else
    echo ""
    echo -e "${RED}   ✗ Ansible bootstrap failed${NC}"
    echo -e "${YELLOW}   You can re-run this script to try again (it's idempotent)${NC}"
    echo -e "${YELLOW}   Command: make config-vps VPS_IP=$VPS_IP${NC}"
    rm -f "$ANSIBLE_OUTPUT"
    exit 1
fi
echo ""

# Step 2: Extract Tailscale IP from Ansible output
echo -e "${CYAN}[2/3] Extracting Tailscale IP from Ansible output...${NC}"
TAILSCALE_IP=$(grep -o 'TAILSCALE_IP=[0-9.]*' "$ANSIBLE_OUTPUT" | head -1 | cut -d= -f2 || echo "")
rm -f "$ANSIBLE_OUTPUT"

if [ -z "$TAILSCALE_IP" ]; then
    echo -e "${RED}   ✗ Could not extract Tailscale IP from Ansible output${NC}"
    echo -e "${YELLOW}   Please check manually and update secrets:${NC}"
    echo -e "${YELLOW}   make secrets-update KEY=TAILSCALE_IP VALUE=<ip>${NC}"
    exit 1
fi

echo -e "${GREEN}   ✓ Tailscale IP: $TAILSCALE_IP${NC}"
echo ""

# Step 3: Update TAILSCALE_IP in secrets
echo -e "${CYAN}[3/3] Updating TAILSCALE_IP in encrypted secrets...${NC}"
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
echo -e "${GREEN}║${NC}   ✓ Secrets transferred (age key)                             ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   ✓ Firewall configured (HTTP/HTTPS/Tailscale only)           ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   ✓ Traefik deployed (reverse proxy with SSL)                 ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   ✓ Portainer deployed (Tailscale-only access)                ${GREEN}║${NC}"
echo -e "${GREEN}║                                                               ║${NC}"
echo -e "${GREEN}║${NC} Services Running:                                             ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   • Traefik: ${CYAN}https://traefik.hill90.com${NC} (Tailscale-only)"
echo -e "${GREEN}║${NC}   • Portainer: ${CYAN}https://portainer.hill90.com${NC} (Tailscale-only)"
echo -e "${GREEN}║                                                               ║${NC}"
echo -e "${GREEN}║${NC} ${YELLOW}⚠️  APPLICATION SERVICES NOT DEPLOYED${NC}                         ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    (Infrastructure only: Traefik + Portainer)                 ${GREEN}║${NC}"
echo -e "${GREEN}║                                                               ║${NC}"
echo -e "${GREEN}║${NC} Next Steps:                                                   ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   1. Setup Portainer admin: ${CYAN}https://portainer.hill90.com${NC}"
echo -e "${GREEN}║${NC}   2. Deploy application: ${YELLOW}make deploy${NC} or GitHub Actions"
echo -e "${GREEN}║${NC}   3. Verify health: ${YELLOW}make health${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
