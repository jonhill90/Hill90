#!/bin/bash
# Deploy infrastructure services (Traefik, dns-manager, Portainer)
# This is typically run once after VPS config, then rarely changes

set -e

ENV=${1:-prod}
COMPOSE_FILE="deployments/compose/${ENV}/docker-compose.infra.yml"
SECRETS_FILE="infra/secrets/${ENV}.enc.env"

# Use SOPS_AGE_KEY_FILE if already set (e.g., from GitHub Actions)
if [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
    AGE_KEY="infra/secrets/keys/age-${ENV}.key"
    export SOPS_AGE_KEY_FILE="$AGE_KEY"
else
    AGE_KEY="$SOPS_AGE_KEY_FILE"
fi

echo "================================"
echo "Infrastructure Deployment - ${ENV}"
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

# Deploy using sops exec-env
echo "Deploying infrastructure with encrypted secrets..."

sops exec-env "$SECRETS_FILE" '
  echo "Stopping existing infrastructure containers..."
  docker compose -f '"$COMPOSE_FILE"' down --remove-orphans || true

  # Force remove any lingering containers by name
  for container in traefik dns-manager portainer; do
    docker rm -f "$container" 2>/dev/null || true
  done

  echo "Generating Traefik basic auth credentials..."
  mkdir -p deployments/platform/edge/dynamic
  echo "admin:${TRAEFIK_ADMIN_PASSWORD_HASH}" > deployments/platform/edge/dynamic/.htpasswd
  echo "✓ Created .htpasswd for Traefik dashboard authentication"

  echo "Building and pulling images..."
  docker compose -f '"$COMPOSE_FILE"' build --parallel
  docker compose -f '"$COMPOSE_FILE"' pull --ignore-buildable

  echo "Deploying infrastructure services..."
  docker compose -f '"$COMPOSE_FILE"' up -d
'

# Show running containers
echo ""
echo "================================"
echo "Infrastructure Deployment Complete!"
echo "================================"
docker compose -f "$COMPOSE_FILE" ps

echo ""
echo "Services deployed:"
echo "  - Traefik (reverse proxy with SSL)"
echo "  - dns-manager (DNS-01 ACME challenges)"
echo "  - Portainer (container management, Tailscale-only)"
echo ""
