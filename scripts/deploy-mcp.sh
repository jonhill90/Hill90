#!/bin/bash
# Deploy MCP Gateway service
# Requires: infrastructure deployed (networks must exist)

set -e

ENV=${1:-prod}
COMPOSE_FILE="deployments/compose/${ENV}/docker-compose.mcp.yml"
SECRETS_FILE="infra/secrets/${ENV}.enc.env"

# Use SOPS_AGE_KEY_FILE if already set
if [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
    AGE_KEY="infra/secrets/keys/age-${ENV}.key"
    export SOPS_AGE_KEY_FILE="$AGE_KEY"
else
    AGE_KEY="$SOPS_AGE_KEY_FILE"
fi

echo "================================"
echo "MCP Service Deployment - ${ENV}"
echo "================================"

# Check prerequisites
if [ ! -f "$COMPOSE_FILE" ]; then
    echo "Error: Compose file not found: $COMPOSE_FILE"
    exit 1
fi

if [ ! -f "$SECRETS_FILE" ]; then
    echo "Error: Secrets file not found: $SECRETS_FILE"
    exit 1
fi

if [ ! -f "$AGE_KEY" ]; then
    echo "Error: Age key not found: $AGE_KEY"
    exit 1
fi

# Check that networks exist (infrastructure must be deployed first)
if ! docker network inspect hill90_edge >/dev/null 2>&1; then
    echo "Error: Network hill90_edge not found. Deploy infrastructure first:"
    echo "  make deploy-infra"
    exit 1
fi

if ! docker network inspect hill90_internal >/dev/null 2>&1; then
    echo "Error: Network hill90_internal not found. Deploy infrastructure first:"
    echo "  make deploy-infra"
    exit 1
fi

# Deploy using sops exec-env
echo "Deploying MCP service with encrypted secrets..."

sops exec-env "$SECRETS_FILE" '
  echo "Stopping existing MCP container..."
  docker compose -f '"$COMPOSE_FILE"' down --remove-orphans || true

  # Force remove any lingering container by name
  docker rm -f mcp 2>/dev/null || true

  echo "Building and pulling images..."
  docker compose -f '"$COMPOSE_FILE"' build --parallel
  docker compose -f '"$COMPOSE_FILE"' pull --ignore-buildable

  echo "Deploying MCP service..."
  docker compose -f '"$COMPOSE_FILE"' up -d
'

# Show running containers
echo ""
echo "================================"
echo "MCP Service Deployment Complete!"
echo "================================"
docker compose -f "$COMPOSE_FILE" ps

echo ""
echo "Service deployed:"
echo "  - mcp (MCP Gateway at ai.hill90.com/mcp)"
echo ""
