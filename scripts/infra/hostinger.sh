#!/usr/bin/env bash
# Unified Hostinger CLI for VPS and DNS management
# Usage: hostinger.sh <service> <command> [args]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Configuration
API_BASE="${HOSTINGER_API_BASE:-https://developers.hostinger.com}"
VPS_ID="${HOSTINGER_VPS_ID:-1264324}"
DOMAIN="${HOSTINGER_DOMAIN:-hill90.com}"

# Load secrets and validate API key (called lazily, not at startup)
_secrets_loaded=false
ensure_api_key() {
    if [[ "$_secrets_loaded" == "true" ]]; then return 0; fi
    _secrets_loaded=true

    if [[ -z "${HOSTINGER_API_KEY:-}" ]]; then
        source "$PROJECT_ROOT/scripts/secrets/load-secrets.sh"
    fi

    API_KEY="${HOSTINGER_API_KEY:-}"
    if [[ -z "$API_KEY" ]]; then
        echo -e "${RED}ERROR: HOSTINGER_API_KEY not set${NC}"
        echo "Add to secrets: make secrets-update KEY=HOSTINGER_API_KEY VALUE='<key>'"
        exit 1
    fi
}

API_KEY=""

# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------

api_call() {
    ensure_api_key

    local method="$1"
    local endpoint="$2"
    local data="${3:-}"

    local url="${API_BASE}${endpoint}"
    local response http_code body

    if [[ -n "$data" ]]; then
        response=$(curl -s -w "\n%{http_code}" --max-time 30 --retry 3 --retry-delay 2 \
            -X "$method" "$url" \
            -H "Authorization: Bearer ${API_KEY}" \
            -H "Content-Type: application/json" \
            -d "$data")
    else
        response=$(curl -s -w "\n%{http_code}" --max-time 30 --retry 3 --retry-delay 2 \
            -X "$method" "$url" \
            -H "Authorization: Bearer ${API_KEY}" \
            -H "Content-Type: application/json")
    fi

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
        echo "$body"
        return 0
    else
        echo -e "${RED}ERROR: HTTP $http_code${NC}" >&2
        echo "$body" | jq '.' 2>/dev/null || echo "$body" >&2
        return 1
    fi
}

# ---------------------------------------------------------------------------
# VPS commands
# ---------------------------------------------------------------------------

vps_get() {
    echo -e "${BLUE}Fetching VPS details...${NC}" >&2
    local response
    response=$(api_call GET "/api/vps/v1/virtual-machines/$VPS_ID")
    local state
    state=$(echo "$response" | jq -r '.state // empty')
    echo -e "${GREEN}VPS state: $state${NC}" >&2
    echo "$response" | jq '.'
}

vps_start() {
    echo -e "${BLUE}Starting VPS...${NC}" >&2
    api_call POST "/api/vps/v1/virtual-machines/$VPS_ID/start" | jq '.'
}

vps_stop() {
    echo -e "${YELLOW}Stopping VPS...${NC}" >&2
    api_call POST "/api/vps/v1/virtual-machines/$VPS_ID/stop" | jq '.'
}

vps_restart() {
    echo -e "${BLUE}Restarting VPS...${NC}" >&2
    api_call POST "/api/vps/v1/virtual-machines/$VPS_ID/restart" | jq '.'
}

vps_recreate() {
    local template_id="${1:-}"
    local password="${2:-}"
    local script_id="${3:-}"

    if [[ -z "$template_id" || -z "$password" ]]; then
        echo "Usage: hostinger.sh vps recreate <template_id> <password> [script_id]"
        echo "Example: hostinger.sh vps recreate 1183 'MyPassword123'"
        return 1
    fi

    echo -e "${YELLOW}WARNING: This will DESTROY all data on the VPS!${NC}" >&2
    echo -e "${BLUE}Recreating VPS (template: $template_id)...${NC}" >&2

    local data
    data=$(jq -n \
        --arg tid "$template_id" \
        --arg pw "$password" \
        '{template_id: ($tid | tonumber), password: $pw}')

    if [[ -n "$script_id" ]]; then
        data=$(echo "$data" | jq --arg sid "$script_id" \
            '. + {post_install_script_id: ($sid | tonumber)}')
    fi

    local response
    response=$(api_call POST "/api/vps/v1/virtual-machines/$VPS_ID/recreate" "$data")
    local action_id
    action_id=$(echo "$response" | jq -r '.id // empty')

    if [[ -n "$action_id" ]]; then
        echo -e "${GREEN}VPS recreation initiated (action: $action_id)${NC}" >&2
    fi
    echo "$response" | jq '.'
}

