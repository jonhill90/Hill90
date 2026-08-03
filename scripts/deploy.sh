#!/usr/bin/env bash
# Deploy CLI — deploy infrastructure stacks
# Usage: deploy.sh {infra|db|auth|minio|vault|observability|verify|backup} [env]

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
  minio    Deploy MinIO object store (platform storage)
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

    # Resolved BEFORE the retry loop, not inside it: the loop runs up to 30
    # times and this reads the encrypted store.
    #
    # It used to be `${DB_USER:-hill90}` interpolated inline. cmd_verify runs as
    # a bare `ssh ... deploy.sh verify db` with no secret environment, so DB_USER
    # was always empty and the literal fallback was always what ran. It passes
    # today only because that literal happens to equal the real POSTGRES_USER —
    # change DB_USER in the store without editing this file and the check would
    # query a role that does not exist, while looking like a Postgres fault.
    local db_user=""
    if [ "$service" = "db" ] || [ "$service" = "auth" ]; then
        db_user=$(secret_value DB_USER "$env" 2>/dev/null || true)
        if [ -z "$db_user" ]; then
            # Still proceed — a readiness check that refuses to run is worse than
            # one making a stated assumption — but say the assumption out loud.
            warn "DB_USER could not be resolved from the store; assuming 'hill90'. If the store disagrees, this check is querying the wrong role."
            db_user="hill90"
        fi
    fi

    case "$service" in
        # pg_isready exits 0 regardless of whether the role exists, so it would
        # pass on a Postgres whose credentials are entirely broken and leave
        # Keycloak to crash-loop instead. Run a real query as the real user.
        db)            check_cmd="docker exec postgres psql -U \"${db_user}\" -tAc 'SELECT 1'"; diag_container="postgres" ;;
        auth)          check_cmd='[ "$(docker inspect --format="{{if .State.Health}}{{.State.Health.Status}}{{end}}" keycloak 2>/dev/null)" = "healthy" ]'; diag_container="keycloak" ;;
        vault)         check_cmd='[ "$(docker inspect --format="{{if .State.Health}}{{.State.Health.Status}}{{end}}" openbao 2>/dev/null)" = "healthy" ]'; diag_container="openbao" ;;
        observability) check_cmd='docker exec prometheus wget -qO- http://localhost:9090/-/healthy'; diag_container="prometheus" ;;
        # Delegated to minio.sh, which resolves MINIO_ROOT_USER/PASSWORD itself
        # (environment first, then SOPS).
        #
        # This used to interpolate ${MINIO_ROOT_USER} directly. cmd_verify is
        # invoked by the workflow as a BARE `ssh ... bash scripts/deploy.sh
        # verify minio` with no `sops exec-env` wrapper, so those variables are
        # empty here — the check built "http://:@127.0.0.1:9000", MinIO answered
        # "Access Denied", and all 30 attempts failed against a perfectly
        # healthy server. Same root cause as the completion-banner bug fixed in
        # #595: a code path that needs secrets, running where the secrets are
        # not.
        #
        # It stayed invisible until #595 because the deploy step used to exit 1
        # before verify ever ran. Fixing that bug is what exposed this one.
        #
        # `minio.sh status` still proves the credentials rather than just
        # liveness — the original reason for preferring `mc admin info` over the
        # unauthenticated `mc ready` — and since #595 it waits for readiness
        # instead of asking once. The wait is kept short because THIS loop is
        # already the retry mechanism; a 90s inner wait inside a 30-attempt
        # outer loop would multiply into a very long silent failure.
        minio)         check_cmd='MINIO_READY_TIMEOUT=5 MINIO_READY_INTERVAL=1 bash "$SCRIPT_DIR/minio.sh" status'; diag_container="minio" ;;
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
        # `set -e` is essential and easy to lose. `sops exec-env` runs this
        # string in a NEW shell that does NOT inherit deploy.sh's `set -e`, and
        # exec-env returns 0 regardless of what the command did. Without it, a
        # failed render is swallowed and `docker compose up` runs anyway —
        # mounting a missing config, which Docker materialises as a DIRECTORY,
        # which stops Traefik and takes every routed service down while the
        # deploy reports success.
        sops exec-env "$secrets_file" '
            set -e

            echo "Generating Traefik basic auth credentials..."
            mkdir -p platform/edge/dynamic
            # An empty hash writes the line "admin:" over the live dashboard
            # credential — a lockout that looks like a successful deploy.
            # keycloak.sh refuses the same shape ("Refusing to write an empty
            # client secret"); this had no such guard.
            [ -n "${TRAEFIK_ADMIN_PASSWORD_HASH}" ] || {
                echo "Refusing to write an empty .htpasswd: TRAEFIK_ADMIN_PASSWORD_HASH resolved empty. Check the key exists in the secrets store." >&2
                exit 1
            }
            echo "admin:${TRAEFIK_ADMIN_PASSWORD_HASH}" > platform/edge/dynamic/.htpasswd
            echo "✓ Created .htpasswd for Traefik dashboard authentication"

            bash '"$SCRIPT_DIR"'/render-traefik-config.sh

            echo "Building and pulling images..."
            docker compose -p "hill90-'"$env"'-edge" -f '"$compose_file"' build --parallel
            docker compose -p "hill90-'"$env"'-edge" -f '"$compose_file"' pull --ignore-buildable

            echo "Deploying edge stack (traefik, portainer)..."
            bash '"$SCRIPT_DIR"'/preflight-edge.sh
            docker compose -p "hill90-'"$env"'-edge" -f '"$compose_file"' up -d --force-recreate
        '
    }

    if [ "$vault_ok" = true ]; then
        (
            # `|| exit 1` IS LOad-BEARING — do not reduce it to a bare call.
            #
            # `set -e` is SUPPRESSED inside a compound command on the left of
            # `||`, and this subshell is exactly that: `( ... ) || { fallback }`.
            # So a bare `vault_load_secrets` that returns non-zero does NOT stop
            # the subshell; it prints its warning and the deploy carries on with
            # no secrets loaded. Demonstrable in three lines:
            #
            #   set -e; f(){ return 1; }
            #   ( f; echo "still running" ) || echo "fallback"   -> still running
            #   ( f || exit 1; echo x )    || echo "fallback"    -> fallback
            #
            # This is the second half of the 2026-08-03 auth outage. The first
            # fix (#651) made vault_load_secrets return non-zero correctly, and
            # the deploy ignored it and shipped a container with every variable
            # blank. `exit` is not subject to the suppression; `return` is.
            vault_load_secrets "infra" "$secrets_file" || exit 1

            echo "Generating Traefik basic auth credentials..."
            mkdir -p platform/edge/dynamic
            # Same guard as the SOPS path: an empty hash locks the dashboard
            # while the deploy reports success.
            [ -n "${TRAEFIK_ADMIN_PASSWORD_HASH:-}" ] \
                || die "Refusing to write an empty .htpasswd: TRAEFIK_ADMIN_PASSWORD_HASH resolved empty from OpenBao. Check the key exists, or force the SOPS path."
            echo "admin:${TRAEFIK_ADMIN_PASSWORD_HASH}" > platform/edge/dynamic/.htpasswd
            echo "✓ Created .htpasswd for Traefik dashboard authentication"

            bash "$SCRIPT_DIR/render-traefik-config.sh"

            echo "Building and pulling images..."
            docker compose -p "hill90-${env}-edge" -f "$compose_file" build --parallel --no-cache
            docker compose -p "hill90-${env}-edge" -f "$compose_file" pull --ignore-buildable

            echo "Deploying edge stack (traefik, portainer)..."
            bash "$SCRIPT_DIR/preflight-edge.sh"
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

    # Apply Portainer's OAuth settings. Portainer keeps authentication in its own
    # database, so unlike Grafana this cannot be expressed in compose — without
    # this step nothing on the VPS ever configures Portainer SSO.
    #
    # Non-fatal on purpose: the edge stack must come up whatever happens here,
    # and Portainer keeps its local admin login regardless.
    echo "Applying Portainer SSO configuration..."
    sops exec-env "$secrets_file" 'bash scripts/portainer.sh apply' \
        || warn "portainer.sh apply failed — Portainer SSO may be unconfigured. The local admin login is unaffected; see docs/runbooks/sso-fallback.md"

    echo ""
    echo "================================"
    echo "Edge Stack Deployment Complete!"
    echo "================================"
    # By project label, not `docker compose ps` — #595 fixed this exact bug in
    # cmd_service and missed this second copy. The secrets live only inside the
    # sops/vault scopes above, both closed by now, and Compose interpolates for
    # `ps` as much as for `up`. docker-compose.infra.yml uses no `${VAR:?...}`
    # today so it would only warn, but that is luck, not design: the day this
    # file gains one required variable, the edge deploy starts exiting 1 after
    # printing "Complete!".
    docker ps -a \
        --filter "label=com.docker.compose.project=hill90-${env}-edge" \
        --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

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

    local compose_file banner containers summary stack stateful pre_up_hook
    pre_up_hook=""
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
        minio)
            compose_file="deploy/compose/${env}/docker-compose.minio.yml"
            containers="minio"
            banner="Object Store Deployment"
            stack="platform"
            stateful=true
            summary="Services deployed:
  - minio (object store; console on storage.hill90.com, S3 API internal only)

  Console login is ROOT CREDENTIALS ONLY. MinIO removed the management
  console from the AGPL build in May 2025, so there is no SSO button.
  Keycloak identities work on the S3/STS path — see
  docs/runbooks/object-store.md."
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
            containers="prometheus loki tempo grafana promtail node-exporter cadvisor alertmanager blackbox-exporter"
            banner="Observability Stack Deployment"
            stack="observability"
            stateful=true
            # Renders /opt/hill90/secrets/alertmanager.yml from the encrypted
            # store. MUST run before compose up: the file is bind-mounted, so
            # without it Docker creates a DIRECTORY at that path and Alertmanager
            # fails to start with a confusing config error.
            pre_up_hook="render-alertmanager-config.sh"
            summary="Services deployed:
  - grafana (dashboards at grafana.hill90.com, Tailscale-only)
  - prometheus (metrics at :9090)
  - loki (logs at :3100)
  - tempo (traces at :3200)
  - promtail (log collector)
  - node-exporter (host metrics)
  - cadvisor (container metrics)
  - alertmanager (:9093, NOT public — no Traefik labels by design)
  - blackbox-exporter (:9115, probes hill90.com and OpenBao health)"
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
    #
    # This guard runs BEFORE secrets are loaded (that happens further down), so
    # ${DB_USER} is empty here and the old inline `${DB_USER:-hill90}` fallback
    # was always what ran. A guard that refuses a deploy must not be built on an
    # unstated assumption: if the role name were ever changed in the store, this
    # would block every auth deploy with a message blaming Postgres.
    if [ "$service" = "auth" ]; then
        local guard_user
        guard_user=$(secret_value DB_USER "$env" 2>/dev/null || true)
        if [ -z "$guard_user" ]; then
            warn "DB_USER could not be resolved from the store; assuming 'hill90' for the pre-deploy database check."
            guard_user="hill90"
        fi
        if ! docker exec postgres psql -U "$guard_user" -tAc 'SELECT 1' >/dev/null 2>&1; then
            die "Cannot deploy auth: cannot query postgres as '${guard_user}'. Deploy it first: bash scripts/deploy.sh db ${env}"
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

    # Pre-deploy backup for stateful services.
    #
    # `auth` has no volume of its own: Keycloak keeps realms, clients and users in
    # the platform Postgres `keycloak` database. So `backup.sh backup auth` was
    # never a valid target and died with "Unknown service for backup: auth" —
    # warned, continued, and the pre-deploy safety net for the IDENTITY PROVIDER
    # silently did nothing. Observed on the 2026-08-03 outage deploy.
    #
    # Backing up `db` is what "back up auth before touching it" actually means.
    if [ "$stateful" = true ]; then
        local backup_target="$service"
        [ "$service" = "auth" ] && backup_target="db"
        if [ "$backup_target" != "$service" ]; then
            echo "Running pre-deploy backup for ${service} (its state lives in ${backup_target})..."
        else
            echo "Running pre-deploy backup for ${service}..."
        fi
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
                set -e
                if [ -n "'"$pre_up_hook"'" ]; then
                    # ALERT_EMAIL_TO falls back to ACME_EMAIL: both are addresses
                    # already configured in the store, and ACME_EMAIL is already
                    # where certificate-expiry notices go. The fallback is to
                    # another explicit value, never to a hardcoded guess — the
                    # render script still refuses if both are empty.
                    export ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-$ACME_EMAIL}"
                    bash "'"$SCRIPT_DIR"'/'"$pre_up_hook"'"
                fi
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
            # `|| exit 1` is load-bearing — see the identical guard on the infra
            # path above for why a bare call silently continues.
            vault_load_secrets "$service" "$secrets_file" || exit 1

            # `|| exit 1` IS LOAD-BEARING, for the third time in this file.
            #
            # A pre-up hook can REFUSE — render-alertmanager-config.sh calls die
            # when SMTP_PASSWORD or ALERT_EMAIL_TO is empty, precisely so a blank
            # config is never written. That refusal was being swallowed: `set -e`
            # is suppressed inside a compound command on the left of `||`, and
            # this subshell is exactly that, so a failing hook printed its error
            # and the deploy carried on and reported success.
            #
            # Observed, not theorised: both observability deploys on 2026-08-03
            # logged "ERROR: SMTP_PASSWORD is not set. Refusing to render the
            # Alertmanager config." and both went green. The Alertmanager config
            # had not been re-rendered since 1 August and nobody knew.
            #
            # Same shape as the vault_load_secrets bug (#652) and the revoke-step
            # condition (#663): a guard whose failure is ignored is worse than no
            # guard, because it reads as coverage. `exit` is not subject to the
            # suppression; `return` and a bare call are.
            if [ -n "$pre_up_hook" ]; then
                export ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-${ACME_EMAIL:-}}"
                bash "$SCRIPT_DIR/$pre_up_hook" || exit 1
            fi

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

    # Provision the MinIO policies that Keycloak realm roles map onto. MinIO
    # grants the policy NAMED in the token claim, so admin/editor/viewer have to
    # exist as policies or every federated login is rejected.
    #
    # Non-fatal: the object store must come up regardless, and root-credential
    # access is unaffected.
    if [ "$service" = "minio" ]; then
        echo "Provisioning MinIO policies..."
        bash "$SCRIPT_DIR/minio.sh" apply \
            || warn "minio.sh apply failed — federated S3 access will be rejected with 'no policy found'. Root credentials are unaffected."
    fi

    # Apply the SSO realm configuration after Keycloak comes up.
    #
    # This is not optional decoration: platform-realm.json is imported ONLY on
    # first boot (IGNORE_EXISTING), so on an existing realm the SSO clients
    # would otherwise never appear and nothing would report a problem. The
    # command is idempotent.
    #
    # Deliberately non-fatal: a failure here must not take down the identity
    # provider deploy itself, and every service retains a local admin login.
    if [ "$service" = "auth" ]; then
        echo "Applying SSO realm configuration..."
        # Wait for Keycloak's own healthcheck — kcadm against a still-migrating
        # Keycloak fails in confusing ways.
        #
        # The status template returns an empty string BOTH when the container has
        # no healthcheck and when it does not exist, so waiting on "!= healthy"
        # alone would burn the full timeout silently in either case. Distinguish
        # them and say which happened.
        local waited=0 health
        while true; do
            if ! docker inspect keycloak >/dev/null 2>&1; then
                warn "Container 'keycloak' does not exist — skipping SSO configuration"
                break
            fi
            health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{end}}' keycloak 2>/dev/null)
            if [ -z "$health" ]; then
                warn "Container 'keycloak' has no healthcheck — applying SSO configuration without waiting"
                break
            fi
            [ "$health" = "healthy" ] && break
            if [ "$waited" -ge 180 ]; then
                warn "Keycloak still '${health}' after ${waited}s — attempting SSO configuration anyway"
                break
            fi
            sleep 5; waited=$((waited + 5))
        done
        bash "$SCRIPT_DIR/keycloak.sh" apply \
            || warn "keycloak.sh apply failed — SSO clients may be missing. Local admin logins are unaffected; see docs/runbooks/sso-fallback.md"
    fi

    echo ""
    echo "================================"
    echo "${banner} Complete!"
    echo "================================"
    # Deliberately `docker ps` by project label, NOT `docker compose ps`.
    #
    # The service secrets exist only inside the `sops exec-env` child process or
    # the vault_load_secrets subshell above — both have exited by the time this
    # line runs, so MINIO_ROOT_USER is no longer in the environment. Compose
    # interpolates the compose file for EVERY subcommand including `ps`, and
    # docker-compose.minio.yml declares ${MINIO_ROOT_USER:?...}, so on
    # 2026-07-31 this status print failed with "required variable
    # MINIO_ROOT_USER is missing a value" and, under `set -e`, exited the script
    # 1 — after the deploy itself had fully succeeded and printed "Complete!".
    #
    # That is the worst kind of failure: it teaches everyone that a red minio
    # deploy is normal, so the next genuine failure gets waved through.
    #
    # Re-entering the secret environment just to print container status would be
    # a decrypt for a cosmetic line. Reading the compose project label needs no
    # interpolation and no secret at all, so the whole class of bug goes away —
    # including for any compose file that adopts `:?` later.
    docker ps -a \
        --filter "label=com.docker.compose.project=${project_name}" \
        --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

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
    local secrets_file="infra/secrets/${env}.enc.env"

    case "$stack" in
        infra)
            compose_file="deploy/compose/${env}/docker-compose.infra.yml"
            project_name="hill90-${env}-edge"
            ;;
        db)
            compose_file="deploy/compose/${env}/docker-compose.db.yml"
            project_name="hill90-${env}-platform"
            ;;
        minio)
            compose_file="deploy/compose/${env}/docker-compose.minio.yml"
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
            die "Unknown stack for teardown: $stack. Use: infra, db, auth, minio, vault, observability"
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
    #
    # Wrapped in `sops exec-env` for the same reason cmd_verify was in #597 and
    # the completion banner was in #595: Compose interpolates the compose file
    # for EVERY subcommand, `down` included, and cmd_teardown loads no secrets
    # of its own. docker-compose.minio.yml declares ${MINIO_ROOT_USER:?...}, so
    # `deploy.sh teardown minio` failed outright with "required variable
    # MINIO_ROOT_USER is missing a value" — after the pre-teardown backup had
    # run and after printing "Volumes: KEPT", which reads like the teardown
    # happened.
    #
    # `set -e` inside the quoted string is load-bearing: `sops exec-env` runs it
    # in a new shell that does not inherit deploy.sh's, and exec-env returns 0
    # regardless of what the command did. Without it a failed `down` would be
    # reported as a successful teardown. Same trap as _deploy_infra_with_sops.
    sops exec-env "$secrets_file" '
        set -e
        docker compose -p "'"$project_name"'" -f '"$compose_file"' down
    '

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
        db|auth|minio|vault|observability) cmd_service "$cmd" "$@" ;;
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
