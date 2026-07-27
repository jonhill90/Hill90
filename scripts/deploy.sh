#!/usr/bin/env bash
# Deploy CLI — deploy infrastructure stacks
# Usage: deploy.sh {infra|db|auth|vault|observability|verify|backup} [env]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Deploy CLI — Hill90 infrastructure deployment

Usage: deploy.sh <command> [env]

Commands:
  infra    Deploy infrastructure (Traefik, Portainer)
  db       Deploy PostgreSQL (platform database)
  auth     Deploy Keycloak (platform identity provider)
  vault    Deploy OpenBao secrets management
  observability  Deploy observability stack (Grafana, Prometheus, Loki, Tempo)
  teardown Stop and remove a stack's containers and networks (volumes KEPT)
  verify   Run post-deploy readiness check for a service
  backup   Run pre-deploy backup for a service (infra, db, vault, observability)
  help     Show this help message

Environment: defaults to 'prod'
EOF
}

# ---------------------------------------------------------------------------
# Readiness checks
# ---------------------------------------------------------------------------

cmd_verify() {
    local service="$1"
    local env="${2:-prod}"

    echo "Verifying readiness: ${service} (${env})"

    local max_attempts=${DEPLOY_VERIFY_MAX_ATTEMPTS:-30}
    local attempt=0
    local check_cmd
    local diag_container  # primary container name for diagnostics

    case "$service" in
        # pg_isready exits 0 regardless of whether the role exists, so it would
        # pass on a Postgres whose credentials are entirely broken and leave
        # Keycloak to crash-loop instead. Run a real query as the real user.
        db)            check_cmd='docker exec postgres psql -U "${DB_USER:-hill90}" -tAc "SELECT 1"'; diag_container="postgres" ;;
        auth)          check_cmd='[ "$(docker inspect --format="{{if .State.Health}}{{.State.Health.Status}}{{end}}" keycloak 2>/dev/null)" = "healthy" ]'; diag_container="keycloak" ;;
        vault)         check_cmd='[ "$(docker inspect --format="{{if .State.Health}}{{.State.Health.Status}}{{end}}" openbao 2>/dev/null)" = "healthy" ]'; diag_container="openbao" ;;
        observability) check_cmd='docker exec prometheus wget -qO- http://localhost:9090/-/healthy'; diag_container="prometheus" ;;
        infra)         check_cmd='docker exec traefik wget -qO- http://localhost:8080/api/overview'; diag_container="traefik" ;;
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
    echo "--- Diagnostic output for ${service} (container: ${diag_container}) ---"
    echo "Container state:"
    docker inspect --format='{{.State.Status}} (health: {{if .State.Health}}{{.State.Health.Status}}{{else}}no healthcheck{{end}})' "$diag_container" 2>/dev/null || echo "  container not found"
    echo "Last 20 log lines:"
    docker logs --tail 20 "$diag_container" 2>&1 || echo "  no logs available"
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
    for container in traefik portainer; do
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

            bash '"$SCRIPT_DIR"'/render-traefik-config.sh

            echo "Building and pulling images..."
            docker compose -p "hill90-'"$env"'-edge" -f '"$compose_file"' build --parallel
            docker compose -p "hill90-'"$env"'-edge" -f '"$compose_file"' pull --ignore-buildable

            echo "Deploying edge stack (traefik, portainer)..."
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

            bash "$SCRIPT_DIR/render-traefik-config.sh"

            echo "Building and pulling images..."
            docker compose -p "hill90-${env}-edge" -f "$compose_file" build --parallel --no-cache
            docker compose -p "hill90-${env}-edge" -f "$compose_file" pull --ignore-buildable

            echo "Deploying edge stack (traefik, portainer)..."
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
    echo "  - Portainer (container management, Tailscale-only)"
    echo ""
}