vps_snapshot() {
    local cmd="${1:-}"
    case "$cmd" in
        create)
            echo -e "${BLUE}Creating VPS snapshot...${NC}" >&2
            echo -e "${YELLOW}NOTE: New snapshot overwrites existing one${NC}" >&2
            api_call POST "/api/vps/v1/virtual-machines/$VPS_ID/snapshot" | jq '.'
            ;;
        get)
            echo -e "${BLUE}Fetching snapshot details...${NC}" >&2
            api_call GET "/api/vps/v1/virtual-machines/$VPS_ID/snapshot" | jq '.'
            ;;
        restore)
            echo -e "${YELLOW}Restoring VPS from snapshot...${NC}" >&2
            api_call POST "/api/vps/v1/virtual-machines/$VPS_ID/snapshot/restore" | jq '.'
            ;;
        *)
            echo "Usage: hostinger.sh vps snapshot <create|get|restore>"
            return 1
            ;;
    esac
}

vps_action() {
    local cmd="${1:-}"
    case "$cmd" in
        get)
            local action_id="${2:-}"
            if [[ -z "$action_id" ]]; then
                echo "Usage: hostinger.sh vps action get <action_id>"
                return 1
            fi
            api_call GET "/api/vps/v1/virtual-machines/$VPS_ID/actions/$action_id" | jq '.'
            ;;
        wait)
            local action_id="${2:-}"
            local max_wait="${3:-600}"
            if [[ -z "$action_id" ]]; then
                echo "Usage: hostinger.sh vps action wait <action_id> [timeout]"
                return 1
            fi
            vps_wait_action "$action_id" "$max_wait"
            ;;
        *)
            echo "Usage: hostinger.sh vps action <get|wait> <action_id>"
            return 1
            ;;
    esac
}

vps_wait_action() {
    local action_id="$1"
    local max_wait="${2:-600}"
    local elapsed=0
    local interval=5
    local max_interval=60

    echo -e "${BLUE}Waiting for action $action_id (timeout: ${max_wait}s)...${NC}" >&2

    while [[ $elapsed -lt $max_wait ]]; do
        local response status
        response=$(api_call GET "/api/vps/v1/virtual-machines/$VPS_ID/actions/$action_id" 2>/dev/null)
        status=$(echo "$response" | jq -r '.state // empty')

        case "$status" in
            success)
                echo -e "${GREEN}Action completed after ${elapsed}s${NC}" >&2
                echo "$response" | jq '.'
                return 0
                ;;
            failed)
                echo -e "${RED}Action failed after ${elapsed}s${NC}" >&2
                echo "$response" | jq '.'
                return 1
                ;;
            started|running|pending)
                echo -e "${YELLOW}$status (${elapsed}s/${max_wait}s, next: ${interval}s)${NC}" >&2
                ;;
            *)
                echo -e "${YELLOW}Unknown: $status (${elapsed}s/${max_wait}s)${NC}" >&2
                ;;
        esac

        sleep "$interval"
        elapsed=$((elapsed + interval))
        interval=$((interval * 2 > max_interval ? max_interval : interval * 2))
    done

    echo -e "${RED}Timed out after ${max_wait}s${NC}" >&2
    return 1
}

vps_actions() {
    echo -e "${BLUE}Listing recent actions...${NC}" >&2
    api_call GET "/api/vps/v1/virtual-machines/$VPS_ID/actions" | jq '.'
}

