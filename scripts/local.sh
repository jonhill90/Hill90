#!/usr/bin/env bash
# Local development CLI — run the Hill90 infrastructure stack on Docker Desktop.
#
# Uses the SAME compose files production uses
# (deploy/compose/prod/docker-compose.*.yml), layered with
# deploy/compose/overrides/local.*.yml and .env.local. There is no separate dev
# compose tree, because a forked tree is how "works on my machine" starts.
#
# This script never touches the VPS. It talks only to the local Docker daemon.
#
# Usage: local.sh {up|down|reset|status|health|logs|urls|help}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT" || exit 1

COMPOSE_DIR="deploy/compose/prod"
OVERRIDE_DIR="deploy/compose/overrides"
ENV_FILE="$PROJECT_ROOT/.env.local"
ENV_EXAMPLE="$PROJECT_ROOT/.env.local.example"

# Distinct from the production project names (hill90-prod-*) so the two can
# never be confused in `docker compose ls`.
EDGE_PROJECT="hill90-local-edge"
OBS_PROJECT="hill90-local-observability"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'

info()    { echo "${BLUE}==>${NC} $*"; }
success() { echo "${GREEN}✓${NC} $*"; }
warn()    { echo "${YELLOW}!${NC} $*" >&2; }
die()     { echo "${RED}✗${NC} $*" >&2; exit 1; }

usage() {
    cat <<EOF
Local development CLI — Hill90 infrastructure on Docker Desktop

Usage: local.sh <command>

Commands:
  up        Bring up the edge and observability stacks
  down      Stop and remove containers and networks; volumes are KEPT
  reset     down, then DELETE the local volumes (destructive, prompts first)
  status    Show container status
  health    Probe every routed surface over HTTP
  logs      Follow logs (optionally: logs <container>)
  urls      Print the local URLs
  help      Show this help

Configuration lives in .env.local (copy from .env.local.example).
Compose files are the same ones production uses, plus $OVERRIDE_DIR/local.*.yml.
EOF
}

require_docker() {
    docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and retry."
}

require_env() {
    if [ ! -f "$ENV_FILE" ]; then
        info "No .env.local found — creating it from .env.local.example"
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        success "Created $ENV_FILE"
    fi
}

# Both stacks, base + local override, with .env.local supplying the values.
compose_edge() {
    docker compose --env-file "$ENV_FILE" -p "$EDGE_PROJECT" \
        -f "$COMPOSE_DIR/docker-compose.infra.yml" \
        -f "$OVERRIDE_DIR/local.infra.yml" "$@"
}

compose_obs() {
    docker compose --env-file "$ENV_FILE" -p "$OBS_PROJECT" \
        -f "$COMPOSE_DIR/docker-compose.observability.yml" \
        -f "$OVERRIDE_DIR/local.observability.yml" "$@"
}

# Read a value out of .env.local without sourcing it.
env_get() {
    local key="$1" default="${2:-}"
    local value
    value=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2-)
    echo "${value:-$default}"
}

base_domain() { env_get BASE_DOMAIN localtest.me; }

# Published HTTP port. Appended to every local URL because a Mac rarely has :80
# free — see HTTP_PORT in .env.local.
http_port() { env_get HTTP_PORT 8080; }
base_url()  { echo "http://$1.$(base_domain):$(http_port)"; }

cmd_up() {
    require_docker
    require_env

    local domain; domain=$(base_domain)

    echo "================================"
    echo "Hill90 local bring-up"
    echo "================================"
    echo "Domain:  ${domain}"
    echo "Compose: ${COMPOSE_DIR}/*.yml + ${OVERRIDE_DIR}/local.*.yml"
    echo ""

    # The edge stack owns the networks; it must come up first, exactly as in
    # production.
    # --force-recreate matches what scripts/deploy.sh cmd_infra does in
    # production, and is required here for a second reason: Traefik's STATIC
    # config is a bind mount that Traefik reads once at startup and never
    # watches. Without a recreate, editing traefik.local.yml appears to do
    # nothing.
    info "Building and starting the edge stack (traefik, dns-manager, portainer)..."
    compose_edge up -d --build --force-recreate || die "Edge stack failed to start"

    # The edge compose declares hill90_internal and hill90_agent_internal but no
    # edge service attaches to them, so compose never creates them. Production
    # has the same gap and scripts/deploy.sh cmd_infra creates them explicitly
    # after the edge stack; do exactly the same here rather than diverging.
    local netpfx; netpfx=$(env_get NETWORK_PREFIX hill90)
    for net in internal agent_internal; do
        if ! docker network inspect "${netpfx}_${net}" >/dev/null 2>&1; then
            docker network create --driver bridge --internal "${netpfx}_${net}" >/dev/null
            success "Created ${netpfx}_${net}"
        fi
    done

    info "Starting the observability stack (prometheus, grafana, loki, tempo, collectors)..."
    compose_obs up -d || die "Observability stack failed to start"

    echo ""
    info "Waiting for containers to become healthy..."
    # Two separate queries: passing two --filter label=... to docker ps ANDs
    # them, so a single combined query matches nothing and this loop would
    # return instantly without waiting for anything.
    local waited=0 starting
    while [ "$waited" -lt 120 ]; do
        starting=$(
            { docker ps --filter "label=com.docker.compose.project=${EDGE_PROJECT}" --format '{{.Status}}'
              docker ps --filter "label=com.docker.compose.project=${OBS_PROJECT}"  --format '{{.Status}}'
            } 2>/dev/null | grep -c "health: starting" || true
        )
        [ "$starting" -eq 0 ] && break
        sleep 3
        waited=$((waited + 3))
    done

    # Container health says the process is up; it does not say Traefik has
    # discovered the router or that Grafana has finished installing plugins.
    # Poll the thing we actually promise works.
    info "Waiting for routed surfaces to answer..."
    local grafana_url; grafana_url="$(base_url "$(env_get GRAFANA_HOST grafana)")/login"
    waited=0
    while [ "$waited" -lt 120 ]; do
        [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$grafana_url" 2>/dev/null)" = "200" ] && break
        sleep 3
        waited=$((waited + 3))
    done

    echo ""
    cmd_status
    echo ""
    cmd_urls
    echo ""
    success "Local stack is up. Run 'bash scripts/local.sh health' to verify."
}

