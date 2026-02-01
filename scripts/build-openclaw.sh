#!/bin/bash
# Build OpenClaw from GitHub and tag for Hill90 deployment

set -e

OPENCLAW_REPO="${OPENCLAW_REPO:-https://github.com/openclaw/openclaw.git}"
OPENCLAW_BRANCH="${OPENCLAW_BRANCH:-main}"
VERSION="${VERSION:-latest}"

echo "Building OpenClaw from ${OPENCLAW_REPO}#${OPENCLAW_BRANCH}..."

# Clone to temp directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

git clone --depth 1 --branch "$OPENCLAW_BRANCH" "$OPENCLAW_REPO" "$TEMP_DIR"

# Build using OpenClaw's existing Dockerfile
cd "$TEMP_DIR"
docker build -t hill90/openclaw:${VERSION} -t hill90/openclaw:latest .

echo "✓ Built hill90/openclaw:${VERSION}"
