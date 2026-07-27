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
VAULT_PROJECT="hill90-local-platform"
DB_PROJECT="hill90-local-db"
AUTH_PROJECT="hill90-local-identity"
MINIO_PROJECT="hill90-local-storage"

# Vault state lives beside the repo, not in /opt/hill90 as it does on the VPS.
# vault.sh takes both paths from the environment, so nothing in it needs to know
# it is running locally.
LOCAL_VAULT_DIR="$PROJECT_ROOT/.local-vault"

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
  vault     Run a vault.sh subcommand against the LOCAL vault
  sso       Configure Keycloak SSO for Grafana, Portainer and OpenBao
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

    # The header of this script promises it never touches the VPS. Compose
    # operations are safe by construction (every project is hill90-local-*), but
    # cmd_up also runs raw `docker exec "${CONTAINER_PREFIX}keycloak"` to relax
    # sslRequired and add local OIDC callbacks. CONTAINER_PREFIX defaults to
    # EMPTY, and the production container is named exactly `keycloak` — so on a
    # host that has both, an empty prefix would point those two security-relevant
    # mutations at production. Refuse instead.
    local prefix; prefix=$(env_get CONTAINER_PREFIX "")
    if [ -z "$prefix" ]; then
        die "CONTAINER_PREFIX is empty in ${ENV_FILE}. Local containers must be
  prefixed (the example uses 'hill90dev-'), because an empty prefix makes
  local commands address production container names directly."
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

compose_db() {
    docker compose --env-file "$ENV_FILE" -p "$DB_PROJECT" \
        -f "$COMPOSE_DIR/docker-compose.db.yml" \
        -f "$OVERRIDE_DIR/local.db.yml" "$@"
}

compose_auth() {
    docker compose --env-file "$ENV_FILE" -p "$AUTH_PROJECT" \
        -f "$COMPOSE_DIR/docker-compose.auth.yml" \
        -f "$OVERRIDE_DIR/local.auth.yml" "$@"
}

compose_minio() {
    docker compose --env-file "$ENV_FILE" -p "$MINIO_PROJECT" \
        -f "$COMPOSE_DIR/docker-compose.minio.yml" \
        -f "$OVERRIDE_DIR/local.minio.yml" "$@"
}

compose_vault() {
    docker compose --env-file "$ENV_FILE" -p "$VAULT_PROJECT" \
        -f "$COMPOSE_DIR/docker-compose.vault.yml" \
        -f "$OVERRIDE_DIR/local.vault.yml" "$@"
}