cmd_down() {
    require_docker
    require_env
    info "Stopping the observability stack..."
    compose_obs down --remove-orphans 2>/dev/null || true
    info "Stopping the edge stack..."
    compose_edge down --remove-orphans 2>/dev/null || true

    # Created by hand in cmd_up, so removed by hand here.
    local netpfx; netpfx=$(env_get NETWORK_PREFIX hill90)
    for net in internal agent_internal; do
        docker network rm "${netpfx}_${net}" >/dev/null 2>&1 && info "Removed ${netpfx}_${net}" || true
    done

    success "Local stack is down. Volumes were kept — use 'reset' to delete them."
}

cmd_reset() {
    require_docker
    require_env

    echo "${BOLD}This deletes local Docker volumes:${NC}"
    echo "  $(env_get VOLUME_PREFIX hill90local)_traefik-certs, ..._portainer-data,"
    echo "  $(env_get VOLUME_PREFIX_BARE hill90local-){prometheus,loki,tempo,grafana}-data"
    echo ""
    echo "Local data only — this cannot touch the VPS. Grafana dashboards are"
    echo "provisioned from disk and will come back; anything you created by hand"
    echo "in the Grafana UI will not."
    echo ""

    if [ "${FORCE:-}" != "true" ]; then
        read -r -p "Type 'reset' to confirm: " reply
        [ "$reply" = "reset" ] || die "Aborted."
    fi

    info "Tearing down with volumes..."
    compose_obs down -v --remove-orphans 2>/dev/null || true
    compose_edge down -v --remove-orphans 2>/dev/null || true
    success "Local stack reset. Run 'bash scripts/local.sh up' to rebuild from the repo."
}

cmd_status() {
    require_docker
    echo "${BOLD}Containers${NC}"
    docker ps -a \
        --filter "label=com.docker.compose.project=${EDGE_PROJECT}" \
        --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null
    docker ps -a \
        --filter "label=com.docker.compose.project=${OBS_PROJECT}" \
        --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null | tail -n +2
}

cmd_urls() {
    require_env
    echo "${BOLD}Local URLs${NC}  (all resolve to 127.0.0.1 via the public localtest.me zone)"
    echo "  Traefik dashboard   $(base_url "$(env_get TRAEFIK_HOST traefik)")/dashboard/"
    echo "  Portainer           $(base_url "$(env_get PORTAINER_HOST portainer)")/"
    echo "  Grafana             $(base_url "$(env_get GRAFANA_HOST grafana)")/"
}

cmd_health() {
    require_docker
    require_env
    local failed=0

    echo "${BOLD}Routed surfaces${NC}"
    check_http "Traefik dashboard" "$(base_url "$(env_get TRAEFIK_HOST traefik)")/dashboard/" 200 || failed=1
    check_http "Portainer"         "$(base_url "$(env_get PORTAINER_HOST portainer)")/"        200 || failed=1
    check_http "Grafana"           "$(base_url "$(env_get GRAFANA_HOST grafana)")/login"       200 || failed=1

    echo ""
    echo "${BOLD}Observability internals${NC}"
    local cp; cp=$(env_get CONTAINER_PREFIX "")
    check_exec "Prometheus ready"  "${cp}prometheus" wget -qO- http://localhost:9090/-/ready || failed=1
    check_exec "Loki ready"        "${cp}loki"       wget -qO- http://localhost:3100/ready   || failed=1
    check_exec "Grafana health"    "${cp}grafana"    wget -qO- http://localhost:3000/api/health || failed=1

    echo ""
    if [ "$failed" -eq 0 ]; then
        success "All local checks passed."
    else
        warn "Some checks failed. 'bash scripts/local.sh logs' for detail."
        return 1
    fi
}

check_http() {
    local name="$1" url="$2" expect="$3" code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)
    if [ "$code" = "$expect" ]; then
        echo "  ${GREEN}✓${NC} ${name} — HTTP ${code}"
    else
        echo "  ${RED}✗${NC} ${name} — HTTP ${code} (expected ${expect}) ${url}"
        return 1
    fi
}

check_exec() {
    local name="$1"; shift
    local container="$1"; shift
    if docker exec "$container" "$@" >/dev/null 2>&1; then
        echo "  ${GREEN}✓${NC} ${name}"
    else
        echo "  ${RED}✗${NC} ${name}"
        return 1
    fi
}

cmd_logs() {
    require_docker
    require_env
    if [ $# -gt 0 ]; then
        docker logs -f "$1"
    else
        compose_edge logs -f --tail 50 &
        compose_obs logs -f --tail 50 &
        wait
    fi
}

main() {
    local cmd="${1:-help}"
    shift || true
    case "$cmd" in
        up)             cmd_up "$@" ;;
        down)           cmd_down "$@" ;;
        reset)          cmd_reset "$@" ;;
        status)         cmd_status "$@" ;;
        health)         cmd_health "$@" ;;
        logs)           cmd_logs "$@" ;;
        urls)           cmd_urls "$@" ;;
        help|--help|-h) usage ;;
        *)              echo "Unknown command: $cmd" >&2; usage; exit 1 ;;
    esac
}

main "$@"
