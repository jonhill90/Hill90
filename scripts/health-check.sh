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
echo "================================"
echo "DNS Verification"
echo "================================"
echo ""

# Get VPS_IP from decrypted secrets if available
VPS_IP=""
if [ -f "infra/secrets/prod.dec.env" ]; then
  VPS_IP=$(grep "^VPS_IP=" infra/secrets/prod.dec.env 2>/dev/null | cut -d '=' -f 2)
fi

# If no decrypted secrets, try to decrypt temporarily
if [ -z "$VPS_IP" ] && [ -f "infra/secrets/prod.enc.env" ]; then
  VPS_IP=$(sops -d infra/secrets/prod.enc.env 2>/dev/null | grep "^VPS_IP=" | cut -d '=' -f 2 || echo "")
fi

if [ -z "$VPS_IP" ]; then
  echo "⚠ Could not retrieve VPS_IP from secrets - skipping DNS verification"
else
  echo "Expected VPS IP: $VPS_IP"
  echo ""

  DOMAINS=("api.hill90.com" "ai.hill90.com" "hill90.com")
  dns_all_correct=true

  for domain in "${DOMAINS[@]}"; do
    echo -n "Checking DNS for $domain... "

    # Use dig to resolve the domain
    RESOLVED_IP=$(dig +short "$domain" @8.8.8.8 | tail -n1)

    if [ -z "$RESOLVED_IP" ]; then
      echo "✗ No DNS record found"
      dns_all_correct=false
    elif [ "$RESOLVED_IP" != "$VPS_IP" ]; then
      echo "✗ Mismatch (resolves to $RESOLVED_IP)"
      dns_all_correct=false
    else
      echo "✓ Correct ($RESOLVED_IP)"
    fi
  done

  echo ""
  if [ "$dns_all_correct" = false ]; then
    echo "⚠ DNS records need updating"
    echo "  Update DNS A records to point to: $VPS_IP"
  fi
fi

echo ""
if [ "$all_healthy" = true ]; then
  echo "✓ All services healthy!"
  exit 0
else
  echo "✗ Some services are unhealthy"
  exit 1
fi