vps_metrics() {
    echo -e "${BLUE}Fetching VPS metrics...${NC}" >&2
    api_call GET "/api/vps/v1/virtual-machines/$VPS_ID/metrics" | jq '.'
}

vps_scripts() {
    echo -e "${BLUE}Listing post-install scripts...${NC}" >&2
    api_call GET "/api/vps/v1/post-install-scripts" | jq '.'
}

# ---------------------------------------------------------------------------
# DNS commands
# ---------------------------------------------------------------------------

dns_get() {
    echo -e "${BLUE}Fetching DNS records for $DOMAIN...${NC}" >&2
    api_call GET "/api/dns/v1/zones/$DOMAIN" | jq '.'
}

dns_update() {
    local input="${1:-}"
    if [[ -z "$input" ]]; then
        echo "Usage: hostinger.sh dns update <json_file_or_inline_json>"
        echo "Example: hostinger.sh dns update records.json"
        return 1
    fi

    local payload
    if [[ -f "$input" ]]; then
        payload=$(cat "$input")
    else
        payload="$input"
    fi

    echo -e "${BLUE}Updating DNS records for $DOMAIN...${NC}" >&2
    api_call PUT "/api/dns/v1/zones/$DOMAIN" "$payload" | jq '.'
}

dns_validate() {
    local input="${1:-}"
    if [[ -z "$input" ]]; then
        echo "Usage: hostinger.sh dns validate <json_file_or_inline_json>"
        return 1
    fi

    local payload
    if [[ -f "$input" ]]; then
        payload=$(cat "$input")
    else
        payload="$input"
    fi

    echo -e "${BLUE}Validating DNS records for $DOMAIN...${NC}" >&2
    if api_call POST "/api/dns/v1/zones/$DOMAIN/validate" "$payload" | jq '.'; then
        echo -e "${GREEN}Validation passed${NC}" >&2
    else
        echo -e "${RED}Validation failed${NC}" >&2
        return 1
    fi
}

dns_delete() {
    local name="${1:-}"
    local type="${2:-}"

    if [[ -z "$name" || -z "$type" ]]; then
        echo "Usage: hostinger.sh dns delete <name> <type>"
        echo "Example: hostinger.sh dns delete www A"
        return 1
    fi

    local payload
    payload=$(jq -n \
        --arg name "$name" \
        --arg type "$type" \
        '{zone: [{name: $name, type: $type}]}')

    echo -e "${YELLOW}Deleting $type record for $name.$DOMAIN...${NC}" >&2
    api_call DELETE "/api/dns/v1/zones/$DOMAIN" "$payload" | jq '.'
}

dns_reset() {
    echo -e "${RED}WARNING: This will reset ALL DNS records to defaults!${NC}" >&2
    api_call POST "/api/dns/v1/zones/$DOMAIN/reset" | jq '.'
}

