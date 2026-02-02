#!/bin/bash
# Deploy all application services (NOT infrastructure)
# Requires: infrastructure deployed first (make deploy-infra)
#
# This deploys: auth, api, ai, mcp
# In dependency order: auth (with postgres) first, then api, ai, mcp

set -e

ENV=${1:-prod}

echo "================================"
echo "All Services Deployment - ${ENV}"
echo "================================"
echo ""
echo "This will deploy all application services:"
echo "  1. auth + postgres"
echo "  2. api"
echo "  3. ai"
echo "  4. mcp"
echo ""

# Check that infrastructure is deployed first
if ! docker network inspect hill90_edge >/dev/null 2>&1; then
    echo "Error: Network hill90_edge not found."
    echo ""
    echo "Infrastructure must be deployed first:"
    echo "  make deploy-infra"
    echo ""
    exit 1
fi

# Deploy in dependency order
echo "Deploying auth service (with postgres)..."
bash scripts/deploy-auth.sh "$ENV"
echo ""

echo "Deploying API service..."
bash scripts/deploy-api.sh "$ENV"
echo ""

echo "Deploying AI service..."
bash scripts/deploy-ai.sh "$ENV"
echo ""

echo "Deploying MCP service..."
bash scripts/deploy-mcp.sh "$ENV"
echo ""

# Show all running containers
echo ""
echo "================================"
echo "All Services Deployment Complete!"
echo "================================"
echo ""
echo "Running containers:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "(NAMES|api|ai|mcp|auth|postgres)" || true

echo ""
echo "Check service health:"
echo "  make health"
echo ""
