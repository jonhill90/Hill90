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

# Decrypt secrets
echo "Decrypting secrets..."
export SOPS_AGE_KEY_FILE="$AGE_KEY"
sops -d "$SECRETS_FILE" > "/tmp/${ENV}.dec.env"

# Export environment variables (filter out comments and empty lines)
export $(cat "/tmp/${ENV}.dec.env" | grep -v '^#' | grep -v '^$' | xargs)

# Pull latest base images and build custom images
echo "Building and pulling images..."
docker compose -f "$COMPOSE_FILE" build
docker compose -f "$COMPOSE_FILE" pull --ignore-buildable

# Deploy services
echo "Deploying services..."
docker compose -f "$COMPOSE_FILE" up -d

# Cleanup decrypted secrets
rm "/tmp/${ENV}.dec.env"

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
