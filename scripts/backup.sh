#!/usr/bin/env bash
# Backup CLI — backup and restore critical Docker volumes
# Usage: backup.sh {backup|backup-all|restore|list|prune} [args]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# Default backup root — override with BACKUP_DIR env var
BACKUP_ROOT="${BACKUP_DIR:-/opt/hill90/backups}"
DEFAULT_RETENTION_DAYS=7
DB_USER="${DB_USER:-hill90}"

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
  db             PostgreSQL (pg_dump + volume tar)
  minio          MinIO object storage (volume tar)
  infra          Traefik certificates + Portainer data (volume tar)
  observability  Grafana dashboards + Prometheus data (volume tar)

Environment variables:
  BACKUP_DIR    Override backup root (default: ${BACKUP_ROOT})
EOF
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

    # SQL dump (portable, recommended for restore)
    if docker exec postgres pg_isready -U "$DB_USER" >/dev/null 2>&1; then
        docker exec postgres pg_dumpall -U "$DB_USER" > "$backup_dir/database.sql"
        echo "  ✓ SQL dump saved to $backup_dir/database.sql"
    else
        warn "PostgreSQL not running — skipping SQL dump"
    fi

    # Volume tar (full data directory backup)
    backup_volume "prod_postgres-data" "$backup_dir/postgres-data.tar.gz" || true
}

backup_minio() {
    local backup_dir="$1"
    mkdir -p "$backup_dir"

    echo "Backing up MinIO..."
    backup_volume "minio-data" "$backup_dir/minio-data.tar.gz"
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

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_backup() {
    local service="$1"

    # Validate service before constructing any paths
    case "$service" in
        db|minio|infra|observability) ;;
        *) die "Unknown service for backup: $service. Use: db, minio, infra, observability" ;;
    esac

    local timestamp
    timestamp="$(date +%Y%m%d_%H%M%S)"
    local backup_dir="${BACKUP_ROOT}/${service}/${timestamp}"

    case "$service" in
        db)            backup_db "$backup_dir" ;;
        minio)         backup_minio "$backup_dir" ;;
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

    for svc in db minio infra observability; do
        cmd_backup "$svc"
        echo ""
    done

    echo "================================"
    echo "Full Backup Complete!"
    echo "================================"
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
        db)
            if [ -f "$backup_dir/database.sql" ]; then
                echo "Restoring PostgreSQL from SQL dump..."
                echo "  Importing $backup_dir/database.sql..."
                docker exec -i postgres psql -U "$DB_USER" < "$backup_dir/database.sql"
                echo "  ✓ SQL dump restored"
            elif [ -f "$backup_dir/postgres-data.tar.gz" ]; then
                warn "No SQL dump found — restoring from volume tar (requires postgres restart)"
                restore_volume "prod_postgres-data" "$backup_dir/postgres-data.tar.gz"
                echo "  Restart postgres: docker restart postgres"
            else
                die "No backup files found in $backup_dir"
            fi
            ;;
        minio)
            [ -f "$backup_dir/minio-data.tar.gz" ] || die "minio-data.tar.gz not found in $backup_dir"
            restore_volume "minio-data" "$backup_dir/minio-data.tar.gz"
            echo "  Restart minio: docker restart minio"
            ;;
        infra)
            [ -f "$backup_dir/traefik-certs.tar.gz" ] || die "traefik-certs.tar.gz not found in $backup_dir"
            restore_volume "prod_traefik-certs" "$backup_dir/traefik-certs.tar.gz"
            if [ -f "$backup_dir/portainer-data.tar.gz" ]; then
                restore_volume "prod_portainer-data" "$backup_dir/portainer-data.tar.gz"
            fi
            echo "  Restart services: docker restart traefik portainer"
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
