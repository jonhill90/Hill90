#!/usr/bin/env bash
# Ops CLI — operational tasks (health checks, backups)
# Usage: ops.sh {health|backup} [args]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Ops CLI — Hill90 operational tasks

Usage: ops.sh <command>

Commands:
  health   Check service health and DNS
  backup   Backup database and volumes
  help     Show this help message
EOF
}

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

cmd_health() {
    local services=(
        "https://api.hill90.com/health"
        "https://ai.hill90.com/health"
    )

    echo "================================"
    echo "Hill90 Health Check"
    echo "================================"
    echo ""

    local all_healthy=true

    for service in "${services[@]}"; do
        echo -n "Checking $service... "
        local response
        response=$(curl -s -o /dev/null -w "%{http_code}" "$service" || echo "000")
        if [ "$response" = "200" ]; then
            echo "✓ Healthy (200)"
        else
            echo "✗ Unhealthy ($response)"
            all_healthy=false
        fi
    done

    echo ""
    echo "Checking internal services..."
    echo -n "Checking MinIO... "
    if docker container inspect minio > /dev/null 2>&1; then
        local minio_health
        minio_health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' minio 2>/dev/null || echo "error")
        local minio_running
        minio_running=$(docker inspect --format='{{.State.Running}}' minio 2>/dev/null || echo "false")
        if [[ "$minio_running" != "true" ]]; then
            echo "✗ Stopped/crashed"
            all_healthy=false
        elif [[ "$minio_health" == "healthy" ]]; then
            echo "✓ Healthy"
        else
            echo "✗ Unhealthy ($minio_health)"
            all_healthy=false
        fi
    else
        echo "- Not deployed (skipped)"
    fi

    echo ""
    echo "================================"
    echo "DNS Verification"
    echo "================================"
    echo ""

    local vps_ip=""
    if [ -f "infra/secrets/prod.dec.env" ]; then
        vps_ip=$(grep "^VPS_IP=" infra/secrets/prod.dec.env 2>/dev/null | cut -d '=' -f 2)
    fi
    if [ -z "$vps_ip" ] && [ -f "infra/secrets/prod.enc.env" ]; then
        vps_ip=$(sops -d infra/secrets/prod.enc.env 2>/dev/null | grep "^VPS_IP=" | cut -d '=' -f 2 || echo "")
    fi

    if [ -z "$vps_ip" ]; then
        echo "⚠ Could not retrieve VPS_IP from secrets - skipping DNS verification"
    else
        echo "Expected VPS IP: $vps_ip"
        echo ""

        local public_domains=("api.hill90.com" "ai.hill90.com" "auth.hill90.com" "hill90.com")
        local dns_all_correct=true

        for domain in "${public_domains[@]}"; do
            echo -n "Checking DNS for $domain... "
            local resolved_ip
            resolved_ip=$(dig +short "$domain" @8.8.8.8 | tail -n1)
            if [ -z "$resolved_ip" ]; then
                echo "✗ No DNS record found"
                dns_all_correct=false
            elif [ "$resolved_ip" != "$vps_ip" ]; then
                echo "✗ Mismatch (resolves to $resolved_ip)"
                dns_all_correct=false
            else
                echo "✓ Correct ($resolved_ip)"
            fi
        done

        # Tailscale-only hosts
        local tailscale_ip=""
        if [ -f "infra/secrets/prod.dec.env" ]; then
            tailscale_ip=$(grep "^TAILSCALE_IP=" infra/secrets/prod.dec.env 2>/dev/null | cut -d '=' -f 2)
        fi
        if [ -z "$tailscale_ip" ] && [ -f "infra/secrets/prod.enc.env" ]; then
            tailscale_ip=$(sops -d infra/secrets/prod.enc.env 2>/dev/null | grep "^TAILSCALE_IP=" | cut -d '=' -f 2 || echo "")
        fi

        if [ -n "$tailscale_ip" ]; then
            echo ""
            echo "Expected Tailscale IP: $tailscale_ip"
            echo ""
            local tailscale_domains=("storage.hill90.com" "portainer.hill90.com" "traefik.hill90.com")
            for domain in "${tailscale_domains[@]}"; do
                echo -n "Checking DNS for $domain... "
                local resolved_ip
                resolved_ip=$(dig +short "$domain" @8.8.8.8 | tail -n1)
                if [ -z "$resolved_ip" ]; then
                    echo "✗ No DNS record found"
                    dns_all_correct=false
                elif [ "$resolved_ip" != "$tailscale_ip" ]; then
                    echo "✗ Mismatch (resolves to $resolved_ip)"
                    dns_all_correct=false
                else
                    echo "✓ Correct ($resolved_ip)"
                fi
            done
        fi

        echo ""
        if [ "$dns_all_correct" = false ]; then
            echo "⚠ DNS records need updating"
            echo "  Update DNS A records to point to: $vps_ip"
        fi
    fi

    echo ""
    if [ "$all_healthy" = true ]; then
        echo "✓ All services healthy!"
        return 0
    else
        echo "✗ Some services are unhealthy"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------

cmd_backup() {
    local backup_dir="backups/$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$backup_dir"

    echo "================================"
    echo "Hill90 Backup"
    echo "================================"
    echo "Backup directory: $backup_dir"
    echo ""

    echo "Backing up Docker volumes..."
    docker run --rm \
        -v postgres-data:/data \
        -v "$(pwd)/$backup_dir":/backup \
        alpine tar czf /backup/postgres-data.tar.gz -C /data .

    docker run --rm \
        -v traefik-certs:/data \
        -v "$(pwd)/$backup_dir":/backup \
        alpine tar czf /backup/traefik-certs.tar.gz -C /data .

    if docker volume inspect minio-data > /dev/null 2>&1; then
        echo "Backing up MinIO data..."
        docker run --rm \
            -v minio-data:/data \
            -v "$(pwd)/$backup_dir":/backup \
            alpine tar czf /backup/minio-data.tar.gz -C /data .
    else
        echo "Skipping MinIO backup (volume not found)"
    fi

    echo "Backing up database..."
    docker exec postgres pg_dumpall -U hill90 > "$backup_dir/database.sql"

    echo ""
    echo "================================"
    echo "Backup Complete!"
    echo "================================"
    echo "Location: $backup_dir"
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
        health)         cmd_health "$@" ;;
        backup)         cmd_backup "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
