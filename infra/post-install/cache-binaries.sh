#!/usr/bin/env bash
# Post-install script for VPS OS rebuild
# Pre-caches binaries to speed up bootstrap process
# This script runs DURING OS rebuild, before Ansible playbooks

set -euo pipefail

CACHE_DIR="/opt/hill90/cache"
SOPS_VERSION="3.8.1"
AGE_VERSION="1.1.1"

echo "=== Hill90 VPS Post-Install: Binary Cache ==="
echo "Cache directory: $CACHE_DIR"

# Create cache directory
mkdir -p "$CACHE_DIR"

# Install Docker (90 seconds saved during Ansible)
echo "Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo "✓ Docker installed"
else
    echo "✓ Docker already installed"
fi

# Download SOPS (15 seconds saved)
echo "Downloading SOPS..."
if [[ ! -f "$CACHE_DIR/sops" ]]; then
    curl -L -o "$CACHE_DIR/sops" \
        "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.amd64"
    chmod +x "$CACHE_DIR/sops"
    echo "✓ SOPS downloaded"
else
    echo "✓ SOPS already cached"
fi

# Download age (15 seconds saved)
echo "Downloading age..."
if [[ ! -f "$CACHE_DIR/age" ]]; then
    curl -L -o "$CACHE_DIR/age.tar.gz" \
        "https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/age-v${AGE_VERSION}-linux-amd64.tar.gz"
    tar -xzf "$CACHE_DIR/age.tar.gz" -C "$CACHE_DIR"
    mv "$CACHE_DIR/age/age" "$CACHE_DIR/age"
    mv "$CACHE_DIR/age/age-keygen" "$CACHE_DIR/age-keygen"
    rm -rf "$CACHE_DIR/age" "$CACHE_DIR/age.tar.gz"
    chmod +x "$CACHE_DIR/age" "$CACHE_DIR/age-keygen"
    echo "✓ age downloaded"
else
    echo "✓ age already cached"
fi

# Install git (5 seconds saved)
echo "Installing git..."
if ! command -v git &> /dev/null; then
    dnf install -y git
    echo "✓ git installed"
else
    echo "✓ git already installed"
fi

# Install jq (useful for Tailscale setup)
echo "Installing jq..."
if ! command -v jq &> /dev/null; then
    dnf install -y jq
    echo "✓ jq installed"
else
    echo "✓ jq already installed"
fi

# Create hill90 directory structure
echo "Creating directory structure..."
mkdir -p /opt/hill90/{app,secrets/keys,logs}
echo "✓ Directories created"

# Summary
echo ""
echo "=== Cache Summary ==="
ls -lh "$CACHE_DIR"
echo ""
echo "✓ Post-install complete! Binaries cached, ~2-3 minutes saved during bootstrap."