# Run the SSO configuration scripts against the LOCAL stack. Same scripts the
# VPS runs; only the container names and public URLs differ, exactly as
# cmd_vault does for vault.sh.
cmd_sso() {
    require_docker
    require_env
    local cp; cp=$(env_get CONTAINER_PREFIX "")
    local kc_url; kc_url=$(base_url "$(env_get AUTH_HOST auth)")

    info "Configuring Keycloak realm clients..."
    # Point the secret lookup at LOCAL state. Without this, any value missing
    # from .env.local falls back to infra/secrets/prod.enc.env — so on a machine
    # holding the prod age key, a local run would decrypt production secrets and
    # write them into the throwaway local realm. cmd_vault already does this.
    KC_SECRETS_FILE="$LOCAL_VAULT_DIR/local.enc.env" \
    SOPS_AGE_KEY_FILE="$LOCAL_VAULT_DIR/age.key" \
    KC_CONTAINER="${cp}keycloak" \
    KC_REALM="$(env_get KC_REALM platform)" \
    KC_ADMIN_USERNAME="$(env_get KC_ADMIN_USERNAME admin)" \
    KC_ADMIN_PASSWORD="$(env_get KC_ADMIN_PASSWORD admin)" \
    KC_PUBLIC_URL="$kc_url" \
    GRAFANA_PUBLIC_URL="$(base_url "$(env_get GRAFANA_HOST grafana)")" \
    PORTAINER_PUBLIC_URL="$(base_url "$(env_get PORTAINER_HOST portainer)")" \
    VAULT_PUBLIC_URL="$(base_url "$(env_get VAULT_HOST vault)")" \
    MINIO_PUBLIC_URL="$(base_url "$(env_get MINIO_HOST storage)")" \
    MINIO_OIDC_CLAIM_NAME="$(env_get MINIO_OIDC_CLAIM_NAME minio_policy)" \
    GRAFANA_OIDC_CLIENT_SECRET="$(env_get GRAFANA_OIDC_CLIENT_SECRET "")" \
    PORTAINER_OIDC_CLIENT_SECRET="$(env_get PORTAINER_OIDC_CLIENT_SECRET "")" \
    VAULT_OIDC_CLIENT_SECRET="$(env_get VAULT_OIDC_CLIENT_SECRET "")" \
    MINIO_OIDC_CLIENT_SECRET="$(env_get MINIO_OIDC_CLIENT_SECRET "")" \
        bash "$SCRIPT_DIR/keycloak.sh" apply || die "keycloak.sh apply failed"

    echo ""
    info "Configuring Portainer OAuth..."
    PORTAINER_SECRETS_FILE="$LOCAL_VAULT_DIR/local.enc.env" \
    SOPS_AGE_KEY_FILE="$LOCAL_VAULT_DIR/age.key" \
    PORTAINER_CONTAINER="${cp}portainer" \
    PORTAINER_INTERNAL_URL="$(base_url "$(env_get PORTAINER_HOST portainer)")" \
    PORTAINER_PUBLIC_URL="$(base_url "$(env_get PORTAINER_HOST portainer)")" \
    PORTAINER_ADMIN_USERNAME="$(env_get PORTAINER_ADMIN_USERNAME admin)" \
    PORTAINER_ADMIN_PASSWORD="$(env_get PORTAINER_ADMIN_PASSWORD "")" \
    PORTAINER_OIDC_CLIENT_SECRET="$(env_get PORTAINER_OIDC_CLIENT_SECRET "")" \
    KC_PUBLIC_URL="$kc_url" \
    KC_REALM="$(env_get KC_REALM platform)" \
        bash "$SCRIPT_DIR/portainer.sh" apply \
        || warn "portainer.sh apply failed — is the Portainer admin initialised? See docs/runbooks/sso-fallback.md"

    echo ""
    info "Provisioning MinIO policies for Keycloak roles..."
    MINIO_CONTAINER="${cp}minio" \
    MINIO_SECRETS_FILE="$LOCAL_VAULT_DIR/local.enc.env" \
    SOPS_AGE_KEY_FILE="$LOCAL_VAULT_DIR/age.key" \
    MINIO_ROOT_USER="$(env_get MINIO_ROOT_USER "")" \
    MINIO_ROOT_PASSWORD="$(env_get MINIO_ROOT_PASSWORD "")" \
        bash "$SCRIPT_DIR/minio.sh" apply \
        || warn "minio.sh apply failed — federated S3 access will be rejected with 'no policy found'"
}

