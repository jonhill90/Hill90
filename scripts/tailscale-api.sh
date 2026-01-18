#!/usr/bin/env bash
# Tailscale API helper functions
# Replaces Terraform-based Tailscale management with direct API calls

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

# Tailscale configuration
TAILNET="${TAILSCALE_TAILNET:-}"
API_KEY="${TAILSCALE_API_KEY:-}"

if [[ -z "$TAILNET" || -z "$API_KEY" ]]; then
    echo -e "${RED}ERROR: TAILSCALE_TAILNET and TAILSCALE_API_KEY must be set in secrets${NC}"
    exit 1
fi

# Generate a pre-authorized auth key for VPS
# Returns: auth key string
generate_auth_key() {
    echo -e "${BLUE}Generating Tailscale auth key...${NC}"

    local response
    response=$(curl -s -X POST "https://api.tailscale.com/api/v2/tailnet/$TAILNET/keys" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        --data '{
            "capabilities": {
                "devices": {
                    "create": {
                        "reusable": false,
                        "ephemeral": false,
                        "preauthorized": true,
                        "tags": ["tag:server", "tag:hill90"]
                    }
                }
            },
            "expirySeconds": 7776000
        }')

    local key
    key=$(echo "$response" | jq -r '.key // empty')

    if [[ -z "$key" ]]; then
        echo -e "${RED}ERROR: Failed to generate auth key${NC}"
        echo "Response: $response"
        return 1
    fi

    echo -e "${GREEN}✓ Auth key generated${NC}"
    echo "$key"
}

# Get Tailscale IP for a device by hostname
# Args: $1 = hostname (e.g., "hill90-vps")
# Returns: Tailscale IP (IPv4)
get_device_ip() {
    local hostname="${1:-hill90-vps}"

    echo -e "${BLUE}Querying Tailscale API for device: $hostname${NC}"

    local response
    response=$(curl -s -H "Authorization: Bearer $API_KEY" \
        "https://api.tailscale.com/api/v2/tailnet/$TAILNET/devices")

    local ip
    ip=$(echo "$response" | jq -r --arg hostname "$hostname" \
        '.devices[] | select(.hostname==$hostname) | .addresses[0] // empty')

    if [[ -z "$ip" ]]; then
        echo -e "${YELLOW}WARNING: Device $hostname not found in Tailscale network${NC}"
        return 1
    fi

    echo -e "${GREEN}✓ Found device $hostname: $ip${NC}"
    echo "$ip"
}

# Wait for device to appear in Tailscale network
# Args: $1 = hostname, $2 = max wait time in seconds (default: 120)
# Returns: Tailscale IP when device appears
wait_for_device() {
    local hostname="${1:-hill90-vps}"
    local max_wait="${2:-120}"
    local elapsed=0
    local interval=5

    echo -e "${BLUE}Waiting for device $hostname to appear in Tailscale network...${NC}"

    while [[ $elapsed -lt $max_wait ]]; do
        local ip
        if ip=$(get_device_ip "$hostname" 2>/dev/null); then
            echo -e "${GREEN}✓ Device online after ${elapsed}s${NC}"
            echo "$ip"
            return 0
        fi

        echo -e "${YELLOW}Device not yet online, waiting... (${elapsed}s/${max_wait}s)${NC}"
        sleep $interval
        elapsed=$((elapsed + interval))
    done

    echo -e "${RED}ERROR: Device did not appear within ${max_wait}s${NC}"
    return 1
}

# Delete a device by hostname
# Args: $1 = hostname
delete_device() {
    local hostname="${1:-hill90-vps}"

    echo -e "${BLUE}Finding device ID for: $hostname${NC}"

    local response
    response=$(curl -s -H "Authorization: Bearer $API_KEY" \
        "https://api.tailscale.com/api/v2/tailnet/$TAILNET/devices")

    local device_id
    device_id=$(echo "$response" | jq -r --arg hostname "$hostname" \
        '.devices[] | select(.hostname==$hostname) | .id // empty')

    if [[ -z "$device_id" ]]; then
        echo -e "${YELLOW}Device $hostname not found, nothing to delete${NC}"
        return 0
    fi

    echo -e "${BLUE}Deleting device ID: $device_id${NC}"

    curl -s -X DELETE \
        -H "Authorization: Bearer $API_KEY" \
        "https://api.tailscale.com/api/v2/device/$device_id"

    echo -e "${GREEN}✓ Device deleted${NC}"
}

# CLI usage
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    case "${1:-}" in
        generate-key)
            generate_auth_key
            ;;
        get-ip)
            get_device_ip "${2:-hill90-vps}"
            ;;
        wait-for-device)
            wait_for_device "${2:-hill90-vps}" "${3:-120}"
            ;;
        delete-device)
            delete_device "${2:-hill90-vps}"
            ;;
        *)
            echo "Usage: $0 {generate-key|get-ip|wait-for-device|delete-device} [hostname] [timeout]"
            echo ""
            echo "Commands:"
            echo "  generate-key              Generate a new auth key for VPS"
            echo "  get-ip [hostname]         Get Tailscale IP for device (default: hill90-vps)"
            echo "  wait-for-device [hostname] [timeout]  Wait for device to appear (default: 120s)"
            echo "  delete-device [hostname]  Delete device from Tailscale network"
            exit 1
            ;;
    esac
fi
