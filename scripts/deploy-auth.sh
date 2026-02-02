#!/bin/bash
# Deploy auth service with PostgreSQL
# Requires: infrastructure deployed (networks must exist)

set -e

ENV=${1:-prod}
COMPOSE_FILE="deployments/compose/${ENV}/docker-compose.auth.yml"
SECRETS_FILE="infra/secrets/${ENV}.enc.env"

# Use SOPS_AGE_KEY_FILE if already set
if [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
    AGE_KEY="infra/secrets/keys/age-${ENV}.key"
    export SOPS_AGE_KEY_FILE="$AGE_KEY"
else
    AGE_KEY="$SOPS_AGE_KEY_FILE"
fi

echo "================================"
echo "Auth Service Deployment - ${ENV}"
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
echo "Deploying auth service with encrypted secrets..."

sops exec-env "$SECRETS_FILE" '
  echo "Stopping existing auth containers..."
  docker compose -f '"$COMPOSE_FILE"' down --remove-orphans || true

  # Force remove any lingering containers by name
  for container in auth postgres; do
    docker rm -f "$container" 2>/dev/null || true
  done

  echo "Building and pulling images..."
  docker compose -f '"$COMPOSE_FILE"' build --parallel
  docker compose -f '"$COMPOSE_FILE"' pull --ignore-buildable

  echo "Deploying auth service..."
  docker compose -f '"$COMPOSE_FILE"' up -d
'

# Show running containers
echo ""
echo "================================"
echo "Auth Service Deployment Complete!"
echo "================================"
docker compose -f "$COMPOSE_FILE" ps

echo ""
echo "Services deployed:"
echo "  - postgres (database)"
echo "  - auth (authentication service)"
echo ""
