#!/usr/bin/env bash
# Hostinger VPS API helper functions
# Provides direct API access for GitHub Actions automation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load secrets
source "$SCRIPT_DIR/load-secrets.sh"

# Hostinger API configuration
API_BASE="${HOSTINGER_API_BASE:-https://developers.hostinger.com}"
API_KEY="${HOSTINGER_API_KEY:-}"
VPS_ID="${HOSTINGER_VPS_ID:-1264324}"

if [[ -z "$API_KEY" ]]; then
    echo -e "${RED}ERROR: HOSTINGER_API_KEY must be set in secrets${NC}"
    echo -e "${YELLOW}To obtain an API key:${NC}"
    echo -e "${YELLOW}1. Login to Hostinger control panel${NC}"
    echo -e "${YELLOW}2. Navigate to API settings${NC}"
    echo -e "${YELLOW}3. Generate a new API key${NC}"
    echo -e "${YELLOW}4. Add to secrets: make secrets-update KEY=HOSTINGER_API_KEY VALUE='<key>'${NC}"
    exit 1
fi

# Get VPS details
# Returns: JSON response with VPS details
get_vps_details() {
    echo -e "${BLUE}Fetching VPS details for ID: $VPS_ID...${NC}"

    local response
    response=$(curl -s --max-time 30 --retry 3 --retry-delay 2 \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        "$API_BASE/api/vps/v1/virtual-machines/$VPS_ID")

    local state
    state=$(echo "$response" | jq -r '.state // empty')

    if [[ -z "$state" ]]; then
        echo -e "${RED}ERROR: Failed to fetch VPS details${NC}"
        echo "Response: $response"
        return 1
    fi

    echo -e "${GREEN}✓ VPS state: $state${NC}"
    echo "$response"
}

# Recreate VPS OS (DESTRUCTIVE!)
# Args: $1 = template_id, $2 = password, $3 = post_install_script_id (optional)
# Returns: JSON response with action details
recreate_vps() {
    local template_id="$1"
    local password="$2"
    local post_install_script_id="${3:-}"

    echo -e "${YELLOW}⚠️  WARNING: This will DESTROY all data on the VPS!${NC}"
    echo -e "${BLUE}Recreating VPS OS...${NC}"
    echo -e "${BLUE}  Template ID: $template_id${NC}"
    echo -e "${BLUE}  Post-install script: ${post_install_script_id:-none}${NC}"

    local data
    data=$(jq -n \
        --arg template_id "$template_id" \
        --arg password "$password" \
        '{
            template_id: ($template_id | tonumber),
            password: $password
        }')

    # Add post_install_script_id if provided
    if [[ -n "$post_install_script_id" ]]; then
        data=$(echo "$data" | jq --arg script_id "$post_install_script_id" \
            '. + {post_install_script_id: ($script_id | tonumber)}')
    fi

    local response
    response=$(curl -s --max-time 30 --retry 3 --retry-delay 2 -X POST \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "$data" \
        "$API_BASE/api/vps/v1/virtual-machines/$VPS_ID/recreate")

    local action_id
    action_id=$(echo "$response" | jq -r '.id // empty')

    if [[ -z "$action_id" ]]; then
        echo -e "${RED}ERROR: Failed to recreate VPS${NC}"
        echo "Response: $response"
        return 1
    fi

    echo -e "${GREEN}✓ VPS recreation initiated (action ID: $action_id)${NC}"
    echo -e "${YELLOW}Rebuild will take ~5 minutes${NC}"
    echo "$response"
}

# Create snapshot (backup)
# Returns: JSON response with snapshot details
create_snapshot() {
    echo -e "${BLUE}Creating VPS snapshot (backup)...${NC}"
    echo -e "${YELLOW}NOTE: Creating new snapshot will overwrite existing snapshot!${NC}"

    local response
    response=$(curl -s --max-time 30 --retry 3 --retry-delay 2 -X POST \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        "$API_BASE/api/vps/v1/virtual-machines/$VPS_ID/snapshot")

    local action_id
    action_id=$(echo "$response" | jq -r '.id // empty')

    if [[ -z "$action_id" ]]; then
        echo -e "${RED}ERROR: Failed to create snapshot${NC}"
        echo "Response: $response"
        return 1
    fi

    echo -e "${GREEN}✓ Snapshot creation initiated (action ID: $action_id)${NC}"
    echo "$response"
}

# Get snapshot details
# Returns: JSON response with snapshot info
get_snapshot() {
    echo -e "${BLUE}Fetching snapshot details...${NC}"

    local response
    response=$(curl -s --max-time 30 --retry 3 --retry-delay 2 \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        "$API_BASE/api/vps/v1/virtual-machines/$VPS_ID/snapshot")

    local size
    size=$(echo "$response" | jq -r '.size // empty')

    if [[ -z "$size" ]]; then
        echo -e "${YELLOW}No snapshot found${NC}"
    else
        echo -e "${GREEN}✓ Snapshot exists (size: $size MB)${NC}"
    fi

    echo "$response"
}

