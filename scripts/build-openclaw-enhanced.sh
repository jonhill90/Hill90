#!/bin/bash
# Build enhanced OpenClaw Docker image with Docker + SSH capabilities
# This image includes tools for infrastructure management from within the container

set -euo pipefail

VERSION="${1:-latest}"
PLATFORM="${2:-linux/amd64}"

echo "Building enhanced OpenClaw image..."
echo "Version: ${VERSION}"
echo "Platform: ${PLATFORM}"

# Build from platform/openclaw directory
cd "$(dirname "$0")/../platform/openclaw"

docker build \
  --platform "${PLATFORM}" \
  -t "hill90/openclaw:enhanced-${VERSION}" \
  -t "hill90/openclaw:enhanced-latest" \
  .

echo "✓ Built hill90/openclaw:enhanced-${VERSION}"
echo ""
echo "Image includes:"
echo "  - Node.js 22 + OpenClaw"
echo "  - Python 3 + pip (Ansible, age, AI libraries)"
echo "  - Docker CLI (container management via socket)"
echo "  - SSH client (host access)"
echo "  - Developer tools (git, vim, curl, jq, etc.)"
