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
    # NOT traefik.hill90.com/ping. That check could never pass: `ping` is not
    # enabled in platform/edge/traefik.yml.tmpl at all — `traefik healthcheck`
    # replies "please enable `ping` to use health check" — and the dashboard
    # router carries auth@file, so the URL returned 401 on every run. A health
    # check that is permanently red is worse than none: it trains people to skim
    # past the output, and the next real failure goes with it.
    #
    # The public apex proves the thing that matters — Traefik is routing and
    # terminating TLS — and it is unauthenticated, so a 200 means 200.
    local services=(
        "https://hill90.com/"
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
    echo -n "Checking openbao... "
    if docker container inspect openbao > /dev/null 2>&1; then
        local bao_health
        bao_health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' openbao 2>/dev/null || echo "error")
        local bao_running
        bao_running=$(docker inspect --format='{{.State.Running}}' openbao 2>/dev/null || echo "false")
        if [[ "$bao_running" != "true" ]]; then
            echo "✗ Stopped/crashed"
            all_healthy=false
        elif [[ "$bao_health" == "healthy" ]]; then
            echo "✓ Healthy"
        else
            echo "✗ Unhealthy ($bao_health)"
            all_healthy=false
        fi
    else
        echo "- Not deployed (skipped)"
    fi


    echo ""
    echo "Checking observability services..."
    local obs_containers=("prometheus" "grafana" "loki" "tempo" "promtail" "node-exporter" "cadvisor")
    for container in "${obs_containers[@]}"; do
        echo -n "Checking $container... "
        if docker container inspect "$container" > /dev/null 2>&1; then
            local obs_health
            obs_health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container" 2>/dev/null || echo "error")
            local obs_running
            obs_running=$(docker inspect --format='{{.State.Running}}' "$container" 2>/dev/null || echo "false")
            if [[ "$obs_running" != "true" ]]; then
                echo "✗ Stopped/crashed"
                all_healthy=false
            elif [[ "$obs_health" == "healthy" ]]; then
                echo "✓ Healthy"
            else
                echo "✗ Unhealthy ($obs_health)"
                all_healthy=false
            fi
        else
            echo "- Not deployed (skipped)"
        fi
    done

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

        local public_domains=("hill90.com")
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
            local tailscale_domains=("portainer.hill90.com" "traefik.hill90.com" "grafana.hill90.com" "vault.hill90.com")
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

    check_host_invariants || all_healthy=false

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
# Host invariants: things Config VPS applies and nothing ever re-checked
# ---------------------------------------------------------------------------
#
# WHY THIS EXISTS
#
# SSH password authentication was enabled on this host for weeks while the
# repository, the playbook and docs/architecture/security.md all said it was off.
# Nothing noticed, because nothing looked. The playbook asserts the value during a
# bootstrap and then never again, and a bootstrap is a rare event.
#
# WHAT MAKES A PROPERTY BELONG HERE
#
# Three things together: it is documented in this repository, it is applied by
# Config VPS, and its failure is SILENT. The last one is the filter. Docker being
# enabled at boot is documented and applied, but if it regresses every service on
# the host is down and you will hear about it within minutes — it does not need a
# checker. These three fail quietly and stay failed:
#
#   1. sshd's EFFECTIVE hardening
#   2. SSH not reachable from the public internet
#   3. the vault auto-unseal unit still enabled at boot
#
# ASSERT THE EFFECTIVE CONFIGURATION, NOT THE FILE
#
# `sshd -T` is the post-include, composed configuration the daemon is actually
# running. The whole point of the original finding is that /etc/ssh/sshd_config
# said `PasswordAuthentication no` while the daemon did the opposite, because a
# drop-in read earlier won. Grepping the file, or asserting the drop-in exists,
# would both have reported healthy throughout. Only `sshd -T` tells the truth.
check_host_invariants() {
    echo ""
    echo "Checking host invariants..."

    local ok=true

    # These need root. deploy has NOPASSWD sudo, so -n succeeds non-interactively;
    # anywhere else, say the check could not run rather than inventing a verdict.
    # A check that cannot run must never report the thing it checks as healthy —
    # nor as broken.
    if ! sudo -n true 2>/dev/null; then
        echo "  ⚠ Cannot check host invariants — no non-interactive root."
        echo "    Run on the VPS as deploy, or with sudo."
        return 0
    fi

    # --- 1. sshd effective hardening -------------------------------------
    local effective
    effective=$(sudo -n /usr/sbin/sshd -T 2>/dev/null)
    if [ -z "$effective" ]; then
        echo "  ⚠ sshd -T produced no output — cannot verify SSH hardening"
    else
        local pwauth rootlogin dropin=/etc/ssh/sshd_config.d/00-hill90-hardening.conf
        pwauth=$(printf '%s\n' "$effective" | awk '/^passwordauthentication /{print $2}')
        rootlogin=$(printf '%s\n' "$effective" | awk '/^permitrootlogin /{print $2}')

        echo -n "  SSH password authentication... "
        if [ "$pwauth" = "no" ]; then
            echo "✓ disabled"
        elif sudo -n test -f "$dropin"; then
            # The control is installed and something is overriding it. That is a
            # REGRESSION — the cloud-init-renames-its-drop-in scenario — and it
            # is the case this check exists to catch.
            echo "✗ ENABLED despite the hardening drop-in being present"
            echo "    Something is read before ${dropin}. Find it with:"
            echo "      sudo grep -rniE '^[[:space:]]*PasswordAuthentication' /etc/ssh/"
            ok=false
        else
            # Known, accepted, not yet applied. WARN rather than FAIL on purpose:
            # a check that fails every run on a condition someone has already
            # decided not to fix yet teaches people to ignore the output, and the
            # next real failure goes with it. This flips to ✗ by itself the moment
            # the drop-in is installed, so no one has to remember to change it.
            echo "⚠ enabled — hardening not applied to this host yet"
            echo "    Known and accepted; see docs/runbooks/ssh-hardening-drop-in.md"
        fi

        echo -n "  SSH root login... "
        if [ "$rootlogin" = "no" ]; then
            echo "✓ disabled"
        else
            echo "✗ permitted (effective: ${rootlogin:-unknown})"
            ok=false
        fi
    fi

    # --- 2. SSH not reachable from the public internet -------------------
    echo -n "  SSH closed on the public zone... "
    local pub
    pub=$(sudo -n firewall-cmd --zone=public --query-service=ssh 2>/dev/null)
    case "$pub" in
        no)  echo "✓ closed" ;;
        yes) echo "✗ OPEN — ssh is served to the public interface"; ok=false ;;
        *)   echo "⚠ could not query firewalld" ;;
    esac

    # --- 3. vault auto-unseal still enabled at boot ------------------------
    echo -n "  Vault auto-unseal unit... "
    local unit
    unit=$(systemctl is-enabled hill90-vault-unseal 2>/dev/null)
    case "$unit" in
        enabled) echo "✓ enabled" ;;
        "")      echo "⚠ unit not installed on this host" ;;
        *)       echo "✗ ${unit} — OpenBao will stay sealed after a reboot"; ok=false ;;
    esac

    [ "$ok" = true ]
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

    # h#748: `set -e` already catches `docker run`/`tar` itself returning
    # non-zero, but that is not the failure this checks for. It cannot catch
    # a CLEAN exit that produced an empty or truncated archive — an empty
    # volume, a race with something still writing to it, or a host out of
    # disk mid-write can all exit 0 with a useless file. `backup.sh`'s own
    # `verify_artifacts` treats an empty required artifact as `die`-worthy,
    # not a soft warning — matching that severity here, since an empty
    # backup file is not a partial success, it is a failure of the one
    # thing this function exists to do. This file previously had NO check
    # beyond `set -e`'s implicit protection, and ended unconditionally at
    # "Backup Complete!" regardless of what the archives actually contained.
    echo "Backing up Docker volumes..."
    docker run --rm \
        -v traefik-certs:/data \
        -v "$(pwd)/$backup_dir":/backup \
        alpine tar czf /backup/traefik-certs.tar.gz -C /data .
    [ -s "$backup_dir/traefik-certs.tar.gz" ] \
        || die "Backup produced an empty archive: $backup_dir/traefik-certs.tar.gz — nothing was actually backed up"

    if docker volume inspect prometheus-data > /dev/null 2>&1; then
        echo "Backing up Prometheus data..."
        docker run --rm \
            -v prometheus-data:/data \
            -v "$(pwd)/$backup_dir":/backup \
            alpine tar czf /backup/prometheus-data.tar.gz -C /data .
        [ -s "$backup_dir/prometheus-data.tar.gz" ] \
            || die "Backup produced an empty archive: $backup_dir/prometheus-data.tar.gz — nothing was actually backed up"
    else
        echo "Skipping Prometheus backup (volume not found)"
    fi

    if docker volume inspect grafana-data > /dev/null 2>&1; then
        echo "Backing up Grafana data..."
        docker run --rm \
            -v grafana-data:/data \
            -v "$(pwd)/$backup_dir":/backup \
            alpine tar czf /backup/grafana-data.tar.gz -C /data .
        [ -s "$backup_dir/grafana-data.tar.gz" ] \
            || die "Backup produced an empty archive: $backup_dir/grafana-data.tar.gz — nothing was actually backed up"
    else
        echo "Skipping Grafana backup (volume not found)"
    fi

    echo ""
    echo "================================"
    echo "Backup Complete!"
    echo "================================"
    echo "Location: $backup_dir"
    # h#748: this is materially incomplete versus scripts/backup.sh — no
    # database dump at all. An operator invoking this expecting parity with
    # the real tool (easily done: same "Hill90 Backup"/"Backup Complete!"
    # message shape) previously had no indication of the gap. Said out loud
    # rather than left implicit; not attempting to add database backup here,
    # which is a feature decision, not this bug fix's scope.
    warn "This is a legacy, volume-only backup — it does NOT back up any database. For a complete backup, use: bash scripts/backup.sh backup-all"
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
