#!/bin/bash
set -e

echo "========================================="
echo "Hill90 VPS Post-Rebuild Bootstrap"
echo "========================================="
echo ""

# Accept parameters or read from temp file
ROOT_PASSWORD="${1:-}"
NEW_VPS_IP="${2:-}"

if [ -z "$ROOT_PASSWORD" ]; then
  if [ -f "/tmp/hill90_root_password.txt" ]; then
    ROOT_PASSWORD=$(cat /tmp/hill90_root_password.txt)
    echo "Using root password from /tmp/hill90_root_password.txt"
  else
    echo "ERROR: ROOT_PASSWORD not provided"
    echo "Usage: $0 <root_password> <vps_ip>"
    exit 1
  fi
fi

if [ -z "$NEW_VPS_IP" ]; then
  echo "ERROR: VPS_IP not provided"
  echo "Usage: $0 <root_password> <vps_ip>"
  exit 1
fi

echo "Configuration:"
echo "  VPS IP: $NEW_VPS_IP"
echo "  Root Password: <provided>"
echo ""

# Remove old SSH host key to avoid conflicts
echo "Removing old SSH host key for $NEW_VPS_IP..."
ssh-keygen -R "$NEW_VPS_IP" 2>/dev/null || true

# Update Ansible inventory with new IP
echo "Updating Ansible inventory..."
INVENTORY_FILE="infra/ansible/inventory/hosts.yml"

if [ ! -f "$INVENTORY_FILE" ]; then
  echo "ERROR: Ansible inventory not found at $INVENTORY_FILE"
  exit 1
fi

# Backup inventory
cp "$INVENTORY_FILE" "${INVENTORY_FILE}.bak"
echo "Backed up inventory to ${INVENTORY_FILE}.bak"

# Update IP in inventory
sed -i.tmp "s/ansible_host=.*/ansible_host=$NEW_VPS_IP/" "$INVENTORY_FILE"
rm -f "${INVENTORY_FILE}.tmp"

echo "Updated Ansible inventory with new IP: $NEW_VPS_IP"
echo ""

# Update encrypted secrets with new IP (using SOPS set - no temp files!)
echo "Updating encrypted secrets..."
SECRETS_FILE="infra/secrets/prod.enc.env"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "ERROR: Encrypted secrets file not found at $SECRETS_FILE"
  exit 1
fi

# Set SOPS age key location (use project-local key)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SOPS_AGE_KEY_FILE="${PROJECT_ROOT}/infra/secrets/keys/age-prod.key"

# Update VPS_IP using SOPS set (atomic operation, no temp files)
sops --set '["VPS_IP"] "'"$NEW_VPS_IP"'"' "$SECRETS_FILE"

echo "Updated encrypted secrets with new IP (using SOPS set)"
echo ""

# Bootstrap VPS as root (deploy user doesn't exist yet)
echo "Running Ansible bootstrap playbook..."
echo "This will:"
echo "  - Create deploy user"
echo "  - Install Docker"
echo "  - Configure firewall"
echo "  - Harden SSH"
echo "  - Install Tailscale"
echo "  - Setup secrets management"
echo "  - Clone repository"
echo "  - Transfer age key"
echo ""

cd infra/ansible

# Extract Tailscale auth key from encrypted secrets
export TAILSCALE_AUTH_KEY=$(sops -d --extract '["TAILSCALE_AUTH_KEY"]' ../secrets/prod.enc.env)

# Set local age key path for Ansible playbook (use project-local key)
export LOCAL_AGE_KEY_PATH="${PROJECT_ROOT}/infra/secrets/keys/age-prod.key"

# Run bootstrap playbook as root
ansible-playbook -i inventory/hosts.yml \
  -u root \
  --extra-vars "ansible_password=$ROOT_PASSWORD" \
  --extra-vars "ansible_ssh_common_args='-o StrictHostKeyChecking=no'" \
  playbooks/bootstrap.yml

# Return to project root
cd ../..

echo ""
echo "========================================="
echo "Bootstrap Complete!"
echo "========================================="
echo ""
echo "VPS Configuration:"
echo "  Public IP: $NEW_VPS_IP"
echo "  Tailscale IP: (check /opt/hill90/.tailscale_ip on VPS)"
echo ""
echo "Next steps:"
echo "  1. SSH via Tailscale: ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip>"
echo "  2. Deploy services: make deploy"
echo "  3. Verify health: make health"
echo "  4. Update DNS if needed (public IP: $NEW_VPS_IP)"
echo ""

# Clean up temporary password file
if [ -f "/tmp/hill90_root_password.txt" ]; then
  rm -f /tmp/hill90_root_password.txt
  echo "Cleaned up temporary password file"
  echo ""
fi

echo "VPS is ready for deployment!"
echo "Public SSH is BLOCKED. Use Tailscale for access."
