#!/usr/bin/env bash
# Hostinger CLI for VPS management
# Usage: hostinger.sh <service> <command> [args]
#
# DNS lives in scripts/cloudflare.sh. hill90.com moved to Cloudflare; Hostinger
# remains the VPS host and the mail provider, and this file covers only the VPS.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# Configuration
API_BASE="${HOSTINGER_API_BASE:-https://developers.hostinger.com}"
VPS_ID="${HOSTINGER_VPS_ID:-1264324}"

# Load secrets and validate API key (called lazily, not at startup)
_secrets_loaded=false
ensure_api_key() {
    if [[ "$_secrets_loaded" == "true" ]]; then return 0; fi
    _secrets_loaded=true

    if [[ -z "${HOSTINGER_API_KEY:-}" ]]; then
        load_secrets
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
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Hostinger CLI — VPS management

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

DNS:
  Moved to Cloudflare — see scripts/cloudflare.sh dns <get|sync|verify>

Environment:
  HOSTINGER_API_KEY    API key (loaded from secrets if not set)
  HOSTINGER_VPS_ID     VPS ID (default: $VPS_ID)
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
            echo "DNS moved to Cloudflare. Use: scripts/cloudflare.sh dns <get|sync|verify>" >&2
            echo "Hostinger remains the VPS host and the mail provider; this CLI is VPS-only." >&2
            exit 1
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
