#!/usr/bin/env bash
# VPS CLI — VPS lifecycle management (recreate, config)
# Usage: vps.sh {recreate|config} [args]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
VPS CLI — Hill90 VPS lifecycle management

Usage: vps.sh <command> [args]

Commands:
  recreate              Rebuild VPS via API (DESTRUCTIVE, auto-rotates Tailscale key)
  config   <vps_ip>     Configure VPS OS via Ansible (no containers)
  help                  Show this help message
EOF
}

# ---------------------------------------------------------------------------
# Tailscale API functions (absorbed from tailscale-api.sh)
# ---------------------------------------------------------------------------

_ensure_tailscale_secrets() {
    if [[ -z "${TAILSCALE_API_KEY:-}" || -z "${TAILSCALE_TAILNET:-}" ]]; then
        load_secrets
    fi
    [[ -n "${TAILSCALE_TAILNET:-}" ]] || die "TAILSCALE_TAILNET not set in secrets"
    [[ -n "${TAILSCALE_API_KEY:-}" ]] || die "TAILSCALE_API_KEY not set in secrets"
}

_tailscale_generate_key() {
    _ensure_tailscale_secrets

    info "Generating Tailscale auth key..."

    local response key
    response=$(curl -s -X POST "https://api.tailscale.com/api/v2/tailnet/$TAILSCALE_TAILNET/keys" \
        -H "Authorization: Bearer $TAILSCALE_API_KEY" \
        -H "Content-Type: application/json" \
        --data '{
            "capabilities": {
                "devices": {
                    "create": {
                        "reusable": false,
                        "ephemeral": false,
                        "preauthorized": true
                    }
                }
            },
            "expirySeconds": 7776000
        }')

    key=$(echo "$response" | jq -r '.key // empty')
    [[ -n "$key" ]] || die "Failed to generate auth key. Response: $response"

    success "✓ Auth key generated"
    echo "$key"
}

# ---------------------------------------------------------------------------
# recreate
# ---------------------------------------------------------------------------

cmd_recreate() {
    echo -e "${BOLD}VPS Rebuild Workflow${NC}"
    echo ""

    # Step 1: Rotate Tailscale auth key
    info "Step 1/3: Rotating Tailscale auth key..."

    local auth_key
    if ! auth_key=$(_tailscale_generate_key 2>&1 | tail -1); then
        die "Failed to generate Tailscale auth key"
    fi

    success "✓ Auth key generated"

    info "Updating secrets with new auth key..."
    if ! bash "$SCRIPT_DIR/secrets.sh" update infra/secrets/prod.enc.env "TAILSCALE_AUTH_KEY" "$auth_key"; then
        die "Failed to update secrets"
    fi
    success "✓ Secrets updated"
    echo ""

    # Step 2: Generate root password
    info "Step 2/3: Generating root password..."
    local root_password="Hill90VPS-$(openssl rand -base64 18 | tr -d '/+=')"
    success "✓ Password generated"
    echo ""

    # Step 3: Configuration
    info "Step 3/3: Configuration..."
    success "Configuration:"
    echo "  Template: AlmaLinux 10 (1183)"
    echo "  Post-install script: none (Ansible will handle all setup)"
    echo "  Tailscale: Auth key rotated"
    echo ""

    # Step 4: Rebuild VPS
    echo -e "${YELLOW}Starting VPS rebuild via Hostinger API...${NC}"
    echo ""

    local output
    output=$(bash "$SCRIPT_DIR/hostinger.sh" vps recreate 1183 "$root_password")
    if [[ $? -ne 0 ]]; then
        die "VPS rebuild failed"
    fi

    local action_id
    action_id=$(echo "$output" | tail -1 | jq -r '.id // empty')
    [[ -n "$action_id" ]] || die "Could not extract action ID from response"

    success "✓ VPS rebuild initiated (action ID: $action_id)"
    echo ""

    # Step 5: Wait for rebuild to complete
    info "Step 4/4: Waiting for VPS rebuild to complete (~5 minutes)..."
    if ! bash "$SCRIPT_DIR/hostinger.sh" vps action wait "$action_id" 600; then
        die "VPS rebuild action failed or timed out"
    fi

    echo ""
    success "✓ VPS rebuild completed successfully!"
    echo ""

    # Step 6: Get new VPS IP
    info "Retrieving new VPS IP address..."
    local details new_ip
    details=$(bash "$SCRIPT_DIR/hostinger.sh" vps get 2>/dev/null)
    new_ip=$(echo "$details" | tail -1 | jq -r '.ipv4[0].address // empty')

    [[ -n "$new_ip" ]] || die "Could not retrieve VPS IP. Run: bash scripts/hostinger.sh vps get | jq -r '.ipv4[0].address'"

    success "✓ New VPS IP: $new_ip"
    echo ""

    # Update VPS_IP secret
    info "Updating VPS_IP secret..."
    if bash "$SCRIPT_DIR/secrets.sh" update infra/secrets/prod.enc.env "VPS_IP" "$new_ip"; then
        success "✓ VPS_IP secret updated"
    else
        warn "Failed to update VPS_IP secret automatically"
        echo -e "${YELLOW}Run manually: make secrets-update KEY=VPS_IP VALUE=\"$new_ip\"${NC}"
    fi
    echo ""

    echo -e "${GREEN}${BOLD}VPS rebuild complete!${NC}"
    echo ""
    echo -e "${YELLOW}Next step: Bootstrap the VPS with Ansible${NC}"
    echo -e "${BOLD}  make config-vps VPS_IP=$new_ip${NC}"
    echo ""
}

# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

cmd_config() {
    local vps_ip="${1:-}"
    if [[ -z "$vps_ip" ]]; then
        die "VPS_IP is required. Usage: vps.sh config <vps_ip>"
    fi

    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}           VPS Configuration (Ansible Bootstrap)               ${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${BLUE}VPS IP:${NC} $vps_ip"
    echo ""

    # Load secrets only if not already set
    if [[ -z "${TAILSCALE_AUTH_KEY:-}" ]]; then
        load_secrets
    fi

    # Step 1: Run Ansible bootstrap
    echo -e "${CYAN}[1/3] Running Ansible bootstrap (this may take 5-10 minutes)...${NC}"
    echo -e "${YELLOW}   Installing: Docker, SOPS, age, Tailscale, SSH hardening${NC}"
    echo -e "${YELLOW}   Deploying: Traefik, Portainer (Tailscale-only access)${NC}"
    echo ""

    export TAILSCALE_AUTH_KEY

    echo -e "${CYAN}Loading secrets from encrypted file...${NC}"
    local traefik_hash hostinger_key existing_ts_ip
    traefik_hash=$(cd "$PROJECT_ROOT" && sops -d --extract '["TRAEFIK_ADMIN_PASSWORD_HASH"]' infra/secrets/prod.enc.env)
    hostinger_key=$(cd "$PROJECT_ROOT" && sops -d --extract '["HOSTINGER_API_KEY"]' infra/secrets/prod.enc.env)
    existing_ts_ip=$(cd "$PROJECT_ROOT" && sops -d --extract '["TAILSCALE_IP"]' infra/secrets/prod.enc.env 2>/dev/null || echo "")

    local ansible_host
    if [ -n "$existing_ts_ip" ]; then
        ansible_host="$existing_ts_ip"
        echo -e "${YELLOW}Using Tailscale IP for SSH (public SSH is locked down): $ansible_host${NC}"
    else
        ansible_host="$vps_ip"
        echo -e "${YELLOW}Using public IP for SSH (initial bootstrap): $ansible_host${NC}"
    fi
    echo ""

    cd "$PROJECT_ROOT/infra/ansible"
    local ansible_output
    ansible_output=$(mktemp)
    if ansible-playbook -i "inventory/hosts.yml" \
                     -e "ansible_host=$ansible_host" \
                     -e "ansible_user=root" \
                     -e "ansible_ssh_private_key_file=~/.ssh/remote.hill90.com" \
                     -e "ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'" \
                     -e "traefik_admin_password_hash=$traefik_hash" \
                     -e "hostinger_api_key=$hostinger_key" \
                     playbooks/bootstrap.yml 2>&1 | tee "$ansible_output"; then
        echo ""
        success "   ✓ Ansible bootstrap complete"
    else
        echo ""
        echo -e "${RED}   ✗ Ansible bootstrap failed${NC}"
        echo -e "${YELLOW}   You can re-run this script to try again (it's idempotent)${NC}"
        echo -e "${YELLOW}   Command: make config-vps VPS_IP=$vps_ip${NC}"
        rm -f "$ansible_output"
        exit 1
    fi
    echo ""

    # Step 2: Extract Tailscale IP
    echo -e "${CYAN}[2/3] Extracting Tailscale IP from Ansible output...${NC}"
    local tailscale_ip
    tailscale_ip=$(grep -o 'TAILSCALE_IP=[0-9.]*' "$ansible_output" | head -1 | cut -d= -f2 || echo "")
    rm -f "$ansible_output"

    if [ -z "$tailscale_ip" ]; then
        echo -e "${RED}   ✗ Could not extract Tailscale IP from Ansible output${NC}"
        echo -e "${YELLOW}   Please check manually and update secrets:${NC}"
        echo -e "${YELLOW}   make secrets-update KEY=TAILSCALE_IP VALUE=<ip>${NC}"
        exit 1
    fi

    success "   ✓ Tailscale IP: $tailscale_ip"
    echo ""

    # Step 3: Update TAILSCALE_IP in secrets
    echo -e "${CYAN}[3/3] Updating TAILSCALE_IP and VPS_HOST in encrypted secrets...${NC}"
    cd "$PROJECT_ROOT"
    make secrets-update KEY=TAILSCALE_IP VALUE="$tailscale_ip" > /dev/null 2>&1
    success "   ✓ TAILSCALE_IP updated"
    make secrets-update KEY=VPS_HOST VALUE="$tailscale_ip" > /dev/null 2>&1
    success "   ✓ VPS_HOST updated (SSH via Tailscale)"
    echo ""

    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              VPS CONFIGURATION COMPLETE!                      ║${NC}"
    echo -e "${GREEN}╠═══════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║${NC} VPS Public IP:     ${CYAN}$vps_ip${NC}"
    echo -e "${GREEN}║${NC} VPS Tailscale IP:  ${CYAN}$tailscale_ip${NC}"
    echo -e "${GREEN}║${NC}                                                               ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC} Next Steps:                                                   ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}   1. Deploy infrastructure: ${YELLOW}make deploy-infra${NC}"
    echo -e "${GREEN}║${NC}   2. Deploy services: ${YELLOW}make deploy-all${NC}"
    echo -e "${GREEN}║${NC}   3. Verify health: ${YELLOW}make health${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
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
        recreate)       cmd_recreate "$@" ;;
        config)         cmd_config "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
