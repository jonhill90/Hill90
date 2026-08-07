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
  harden-ssh [--check]  Re-apply firewall + SSH hardening only (02+04), against
                         the already-known TAILSCALE_IP — see h#681/h#786.
                         --check reports what would change without changing it.
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

    # Four genuinely different failure states used to collapse into one
    # message ("Failed to generate auth key. Response: $response") — or
    # worse, into nothing at all once cmd_recreate's own capture below
    # discarded it. "The API rejected us", "the API answered something we
    # could not parse", and "the API answered fine but with no key field"
    # each point at a different fix; a run that never reached the API at
    # all (DNS/TLS/connection failure) points at a fourth. Distinguished
    # here so whichever one happens is nameable from the log, not
    # re-diagnosed from scratch next time — which is what happened to the
    # run that surfaced this (recreate-vps.yml, 2026-06-14): the log shows
    # only a generic failure, and it is not possible to tell from it alone
    # whether the cause was an expired credential or something else.
    local http_code response_body response_file curl_exit=0
    response_file=$(mktemp)
    http_code=$(curl -sS -o "$response_file" -w '%{http_code}' -X POST \
        "https://api.tailscale.com/api/v2/tailnet/$TAILSCALE_TAILNET/keys" \
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
        }') || curl_exit=$?
    response_body=$(cat "$response_file" 2>/dev/null || true)
    rm -f "$response_file"

    if [[ "$curl_exit" -ne 0 ]]; then
        die "Could not reach the Tailscale API (curl exit ${curl_exit}) — DNS, TLS, or connection failure. No HTTP response was received, so this is not the API rejecting the request; the request never arrived."
    fi

    if [[ "$http_code" != "200" ]]; then
        die "Tailscale API rejected the request (HTTP ${http_code}). Response: ${response_body}"
    fi

    local key
    if ! key=$(printf '%s' "$response_body" | jq -r '.key // empty' 2>/dev/null); then
        die "Tailscale API returned HTTP 200 with a body that could not be parsed as JSON. Response: ${response_body}"
    fi

    [[ -n "$key" ]] || die "Tailscale API returned HTTP 200 with valid JSON but no 'key' field. Response: ${response_body}"

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

    # Deliberately NOT `2>&1 | tail -1`. _tailscale_generate_key sends every
    # info/success/die message to stderr and returns only the key on stdout,
    # so capturing stdout alone is enough — and it stops this step from
    # discarding _tailscale_generate_key's own specific failure message. The
    # old pattern mixed stdout and stderr, kept only the last combined line
    # in $auth_key, and then threw that value away on the failure branch in
    # favor of the generic message below — so no matter how specific
    # _tailscale_generate_key's own diagnosis was, only "Failed to generate
    # Tailscale auth key" ever reached the log. It still runs first and is
    # still visible above this line; this message is step-level context, not
    # a replacement for it.
    local auth_key
    if ! auth_key=$(_tailscale_generate_key); then
        die "Failed to generate Tailscale auth key — see the specific cause above."
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

    # h#751: `set -e` protects against `make`/`sops --set` returning non-zero,
    # but a write that exits 0 is not proof the value actually landed as
    # intended — the same distinction the rest of this sweep draws elsewhere.
    # Read each value back with the same `sops -d --extract` mechanism
    # secrets.sh's own `get` command uses (and this function already uses a
    # few lines above, for TRAEFIK_ADMIN_PASSWORD_HASH/HOSTINGER_API_KEY/
    # TAILSCALE_IP) and compare it against what was just written, matching
    # the verification discipline provision-tenant-db.sh already applies to
    # its own writes.
    make secrets-update KEY=TAILSCALE_IP VALUE="$tailscale_ip" > /dev/null 2>&1
    local readback_ts
    readback_ts=$(sops -d --extract '["TAILSCALE_IP"]' infra/secrets/prod.enc.env 2>/dev/null || echo "")
    [ "$readback_ts" = "$tailscale_ip" ] \
        || die "TAILSCALE_IP update did not take: wrote '${tailscale_ip}', read back '${readback_ts}'. The secrets store may be inconsistent — check infra/secrets/prod.enc.env by hand before continuing."
    success "   ✓ TAILSCALE_IP updated (verified)"

    make secrets-update KEY=VPS_HOST VALUE="$tailscale_ip" > /dev/null 2>&1
    local readback_host
    readback_host=$(sops -d --extract '["VPS_HOST"]' infra/secrets/prod.enc.env 2>/dev/null || echo "")
    [ "$readback_host" = "$tailscale_ip" ] \
        || die "VPS_HOST update did not take: wrote '${tailscale_ip}', read back '${readback_host}'. The secrets store may be inconsistent — check infra/secrets/prod.enc.env by hand before continuing."
    success "   ✓ VPS_HOST updated (verified, SSH via Tailscale)"
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
# Narrow re-apply of firewall + SSH hardening only — h#681 / h#786
# ---------------------------------------------------------------------------

