#!/usr/bin/env bash
# Deploy CLI — deploy infrastructure and application services
# Usage: deploy.sh {infra|db|minio|vault|auth|api|ai|mcp|ui|all|verify|backup} [env]

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
  vault    Deploy OpenBao secrets management
  auth     Deploy auth identity provider (Keycloak)
  api      Deploy API service
  ai       Deploy AI service
  mcp      Deploy MCP service
  ui       Deploy UI service
  observability  Deploy observability stack (Grafana, Prometheus, Loki, Tempo)
  all      Deploy all application services (NOT infrastructure or db)
  verify   Run post-deploy readiness check for a service
  backup   Run pre-deploy backup for a service (db, minio, infra, observability)
  help     Show this help message

Environment: defaults to 'prod'
EOF
}

# ---------------------------------------------------------------------------
# Dependency and readiness checks
# ---------------------------------------------------------------------------

check_dependency() {
    local dep="$1"
    local check_cmd

    case "$dep" in
        postgres)  check_cmd='docker exec postgres pg_isready -U postgres' ;;
        keycloak)  check_cmd='[ "$(docker inspect --format="{{if .State.Health}}{{.State.Health.Status}}{{end}}" keycloak 2>/dev/null)" = "healthy" ]' ;;
        *)         echo "Unknown dependency: $dep"; return 1 ;;
    esac

    if eval "$check_cmd" >/dev/null 2>&1; then
        echo "✓ Dependency healthy: $dep"
        return 0
    else
        echo "✗ Dependency not healthy: $dep"
        return 1
    fi
}