dns_sync() {
    local vps_ip="${1:-}"
    local tailscale_ip="${2:-}"

    # If IPs not passed as args, read from SOPS secrets
    if [[ -z "$vps_ip" ]]; then
        vps_ip=$(sops --decrypt "$PROJECT_ROOT/infra/secrets/prod.enc.env" 2>/dev/null \
            | grep "^VPS_IP=" | cut -d'=' -f2 | tr -d '"')
    fi
    if [[ -z "$tailscale_ip" ]]; then
        tailscale_ip=$(sops --decrypt "$PROJECT_ROOT/infra/secrets/prod.enc.env" 2>/dev/null \
            | grep "^TAILSCALE_IP=" | cut -d'=' -f2 | tr -d '"')
    fi

    echo -e "${BLUE}Syncing DNS A records...${NC}" >&2

    if [[ -z "$vps_ip" ]]; then
        echo -e "${RED}ERROR: VPS_IP not found in secrets${NC}" >&2
        return 1
    fi
    if [[ -z "$tailscale_ip" ]]; then
        echo -e "${RED}ERROR: TAILSCALE_IP not found in secrets${NC}" >&2
        return 1
    fi

    echo -e "${BLUE}  Public IP:    $vps_ip${NC}" >&2
    echo -e "${BLUE}  Tailscale IP: $tailscale_ip${NC}" >&2

    # Fetch current records and check if update needed
    local current_records
    current_records=$(api_call GET "/api/dns/v1/zones/$DOMAIN")

    local needs_update=false
    for pair in "@:$vps_ip" "api:$vps_ip" "ai:$vps_ip" "portainer:$tailscale_ip" "traefik:$tailscale_ip"; do
        local name="${pair%%:*}"
        local expected="${pair##*:}"
        local current
        current=$(echo "$current_records" | jq -r \
            ".[] | select(.name==\"$name\" and .type==\"A\") | .records[0].content" 2>/dev/null || echo "")

        if [[ "$current" == "$expected" ]]; then
            echo -e "  ${GREEN}$name.$DOMAIN -> $expected${NC}" >&2
        else
            echo -e "  ${YELLOW}$name.$DOMAIN -> $current (expected $expected)${NC}" >&2
            needs_update=true
        fi
    done

    if [[ "$needs_update" == "false" ]]; then
        echo -e "${GREEN}All DNS records are correct. No update needed.${NC}" >&2
        return 0
    fi

    # Build and validate payload
    local payload
    payload=$(jq -n \
        --arg vps "$vps_ip" \
        --arg ts "$tailscale_ip" \
        '{
            domain: "hill90.com",
            overwrite: true,
            zone: [
                {name: "@",         type: "A", ttl: 3600, records: [{content: $vps}]},
                {name: "api",       type: "A", ttl: 3600, records: [{content: $vps}]},
                {name: "ai",        type: "A", ttl: 3600, records: [{content: $vps}]},
                {name: "portainer", type: "A", ttl: 3600, records: [{content: $ts}]},
                {name: "traefik",   type: "A", ttl: 3600, records: [{content: $ts}]}
            ]
        }')

    echo -e "${BLUE}Validating...${NC}" >&2
    if ! api_call POST "/api/dns/v1/zones/$DOMAIN/validate" "$payload" > /dev/null; then
        echo -e "${RED}Validation failed${NC}" >&2
        return 1
    fi
    echo -e "${GREEN}Validation passed${NC}" >&2

    echo -e "${BLUE}Applying DNS update...${NC}" >&2
    api_call PUT "/api/dns/v1/zones/$DOMAIN" "$payload" > /dev/null

    echo -e "${GREEN}DNS records updated successfully${NC}" >&2
    echo -e "${YELLOW}Propagation takes 5-10 minutes${NC}" >&2
}

dns_verify() {
    local expected_ip="${1:-}"

    # Try to get expected IP from secrets if not passed
    if [[ -z "$expected_ip" ]]; then
        expected_ip=$(sops --decrypt "$PROJECT_ROOT/infra/secrets/prod.enc.env" 2>/dev/null \
            | grep "^VPS_IP=" | cut -d'=' -f2 | tr -d '"' || true)
    fi

    if [[ -n "$expected_ip" ]]; then
        echo -e "${BLUE}Verifying DNS propagation (expected: $expected_ip)...${NC}" >&2
    else
        echo -e "${BLUE}Verifying DNS propagation...${NC}" >&2
    fi
    echo "" >&2

    for host in "$DOMAIN" "www.$DOMAIN" "api.$DOMAIN" "ai.$DOMAIN"; do
        local resolved
        resolved=$(dig +short "$host" 2>/dev/null | head -n1)
        if [[ -n "$expected_ip" && "$resolved" == "$expected_ip" ]]; then
            echo -e "  ${GREEN}$host -> $resolved${NC}" >&2
        elif [[ -n "$resolved" ]]; then
            if [[ -n "$expected_ip" ]]; then
                echo -e "  ${YELLOW}$host -> $resolved (expected $expected_ip)${NC}" >&2
            else
                echo -e "  ${BLUE}$host -> $resolved${NC}" >&2
            fi
        else
            echo -e "  ${RED}$host -> (no record)${NC}" >&2
        fi
    done
}