# Re-applies infra/ansible/playbooks/ssh-harden.yml (02-firewall + 04-ssh-lockdown
# ONLY — see that file's own header for why bootstrap.yml is the wrong tool for
# this). Unlike cmd_config, this takes NO vps_ip argument: it targets an
# ALREADY-BOOTSTRAPPED host by its known TAILSCALE_IP, which is the only address
# that still answers once 04 has taken effect — a bare host with no Tailscale IP
# recorded yet has nothing for this command to re-harden.
#
# Connects as deploy_user, not root: root login is refused by design once 04 has
# taken effect even once, and the whole reason this command exists is hosts where
# it may already have partially taken effect. Verified live before this was
# written, not assumed: `deploy` has key-based access and passwordless sudo on
# the current production host.
cmd_harden_ssh() {
    local mode="apply"
    case "${1:-}" in
        --check|--dry-run) mode="check" ;;
        "") : ;;
        *) die "Unknown option '$1'. Usage: vps.sh harden-ssh [--check]" ;;
    esac

    local ansible_flags=()
    if [ "$mode" = "check" ]; then
        ansible_flags=(--check --diff)
        echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
        echo -e "${CYAN}  DRY RUN — Firewall + SSH Hardening (02 + 04 only), no changes  ${NC}"
        echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
        echo -e "${YELLOW}--check --diff: reports what would change without changing it.${NC}"
        echo -e "${YELLOW}Read-only diagnostics (sshd -t, sshd -T, firewall-cmd --list-services)${NC}"
        echo -e "${YELLOW}still run for real, so this reports the CURRENT effective state too.${NC}"
    else
        echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
        echo -e "${CYAN}       Re-apply Firewall + SSH Hardening (02 + 04 only)         ${NC}"
        echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    fi
    echo ""

    if [[ -z "${TAILSCALE_AUTH_KEY:-}" ]]; then
        load_secrets
    fi

    local tailscale_ip
    tailscale_ip=$(cd "$PROJECT_ROOT" && sops -d --extract '["TAILSCALE_IP"]' infra/secrets/prod.enc.env 2>/dev/null || echo "")
    [ -n "$tailscale_ip" ] \
        || die "No TAILSCALE_IP recorded in the store. This command re-hardens an already-bootstrapped host; a host that has never completed 'make config-vps' has nothing here to re-apply — run that first."

    echo -e "${BLUE}Target (Tailscale IP):${NC} $tailscale_ip"
    echo -e "${BLUE}Connecting as:${NC} deploy (root login is refused once hardening has taken effect)"
    if [ "$mode" = "apply" ]; then
        echo -e "${YELLOW}This RELOADS sshd if anything changed. Keep this session open and verify${NC}"
        echo -e "${YELLOW}access from a SECOND, fresh session before disconnecting this one.${NC}"
    fi
    echo ""

    cd "$PROJECT_ROOT/infra/ansible"
    if ansible-playbook -i "inventory/hosts.yml" \
                     "${ansible_flags[@]}" \
                     -e "ansible_host=$tailscale_ip" \
                     -e "ansible_user=deploy" \
                     -e "ansible_become=yes" \
                     -e "ansible_ssh_private_key_file=~/.ssh/remote.hill90.com" \
                     -e "ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'" \
                     playbooks/ssh-harden.yml; then
        echo ""
        if [ "$mode" = "check" ]; then
            success "   ✓ Dry run complete — nothing was changed. Re-run without --check to apply."
        else
            success "   ✓ Firewall + SSH hardening re-applied and verified against sshd -T"
        fi
    else
        echo ""
        if [ "$mode" = "check" ]; then
            echo -e "${YELLOW}   Dry run reported a failure — see ansible output above. Nothing was changed.${NC}"
            echo -e "${YELLOW}   A failed assert here can just mean the host is currently in the broken${NC}"
            echo -e "${YELLOW}   state this fix addresses — that is what a dry run against a broken host${NC}"
            echo -e "${YELLOW}   is expected to show.${NC}"
        else
            echo -e "${RED}   ✗ Re-apply failed — see ansible output above${NC}"
            echo -e "${YELLOW}   Re-run is safe: both imported task files are idempotent.${NC}"
        fi
        exit 1
    fi
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
        harden-ssh)     cmd_harden_ssh "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
