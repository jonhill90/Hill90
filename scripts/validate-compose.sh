#!/bin/bash
# Validate Docker Compose configuration

set -e

ENV=${1:-prod}
COMPOSE_FILE="deployments/compose/${ENV}/docker-compose.yml"

echo "================================"
echo "Docker Compose Validation"
echo "================================"
echo ""

all_valid=true

# Check compose file exists
echo -n "Checking compose file exists... "
if [ -f "$COMPOSE_FILE" ]; then
  echo "✓"
else
  echo "✗ Not found: $COMPOSE_FILE"
  all_valid=false
  echo ""
  echo "================================"
  echo "✗ Compose file missing"
  echo "================================"
  exit 1
fi

# Check Docker is installed
echo -n "Checking Docker installation... "
if command -v docker >/dev/null 2>&1; then
  echo "✓"
else
  echo "✗ Docker not installed"
  all_valid=false
  echo ""
  echo "================================"
  echo "✗ Install Docker Desktop"
  echo "================================"
  exit 1
fi

# Check Docker daemon is running
echo -n "Checking Docker daemon... "
if docker info >/dev/null 2>&1; then
  echo "✓"
else
  echo "✗ Docker daemon not running"
  all_valid=false
  echo ""
  echo "================================"
  echo "✗ Start Docker Desktop"
  echo "================================"
  exit 1
fi

# Validate compose file syntax
echo -n "Validating compose file syntax... "
if docker compose -f "$COMPOSE_FILE" config > /dev/null 2>&1; then
  echo "✓"
else
  echo "✗ Invalid compose syntax"
  all_valid=false
  echo ""
  echo "Run to see errors:"
  echo "  docker compose -f $COMPOSE_FILE config"
fi

# Check required services are defined
if [ -f "$COMPOSE_FILE" ]; then
  echo ""
  echo "Checking required services:"

  REQUIRED_SERVICES=("traefik" "api" "ai" "auth" "postgres")

  for service in "${REQUIRED_SERVICES[@]}"; do
    echo -n "  $service... "
    if grep -q "^  ${service}:" "$COMPOSE_FILE"; then
      echo "✓"
    else
      echo "✗ Missing service definition"
      all_valid=false
    fi
  done
fi

# Check required networks are defined
if [ -f "$COMPOSE_FILE" ]; then
  echo ""
  echo "Checking required networks:"

  REQUIRED_NETWORKS=("edge" "internal")

  for network in "${REQUIRED_NETWORKS[@]}"; do
    echo -n "  $network... "
    if grep -q "^  ${network}:" "$COMPOSE_FILE"; then
      echo "✓"
    else
      echo "✗ Missing network definition"
      all_valid=false
    fi
  done
fi

# Validate Traefik volume mounts reference existing files
if [ -f "$COMPOSE_FILE" ]; then
  echo ""
  echo "Checking Traefik configuration files:"

  # Check traefik.yml
  echo -n "  traefik.yml... "
  if [ -f "deployments/platform/edge/traefik.yml" ]; then
    echo "✓"
  else
    echo "✗ File not found"
    all_valid=false
  fi

  # Check dynamic config directory
  echo -n "  dynamic config directory... "
  if [ -d "deployments/platform/edge/dynamic" ]; then
    echo "✓"
  else
    echo "✗ Directory not found"
    all_valid=false
  fi
fi

echo ""
echo "================================"
if [ "$all_valid" = true ]; then
  echo "✓ Docker Compose configuration valid"
  echo "================================"
  exit 0
else
  echo "✗ Docker Compose configuration has errors"
  echo "================================"
  exit 1
fi
