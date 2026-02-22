#!/usr/bin/env bash
# Deploy CLI — deploy infrastructure and application services
# Usage: deploy.sh {infra|db|minio|auth|api|ai|mcp|agentbox|ui|all} [env]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Deploy CLI — Hill90 service deployment

Usage: deploy.sh <command> [env]

Commands:
  infra    Deploy infrastructure (Traefik, dns-manager, Portainer)
  db       Deploy database (PostgreSQL)
  minio    Deploy MinIO object storage
  auth     Deploy Keycloak identity provider
  api      Deploy API service
  ai       Deploy AI service
  mcp      Deploy MCP service
  agentbox Deploy agent container(s)
  ui       Deploy UI service
  observability  Deploy observability stack (Grafana, Prometheus, Loki, Tempo)
  all      Deploy all application services (NOT infrastructure or db)
  help     Show this help message

Environment: defaults to 'prod'
EOF
}

# ---------------------------------------------------------------------------
# Infrastructure deployment
# ---------------------------------------------------------------------------

cmd_infra() {
    local env="${1:-prod}"
    local compose_file="deploy/compose/${env}/docker-compose.infra.yml"
    local secrets_file="infra/secrets/${env}.enc.env"

    ensure_age_key "$env"
    require_file "$compose_file" "Compose file"
    require_file "$secrets_file" "Secrets file"

    echo "================================"
    echo "Infrastructure Deployment - ${env}"
    echo "================================"

    sops exec-env "$secrets_file" '
        echo "Stopping existing infrastructure containers..."
        docker compose -f '"$compose_file"' down --remove-orphans || true

        for container in traefik dns-manager portainer; do
            docker rm -f "$container" 2>/dev/null || true
        done

        echo "Generating Traefik basic auth credentials..."
        mkdir -p platform/edge/dynamic
        echo "admin:${TRAEFIK_ADMIN_PASSWORD_HASH}" > platform/edge/dynamic/.htpasswd
        echo "✓ Created .htpasswd for Traefik dashboard authentication"

        echo "Building and pulling images..."
        docker compose -f '"$compose_file"' build --parallel
        docker compose -f '"$compose_file"' pull --ignore-buildable

        echo "Deploying infrastructure services..."
        docker compose -f '"$compose_file"' up -d

        # Create internal network if not created by compose (no infra service uses it)
        if ! docker network inspect hill90_internal >/dev/null 2>&1; then
            docker network create --driver bridge --internal hill90_internal
            echo "✓ Created hill90_internal network for app services"
        fi
    '

    echo ""
    echo "================================"
    echo "Infrastructure Deployment Complete!"
    echo "================================"
    docker compose -f "$compose_file" ps

    echo ""
    echo "Services deployed:"
    echo "  - Traefik (reverse proxy with SSL)"
    echo "  - dns-manager (DNS-01 ACME challenges)"
    echo "  - Portainer (container management, Tailscale-only)"
    echo ""
}

# ---------------------------------------------------------------------------
# Application service deployment
# ---------------------------------------------------------------------------

