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

# Update encrypted secrets with new IP
echo "Updating encrypted secrets..."
SECRETS_FILE="infra/secrets/prod.enc.env"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "ERROR: Encrypted secrets file not found at $SECRETS_FILE"
  exit 1
fi

# Decrypt secrets
sops -d "$SECRETS_FILE" > /tmp/prod.dec.env

# Update VPS_IP in decrypted secrets
sed -i.tmp "s/VPS_IP=.*/VPS_IP=$NEW_VPS_IP/" /tmp/prod.dec.env
rm -f /tmp/prod.dec.env.tmp

# Re-encrypt secrets
sops -e /tmp/prod.dec.env > "$SECRETS_FILE"

# Clean up decrypted secrets
rm -f /tmp/prod.dec.env

echo "Updated encrypted secrets with new IP"
echo ""

# Bootstrap VPS as root (deploy user doesn't exist yet)
echo "Running Ansible bootstrap playbook..."
echo "This will:"
echo "  - Create deploy user"
echo "  - Install Docker"
echo "  - Configure firewall"
echo "  - Harden SSH"
echo "  - Setup secrets management"
echo ""

cd infra/ansible

# Run bootstrap playbook as root
ansible-playbook -i inventory/hosts.yml \
  -u root \
  --extra-vars "ansible_password=$ROOT_PASSWORD" \
  --extra-vars "ansible_ssh_common_args='-o StrictHostKeyChecking=no'" \
  playbooks/bootstrap.yml

echo ""
echo "========================================="
echo "Bootstrap Complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Verify connectivity: ssh deploy@$NEW_VPS_IP"
echo "  2. Deploy application: make deploy"
echo "  3. Verify health: make health"
echo "  4. Update DNS records if IP changed"
echo ""

# Clean up temporary password file
if [ -f "/tmp/hill90_root_password.txt" ]; then
  rm -f /tmp/hill90_root_password.txt
  echo "Cleaned up temporary password file"
fi

echo "VPS is ready for deployment!"
