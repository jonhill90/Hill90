#!/bin/bash
# Deploy Hill90 services to VPS

set -e

ENV=${1:-prod}
COMPOSE_FILE="deployments/compose/${ENV}/docker-compose.yml"
SECRETS_FILE="infra/secrets/${ENV}.enc.env"
AGE_KEY="infra/secrets/keys/age-${ENV}.key"

echo "================================"
echo "Hill90 Deployment - ${ENV}"
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

# Deploy using sops exec-env (no temporary files!)
echo "Deploying with encrypted secrets..."
export SOPS_AGE_KEY_FILE="$AGE_KEY"

# Use sops exec-env to run docker compose with secrets in environment
# This avoids creating temporary decrypted files
sops exec-env "$SECRETS_FILE" '
  echo "Building and pulling images..."
  docker compose -f '"$COMPOSE_FILE"' build
  docker compose -f '"$COMPOSE_FILE"' pull --ignore-buildable

  echo "Deploying services..."
  docker compose -f '"$COMPOSE_FILE"' up -d
'

# Show running containers
echo ""
echo "================================"
echo "Deployment Complete!"
echo "================================"
docker compose -f "$COMPOSE_FILE" ps

echo ""
echo "Check service health:"
echo "  make health"
echo ""
echo "View logs:"
echo "  make logs"
