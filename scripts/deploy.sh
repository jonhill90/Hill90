#!/bin/bash
# Deploy Hill90 services to VPS

set -e

ENV=${1:-prod}
COMPOSE_FILE="deployments/compose/${ENV}/docker-compose.yml"
SECRETS_FILE="infra/secrets/${ENV}.enc.env"

# Use SOPS_AGE_KEY_FILE if already set (e.g., from GitHub Actions)
# Otherwise use default location
if [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
    AGE_KEY="infra/secrets/keys/age-${ENV}.key"
    export SOPS_AGE_KEY_FILE="$AGE_KEY"
else
    AGE_KEY="$SOPS_AGE_KEY_FILE"
fi

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

# Run pre-deployment validation
if [ "${SKIP_VALIDATION:-false}" != "true" ]; then
    echo ""
    echo "Running pre-deployment validation..."
    echo ""
    if ! bash scripts/validate-infra.sh "$ENV"; then
        echo ""
        echo "✗ Validation failed! Fix errors before deploying."
        echo ""
        echo "To skip validation (NOT RECOMMENDED):"
        echo "  SKIP_VALIDATION=true bash scripts/deploy.sh ${ENV}"
        echo ""
        exit 1
    fi
    echo ""
fi

# Deploy using sops exec-env (no temporary files!)
echo "Deploying with encrypted secrets..."

# Use sops exec-env to run docker compose with secrets in environment
# This avoids creating temporary decrypted files
sops exec-env "$SECRETS_FILE" '
  echo "Stopping existing services..."
  docker compose -f '"$COMPOSE_FILE"' down --remove-orphans || true

  # Force remove any lingering containers by name
  for container in traefik postgres api ai mcp auth; do
    docker rm -f "$container" 2>/dev/null || true
  done

  echo "Building and pulling images (parallel mode)..."
  docker compose -f '"$COMPOSE_FILE"' build --parallel
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
