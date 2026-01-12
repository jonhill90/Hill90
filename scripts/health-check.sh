#!/bin/bash
# Health check for Hill90 services

set -e

SERVICES=(
  "https://api.hill90.com/health"
  "https://ai.hill90.com/health"
  # MCP requires authentication, skip for now
  # "https://ai.hill90.com/mcp/health"
)

echo "================================"
echo "Hill90 Health Check"
echo "================================"
echo ""

all_healthy=true

for service in "${SERVICES[@]}"; do
  echo -n "Checking $service... "

  response=$(curl -s -o /dev/null -w "%{http_code}" "$service" || echo "000")

  if [ "$response" = "200" ]; then
    echo "✓ Healthy (200)"
  else
    echo "✗ Unhealthy ($response)"
    all_healthy=false
  fi
done

echo ""
if [ "$all_healthy" = true ]; then
  echo "✓ All services healthy!"
  exit 0
else
  echo "✗ Some services are unhealthy"
  exit 1
fi
