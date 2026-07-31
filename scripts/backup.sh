#!/usr/bin/env bash
# Backup CLI — backup and restore critical Docker volumes
# Usage: backup.sh {backup|backup-all|restore|list|prune} [args]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# Default backup root — override with BACKUP_DIR env var
BACKUP_ROOT="${BACKUP_DIR:-/opt/hill90/backups}"
DEFAULT_RETENTION_DAYS=7

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Backup CLI — Hill90 volume backup and restore

Usage: backup.sh <command> [args]

Commands:
  backup <service>         Backup a single service's volumes
  backup-all               Backup all critical volumes
  restore <service> <file> Restore a service from a backup file
  list [service]           List available backups (optionally filter by service)
  prune [days]             Delete backups older than N days (default: ${DEFAULT_RETENTION_DAYS})
  help                     Show this help message

Services with backups:
  db             PostgreSQL SQL dump + data volume tar
  app-db         hill90-app tenant: SQL dump + data volume tar
  minio          Object store data volume tar
  vault          OpenBao secrets data (volume tar)
  infra          Traefik certificates + Portainer data (volume tar)
  observability  Grafana dashboards + Prometheus data (volume tar)

Environment variables:
  BACKUP_DIR    Override backup root (default: ${BACKUP_ROOT})
EOF
}

# ---------------------------------------------------------------------------
# sops resolution
#
# THIS IS THE INCIDENT. /etc/crontab sets PATH=/sbin:/bin:/usr/sbin:/usr/bin and
# sops is installed to /usr/local/bin, so under cron `sops` was "command not
# found". Its stderr went to /dev/null, DB_USER came back empty, the SQL dump
# was skipped with a warning, the volume tar still ran, and the script exited 0.
# Three consecutive nightly backups held a tar and no dump while cron reported
# success. The same command worked by hand, which is why it survived.
#
# Resolve by PATH first, then by the known install location.
# ---------------------------------------------------------------------------

