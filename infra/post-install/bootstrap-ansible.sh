#!/usr/bin/env bash
#
# Minimal Post-Install Script for Hill90 VPS
#
# Purpose: Install ONLY what's needed to run Ansible.
#          Everything else (Docker, SOPS, age, Tailscale) goes in Ansible playbooks.
#
# This approach prioritizes:
# - Flexibility: Can update tools via Ansible without OS rebuild
# - Reliability: Less in one-time script = fewer failure points
# - Idempotency: If Ansible fails, just re-run Ansible (no OS rebuild needed)
#
# Tradeoff: +2-3 minutes on first bootstrap vs binary caching approach
#

set -euo pipefail

# Log all output
exec > >(tee -a /opt/hill90/logs/bootstrap.log) 2>&1

echo "========================================"
echo "Hill90 VPS - Minimal Bootstrap"
echo "Started: $(date)"
echo "========================================"

# Create directory structure first (needed for logging)
echo "[$(date)] Creating directory structure..."
mkdir -p /opt/hill90/{app,secrets/keys,logs,cache}

# Install Python 3 + pip (required for Ansible)
echo "[$(date)] Installing Python 3 and pip..."
dnf install -y python3 python3-pip

# Install essential tools for Ansible to work
echo "[$(date)] Installing essential tools..."
dnf install -y git curl which sudo

# Verify installations
echo "[$(date)] Verifying installations..."
python3 --version
pip3 --version
git --version
curl --version

# Set proper permissions
echo "[$(date)] Setting permissions..."
chmod 755 /opt/hill90
chmod 700 /opt/hill90/secrets/keys
chmod 755 /opt/hill90/logs

# Final status
echo "========================================"
echo "Bootstrap Complete - Ansible Ready"
echo "Completed: $(date)"
echo "========================================"
echo ""
echo "Next steps:"
echo "1. SSH to VPS: ssh -i ~/.ssh/remote.hill90.com root@<vps-ip>"
echo "2. Run Ansible bootstrap: ansible-playbook bootstrap-v2.yml"
echo ""
