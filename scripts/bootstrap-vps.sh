#!/bin/bash
# Hill90 VPS Bootstrap Script
# Wrapper script for Ansible bootstrap

set -e

echo "================================"
echo "Hill90 VPS Bootstrap"
echo "================================"

# Check prerequisites
if ! command -v ansible-playbook &> /dev/null; then
    echo "Error: Ansible is not installed"
    exit 1
fi

# Check if VPS IP is set
if [ -z "$VPS_IP" ]; then
    echo "Error: VPS_IP environment variable is not set"
    echo "Usage: VPS_IP=1.2.3.4 $0"
    exit 1
fi

# Run Ansible bootstrap
cd "$(dirname "$0")/../infra/ansible"
ansible-playbook -i inventory/hosts.yml playbooks/bootstrap.yml

echo "================================"
echo "Bootstrap Complete!"
echo "================================"