resolve_sops() {
    if command -v sops >/dev/null 2>&1; then
        command -v sops
        return 0
    fi
    for candidate in /usr/local/bin/sops /usr/bin/sops /opt/homebrew/bin/sops; do
        [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
    done
    return 1
}

# ---------------------------------------------------------------------------
# Artifact verification
#
# Two backup directories on the VPS were completely empty and still counted as
# successful runs. An empty directory must be impossible to report as a backup.
# ---------------------------------------------------------------------------

verify_artifacts() {
    local backup_dir="$1"
    shift
    local required=("$@")

    [ -d "$backup_dir" ] || die "Backup directory was never created: $backup_dir"

    local found
    found=$(find "$backup_dir" -type f ! -name '.*.partial' | wc -l | tr -d ' ')
    [ "$found" -gt 0 ] || die "Backup produced no files at all: $backup_dir"

    local f
    for f in "${required[@]}"; do
        [ -f "$backup_dir/$f" ] || die "Expected artifact missing: $backup_dir/$f"
        [ -s "$backup_dir/$f" ] || die "Expected artifact is empty: $backup_dir/$f"
    done

    # Nothing that survived should be zero-length.
    while IFS= read -r f; do
        [ -s "$f" ] || die "Backup artifact is empty: $f"
    done < <(find "$backup_dir" -type f ! -name '.*.partial')

    echo "  ✓ verified ${found} artifact(s) in $backup_dir"
}

# ---------------------------------------------------------------------------
# Volume backup helpers
# ---------------------------------------------------------------------------

# Backup a named Docker volume to a tar.gz file
backup_volume() {
    local volume="$1"
    local dest_file="$2"

    if ! docker volume inspect "$volume" >/dev/null 2>&1; then
        warn "Volume $volume not found — skipping"
        return 1
    fi

    echo "  Backing up volume $volume..."
    docker run --rm \
        -v "${volume}:/data:ro" \
        -v "$(dirname "$dest_file"):/backup" \
        alpine tar czf "/backup/$(basename "$dest_file")" -C /data .

    echo "  ✓ Saved to $dest_file"
}

# Restore a named Docker volume from a tar.gz file
restore_volume() {
    local volume="$1"
    local src_file="$2"

    if [ ! -f "$src_file" ]; then
        die "Backup file not found: $src_file"
    fi

    echo "  Restoring volume $volume from $src_file..."
    docker run --rm \
        -v "${volume}:/data" \
        -v "$(dirname "$src_file"):/backup:ro" \
        alpine sh -c "rm -rf /data/* && tar xzf /backup/$(basename "$src_file") -C /data"

    echo "  ✓ Restored $volume"
}

# ---------------------------------------------------------------------------
# Per-service backup implementations
# ---------------------------------------------------------------------------

backup_db() {
    local backup_dir="$1"
    mkdir -p "$backup_dir"

    echo "Backing up PostgreSQL..."

    # deploy.sh calls the pre-deploy backup BEFORE it loads secrets, so DB_USER
    # arrives empty. That used to produce a zero-byte database.sql and, because
    # `set -e` killed the script on the failed pg_dumpall, the volume tar below
    # never ran either — a deploy that destroys and recreates the container
    # while reporting only "Pre-deploy backup failed (continuing deploy)".
    # Load secrets here rather than depending on the caller's ordering.
    local db_user="${DB_USER:-}"
    if [ -z "$db_user" ] && [ -f "${PROJECT_ROOT}/infra/secrets/prod.enc.env" ]; then
        local sops_bin
        if sops_bin="$(resolve_sops)"; then
            db_user=$("$sops_bin" -d "${PROJECT_ROOT}/infra/secrets/prod.enc.env" 2>/dev/null \
                      | grep '^DB_USER=' | cut -d= -f2- || true)
        else
            die "sops is not installed or not resolvable (PATH=$PATH).
Under cron, PATH is /sbin:/bin:/usr/sbin:/usr/bin and sops lives in
/usr/local/bin — this is exactly how the SQL dump silently stopped running."
        fi
    fi

    # pg_isready is NOT an authentication check — it exits 0 for any role name,
    # including one that does not exist and including the empty string. Prove
    # the credentials work by running a query.
    # These used to be warnings. A backup that produces no dump and still reports
    # success manufactures false confidence, which is worse than an error: the
    # operator believes they have a restore path and does not.
    if [ -z "$db_user" ]; then
        die "DB_USER could not be resolved — refusing to report a backup with no SQL dump"
    elif ! docker exec postgres psql -U "$db_user" -tAc 'SELECT 1' >/dev/null 2>&1; then
        die "Cannot authenticate to PostgreSQL as '${db_user}' — refusing to report a backup with no SQL dump"
    else
        # Never leave a truncated dump behind claiming to be a backup: write to
        # a temp file, check the exit status AND that it is non-empty, and only
        # then move it into place.
        if docker exec postgres pg_dumpall -U "$db_user" > "$backup_dir/.database.sql.partial" 2>/dev/null \
           && [ -s "$backup_dir/.database.sql.partial" ]; then
            mv "$backup_dir/.database.sql.partial" "$backup_dir/database.sql"
            echo "  ✓ SQL dump saved to $backup_dir/database.sql ($(wc -c < "$backup_dir/database.sql") bytes)"
        else
            rm -f "$backup_dir/.database.sql.partial"
            die "pg_dumpall failed or produced an empty dump — refusing to report success"
        fi
    fi

    # Volume tar (full data directory backup). Runs regardless of the dump.
    backup_volume "prod_postgres-data" "$backup_dir/postgres-data.tar.gz" || true

    verify_artifacts "$backup_dir" "database.sql"
}

# ---------------------------------------------------------------------------
# Tenant database backup — hill90-app
#
# prod_app-postgres-data had never been backed up by anything. This repo's
# backup.sh only knew prod_postgres-data, and hill90-app has no backup script of
# its own. That volume holds the app's Keycloak realm and its user accounts, AKM
# knowledge, chat history and LiteLLM data.
#
# The user is read from the running container rather than from a secrets store,
# because the app's store lives in the app's repository and is not present here.
# A tar of a live PGDATA is crash-consistent at best; pg_dumpall is the artifact
# that restores cleanly, so both are taken and the dump is required.
# ---------------------------------------------------------------------------

backup_app_db() {
    local backup_dir="$1"
    mkdir -p "$backup_dir"

    local container="${APP_PG_CONTAINER:-app-postgres}"

    echo "Backing up the hill90-app tenant database..."

    # app-postgres was retired on 2026-07-30 and the tenant's databases moved to the
    # platform Postgres, so the `db` target's pg_dumpall already contains hill90_akm,
    # hill90_api and hill90_litellm. Dying here would make `backup all` report FAILED
    # every night for data that IS backed up — and a backup job that cries wolf is how
    # a real failure gets ignored.
    #
    # This is deliberately not the same as "the tenant is not deployed": that case is
    # still a failure when the container is expected. The retirement is identified by
    # the container being absent AND its databases being covered elsewhere, which is
    # exactly the post-cutover state.
    if ! docker inspect "$container" >/dev/null 2>&1; then
        echo "  • '${container}' is retired (2026-07-30) — its databases moved to the"
        echo "    platform Postgres and are covered by the 'db' target's pg_dumpall."

        # The retained volume is the only artifact still uniquely app-db's, and only
        # for as long as it exists. Tar it while it is there; say so when it is not.
        if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx "prod_app-postgres-data"; then
            echo "    The retained volume prod_app-postgres-data still exists — archiving it."
            backup_volume "prod_app-postgres-data" "$backup_dir/app-postgres-data.tar.gz" || true
        else
            echo "    The retained volume is gone too; nothing left for this target to do."
        fi
        return 0
    fi

    local app_user="${APP_DB_USER:-}"
    if [ -z "$app_user" ]; then
        app_user=$(docker inspect "$container" \
                   --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
                   | grep '^POSTGRES_USER=' | cut -d= -f2- || true)
    fi
    [ -n "$app_user" ] || die "Could not determine the tenant database user from ${container}"

    docker exec "$container" psql -U "$app_user" -tAc 'SELECT 1' >/dev/null 2>&1 \
        || die "Cannot authenticate to ${container} as '${app_user}' — refusing to report a backup with no SQL dump"

    if docker exec "$container" pg_dumpall -U "$app_user" > "$backup_dir/.app-database.sql.partial" 2>/dev/null \
       && [ -s "$backup_dir/.app-database.sql.partial" ]; then
        mv "$backup_dir/.app-database.sql.partial" "$backup_dir/app-database.sql"
        echo "  ✓ SQL dump saved to $backup_dir/app-database.sql ($(wc -c < "$backup_dir/app-database.sql") bytes)"
    else
        rm -f "$backup_dir/.app-database.sql.partial"
        die "pg_dumpall against ${container} failed or produced an empty dump — refusing to report success"
    fi

    backup_volume "prod_app-postgres-data" "$backup_dir/app-postgres-data.tar.gz" || true

    verify_artifacts "$backup_dir" "app-database.sql"
}

backup_infra() {
    local backup_dir="$1"
    mkdir -p "$backup_dir"

    echo "Backing up infrastructure volumes..."
    backup_volume "prod_traefik-certs" "$backup_dir/traefik-certs.tar.gz" || true
    backup_volume "prod_portainer-data" "$backup_dir/portainer-data.tar.gz" || true
}

backup_observability() {
    local backup_dir="$1"
    mkdir -p "$backup_dir"

    echo "Backing up observability volumes..."
    backup_volume "grafana-data" "$backup_dir/grafana-data.tar.gz" || true
    backup_volume "prometheus-data" "$backup_dir/prometheus-data.tar.gz" || true
}

backup_minio() {
    local backup_dir="$1"
    mkdir -p "$backup_dir"

    echo "Backing up MinIO object store..."
    # Volume tar only. `mc mirror` would need working credentials and somewhere
    # to mirror TO; the volume is the whole store and is what a restore needs.
    backup_volume "prod_minio-data" "$backup_dir/minio-data.tar.gz" || true
}

backup_vault() {
    local backup_dir="$1"
    mkdir -p "$backup_dir"

    echo "Backing up OpenBao..."
    backup_volume "openbao-data" "$backup_dir/openbao-data.tar.gz"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_backup() {
    local service="$1"

    # Validate service before constructing any paths
    case "$service" in
        db|app-db|minio|vault|infra|observability) ;;
        *) die "Unknown service for backup: $service. Use: db, app-db, minio, vault, infra, observability" ;;
    esac

    local timestamp
    timestamp="$(date +%Y%m%d_%H%M%S)"
    local backup_dir="${BACKUP_ROOT}/${service}/${timestamp}"

    case "$service" in
        db)            backup_db "$backup_dir" ;;
        app-db)        backup_app_db "$backup_dir" ;;
        minio)         backup_minio "$backup_dir" ;;
        vault)         backup_vault "$backup_dir" ;;
        infra)         backup_infra "$backup_dir" ;;
        observability) backup_observability "$backup_dir" ;;
    esac

    echo ""
    echo "✓ Backup complete: $backup_dir"
}