# Run a vault.sh subcommand against the LOCAL vault. Every variable here is an
# override vault.sh already supports, so the script executed is byte-identical
# to the one that runs on the VPS — which is what makes this a rehearsal rather
# than a simulation.
cmd_vault() {
    [ $# -gt 0 ] || die "Usage: local.sh vault <init|unseal|status|setup|seed|setup-sync-token|revoke-root|auto-unseal|...>"
    require_docker
    require_env
    mkdir -p "$LOCAL_VAULT_DIR"
    local cp; cp=$(env_get CONTAINER_PREFIX "")
    VAULT_CONTAINER="${cp}openbao" \
    VAULT_UNSEAL_KEY_PATH="$LOCAL_VAULT_DIR/openbao-unseal.key" \
    VAULT_ROOT_TOKEN_PATH="$LOCAL_VAULT_DIR/openbao-root.token" \
    VAULT_SECRETS_FILE="$LOCAL_VAULT_DIR/local.enc.env" \
    SOPS_AGE_KEY_FILE="$LOCAL_VAULT_DIR/age.key" \
    BAO_TOKEN="${BAO_TOKEN:-$(cat "$LOCAL_VAULT_DIR/openbao-root.token" 2>/dev/null || true)}" \
        bash "$SCRIPT_DIR/vault.sh" "$@"
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
    info "Building and starting the edge stack (traefik, portainer)..."
    compose_edge up -d --build --force-recreate || die "Edge stack failed to start"

    # Refuse to share networks with an unrelated project.
    #
    # Two shapes matter and the compose-project label only catches one. A
    # network created by hand — which is how internal and agent_internal are
    # made, here and in production — carries no project label at all, and
    # another stack can quietly join a network we created. Both were observed
    # on the reference machine: a separate Hill90 app stack attached to
    # hill90dev_edge, hill90dev_internal and hill90dev_agent_internal.
    #
    # So check what is actually attached, not just who nominally owns it. Any
    # container that is not ours means the network is shared, and a teardown
    # here would disrupt something else.
    local netpfx_pre; netpfx_pre=$(env_get NETWORK_PREFIX hill90dev)
    local cprefix; cprefix=$(env_get CONTAINER_PREFIX "")
    for net in edge internal agent_internal; do
        local owner foreign
        owner=$(docker network inspect "${netpfx_pre}_${net}" \
                --format '{{index .Labels "com.docker.compose.project"}}' 2>/dev/null || true)
        if [ -n "$owner" ] && [ "$owner" != "$EDGE_PROJECT" ] && [ "$owner" != "$OBS_PROJECT" ]; then
            die "Network ${netpfx_pre}_${net} already exists and belongs to compose project '${owner}'.
    Change NETWORK_PREFIX in .env.local to something unused, then retry."
        fi
        foreign=$(docker network inspect "${netpfx_pre}_${net}" \
                  --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null \
                  | tr ' ' '\n' | grep -v '^$' | grep -v "^${cprefix}" || true)
        if [ -n "$foreign" ]; then
            die "Network ${netpfx_pre}_${net} is shared with containers that are not ours:
    $(echo "$foreign" | tr '\n' ' ')
    Sharing it means a teardown here would disrupt them. Change NETWORK_PREFIX
    in .env.local to something unused, then retry."
        fi
    done

    # The edge compose declares hill90_internal and hill90_agent_internal but no
    # edge service attaches to them, so compose never creates them. Production
    # has the same gap and scripts/deploy.sh cmd_infra creates them explicitly
    # after the edge stack; do exactly the same here rather than diverging.
    local netpfx; netpfx=$(env_get NETWORK_PREFIX hill90dev)
    for net in internal agent_internal; do
        if ! docker network inspect "${netpfx}_${net}" >/dev/null 2>&1; then
            docker network create --driver bridge --internal "${netpfx}_${net}" >/dev/null
            success "Created ${netpfx}_${net}"
        fi
    done

    info "Starting the observability stack (prometheus, grafana, loki, tempo, collectors)..."
    compose_obs up -d || die "Observability stack failed to start"

    info "Starting the platform database (postgres)..."
    compose_db up -d || die "Database stack failed to start"

    # Keycloak stores realms in Postgres; wait rather than crash-loop.
    local waited=0
    until docker exec "$(env_get CONTAINER_PREFIX '')postgres" pg_isready -U "$(env_get DB_USER hill90)" >/dev/null 2>&1; do
        [ "$waited" -ge 60 ] && die "postgres did not become ready"
        sleep 3; waited=$((waited + 3))
    done

    info "Starting the identity provider (keycloak)..."
    compose_auth up -d || die "Auth stack failed to start"

    # Keycloak imports the realm and runs migrations on first boot, which takes
    # appreciably longer than the container being "started". Everything below
    # talks to its admin API, so wait for the container's own healthcheck.
    local cpfx; cpfx=$(env_get CONTAINER_PREFIX "")
    waited=0
    until [ "$(docker inspect "${cpfx}keycloak" --format '{{.State.Health.Status}}' 2>/dev/null)" = "healthy" ]; do
        [ "$waited" -ge 180 ] && die "keycloak did not become healthy within 180s"
        sleep 5; waited=$((waited + 5))
    done

    # The platform realm ships with sslRequired=external. That is correct for
    # production and it is why plain HTTP locally returns
    # 403 {"error":"invalid_request","error_description":"HTTPS required"}.
    # Relax it on the RUNNING realm only — platform-realm.json is untouched, so
    # production still gets external. This is the same shape as the other local
    # accommodations: production values are the defaults, local adds deltas.
    if docker exec "${cpfx}keycloak" sh -c \
        "/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080 \
           --realm master --user \"$(env_get KC_ADMIN_USERNAME admin)\" --password \"$(env_get KC_ADMIN_PASSWORD admin)\" && \
         /opt/keycloak/bin/kcadm.sh update realms/platform -s sslRequired=NONE" >/dev/null 2>&1; then
        success "Relaxed sslRequired on the local platform realm"
    else
        warn "Could not relax sslRequired on the platform realm — http://auth.$(base_domain):$(http_port)/realms/platform will return 403 until it is set to NONE"
    fi

    # Same shape, second delta: hill90-vault ships production redirect URIs, so
    # a local OIDC login is rejected with "Invalid parameter: redirect_uri".
    # Append the local callbacks to the RUNNING client, keeping the production
    # ones — platform-realm.json is again untouched.
    local vault_local; vault_local="$(base_url "$(env_get VAULT_HOST vault)")"
    local uris_json
    uris_json=$(python3 -c '
import json, sys
base = sys.argv[1].rstrip("/")
print(json.dumps([
    "https://vault.hill90.com/ui/vault/auth/oidc/oidc/callback",
    "https://vault.hill90.com/v1/auth/oidc/callback",
    base + "/ui/vault/auth/oidc/oidc/callback",
    base + "/v1/auth/oidc/callback",
]))' "$vault_local")
    local vault_cid
    vault_cid=$(docker exec "${cpfx}keycloak" /opt/keycloak/bin/kcadm.sh get clients \
        -r "${KC_PLATFORM_REALM:-platform}" -q clientId=hill90-vault --fields id \
        --format csv --noquotes 2>/dev/null | tr -d '\r')
    if [ -n "$vault_cid" ] && docker exec "${cpfx}keycloak" /opt/keycloak/bin/kcadm.sh update \
        "clients/${vault_cid}" -r "${KC_PLATFORM_REALM:-platform}" \
        -s "redirectUris=${uris_json}" >/dev/null 2>&1; then
        success "Added local OIDC callbacks to the hill90-vault client"
    else
        warn "Could not add local OIDC callbacks to hill90-vault — 'local.sh vault setup-oidc' logins will fail with 'Invalid parameter: redirect_uri'"
    fi

    info "Starting the object store (minio)..."
    compose_minio up -d || die "Object store failed to start"

    info "Starting the vault stack (openbao)..."
    compose_vault up -d || die "Vault stack failed to start"

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

    # Container health says the process is up. It does not say Traefik has
    # discovered the router, and Traefik discovers routers asynchronously from
    # container start. Poll every routed surface, not just one — waiting on
    # Grafana alone once let `up` return while Prometheus was still 404ing,
    # which looks exactly like a broken config to whoever runs it next.
    info "Waiting for routed surfaces to answer..."
    local waited=0 pending
    while [ "$waited" -lt 120 ]; do
        pending=0
        for probe in \
            "$(base_url "$(env_get TRAEFIK_HOST traefik)")/dashboard/" \
            "$(base_url "$(env_get PORTAINER_HOST portainer)")/" \
            "$(base_url "$(env_get GRAFANA_HOST grafana)")/login" \
            "$(base_url "$(env_get PROMETHEUS_HOST prometheus)")/graph"
        do
            [ "$(curl -sL -o /dev/null -w '%{http_code}' --max-time 5 "$probe" 2>/dev/null)" = "200" ] || pending=1
        done
        [ "$pending" -eq 0 ] && break
        sleep 3
        waited=$((waited + 3))
    done
    [ "$waited" -ge 120 ] && warn "Some routed surfaces did not answer within 120s — run 'local.sh health'"

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
    info "Stopping the object store..."
    compose_minio down --remove-orphans 2>/dev/null || true
    info "Stopping the vault stack..."
    compose_vault down --remove-orphans 2>/dev/null || true
    info "Stopping the identity provider..."
    compose_auth down --remove-orphans 2>/dev/null || true
    info "Stopping the platform database..."
    compose_db down --remove-orphans 2>/dev/null || true
    info "Stopping the observability stack..."
    compose_obs down --remove-orphans 2>/dev/null || true
    info "Stopping the edge stack..."
    compose_edge down --remove-orphans 2>/dev/null || true

    # Created by hand in cmd_up, so removed by hand here — but only when empty.
    # Docker refuses to remove an in-use network, and swallowing that error made
    # it look deliberate; be explicit instead so a shared network is reported
    # rather than silently left behind.
    local netpfx; netpfx=$(env_get NETWORK_PREFIX hill90dev)
    for net in internal agent_internal; do
        local attached
        attached=$(docker network inspect "${netpfx}_${net}" --format '{{len .Containers}}' 2>/dev/null || echo "")
        if [ -z "$attached" ]; then
            continue
        elif [ "$attached" = "0" ]; then
            docker network rm "${netpfx}_${net}" >/dev/null 2>&1 && info "Removed ${netpfx}_${net}"
        else
            warn "Left ${netpfx}_${net} in place — ${attached} container(s) from another project are attached"
        fi
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
    compose_minio down -v --remove-orphans 2>/dev/null || true
    compose_vault down -v --remove-orphans 2>/dev/null || true
    compose_auth down -v --remove-orphans 2>/dev/null || true
    compose_db down -v --remove-orphans 2>/dev/null || true
    rm -rf "$LOCAL_VAULT_DIR"
    compose_obs down -v --remove-orphans 2>/dev/null || true
    compose_edge down -v --remove-orphans 2>/dev/null || true
    success "Local stack reset. Run 'bash scripts/local.sh up' to rebuild from the repo."
}

# ---------------------------------------------------------------------------
# Env drift
# ---------------------------------------------------------------------------
#
# .env.local is gitignored, so it does not move when .env.local.example gains a
# variable. Compose substitutes an unset variable with an empty string rather
# than failing, so the stack comes up looking fine with auth, the database or
# SSO silently unconfigured. This check exists because that happened: a
# .env.local drifted twenty variables behind the example with no signal at all.
#
# Reports only. It never edits .env.local.
check_env_drift() {
    local example="${PROJECT_ROOT}/.env.local.example"
    local envfile="${PROJECT_ROOT}/.env.local"

    [ -f "$example" ] || return 0
    if [ ! -f "$envfile" ]; then
        echo "${YELLOW}!${NC} .env.local does not exist — copy it from .env.local.example"
        return 0
    fi

    local missing
    missing=$(comm -23 \
        <(grep -oE '^[A-Z_]+' "$example" | sort -u) \
        <(grep -oE '^[A-Z_]+' "$envfile" | sort -u))

    if [ -n "$missing" ]; then
        local count
        count=$(echo "$missing" | wc -l | tr -d ' ')
        echo "${YELLOW}!${NC} .env.local is missing ${count} variable(s) present in .env.local.example:"
        echo "$missing" | sed 's/^/    /'
        echo "  Compose substitutes these as empty strings rather than failing, so the"
        echo "  stack may start with those features silently unconfigured."
    else
        echo "${GREEN}✓${NC} .env.local carries every variable in .env.local.example"
    fi

    # Structural variables: differing from the example is meaningful, not neutral.
    #
    # These name the containers, networks and volumes the stack creates. Changing
    # them is a supported, deliberate act -- it is how you run two stacks side by
    # side, and docs/runbooks/local-development.md tells you to do exactly that
    # when a network turns out to be shared. What is NOT safe is changing them
    # while a stack is already running under the old prefix.
    # Compose keys containers on container_name, so `up` with a different prefix
    # orphans whatever is already running and builds a duplicate set beside it,
    # which then collides on the published ports.
    #
    # Observed: a .env.local carrying hill90local- while every running container,
    # network and volume used hill90dev-.
    local structural="CONTAINER_PREFIX NETWORK_PREFIX VOLUME_PREFIX VOLUME_PREFIX_BARE"
    local mismatched=""
    local key exval myval
    for key in $structural; do
        exval=$(grep -E "^${key}=" "$example" 2>/dev/null | head -1 | cut -d= -f2-)
        myval=$(grep -E "^${key}=" "$envfile" 2>/dev/null | head -1 | cut -d= -f2-)
        [ -z "$exval" ] && continue
        [ -z "$myval" ] && continue
        if [ "$exval" != "$myval" ]; then
            mismatched="${mismatched}    ${key}: yours=${myval}  example=${exval}\n"
        fi
    done

    if [ -n "$mismatched" ]; then
        echo "${YELLOW}!${NC} .env.local uses non-default values for structural variables:"
        printf "%b" "$mismatched"
        echo "  These name the containers, networks and volumes this stack creates."
        echo "  Deliberate? Fine -- that is how you run two stacks side by side. But bring"
        echo "  the other one down first: compose keys containers on container_name, so 'up'"
        echo "  under a new prefix orphans whatever is running and builds a duplicate beside"
        echo "  it, which then collides on the published ports."
        echo "  Unintentional? Align them with .env.local.example before running 'up'."
    else
        echo "${GREEN}✓${NC} structural prefixes match the example"
    fi
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
    docker ps -a \
        --filter "label=com.docker.compose.project=${VAULT_PROJECT}" \
        --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null | tail -n +2
    docker ps -a \
        --filter "label=com.docker.compose.project=${AUTH_PROJECT}" \
        --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null | tail -n +2
    docker ps -a \
        --filter "label=com.docker.compose.project=${DB_PROJECT}" \
        --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null | tail -n +2
    docker ps -a \
        --filter "label=com.docker.compose.project=${MINIO_PROJECT}" \
        --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null | tail -n +2
    echo
    echo "${BOLD}Environment${NC}"
    check_env_drift
}

cmd_urls() {
    require_env
    echo "${BOLD}Local URLs${NC}  (all resolve to 127.0.0.1 via the public localtest.me zone)"
    echo "  Traefik dashboard   $(base_url "$(env_get TRAEFIK_HOST traefik)")/dashboard/"
    echo "  Portainer           $(base_url "$(env_get PORTAINER_HOST portainer)")/"
    echo "  Grafana             $(base_url "$(env_get GRAFANA_HOST grafana)")/"
    echo "  Prometheus          $(base_url "$(env_get PROMETHEUS_HOST prometheus)")/  (local only; prod reaches it via Grafana)"
    echo "  OpenBao             $(base_url "$(env_get VAULT_HOST vault)")/  (uninitialized until: local.sh vault init)"
    echo "  Keycloak            $(base_url "$(env_get AUTH_HOST auth)")/  (platform realm; admin/admin)"
    echo "  MinIO console       $(base_url "$(env_get MINIO_HOST storage)")/  (ROOT CREDENTIALS ONLY — no SSO in the AGPL build)"
}

cmd_health() {
    require_docker
    require_env
    local failed=0

    echo "${BOLD}Routed surfaces${NC}"
    check_http "Traefik dashboard" "$(base_url "$(env_get TRAEFIK_HOST traefik)")/dashboard/" 200 || failed=1
    check_http "Portainer"         "$(base_url "$(env_get PORTAINER_HOST portainer)")/"        200 || failed=1
    check_http "Grafana"           "$(base_url "$(env_get GRAFANA_HOST grafana)")/login"       200 || failed=1
    check_http "Prometheus"        "$(base_url "$(env_get PROMETHEUS_HOST prometheus)")/graph"  200 || failed=1

    echo ""
    echo "${BOLD}Observability internals${NC}"
    local cp; cp=$(env_get CONTAINER_PREFIX "")
    check_exec "Prometheus ready"  "${cp}prometheus" wget -qO- http://localhost:9090/-/ready || failed=1
    check_exec "Loki ready"        "${cp}loki"       wget -qO- http://localhost:3100/ready   || failed=1
    check_exec "Grafana health"    "${cp}grafana"    wget -qO- http://localhost:3000/api/health || failed=1

    # The vault answers /v1/sys/health with 501 when uninitialized and 503 when
    # sealed, so "is the process up" is the honest check here; seal state is
    # reported separately because both are legitimate local states.
    if docker inspect "${cp}openbao" >/dev/null 2>&1; then
        check_exec "OpenBao responding" "${cp}openbao" sh -c 'wget -qO- --spider http://127.0.0.1:8200/v1/sys/seal-status' || failed=1
        # `bao status` exits 2 when sealed and 2 when uninitialized — both are
        # normal here. Under `set -o pipefail` that non-zero status fails the
        # whole pipeline even though the JSON parsed fine, so the `|| echo`
        # fallback fired *as well* and put two lines in one variable. Run the
        # capture in a subshell with pipefail off so only the parse decides.
        local seal
        seal=$(set +o pipefail
               docker exec -e BAO_ADDR=http://127.0.0.1:8200 "${cp}openbao" bao status -format=json 2>/dev/null \
               | python3 -c 'import sys,json;d=json.load(sys.stdin);print("uninitialized" if not d["initialized"] else ("sealed" if d["sealed"] else "unsealed"))' 2>/dev/null)
        echo "  ${BLUE}i${NC} OpenBao state — ${seal:-unknown}"
    fi

    echo ""
    echo "${BOLD}Platform services${NC}"
    # Postgres is a platform primitive, not an app dependency — it exists here
    # to back Keycloak. See docs/decisions/platform-primitives.md.
    check_exec "Postgres accepting connections" "${cp}postgres" \
        pg_isready -U "$(env_get DB_USER hill90)" || failed=1

    # Guard the reason Postgres was deleted in #495: if application databases
    # reappear here, Postgres has drifted back into being an app dependency.
    local appdbs
    # An ALLOWLIST, not a hill90_* prefix match: a database called `litellm` is
    # just as much an application database, and a denylist silently passes it.
    appdbs=$(docker exec "${cp}postgres" psql -U "$(env_get DB_USER hill90)" -tAc \
        "SELECT datname FROM pg_database
          WHERE datistemplate = false
            AND datname NOT IN ('postgres', 'keycloak', '$(env_get DB_USER hill90)')" \
        2>/dev/null | tr -d '\r' | tr '\n' ' ')
    if [ -n "${appdbs// /}" ]; then
        echo "  ${RED}✗${NC} Platform-only databases — found non-platform databases: ${appdbs}"
        failed=1
    else
        echo "  ${GREEN}✓${NC} Platform-only databases (only postgres, keycloak and the owner role's database)"
    fi

    # The realm must actually serve OIDC discovery over the local scheme; a
    # healthy container proves nothing if sslRequired still rejects plain HTTP.
    check_http "Keycloak platform realm (OIDC discovery)" \
        "$(base_url "$(env_get AUTH_HOST auth)")/realms/${KC_PLATFORM_REALM:-platform}/.well-known/openid-configuration" 200 || failed=1

    echo ""
    if [ "$failed" -eq 0 ]; then
        success "All local checks passed."
    else
        warn "Some checks failed. 'bash scripts/local.sh logs' for detail."
        return 1
    fi
}

check_http() {
    # -L because a browser follows redirects and so should this: Prometheus
    # sends /graph to /query, and Grafana sends / to /login. Asserting on the
    # first response would fail on a page that works fine.
    local name="$1" url="$2" expect="$3" code
    code=$(curl -sL -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)
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
        vault)          cmd_vault "$@" ;;
        sso)            cmd_sso "$@" ;;
        logs)           cmd_logs "$@" ;;
        urls)           cmd_urls "$@" ;;
        help|--help|-h) usage ;;
        *)              echo "Unknown command: $cmd" >&2; usage; exit 1 ;;
    esac
}

main "$@"