dns_snapshot() {
    local cmd="${1:-}"
    case "$cmd" in
        list)
            echo -e "${BLUE}Listing DNS snapshots for $DOMAIN...${NC}" >&2
            api_call GET "/api/dns/v1/snapshots/$DOMAIN" | jq '.'
            ;;
        get)
            local snapshot_id="${2:-}"
            if [[ -z "$snapshot_id" ]]; then
                echo "Usage: hostinger.sh dns snapshot get <snapshot_id>"
                return 1
            fi
            api_call GET "/api/dns/v1/snapshots/$DOMAIN/$snapshot_id" | jq '.'
            ;;
        restore)
            local snapshot_id="${2:-}"
            if [[ -z "$snapshot_id" ]]; then
                echo "Usage: hostinger.sh dns snapshot restore <snapshot_id>"
                return 1
            fi
            echo -e "${YELLOW}Restoring DNS from snapshot $snapshot_id...${NC}" >&2
            api_call POST "/api/dns/v1/snapshots/$DOMAIN/$snapshot_id/restore" | jq '.'
            ;;
        *)
            echo "Usage: hostinger.sh dns snapshot <list|get|restore> [snapshot_id]"
            return 1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Hostinger CLI — VPS and DNS management for $DOMAIN

Usage: hostinger.sh <service> <command> [args]

VPS Commands:
  vps get                                    Get VPS details
  vps start                                  Start VPS
  vps stop                                   Stop VPS
  vps restart                                Restart VPS
  vps recreate <template_id> <pass> [script] Recreate VPS OS (DESTRUCTIVE)
  vps snapshot <create|get|restore>          Manage VPS snapshots
  vps action get <action_id>                 Get action status
  vps action wait <action_id> [timeout]      Wait for action to complete
  vps actions                                List recent actions
  vps metrics                                Get VPS metrics
  vps scripts                                List post-install scripts

DNS Commands:
  dns get                                    Get all DNS records
  dns update <json_file_or_json>             Update DNS records
  dns validate <json_file_or_json>           Validate records before applying
  dns delete <name> <type>                   Delete specific record
  dns reset                                  Reset to defaults (DESTRUCTIVE)
  dns sync [vps_ip] [tailscale_ip]            Sync A records (args or from secrets)
  dns verify                                 Verify DNS propagation with dig
  dns snapshot <list|get|restore> [id]       Manage DNS snapshots

Environment:
  HOSTINGER_API_KEY    API key (loaded from secrets if not set)
  HOSTINGER_VPS_ID     VPS ID (default: $VPS_ID)
  HOSTINGER_DOMAIN     Domain (default: $DOMAIN)
EOF
}

# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

main() {
    if [[ $# -lt 1 ]]; then
        usage
        exit 0
    fi

    local service="$1"
    shift

    case "$service" in
        vps)
            local cmd="${1:-}"
            shift 2>/dev/null || true
            case "$cmd" in
                get)        vps_get ;;
                start)      vps_start ;;
                stop)       vps_stop ;;
                restart)    vps_restart ;;
                recreate)   vps_recreate "$@" ;;
                snapshot)   vps_snapshot "$@" ;;
                action)     vps_action "$@" ;;
                actions)    vps_actions ;;
                metrics)    vps_metrics ;;
                scripts)    vps_scripts ;;
                *)
                    echo "Unknown vps command: $cmd"
                    echo "Run: hostinger.sh vps"
                    exit 1
                    ;;
            esac
            ;;
        dns)
            local cmd="${1:-}"
            shift 2>/dev/null || true
            case "$cmd" in
                get)        dns_get ;;
                update)     dns_update "$@" ;;
                validate)   dns_validate "$@" ;;
                delete)     dns_delete "$@" ;;
                reset)      dns_reset ;;
                sync)       dns_sync "$@" ;;
                verify)     dns_verify "$@" ;;
                snapshot)   dns_snapshot "$@" ;;
                *)
                    echo "Unknown dns command: $cmd"
                    echo "Run: hostinger.sh dns"
                    exit 1
                    ;;
            esac
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            echo "Unknown service: $service"
            usage
            exit 1
            ;;
    esac
}

main "$@"