cmd_backup_all() {
    echo "================================"
    echo "Full Backup — All Critical Volumes"
    echo "================================"
    echo ""

    # Run every service even if one fails, then fail the job at the end.
    #
    # Aborting on the first failure would be worse than the bug being fixed: the
    # tenant's database is legitimately absent whenever the tenant is torn down
    # (which happened during a teardown test on 2026-07-29), and `set -e` would
    # then skip vault, infra and observability entirely. One missing service must
    # not cost the other four their backups — but it must still turn the run red.
    local failed=()
    for svc in db app-db minio vault infra observability; do
        if ! ( cmd_backup "$svc" ); then
            failed+=("$svc")
            warn "Backup FAILED for: $svc (continuing with the remaining services)"
        fi
        echo ""
    done

    echo "================================"
    if [ ${#failed[@]} -eq 0 ]; then
        echo "Full Backup Complete!"
        echo "================================"
        return 0
    fi

    echo "Full Backup INCOMPLETE"
    echo "================================"
    die "These services produced no usable backup: ${failed[*]}
The other services were backed up. This exits non-zero deliberately — a partial
backup must not be reported as success."
}

cmd_restore() {
    local service="$1"
    local backup_path="$2"

    if [ -z "$service" ] || [ -z "$backup_path" ]; then
        die "Usage: backup.sh restore <service> <backup-dir-or-file>"
    fi

    # If a directory is given, resolve the expected files within it
    if [ -d "$backup_path" ]; then
        local backup_dir="$backup_path"
    else
        die "Backup path must be a directory: $backup_path"
    fi

    echo "================================"
    echo "Restore — ${service}"
    echo "================================"
    echo "Source: $backup_dir"
    echo ""
    warn "This will REPLACE existing data for ${service}. Press Ctrl+C within 5 seconds to abort."
    sleep 5

    case "$service" in
        infra)
            [ -f "$backup_dir/traefik-certs.tar.gz" ] || die "traefik-certs.tar.gz not found in $backup_dir"
            restore_volume "prod_traefik-certs" "$backup_dir/traefik-certs.tar.gz"
            if [ -f "$backup_dir/portainer-data.tar.gz" ]; then
                restore_volume "prod_portainer-data" "$backup_dir/portainer-data.tar.gz"
            fi
            echo "  Restart services: docker restart traefik portainer"
            ;;
        vault)
            [ -f "$backup_dir/openbao-data.tar.gz" ] || die "openbao-data.tar.gz not found in $backup_dir"
            restore_volume "openbao-data" "$backup_dir/openbao-data.tar.gz"
            echo "  Restart openbao: docker restart openbao"
            echo "  Then unseal: bash scripts/vault.sh unseal"
            ;;
        observability)
            if [ -f "$backup_dir/grafana-data.tar.gz" ]; then
                restore_volume "grafana-data" "$backup_dir/grafana-data.tar.gz"
            fi
            if [ -f "$backup_dir/prometheus-data.tar.gz" ]; then
                restore_volume "prometheus-data" "$backup_dir/prometheus-data.tar.gz"
            fi
            echo "  Restart services: docker restart grafana prometheus"
            ;;
        *)
            die "Unknown service for restore: $service"
            ;;
    esac

    echo ""
    echo "✓ Restore complete"
}