cmd_verify() {
    local service="$1"
    local env="${2:-prod}"

    echo "Verifying readiness: ${service} (${env})"

    local max_attempts=${DEPLOY_VERIFY_MAX_ATTEMPTS:-30}
    local attempt=0
    local check_cmd

    case "$service" in
        db)            check_cmd='docker exec postgres pg_isready -U postgres' ;;
        auth)          check_cmd='[ "$(docker inspect --format="{{if .State.Health}}{{.State.Health.Status}}{{end}}" keycloak 2>/dev/null)" = "healthy" ]' ;;
        api)           check_cmd='docker exec api node -e "require(\"http\").get(\"http://localhost:3000/health\",(r)=>{process.exit(r.statusCode===200?0:1)})"' ;;
        ai)            check_cmd='docker exec ai python -c "import requests; r=requests.get(\"http://localhost:8000/health\"); exit(0 if r.ok else 1)"' ;;
        mcp)           check_cmd='docker exec mcp python -c "import requests; r=requests.get(\"http://localhost:8001/health\"); exit(0 if r.ok else 1)"' ;;
        ui)            check_cmd='docker exec ui node -e "require(\"http\").get(\"http://localhost:3000/api/health\",(r)=>{process.exit(r.statusCode===200?0:1)})"' ;;
        minio)         check_cmd='docker exec minio mc ready local' ;;
        vault)         check_cmd='docker exec openbao bao status -format=json 2>/dev/null | grep -q "\"sealed\":false"' ;;
        observability) check_cmd='docker exec prometheus wget -qO- http://localhost:9090/-/healthy' ;;
        infra)         check_cmd='docker exec traefik wget -qO- http://localhost:8080/api/overview' ;;
        *)             echo "Unknown service: $service"; exit 1 ;;
    esac

    while [ $attempt -lt $max_attempts ]; do
        if eval "$check_cmd" >/dev/null 2>&1; then
            echo "✓ ${service} is healthy"
            return 0
        fi
        attempt=$((attempt + 1))
        echo "  Waiting for ${service}... (${attempt}/${max_attempts})"
        sleep 2
    done

    echo "✗ ${service} failed readiness check after ${max_attempts} attempts"
    echo "--- Diagnostic output for ${service} ---"
    echo "Container state:"
    docker inspect --format='{{.State.Status}} (health: {{if .State.Health}}{{.State.Health.Status}}{{else}}no healthcheck{{end}})' "$service" 2>/dev/null || echo "  container not found"
    echo "Last 20 log lines:"
    docker logs --tail 20 "$service" 2>&1 || echo "  no logs available"
    echo "--- End diagnostics ---"
    exit 1
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

    # Pre-deploy backup of infrastructure volumes
    echo "Running pre-deploy backup..."
    bash "$SCRIPT_DIR/backup.sh" backup infra || warn "Pre-deploy backup failed (continuing deploy)"

    # One-time migration: remove old-project containers that would collide
    local project_name="hill90-${env}-edge"
    local old_project
    for container in traefik dns-manager portainer; do
        old_project=$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null) || true
        if [ -n "$old_project" ] && [ "$old_project" = "prod" ]; then
            echo "Migrating $container from old project '$old_project' to $project_name..."
            docker rm -f "$container" 2>/dev/null || true
        fi
    done

    echo "================================"
    echo "Edge Stack Deployment - ${env}"
    echo "================================"

    # Vault-first, SOPS-fallback for infra secrets
    local vault_ok=false
    if vault_available; then
        if (vault_login "infra" "$secrets_file") >/dev/null 2>&1; then
            vault_ok=true
            info "OpenBao authenticated for infra"
        else
            warn "OpenBao available but login failed for infra, falling back to SOPS"
        fi
    else
        warn "OpenBao not available, using SOPS fallback for infra"
    fi

    # Helper: infra deploy with SOPS
    _deploy_infra_with_sops() {
        sops exec-env "$secrets_file" '
            echo "Generating Traefik basic auth credentials..."
            mkdir -p platform/edge/dynamic
            echo "admin:${TRAEFIK_ADMIN_PASSWORD_HASH}" > platform/edge/dynamic/.htpasswd
            echo "✓ Created .htpasswd for Traefik dashboard authentication"

            echo "Building and pulling images..."
            docker compose -p "hill90-'"$env"'-edge" -f '"$compose_file"' build --parallel
            docker compose -p "hill90-'"$env"'-edge" -f '"$compose_file"' pull --ignore-buildable

            echo "Deploying edge stack (traefik, dns-manager, portainer)..."
            docker compose -p "hill90-'"$env"'-edge" -f '"$compose_file"' up -d --force-recreate
        '
    }

    if [ "$vault_ok" = true ]; then
        (
            vault_load_secrets "infra" "$secrets_file"

            echo "Generating Traefik basic auth credentials..."
            mkdir -p platform/edge/dynamic
            echo "admin:${TRAEFIK_ADMIN_PASSWORD_HASH}" > platform/edge/dynamic/.htpasswd
            echo "✓ Created .htpasswd for Traefik dashboard authentication"

            echo "Building and pulling images..."
            docker compose -p "hill90-${env}-edge" -f "$compose_file" build --parallel
            docker compose -p "hill90-${env}-edge" -f "$compose_file" pull --ignore-buildable

            echo "Deploying edge stack (traefik, dns-manager, portainer)..."
            docker compose -p "hill90-${env}-edge" -f "$compose_file" up -d --force-recreate
        ) || {
            warn "Vault deploy failed for infra, retrying with SOPS fallback"
            _deploy_infra_with_sops
        }
    else
        _deploy_infra_with_sops
    fi

    # Create internal networks if not present (edge compose creates hill90_edge;
    # internal networks are needed by app services but not by edge services)
    if ! docker network inspect hill90_internal >/dev/null 2>&1; then
        docker network create --driver bridge --internal hill90_internal
        echo "✓ Created hill90_internal network for app services"
    fi
    if ! docker network inspect hill90_agent_internal >/dev/null 2>&1; then
        docker network create --driver bridge --internal hill90_agent_internal
        echo "✓ Created hill90_agent_internal network for agent containers"
    fi

    echo ""
    echo "================================"
    echo "Edge Stack Deployment Complete!"
    echo "================================"
    docker compose -p "hill90-${env}-edge" -f "$compose_file" ps

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

    local compose_file banner containers summary stack stateful
    case "$service" in
        db)
            compose_file="deploy/compose/${env}/docker-compose.db.yml"
            containers="postgres postgres-exporter"
            banner="Database Deployment"
            stack="platform"
            stateful=true
            summary="Services deployed:
  - postgres (PostgreSQL database)
  - postgres-exporter (Prometheus metrics on :9187)"
            ;;
        auth)
            compose_file="deploy/compose/${env}/docker-compose.auth.yml"
            containers="keycloak"
            banner="Keycloak Deployment"
            stack="identity"
            stateful=true
            summary="Service deployed:
  - keycloak (identity provider at auth.hill90.com)"
            ;;
        api)
            compose_file="deploy/compose/${env}/docker-compose.api.yml"
            containers="api docker-proxy"
            banner="API Service Deployment"
            stack="apps"
            stateful=false
            summary="Services deployed:
  - api (API Gateway at api.hill90.com)
  - docker-proxy (Docker socket proxy for agentbox management)"
            ;;
        ai)
            compose_file="deploy/compose/${env}/docker-compose.ai.yml"
            containers="ai"
            banner="AI Service Deployment"
            stack="apps"
            stateful=false
            summary="Service deployed:
  - ai (AI service at ai.hill90.com)"
            ;;
        mcp)
            compose_file="deploy/compose/${env}/docker-compose.mcp.yml"
            containers="mcp"
            banner="MCP Service Deployment"
            stack="apps"
            stateful=false
            summary="Service deployed:
  - mcp (MCP Gateway at ai.hill90.com/mcp)"
            ;;
        minio)
            compose_file="deploy/compose/${env}/docker-compose.minio.yml"
            containers="minio"
            banner="MinIO Storage Deployment"
            stack="platform"
            stateful=true
            summary="Service deployed:
  - minio (S3-compatible object storage, console at storage.hill90.com)"
            ;;
        vault)
            compose_file="deploy/compose/${env}/docker-compose.vault.yml"
            containers="openbao"
            banner="OpenBao Vault Deployment"
            stack="platform"
            stateful=true
            summary="Service deployed:
  - openbao (secrets management at vault.hill90.com, Tailscale-only)"
            ;;
        ui)
            compose_file="deploy/compose/${env}/docker-compose.ui.yml"
            containers="ui"
            banner="UI Service Deployment"
            stack="apps"
            stateful=false
            summary="Service deployed:
  - ui (UI at hill90.com)"
            ;;
        observability)
            compose_file="deploy/compose/${env}/docker-compose.observability.yml"
            containers="prometheus loki tempo grafana promtail node-exporter cadvisor"
            banner="Observability Stack Deployment"
            stack="observability"
            stateful=true
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

    local project_name="hill90-${env}-${stack}"
    local secrets_file="infra/secrets/${env}.enc.env"

    ensure_age_key "$env"
    require_file "$compose_file" "Compose file"
    require_file "$secrets_file" "Secrets file"

    # Service-specific preflight checks
    if [[ "$service" == "api" ]]; then
        # Ensure agentbox config directory exists
        mkdir -p /opt/hill90/agentbox-configs
        chown 1000:1000 /opt/hill90/agentbox-configs 2>/dev/null || true
    fi
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

    # Pre-deploy dependency checks
    case "$service" in
        auth)
            check_dependency postgres || die "Cannot deploy auth: postgres is not healthy"
            ;;
        api|mcp)
            check_dependency postgres || die "Cannot deploy ${service}: postgres is not healthy"
            check_dependency keycloak || die "Cannot deploy ${service}: keycloak is not healthy"
            ;;
    esac

    # One-time migration: remove old-project containers that would collide
    # with new project names. Safe because the subsequent `up -d` immediately
    # recreates them under the new project.
    local old_project
    for container in $containers; do
        old_project=$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null) || true
        if [ -n "$old_project" ] && [ "$old_project" = "prod" ]; then
            echo "Migrating $container from old project '$old_project' to $project_name..."
            docker rm -f "$container" 2>/dev/null || true
        fi
    done

    echo "================================"
    echo "${banner} - ${env}"
    echo "================================"

    # Pre-deploy backup for stateful services
    if [ "$stateful" = true ]; then
        # Map service to its backup target (auth data lives in postgres)
        local backup_target="$service"
        if [ "$service" = "auth" ]; then
            backup_target="db"
        fi
        echo "Running pre-deploy backup for ${backup_target}..."
        bash "$SCRIPT_DIR/backup.sh" backup "$backup_target" || warn "Pre-deploy backup failed (continuing deploy)"
    fi

    # Vault-first, SOPS-fallback for service secrets
    local vault_ok=false
    if vault_available; then
        if (vault_login "$service" "$secrets_file") >/dev/null 2>&1; then
            vault_ok=true
            info "OpenBao authenticated for ${service}"
        else
            warn "OpenBao available but login failed for ${service}, falling back to SOPS"
        fi
    else
        warn "OpenBao not available, using SOPS fallback"
    fi

    # Helper: run compose deploy with secrets from SOPS
    _deploy_with_sops() {
        local mode="$1"  # "stateful" or "stateless"
        if [ "$mode" = "stateful" ]; then
            sops exec-env "$secrets_file" '
                echo "Stopping existing '"$service"' containers..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' down || true
                for container in '"$containers"'; do
                    docker rm -f "$container" 2>/dev/null || true
                done
                echo "Building and pulling images..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' build --parallel
                docker compose -p "'"$project_name"'" -f '"$compose_file"' pull --ignore-buildable
                echo "Deploying '"$service"' service..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' up -d
            '
        else
            sops exec-env "$secrets_file" '
                echo "Building and pulling images..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' build --parallel
                docker compose -p "'"$project_name"'" -f '"$compose_file"' pull --ignore-buildable
                echo "Deploying '"$service"' service..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' up -d --force-recreate --no-deps
            '
        fi
    }

    local deploy_mode="stateless"
    [ "$stateful" = true ] && deploy_mode="stateful"

    if [ "$vault_ok" = true ]; then
        # Subshell: load secrets + deploy. If vault_load_secrets fails
        # transiently, fall through to SOPS.
        (
            vault_load_secrets "$service" "$secrets_file"

            if [ "$deploy_mode" = "stateful" ]; then
                echo "Stopping existing $service containers..."
                docker compose -p "$project_name" -f "$compose_file" down || true
                for container in $containers; do
                    docker rm -f "$container" 2>/dev/null || true
                done
            fi

            echo "Building and pulling images..."
            docker compose -p "$project_name" -f "$compose_file" build --parallel
            docker compose -p "$project_name" -f "$compose_file" pull --ignore-buildable

            echo "Deploying $service service..."
            if [ "$deploy_mode" = "stateful" ]; then
                docker compose -p "$project_name" -f "$compose_file" up -d
            else
                docker compose -p "$project_name" -f "$compose_file" up -d --force-recreate --no-deps
            fi
        ) || {
            warn "Vault deploy failed for ${service}, retrying with SOPS fallback"
            _deploy_with_sops "$deploy_mode"
        }
    else
        _deploy_with_sops "$deploy_mode"
    fi

    # Auto-unseal vault after deploy so verify can pass
    if [ "$service" = "vault" ]; then
        echo "Attempting auto-unseal..."
        bash "$SCRIPT_DIR/vault.sh" auto-unseal || warn "Auto-unseal failed — run 'vault.sh unseal' manually"
    fi

    echo ""
    echo "================================"
    echo "${banner} Complete!"
    echo "================================"
    docker compose -p "$project_name" -f "$compose_file" ps

    echo ""
    echo "$summary"
    echo ""
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
        db|auth|api|ai|mcp|minio|vault|ui|observability) cmd_service "$cmd" "$@" ;;
        all)            cmd_all "$@" ;;
        verify)         cmd_verify "$@" ;;
        backup)         bash "$SCRIPT_DIR/backup.sh" backup "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
