#!/usr/bin/env bash
set -euo pipefail

# Secure, idempotent DNS record updater for Hostinger API
# Updates DNS A records for VPS services after VPS recreate

DOMAIN="hill90.com"
API_BASE="https://developers.hostinger.com/api/dns/v1"

# Check for jq and install if missing (GitHub Actions runner)
if ! command -v jq &> /dev/null; then
    echo "Installing jq..."
    sudo apt-get update -qq && sudo apt-get install -y -qq jq > /dev/null 2>&1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;36m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Validate inputs
if [[ -z "${HOSTINGER_API_KEY:-}" ]]; then
    log_error "HOSTINGER_API_KEY environment variable is required"
    exit 1
fi

if [[ $# -ne 2 ]]; then
    log_error "Usage: $0 <VPS_IP> <TAILSCALE_IP>"
    exit 1
fi

VPS_IP="$1"
TAILSCALE_IP="$2"

# Validate IP addresses
if ! [[ "$VPS_IP" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    log_error "Invalid VPS_IP format: $VPS_IP"
    exit 1
fi

if ! [[ "$TAILSCALE_IP" =~ ^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    log_error "Invalid TAILSCALE_IP format (must be in 100.x.x.x range): $TAILSCALE_IP"
    exit 1
fi

log_info "Updating DNS records for $DOMAIN"
log_info "  VPS IP (public):      $VPS_IP"
log_info "  Tailscale IP (private): $TAILSCALE_IP"
echo ""

# Function to call Hostinger API
api_call() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"

    local url="${API_BASE}${endpoint}"
    local response
    local http_code

    if [[ -n "$data" ]]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" \
            -H "Authorization: Bearer ${HOSTINGER_API_KEY}" \
            -H "Content-Type: application/json" \
            -d "$data")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" \
            -H "Authorization: Bearer ${HOSTINGER_API_KEY}")
    fi

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
        echo "$body"
        return 0
    else
        log_error "API call failed with HTTP $http_code"
        echo "$body" | jq '.' 2>/dev/null || echo "$body"
        return 1
    fi
}

# Get current DNS records
log_step "Fetching current DNS records..."
current_records=$(api_call GET "/zones/$DOMAIN" 2>&1) || {
    log_error "Failed to fetch current DNS records. API response:"
    echo "$current_records"
    exit 1
}

# Check if records need updating (idempotency check)
needs_update=false

check_record() {
    local name="$1"
    local expected_ip="$2"

    current_ip=$(echo "$current_records" | jq -r ".[] | select(.name==\"$name\" and .type==\"A\") | .records[0].content" 2>/dev/null || echo "")

    if [[ "$current_ip" == "$expected_ip" ]]; then
        log_info "  ✓ $name.$DOMAIN already points to $expected_ip"
        return 0
    else
        log_warn "  ⚠ $name.$DOMAIN points to $current_ip (expected $expected_ip)"
        needs_update=true
        return 1
    fi
}

log_step "Checking if DNS records need updating..."
check_record "@" "$VPS_IP" || true
check_record "api" "$VPS_IP" || true
check_record "ai" "$VPS_IP" || true
check_record "portainer" "$TAILSCALE_IP" || true
check_record "traefik" "$TAILSCALE_IP" || true

if [[ "$needs_update" == "false" ]]; then
    log_info ""
    log_info "✅ All DNS records are already correct. No updates needed."
    exit 0
fi

echo ""
log_step "Preparing DNS update payload..."

# Build JSON payload for DNS update
# Only update A records, preserve all other record types
dns_payload=$(cat <<EOF
{
  "domain": "$DOMAIN",
  "overwrite": true,
  "zone": [
    {
      "name": "@",
      "type": "A",
      "ttl": 3600,
      "records": [{"content": "$VPS_IP"}]
    },
    {
      "name": "api",
      "type": "A",
      "ttl": 3600,
      "records": [{"content": "$VPS_IP"}]
    },
    {
      "name": "ai",
      "type": "A",
      "ttl": 3600,
      "records": [{"content": "$VPS_IP"}]
    },
    {
      "name": "portainer",
      "type": "A",
      "ttl": 3600,
      "records": [{"content": "$TAILSCALE_IP"}]
    },
    {
      "name": "traefik",
      "type": "A",
      "ttl": 3600,
      "records": [{"content": "$TAILSCALE_IP"}]
    }
  ]
}
EOF
)

# Validate DNS records before applying
log_step "Validating DNS records..."
validation_response=$(api_call POST "/zones/$DOMAIN/validate" "$dns_payload" 2>&1) || {
    log_error "DNS validation failed. API response:"
    echo "$validation_response"
    exit 1
}
log_info "  ✓ DNS records validation passed"

# Apply DNS update
log_step "Applying DNS updates..."
update_response=$(api_call POST "/zones/$DOMAIN" "$dns_payload" 2>&1) || {
    log_error "Failed to update DNS records. API response:"
    echo "$update_response"
    exit 1
}
log_info "  ✓ DNS records updated successfully"

echo ""
log_info "✅ DNS update complete!"
log_info ""
log_info "Updated records:"
log_info "  $DOMAIN              → $VPS_IP"
log_info "  api.$DOMAIN          → $VPS_IP"
log_info "  ai.$DOMAIN           → $VPS_IP"
log_info "  portainer.$DOMAIN    → $TAILSCALE_IP"
log_info "  traefik.$DOMAIN      → $TAILSCALE_IP"
log_info ""
log_info "⏱  DNS propagation typically takes 5-10 minutes"