# ---------------------------------------------------------------------------
# Platform service deployment
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
  - postgres (platform database — Keycloak's store)
  - postgres-exporter (Prometheus metrics on :9187)"
            ;;
        auth)
            compose_file="deploy/compose/${env}/docker-compose.auth.yml"
            containers="keycloak"
            banner="Keycloak Deployment"
            stack="identity"
            stateful=true
            summary="Service deployed:
  - keycloak (platform identity provider at auth.hill90.com)"
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

    # Check that networks exist (infrastructure must be deployed first)
    if ! docker network inspect hill90_edge >/dev/null 2>&1; then
        die "Network hill90_edge not found. Deploy infrastructure first: make deploy-infra"
    fi
    if ! docker network inspect hill90_internal >/dev/null 2>&1; then
        die "Network hill90_internal not found. Deploy infrastructure first: make deploy-infra"
    fi

    # Keycloak stores its realms in Postgres, so refuse rather than start into a
    # crash loop if the database is not up.
    if [ "$service" = "auth" ]; then
        if ! docker exec postgres psql -U "${DB_USER:-hill90}" -tAc 'SELECT 1' >/dev/null 2>&1; then
            die "Cannot deploy auth: cannot query postgres as '${DB_USER:-hill90}'. Deploy it first: bash scripts/deploy.sh db ${env}"
        fi
    fi

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
        echo "Running pre-deploy backup for ${service}..."
        bash "$SCRIPT_DIR/backup.sh" backup "$service" || warn "Pre-deploy backup failed (continuing deploy)"
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
                docker compose -p "'"$project_name"'" -f '"$compose_file"' build --parallel --no-cache
                docker compose -p "'"$project_name"'" -f '"$compose_file"' pull --ignore-buildable
                echo "Deploying '"$service"' service..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' up -d
            '
        else
            sops exec-env "$secrets_file" '
                echo "Building and pulling images..."
                docker compose -p "'"$project_name"'" -f '"$compose_file"' build --parallel --no-cache
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
# Teardown
# ---------------------------------------------------------------------------

# Removes containers and networks for one stack. Volumes are NEVER touched:
# rebuilding is meant to be routine, and routine operations must not be able to
# destroy data. Deleting a volume on the VPS stays a deliberate manual act,
# preceded by scripts/backup.sh — see docs/runbooks/deployment.md.
cmd_teardown() {
    local stack="$1"
    local env="${2:-prod}"
    local compose_file project_name

    case "$stack" in
        infra)
            compose_file="deploy/compose/${env}/docker-compose.infra.yml"
            project_name="hill90-${env}-edge"
            ;;
        db)
            compose_file="deploy/compose/${env}/docker-compose.db.yml"
            project_name="hill90-${env}-platform"
            ;;
        auth)
            compose_file="deploy/compose/${env}/docker-compose.auth.yml"
            project_name="hill90-${env}-identity"
            ;;
        vault|observability)
            compose_file="deploy/compose/${env}/docker-compose.${stack}.yml"
            [ "$stack" = "vault" ] && project_name="hill90-${env}-platform" \
                                   || project_name="hill90-${env}-observability"
            ;;
        *)
            die "Unknown stack for teardown: $stack. Use: infra, db, auth, vault, observability"
            ;;
    esac

    require_file "$compose_file" "Compose file"

    echo "================================"
    echo "Teardown: ${stack} (${env})"
    echo "================================"
    echo "Project:  ${project_name}"
    echo "Volumes:  KEPT — data survives; rebuild restores the stack as-is."
    echo ""

    echo "Backing up before teardown..."
    bash "$SCRIPT_DIR/backup.sh" backup "$stack" || warn "Backup failed (continuing teardown)"

    # Orphan removal is deliberately not used here — it is banned repo-wide
    # because it will happily delete containers belonging to another stack that
    # shares a project name. See tests/scripts/deploy.bats.
    docker compose -p "$project_name" -f "$compose_file" down

    echo ""
    success "${stack} torn down. Rebuild with: bash scripts/deploy.sh ${stack} ${env}"
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
        db|auth|vault|observability) cmd_service "$cmd" "$@" ;;
        teardown)       cmd_teardown "$@" ;;
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
