#!/bin/bash
# Deploy a single application service
# Usage: bash scripts/deploy/_service.sh <service> [env]
#
# Replaces deploy-auth.sh, deploy-api.sh, deploy-ai.sh, deploy-mcp.sh
# Handles per-service differences via case statement

set -e

SERVICE=${1:-}
ENV=${2:-prod}

if [ -z "$SERVICE" ]; then
    echo "Error: Service name required"
    echo "Usage: bash scripts/deploy/_service.sh <service> [env]"
    echo "Services: auth, api, ai, mcp"
    exit 1
fi

# Per-service configuration
case "$SERVICE" in
    auth)
        COMPOSE_FILE="deployments/compose/${ENV}/docker-compose.auth.yml"
        CONTAINERS="auth postgres"
        BANNER="Auth Service Deployment"
        SUMMARY="Services deployed:
  - postgres (database)
  - auth (authentication service)"
        ;;
    api)
        COMPOSE_FILE="deployments/compose/${ENV}/docker-compose.api.yml"
        CONTAINERS="api"
        BANNER="API Service Deployment"
        SUMMARY="Service deployed:
  - api (API Gateway at api.hill90.com)"
        ;;
    ai)
        COMPOSE_FILE="deployments/compose/${ENV}/docker-compose.ai.yml"
        CONTAINERS="ai"
        BANNER="AI Service Deployment"
        SUMMARY="Service deployed:
  - ai (AI service at ai.hill90.com)"
        ;;
    mcp)
        COMPOSE_FILE="deployments/compose/${ENV}/docker-compose.mcp.yml"
        CONTAINERS="mcp"
        BANNER="MCP Service Deployment"
        SUMMARY="Service deployed:
  - mcp (MCP Gateway at ai.hill90.com/mcp)"
        ;;
    *)
        echo "Error: Unknown service: $SERVICE"
        echo "Valid services: auth, api, ai, mcp"
        exit 1
        ;;
esac

SECRETS_FILE="infra/secrets/${ENV}.enc.env"

# Use SOPS_AGE_KEY_FILE if already set
if [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
    AGE_KEY="infra/secrets/keys/age-${ENV}.key"
    export SOPS_AGE_KEY_FILE="$AGE_KEY"
else
    AGE_KEY="$SOPS_AGE_KEY_FILE"
fi

echo "================================"
echo "${BANNER} - ${ENV}"
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
echo "Deploying ${SERVICE} service with encrypted secrets..."

sops exec-env "$SECRETS_FILE" '
  echo "Stopping existing '"$SERVICE"' containers..."
  docker compose -f '"$COMPOSE_FILE"' down --remove-orphans || true

  # Force remove any lingering containers by name
  for container in '"$CONTAINERS"'; do
    docker rm -f "$container" 2>/dev/null || true
  done

  echo "Building and pulling images..."
  docker compose -f '"$COMPOSE_FILE"' build --parallel
  docker compose -f '"$COMPOSE_FILE"' pull --ignore-buildable

  echo "Deploying '"$SERVICE"' service..."
  docker compose -f '"$COMPOSE_FILE"' up -d
'

# Show running containers
echo ""
echo "================================"
echo "${BANNER} Complete!"
echo "================================"
docker compose -f "$COMPOSE_FILE" ps

echo ""
echo "$SUMMARY"
echo ""