# List post-install scripts
# Returns: JSON response with script list
list_scripts() {
    echo -e "${BLUE}Listing post-install scripts...${NC}"

    local response
    response=$(curl -s --max-time 30 --retry 3 --retry-delay 2 \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        "$API_BASE/api/vps/v1/post-install-scripts")

    local count
    count=$(echo "$response" | jq '.data | length')

    echo -e "${GREEN}✓ Found $count post-install scripts${NC}"
    echo "$response"
}

# Get action status
# Args: $1 = action_id
# Returns: JSON response with action status
get_action_status() {
    local action_id="$1"

    echo -e "${BLUE}Fetching action status for ID: $action_id...${NC}"

    local response
    response=$(curl -s --max-time 30 --retry 3 --retry-delay 2 \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        "$API_BASE/api/vps/v1/virtual-machines/$VPS_ID/actions/$action_id")

    local status
    status=$(echo "$response" | jq -r '.status // empty')

    if [[ -z "$status" ]]; then
        echo -e "${RED}ERROR: Failed to fetch action status${NC}"
        echo "Response: $response"
        return 1
    fi

    echo -e "${GREEN}✓ Action status: $status${NC}"
    echo "$response"
}

# Wait for action to complete
# Args: $1 = action_id, $2 = max wait time in seconds (default: 600)
# Returns: Final action status
wait_for_action() {
    local action_id="$1"
    local max_wait="${2:-600}"
    local elapsed=0
    local interval=5  # Start with 5 second intervals
    local max_interval=60  # Cap at 60 seconds

    echo -e "${BLUE}Waiting for action $action_id to complete...${NC}"

    while [[ $elapsed -lt $max_wait ]]; do
        local response
        response=$(curl -s --max-time 30 --retry 3 --retry-delay 2 \
            -H "Authorization: Bearer $API_KEY" \
            -H "Content-Type: application/json" \
            "$API_BASE/api/vps/v1/virtual-machines/$VPS_ID/actions/$action_id")

        local status
        status=$(echo "$response" | jq -r '.status // empty')

        case "$status" in
            "completed")
                echo -e "${GREEN}✓ Action completed after ${elapsed}s${NC}"
                echo "$response"
                return 0
                ;;
            "failed")
                echo -e "${RED}ERROR: Action failed after ${elapsed}s${NC}"
                echo -e "${RED}Last known status: $status${NC}"
                echo -e "${RED}Action ID: $action_id${NC}"
                echo "$response"
                return 1
                ;;
            "running"|"pending")
                echo -e "${YELLOW}Action still $status... (${elapsed}s/${max_wait}s, next check in ${interval}s)${NC}"
                ;;
            *)
                echo -e "${YELLOW}Unknown status: $status (${elapsed}s/${max_wait}s)${NC}"
                ;;
        esac

        sleep $interval
        elapsed=$((elapsed + interval))

        # Exponential backoff: double interval each time, but cap at max_interval
        interval=$((interval * 2))
        if [[ $interval -gt $max_interval ]]; then
            interval=$max_interval
        fi
    done

    echo -e "${RED}ERROR: Action did not complete in ${max_wait} seconds${NC}"
    echo -e "${RED}Last known status: $status${NC}"
    echo -e "${RED}Action ID: $action_id${NC}"
    echo -e "${YELLOW}Check manually: bash scripts/hostinger-api.sh get-action $action_id${NC}"
    return 1
}

# CLI usage
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        get-details)
            get_vps_details
            ;;
        recreate)
            if [[ $# -lt 3 ]]; then
                echo "Usage: $0 recreate <template_id> <password> [post_install_script_id]"
                echo ""
                echo "Example:"
                echo "  $0 recreate 1183 'MySecurePassword123' 2395"
                exit 1
            fi
            recreate_vps "$2" "$3" "${4:-}"
            ;;
        snapshot)
            create_snapshot
            ;;
        get-snapshot)
            get_snapshot
            ;;
        list-scripts)
            list_scripts
            ;;
        get-action)
            if [[ $# -lt 2 ]]; then
                echo "Usage: $0 get-action <action_id>"
                exit 1
            fi
            get_action_status "$2"
            ;;
        wait-action)
            if [[ $# -lt 2 ]]; then
                echo "Usage: $0 wait-action <action_id> [timeout_seconds]"
                exit 1
            fi
            wait_for_action "$2" "${3:-600}"
            ;;
        *)
            echo "Hostinger VPS API Client"
            echo ""
            echo "Usage: $0 <command> [arguments]"
            echo ""
            echo "Commands:"
            echo "  get-details                           Get VPS details"
            echo "  recreate <template_id> <password> [script_id]  Recreate VPS OS (DESTRUCTIVE)"
            echo "  snapshot                              Create snapshot (backup)"
            echo "  get-snapshot                          Get snapshot details"
            echo "  list-scripts                          List post-install scripts"
            echo "  get-action <action_id>                Get action status"
            echo "  wait-action <action_id> [timeout]     Wait for action to complete"
            echo ""
            echo "Environment variables:"
            echo "  HOSTINGER_API_KEY    API key from Hostinger control panel (required)"
            echo "  HOSTINGER_VPS_ID     VPS ID (default: 1264324)"
            echo "  HOSTINGER_API_BASE   API base URL (default: https://api.hostinger.com)"
            exit 1
            ;;
    esac
fi