cmd_service() {
    local service="$1"
    local env="${2:-prod}"

    local compose_file banner containers summary
    case "$service" in
        db)
            compose_file="deploy/compose/${env}/docker-compose.db.yml"
            containers="postgres postgres-exporter"
            banner="Database Deployment"
            summary="Services deployed:
  - postgres (PostgreSQL database)
  - postgres-exporter (Prometheus metrics on :9187)"
            ;;
        auth)
            compose_file="deploy/compose/${env}/docker-compose.auth.yml"
            containers="keycloak"
            banner="Keycloak Deployment"
            summary="Service deployed:
  - keycloak (identity provider at auth.hill90.com)"
            ;;
        api)
            compose_file="deploy/compose/${env}/docker-compose.api.yml"
            containers="api"
            banner="API Service Deployment"
            summary="Service deployed:
  - api (API Gateway at api.hill90.com)"
            ;;
        ai)
            compose_file="deploy/compose/${env}/docker-compose.ai.yml"
            containers="ai"
            banner="AI Service Deployment"
            summary="Service deployed:
  - ai (AI service at ai.hill90.com)"
            ;;
        mcp)
            compose_file="deploy/compose/${env}/docker-compose.mcp.yml"
            containers="mcp"
            banner="MCP Service Deployment"
            summary="Service deployed:
  - mcp (MCP Gateway at ai.hill90.com/mcp)"
            ;;
        minio)
            compose_file="deploy/compose/${env}/docker-compose.minio.yml"
            containers="minio"
            banner="MinIO Storage Deployment"
            summary="Service deployed:
  - minio (S3-compatible object storage, console at storage.hill90.com)"
            ;;
        ui)
            compose_file="deploy/compose/${env}/docker-compose.ui.yml"
            containers="ui"
            banner="UI Service Deployment"
            summary="Service deployed:
  - ui (UI at hill90.com)"
            ;;
        observability)
            compose_file="deploy/compose/${env}/docker-compose.observability.yml"
            containers="prometheus loki tempo grafana promtail node-exporter cadvisor"
            banner="Observability Stack Deployment"
            summary="Services deployed:
  - grafana (dashboards at grafana.hill90.com, Tailscale-only)
  - prometheus (metrics at :9090)
  - loki (logs at :3100)
  - tempo (traces at :3200)
  - promtail (log collector)
  - node-exporter (host metrics)
  - cadvisor (container metrics)"
            ;;
    esac

    local secrets_file="infra/secrets/${env}.enc.env"

    ensure_age_key "$env"
    require_file "$compose_file" "Compose file"
    require_file "$secrets_file" "Secrets file"

    # Service-specific preflight checks
    if [[ "$service" == "minio" ]]; then
        sops exec-env "$secrets_file" 'test -n "$MINIO_ROOT_USER" && test -n "$MINIO_ROOT_PASSWORD"' \
            || die "MINIO_ROOT_USER and MINIO_ROOT_PASSWORD must be set in secrets. Run: make secrets-update KEY=MINIO_ROOT_USER VALUE=..."
    fi

    # Check that networks exist (infrastructure must be deployed first)
    if ! docker network inspect hill90_edge >/dev/null 2>&1; then
        die "Network hill90_edge not found. Deploy infrastructure first: make deploy-infra"
    fi
    if ! docker network inspect hill90_internal >/dev/null 2>&1; then
        die "Network hill90_internal not found. Deploy infrastructure first: make deploy-infra"
    fi

    echo "================================"
    echo "${banner} - ${env}"
    echo "================================"

    sops exec-env "$secrets_file" '
        echo "Stopping existing '"$service"' containers..."
        docker compose -f '"$compose_file"' down || true

        for container in '"$containers"'; do
            docker rm -f "$container" 2>/dev/null || true
        done

        echo "Building and pulling images..."
        docker compose -f '"$compose_file"' build --parallel
        docker compose -f '"$compose_file"' pull --ignore-buildable

        echo "Deploying '"$service"' service..."
        docker compose -f '"$compose_file"' up -d
    '

    echo ""
    echo "================================"
    echo "${banner} Complete!"
    echo "================================"
    docker compose -f "$compose_file" ps

    echo ""
    echo "$summary"
    echo ""
}

# ---------------------------------------------------------------------------
# AgentBox deployment (custom — generates compose + builds image)
# ---------------------------------------------------------------------------

cmd_agentbox() {
    local env="${1:-prod}"
    local compose_file="deploy/compose/${env}/docker-compose.agentbox.yml"

    if ! docker network inspect hill90_internal >/dev/null 2>&1; then
        die "Network hill90_internal not found. Deploy infrastructure first: make deploy-infra"
    fi

    echo "================================"
    echo "AgentBox Deployment - ${env}"
    echo "================================"

    echo "Generating compose from agent configs..."
    python3 scripts/agentbox-compose-gen.py

    echo "Building agentbox image..."
    docker build -t hill90/agentbox:latest src/services/agentbox/

    echo "Deploying agent containers..."
    docker compose -p agentbox -f "$compose_file" up -d

    echo ""
    echo "================================"
    echo "AgentBox Deployment Complete!"
    echo "================================"
    docker compose -p agentbox -f "$compose_file" ps
}

# ---------------------------------------------------------------------------
# Deploy all application services
# ---------------------------------------------------------------------------

cmd_all() {
    local env="${1:-prod}"

    echo "================================"
    echo "All Services Deployment - ${env}"
    echo "================================"
    echo ""
    echo "This will deploy all application services:"
    echo "  1. keycloak (auth)"
    echo "  2. api"
    echo "  3. ai"
    echo "  4. mcp"
    echo "  5. ui"
    echo ""

    if ! docker network inspect hill90_edge >/dev/null 2>&1; then
        die "Network hill90_edge not found. Deploy infrastructure first: make deploy-infra"
    fi

    if ! docker ps --format '{{.Names}}' | grep -q '^postgres$'; then
        echo "WARNING: postgres container not running. Keycloak requires it."
        echo "Run 'make deploy-db' first, then re-run 'make deploy-all'."
        die "Prerequisite not met: postgres must be running before deploy-all"
    fi

    for svc in auth api ai mcp ui; do
        echo "Deploying ${svc} service..."
        cmd_service "$svc" "$env"
        echo ""
    done

    echo ""
    echo "================================"
    echo "All Services Deployment Complete!"
    echo "================================"
    echo ""
    echo "Running containers:"
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "(NAMES|api|ai|mcp|keycloak|ui)" || true
    echo ""
    echo "Check service health:"
    echo "  make health"
    echo ""
}

# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

main() {
    if [[ $# -lt 1 ]]; then
        usage
        exit 1
    fi

    local cmd="$1"
    shift

    case "$cmd" in
        infra)          cmd_infra "$@" ;;
        db|auth|api|ai|mcp|minio|ui|observability) cmd_service "$cmd" "$@" ;;
        agentbox)       cmd_agentbox "$@" ;;
        all)            cmd_all "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
