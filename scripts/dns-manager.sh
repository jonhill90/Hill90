#!/usr/bin/env bash
set -euo pipefail

# DNS Manager for Hill90 VPS
# Uses Claude Code MCP tools for DNS management via Hostinger API

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DNS_TEMPLATE="$PROJECT_ROOT/infra/dns/hill90.com.json"
SECRETS_FILE="$PROJECT_ROOT/infra/secrets/prod.enc.env"
DOMAIN="hill90.com"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Get VPS IP from encrypted secrets
get_vps_ip() {
    if [[ ! -f "$SECRETS_FILE" ]]; then
        log_error "Secrets file not found: $SECRETS_FILE"
        exit 1
    fi

    # Decrypt and extract VPS_IP
    local vps_ip
    vps_ip=$(sops --decrypt "$SECRETS_FILE" 2>/dev/null | grep "^VPS_IP=" | cut -d'=' -f2 | tr -d '"')

    if [[ -z "$vps_ip" ]]; then
        log_error "VPS_IP not found in secrets file"
        exit 1
    fi

    echo "$vps_ip"
}

# Get current DNS records
get_records() {
    log_info "Fetching current DNS records for $DOMAIN..."

    # Use Claude Code to call MCP tool
    cat <<'EOF'
To view current DNS records, use Claude Code with:

    ToolSearch query="select:mcp__MCP_DOCKER__DNS_getDNSRecordsV1"
    mcp__MCP_DOCKER__DNS_getDNSRecordsV1(domain="hill90.com")

This will show all current DNS records including A, CNAME, CAA, SRV, etc.
EOF
}

# Create DNS snapshot
create_snapshot() {
    log_info "Creating DNS snapshot for $DOMAIN..."

    cat <<'EOF'
To create a DNS snapshot backup, use Claude Code with:

    ToolSearch query="select:mcp__MCP_DOCKER__DNS_getDNSSnapshotListV1"

Note: Snapshots are created automatically by Hostinger before DNS updates.
To view existing snapshots:

    mcp__MCP_DOCKER__DNS_getDNSSnapshotListV1(domain="hill90.com")
EOF
}

# List DNS snapshots
list_snapshots() {
    log_info "Listing DNS snapshots for $DOMAIN..."

    cat <<'EOF'
To list DNS snapshots, use Claude Code with:

    mcp__MCP_DOCKER__DNS_getDNSSnapshotListV1(domain="hill90.com")

This will show all available backup snapshots with their IDs and timestamps.
EOF
}

# Restore DNS snapshot
restore_snapshot() {
    local snapshot_id="$1"

    if [[ -z "$snapshot_id" ]]; then
        log_error "Snapshot ID required"
        echo "Usage: $0 restore-snapshot SNAPSHOT_ID"
        exit 1
    fi

    log_warn "This will restore DNS to snapshot $snapshot_id"

    cat <<EOF
To restore DNS snapshot, use Claude Code with:

    mcp__MCP_DOCKER__DNS_restoreDNSSnapshotV1(
        domain="hill90.com",
        snapshotId=$snapshot_id
    )

WARNING: This will replace current DNS configuration!
EOF
}

# Sync DNS A records to current VPS IP
sync_vps_dns() {
    local vps_ip
    vps_ip=$(get_vps_ip)

    log_info "Syncing DNS A records to VPS IP: $vps_ip"

    cat <<EOF
To sync DNS A records to current VPS IP ($vps_ip), use Claude Code with:

1. Validate the update first:
    mcp__MCP_DOCKER__DNS_validateDNSRecordsV1(
        domain="hill90.com",
        overwrite=false,
        zone=[
            {
                "name": "@",
                "type": "A",
                "ttl": 3600,
                "records": [{"content": "$vps_ip"}]
            },
            {
                "name": "www",
                "type": "A",
                "ttl": 3600,
                "records": [{"content": "$vps_ip"}]
            },
            {
                "name": "api",
                "type": "A",
                "ttl": 3600,
                "records": [{"content": "$vps_ip"}]
            },
            {
                "name": "ai",
                "type": "A",
                "ttl": 3600,
                "records": [{"content": "$vps_ip"}]
            }
        ]
    )

2. If validation passes, apply the update:
    mcp__MCP_DOCKER__DNS_updateDNSRecordsV1(
        domain="hill90.com",
        overwrite=true,
        zone=[
            {
                "name": "@",
                "type": "A",
                "ttl": 3600,
                "records": [{"content": "$vps_ip"}]
            },
            {
                "name": "www",
                "type": "A",
                "ttl": 3600,
                "records": [{"content": "$vps_ip"}]
            },
            {
                "name": "api",
                "type": "A",
                "ttl": 3600,
                "records": [{"content": "$vps_ip"}]
            },
            {
                "name": "ai",
                "type": "A",
                "ttl": 3600,
                "records": [{"content": "$vps_ip"}]
            }
        ]
    )

Note: Using overwrite=true to replace old A records with new VPS IP.
Other record types (CNAME, CAA, SRV) will be preserved.
EOF
}

# Verify DNS propagation
verify_dns() {
    local vps_ip
    vps_ip=$(get_vps_ip)

    log_info "Verifying DNS propagation for $DOMAIN (expected: $vps_ip)..."

    echo ""
    echo "Checking DNS records:"
    echo "====================="

    for host in "$DOMAIN" "www.$DOMAIN" "api.$DOMAIN" "ai.$DOMAIN"; do
        echo -n "$host: "
        local resolved
        resolved=$(dig +short "$host" 2>/dev/null | head -n1)

        if [[ "$resolved" == "$vps_ip" ]]; then
            echo -e "${GREEN}✓ $resolved${NC}"
        elif [[ -n "$resolved" ]]; then
            echo -e "${YELLOW}⚠ $resolved (expected $vps_ip)${NC}"
        else
            echo -e "${RED}✗ No A record${NC}"
        fi
    done

    echo ""
    log_info "DNS propagation can take 5-10 minutes"
    log_info "Use 'watch -n 5 dig +short $DOMAIN' to monitor"
}

# Show usage
usage() {
    cat <<EOF
DNS Manager for Hill90 VPS

Usage: $0 COMMAND [OPTIONS]

Commands:
    get-records              List current DNS records for $DOMAIN
    sync-vps-dns             Sync A records to current VPS_IP from secrets
    create-snapshot          Create DNS backup snapshot
    list-snapshots           List available DNS snapshots
    restore-snapshot ID      Restore DNS from snapshot
    verify-dns               Verify DNS propagation with dig

Examples:
    $0 get-records
    $0 sync-vps-dns
    $0 verify-dns
    $0 restore-snapshot 123

Note: Most operations output Claude Code MCP tool commands.
      Run these commands via Claude Code to execute DNS operations.
EOF
}

# Main command dispatcher
main() {
    if [[ $# -eq 0 ]]; then
        usage
        exit 0
    fi

    local command="$1"
    shift

    case "$command" in
        get-records)
            get_records
            ;;
        sync-vps-dns)
            sync_vps_dns
            ;;
        create-snapshot)
            create_snapshot
            ;;
        list-snapshots)
            list_snapshots
            ;;
        restore-snapshot)
            restore_snapshot "$@"
            ;;
        verify-dns)
            verify_dns
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            log_error "Unknown command: $command"
            echo ""
            usage
            exit 1
            ;;
    esac
}

main "$@"