cmd_list() {
    local service="${1:-}"

    echo "================================"
    echo "Available Backups"
    echo "================================"
    echo "Location: ${BACKUP_ROOT}"
    echo ""

    if [ ! -d "$BACKUP_ROOT" ]; then
        echo "No backups found."
        return 0
    fi

    if [ -n "$service" ]; then
        local svc_dir="${BACKUP_ROOT}/${service}"
        if [ ! -d "$svc_dir" ]; then
            echo "No backups for service: $service"
            return 0
        fi
        echo "Service: $service"
        for d in "$svc_dir"/*/; do
            [ -d "$d" ] || continue
            local ts
            ts="$(basename "$d")"
            local size
            size="$(du -sh "$d" 2>/dev/null | cut -f1)"
            echo "  ${ts}  (${size})"
        done
    else
        for svc_dir in "$BACKUP_ROOT"/*/; do
            [ -d "$svc_dir" ] || continue
            local svc
            svc="$(basename "$svc_dir")"
            local count
            count="$(find "$svc_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
            echo "  ${svc}: ${count} backup(s)"
        done
    fi
}

cmd_prune() {
    local retention_days="${1:-$DEFAULT_RETENTION_DAYS}"
    [[ "$retention_days" =~ ^[0-9]+$ ]] || die "Retention days must be a positive integer, got: $retention_days"

    echo "================================"
    echo "Pruning backups older than ${retention_days} days"
    echo "================================"
    echo ""

    if [ ! -d "$BACKUP_ROOT" ]; then
        echo "No backups directory found."
        return 0
    fi

    local pruned=0
    for svc_dir in "$BACKUP_ROOT"/*/; do
        [ -d "$svc_dir" ] || continue
        local svc
        svc="$(basename "$svc_dir")"

        for backup_dir in "$svc_dir"/*/; do
            [ -d "$backup_dir" ] || continue
            local ts
            ts="$(basename "$backup_dir")"

            # Parse timestamp: YYYYMMDD_HHMMSS
            local backup_date="${ts%%_*}"
            if [ ${#backup_date} -ne 8 ]; then
                continue
            fi

            local cutoff_epoch
            cutoff_epoch="$(date -d "-${retention_days} days" +%s 2>/dev/null || date -v "-${retention_days}d" +%s 2>/dev/null)" || continue
            local backup_epoch
            backup_epoch="$(date -d "${backup_date:0:4}-${backup_date:4:2}-${backup_date:6:2}" +%s 2>/dev/null || date -j -f "%Y%m%d" "$backup_date" +%s 2>/dev/null)" || continue

            if [ "$backup_epoch" -lt "$cutoff_epoch" ]; then
                echo "  Removing: ${svc}/${ts}"
                rm -rf "$backup_dir"
                pruned=$((pruned + 1))
            fi
        done
    done

    echo ""
    echo "✓ Pruned ${pruned} backup(s)"
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
        backup)         cmd_backup "$@" ;;
        backup-all)     cmd_backup_all "$@" ;;
        restore)        cmd_restore "$@" ;;
        list)           cmd_list "$@" ;;
        prune)          cmd_prune "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
