#!/usr/bin/env bash
# Vault CLI — OpenBao secrets management lifecycle
# Usage: vault.sh {init|unseal|auto-unseal|status|setup|seed|policy-apply|backup|export|sync-to-sops|setup-sync-token|help}

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

CONTAINER_NAME="openbao"
UNSEAL_KEY_PATH="/opt/hill90/secrets/openbao-unseal.key"
SECRETS_FILE="${PROJECT_ROOT}/infra/secrets/prod.enc.env"
POLICY_DIR="${PROJECT_ROOT}/platform/vault/policies"

# Services that get their own AppRole
VAULT_SERVICES="db api ai auth ui mcp minio infra observability"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Vault CLI — OpenBao secrets management lifecycle

Usage: vault.sh <command>

Commands:
  init          Initialize OpenBao (generates unseal key + root token)
  unseal        Unseal OpenBao using host key file or SOPS fallback
  status        Show OpenBao seal/init status
  setup         Enable KV v2, AppRole, audit, apply policies, create roles
  setup-oidc    Configure OIDC auth method (Keycloak SSO for vault UI)
  seed          Seed KV v2 paths from SOPS-encrypted secrets
  policy-apply  Apply all policy HCL files
  backup        Backup OpenBao data volume
  export        Export all KV v2 secrets to stdout (requires BAO_TOKEN)
  auto-unseal         Wait for container + unseal (for systemd/deploy hooks)
  sync-to-sops        Sync vault secrets back to SOPS backup (requires BAO_TOKEN)
  setup-sync-token    Create a read-only sync token and store in SOPS (requires BAO_TOKEN)
  help                Show this help message

Environment variables:
  BAO_TOKEN     Root or admin token (required for setup, seed, export)
EOF
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

bao_exec() {
    docker exec -e "BAO_ADDR=http://127.0.0.1:8200" "$CONTAINER_NAME" bao "$@"
}

bao_exec_env() {
    local token="${BAO_TOKEN:-}"
    if [ -z "$token" ]; then
        die "BAO_TOKEN is required. Export it before running this command."
    fi
    docker exec -e "BAO_ADDR=http://127.0.0.1:8200" -e "BAO_TOKEN=${token}" "$CONTAINER_NAME" bao "$@"
}

require_running() {
    if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
        die "Container $CONTAINER_NAME is not running. Deploy it first: make deploy-vault"
    fi
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_init() {
    require_running

    echo "================================"
    echo "OpenBao Initialization"
    echo "================================"
    echo ""

    # Check if already initialized
    local init_status
    init_status=$(bao_exec status -format=json 2>/dev/null | grep '"initialized"' | tr -d ' ,"' || echo "")
    if [[ "$init_status" == *"true"* ]]; then
        warn "OpenBao is already initialized"
        echo "Use 'vault.sh unseal' if it is sealed, or 'vault.sh status' to check."
        return 0
    fi

    echo "Initializing with 1 key share, 1 key threshold..."
    local init_output
    init_output=$(bao_exec operator init -key-shares=1 -key-threshold=1 -format=json)

    local unseal_key
    unseal_key=$(echo "$init_output" | python3 -c "import sys,json; print(json.load(sys.stdin)['unseal_keys_b64'][0])")
    local root_token
    root_token=$(echo "$init_output" | python3 -c "import sys,json; print(json.load(sys.stdin)['root_token'])")

    echo ""
    echo "================================"
    echo "SAVE THESE VALUES SECURELY"
    echo "================================"
    echo ""
    echo "Unseal Key: ${unseal_key}"
    echo "Root Token: ${root_token}"
    echo ""
    echo "Next steps:"
    echo "  1. Store unseal key in SOPS: make secrets-update KEY=OPENBAO_UNSEAL_KEY VALUE=\"${unseal_key}\""
    echo "  2. Copy to host: echo \"${unseal_key}\" | sudo tee ${UNSEAL_KEY_PATH} && sudo chmod 0600 ${UNSEAL_KEY_PATH}"
    echo "  3. Unseal: bash scripts/vault.sh unseal"
    echo "  4. Setup: export BAO_TOKEN=\"${root_token}\" && bash scripts/vault.sh setup"
    echo "  5. Seed: bash scripts/vault.sh seed"
    echo "  6. Revoke root token: docker exec openbao bao token revoke -self"
    echo ""
}

cmd_unseal() {
    require_running

    echo "Unsealing OpenBao..."

    # Check if already unsealed
    local sealed_status
    sealed_status=$(bao_exec status -format=json 2>/dev/null | grep '"sealed"' | tr -d ' ,"' || echo "")
    if [[ "$sealed_status" == *"false"* ]]; then
        success "OpenBao is already unsealed"
        return 0
    fi

    local unseal_key=""

    # Try host key file first
    if [ -f "$UNSEAL_KEY_PATH" ]; then
        unseal_key=$(cat "$UNSEAL_KEY_PATH")
        info "Using unseal key from ${UNSEAL_KEY_PATH}"
    fi

    # Fall back to SOPS
    if [ -z "$unseal_key" ] && [ -f "$SECRETS_FILE" ]; then
        info "Host key file not found, falling back to SOPS..."
        ensure_age_key prod
        unseal_key=$(sops -d --extract '["OPENBAO_UNSEAL_KEY"]' "$SECRETS_FILE" 2>/dev/null || echo "")
    fi

    if [ -z "$unseal_key" ]; then
        die "No unseal key found. Provide it at ${UNSEAL_KEY_PATH} or in SOPS as OPENBAO_UNSEAL_KEY."
    fi

    bao_exec operator unseal "$unseal_key" >/dev/null
    success "OpenBao unsealed successfully"
}

cmd_status() {
    require_running

    echo "================================"
    echo "OpenBao Status"
    echo "================================"
    echo ""
    bao_exec status || true
}

cmd_setup() {
    require_running

    echo "================================"
    echo "OpenBao Setup"
    echo "================================"
    echo ""

    # Enable KV v2 secrets engine
    echo "Enabling KV v2 secrets engine at secret/..."
    bao_exec_env secrets enable -path=secret -version=2 kv 2>/dev/null || info "KV v2 already enabled at secret/"

    # Enable AppRole auth method
    echo "Enabling AppRole auth method..."
    bao_exec_env auth enable approle 2>/dev/null || info "AppRole already enabled"

    # Enable audit logging to stdout
    echo "Enabling audit logging to stdout..."
    bao_exec_env audit enable file file_path=/dev/stdout 2>/dev/null || info "Audit logging already enabled"

    # Apply all policies
    cmd_policy_apply

    # Create AppRoles for each service
    echo ""
    echo "Creating AppRoles for each service..."
    for svc in $VAULT_SERVICES; do
        local policy_name="policy-${svc}"
        echo "  Creating AppRole: ${svc} (policy: ${policy_name})"
        bao_exec_env write "auth/approle/role/${svc}" \
            token_policies="${policy_name}" \
            token_ttl=1h \
            token_max_ttl=4h \
            secret_id_ttl=0
    done

    # Setup OIDC if client secret is available (optional — skip silently if not configured)
    local oidc_secret
    oidc_secret=$(sops -d "$SECRETS_FILE" 2>/dev/null | grep "^VAULT_OIDC_CLIENT_SECRET=" | cut -d= -f2- || echo "")
    if [ -n "$oidc_secret" ]; then
        echo ""
        cmd_setup_oidc
    else
        info "VAULT_OIDC_CLIENT_SECRET not in SOPS — skipping OIDC setup (run 'vault.sh setup-oidc' after creating Keycloak client)"
    fi

    echo ""
    success "Setup complete!"
    echo ""
    echo "Next: Generate AppRole credentials for each service:"
    for svc in $VAULT_SERVICES; do
        echo "  role_id:    bao read auth/approle/role/${svc}/role-id"
        echo "  secret_id:  bao write -f auth/approle/role/${svc}/secret-id"
    done
    echo ""
}

cmd_setup_oidc() {
    require_running

    local secrets_file="${SECRETS_FILE}"
    require_file "$secrets_file" "Secrets file"
    ensure_age_key prod

    echo "================================"
    echo "OpenBao OIDC Setup (Keycloak)"
    echo "================================"
    echo ""

    # Read OIDC client secret from SOPS
    local client_secret
    client_secret=$(sops -d "$secrets_file" 2>/dev/null | grep "^VAULT_OIDC_CLIENT_SECRET=" | cut -d= -f2-)

    if [ -z "$client_secret" ]; then
        die "VAULT_OIDC_CLIENT_SECRET not found in SOPS. Create the Keycloak client first."
    fi

    # Enable OIDC auth method (idempotent)
    echo "Enabling OIDC auth method..."
    bao_exec_env auth enable oidc 2>/dev/null || info "OIDC auth already enabled"

    # Configure OIDC provider (Keycloak)
    echo "Configuring OIDC provider (Keycloak)..."
    bao_exec_env write auth/oidc/config \
        oidc_discovery_url="https://auth.hill90.com/realms/hill90" \
        oidc_client_id="hill90-vault" \
        oidc_client_secret="$client_secret" \
        default_role="admin-sso"

    # Apply OIDC admin policy
    echo "Applying OIDC admin policy..."
    bao_exec_env policy write policy-oidc-admin "/openbao/policies/policy-oidc-admin.hcl"

    # Create admin-sso role (maps Keycloak admin role to vault policy)
    # Uses JSON via stdin because bound_claims requires a map type that
    # the CLI doesn't parse correctly from positional arguments.
    echo "Creating admin-sso OIDC role..."
    local role_json='{"role_type":"oidc","user_claim":"sub","policies":["policy-oidc-admin"],"oidc_scopes":["openid","profile","email"],"bound_claims":{"realm_roles":["admin"]},"allowed_redirect_uris":["https://vault.hill90.com/v1/auth/oidc/callback","https://vault.hill90.com/ui/vault/auth/oidc/oidc/callback"]}'
    local token="${BAO_TOKEN:-}"
    echo "$role_json" | docker exec -i -e "BAO_ADDR=http://127.0.0.1:8200" -e "BAO_TOKEN=${token}" "$CONTAINER_NAME" \
        bao write auth/oidc/role/admin-sso -

    echo ""
    success "OIDC setup complete!"
    echo "  Login at: https://vault.hill90.com/ui/"
    echo "  Auth method: OIDC"
    echo "  Keycloak users with 'admin' role can now sign in."
    echo ""
}

cmd_seed() {
    require_running

    echo "================================"
    echo "OpenBao Seed — SOPS to KV v2"
    echo "================================"
    echo ""

    require_file "$SECRETS_FILE" "Secrets file"
    ensure_age_key prod

    # Decrypt secrets to temporary file
    local temp_file
    temp_file=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f '$temp_file'" RETURN

    sops -d "$SECRETS_FILE" > "$temp_file"

    # Helper to read a key from the decrypted secrets
    get_secret() {
        grep "^${1}=" "$temp_file" | cut -d '=' -f 2-
    }

    # Seed shared/database
    echo "Seeding secret/shared/database..."
    bao_exec_env kv put secret/shared/database \
        "DB_USER=$(get_secret DB_USER)" \
        "DB_PASSWORD=$(get_secret DB_PASSWORD)" \
        "DB_NAME=$(get_secret DB_NAME)"

    # Seed shared/jwt
    echo "Seeding secret/shared/jwt..."
    bao_exec_env kv put secret/shared/jwt \
        "JWT_SECRET=$(get_secret JWT_SECRET)" \
        "JWT_PRIVATE_KEY=$(get_secret JWT_PRIVATE_KEY)" \
        "JWT_PUBLIC_KEY=$(get_secret JWT_PUBLIC_KEY)"

    # Seed api/config
    echo "Seeding secret/api/config..."
    bao_exec_env kv put secret/api/config \
        "INTERNAL_SERVICE_SECRET=$(get_secret INTERNAL_SERVICE_SECRET)" \
        "MINIO_ROOT_USER=$(get_secret MINIO_ROOT_USER)" \
        "MINIO_ROOT_PASSWORD=$(get_secret MINIO_ROOT_PASSWORD)"

    # Seed ai/config
    echo "Seeding secret/ai/config..."
    bao_exec_env kv put secret/ai/config \
        "ANTHROPIC_API_KEY=$(get_secret ANTHROPIC_API_KEY)" \
        "OPENAI_API_KEY=$(get_secret OPENAI_API_KEY)"

    # Seed auth/config
    echo "Seeding secret/auth/config..."
    bao_exec_env kv put secret/auth/config \
        "KC_ADMIN_USERNAME=$(get_secret KC_ADMIN_USERNAME)" \
        "KC_ADMIN_PASSWORD=$(get_secret KC_ADMIN_PASSWORD)" \
        "SMTP_PASSWORD=$(get_secret SMTP_PASSWORD)"

    # Seed ui/config
    echo "Seeding secret/ui/config..."
    bao_exec_env kv put secret/ui/config \
        "AUTH_KEYCLOAK_ID=$(get_secret AUTH_KEYCLOAK_ID)" \
        "AUTH_KEYCLOAK_SECRET=$(get_secret AUTH_KEYCLOAK_SECRET)" \
        "AUTH_SECRET=$(get_secret AUTH_SECRET)"

    # Seed minio/config
    echo "Seeding secret/minio/config..."
    bao_exec_env kv put secret/minio/config \
        "MINIO_ROOT_USER=$(get_secret MINIO_ROOT_USER)" \
        "MINIO_ROOT_PASSWORD=$(get_secret MINIO_ROOT_PASSWORD)"

    # Seed infra/traefik
    echo "Seeding secret/infra/traefik..."
    bao_exec_env kv put secret/infra/traefik \
        "TRAEFIK_ADMIN_PASSWORD_HASH=$(get_secret TRAEFIK_ADMIN_PASSWORD_HASH)" \
        "ACME_EMAIL=$(get_secret ACME_EMAIL)" \
        "ACME_CA_SERVER=$(get_secret ACME_CA_SERVER)"

    # Seed infra/dns-manager
    echo "Seeding secret/infra/dns-manager..."
    bao_exec_env kv put secret/infra/dns-manager \
        "HOSTINGER_API_KEY=$(get_secret HOSTINGER_API_KEY)"

    # Seed observability/grafana
    echo "Seeding secret/observability/grafana..."
    bao_exec_env kv put secret/observability/grafana \
        "GRAFANA_ADMIN_PASSWORD=$(get_secret GRAFANA_ADMIN_PASSWORD)"

    # Seed mcp/config (if keys exist)
    echo "Seeding secret/mcp/config..."
    local mcp_internal_secret
    mcp_internal_secret=$(get_secret INTERNAL_SERVICE_SECRET)
    bao_exec_env kv put secret/mcp/config \
        "INTERNAL_SERVICE_SECRET=${mcp_internal_secret}"

    rm -f "$temp_file"
    trap - RETURN

    echo ""
    success "All secrets seeded to KV v2!"
}

cmd_policy_apply() {
    require_running

    echo "Applying policies from ${POLICY_DIR}..."
    for policy_file in "$POLICY_DIR"/policy-*.hcl; do
        local policy_name
        policy_name=$(basename "$policy_file" .hcl)
        echo "  Applying policy: ${policy_name}"
        bao_exec_env policy write "$policy_name" "/openbao/policies/$(basename "$policy_file")"
    done
    success "All policies applied"
}

cmd_backup() {
    echo "Backing up OpenBao data volume..."
    bash "$SCRIPT_DIR/backup.sh" backup vault
}

cmd_export() {
    require_running

    echo "================================"
    echo "OpenBao KV v2 Export"
    echo "================================"
    echo ""

    local paths=(
        "secret/shared/database"
        "secret/shared/jwt"
        "secret/api/config"
        "secret/ai/config"
        "secret/auth/config"
        "secret/ui/config"
        "secret/minio/config"
        "secret/infra/traefik"
        "secret/infra/dns-manager"
        "secret/observability/grafana"
        "secret/mcp/config"
    )

    for p in "${paths[@]}"; do
        echo "--- ${p} ---"
        bao_exec_env kv get "$p" 2>/dev/null || warn "Path not found: $p"
        echo ""
    done
}

cmd_sync_to_sops() {
    require_running

    echo "================================"
    echo "Vault -> SOPS Sync"
    echo "================================"
    echo ""

    require_file "$SECRETS_FILE" "Secrets file"
    ensure_age_key prod

    # Canonical vault paths — read in this order for deduplication.
    # api/config is read first so MINIO_ROOT_USER and INTERNAL_SERVICE_SECRET
    # come from their canonical source; later paths skip already-seen keys.
    local SYNC_PATHS=(
        "secret/api/config"
        "secret/shared/database"
        "secret/shared/jwt"
        "secret/ai/config"
        "secret/auth/config"
        "secret/ui/config"
        "secret/minio/config"
        "secret/infra/traefik"
        "secret/infra/dns-manager"
        "secret/observability/grafana"
        "secret/mcp/config"
    )

    # Create timestamped backup before modifying SOPS
    local backup_file
    backup_file="${SECRETS_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$SECRETS_FILE" "$backup_file"
    info "Created backup: $backup_file"

    # Temp files for key=value pairs and dedup tracking
    local kv_file seen_file
    kv_file=$(mktemp)
    seen_file=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f '$kv_file' '$seen_file'" RETURN

    local synced=0
    local skipped=0

    for path in "${SYNC_PATHS[@]}"; do
        echo "Reading ${path}..."

        # Read raw JSON from vault — do NOT use vault_read_kv() which
        # shell-escapes values via shlex.quote(), breaking multiline secrets.
        local json_output
        json_output=$(bao_exec_env kv get -format=json "$path" 2>/dev/null) || {
            warn "Path not found or not accessible: $path — skipping"
            continue
        }

        # Parse JSON to KEY=VALUE lines (raw values, no shell escaping)
        echo "$json_output" | python3 -c "
import sys, json
data = json.load(sys.stdin)['data']['data']
for k, v in sorted(data.items()):
    print(f'{k}={v}')
" > "$kv_file" || {
            warn "Failed to parse JSON for $path — skipping"
            continue
        }

        # Update SOPS for each key, deduplicating
        while IFS='=' read -r key value; do
            [ -z "$key" ] && continue

            # Dedup: skip if we already synced this key from a prior path
            if grep -qxF "$key" "$seen_file" 2>/dev/null; then
                info "  Skipping $key (already synced from earlier path)"
                skipped=$((skipped + 1))
                continue
            fi

            # Record as seen
            echo "$key" >> "$seen_file"

            # Escape value as JSON string (handles multiline, special chars)
            local escaped_value
            escaped_value=$(printf '%s' "$value" | jq -Rs .)

            if sops --set "[\"${key}\"] ${escaped_value}" "$SECRETS_FILE"; then
                echo "  Synced: $key"
                synced=$((synced + 1))
            else
                warn "sops --set failed for key $key — restoring from backup"
                cp "$backup_file" "$SECRETS_FILE"
                rm -f "$kv_file" "$seen_file"
                trap - RETURN
                die "Sync aborted. SOPS file restored from backup: $backup_file"
            fi
        done < "$kv_file"
    done

    rm -f "$kv_file" "$seen_file"
    trap - RETURN

    echo ""
    success "Sync complete! $synced keys synced, $skipped duplicates skipped."
    echo "Backup saved: $backup_file"
}

cmd_setup_sync_token() {
    require_running

    echo "================================"
    echo "Setup Vault Sync Token"
    echo "================================"
    echo ""

    require_file "$SECRETS_FILE" "Secrets file"
    ensure_age_key prod

    # Apply the sync policy
    echo "Applying policy-sync..."
    bao_exec_env policy write policy-sync "/openbao/policies/policy-sync.hcl"

    # Create an orphan periodic token with only the sync policy.
    # Periodic tokens don't expire as long as they're renewed within each
    # period window. The workflow renews on each run (weekly), so the
    # 32-day period provides ample buffer.
    echo "Creating periodic sync token (period=768h, policy=policy-sync)..."
    local token_output
    token_output=$(bao_exec_env token create \
        -orphan \
        -period=768h \
        -policy=policy-sync \
        -display-name=vault-sync-to-sops \
        -format=json)

    local sync_token
    sync_token=$(echo "$token_output" | python3 -c "import sys,json; print(json.load(sys.stdin)['auth']['client_token'])")

    if [ -z "$sync_token" ]; then
        die "Failed to create sync token"
    fi

    # Store the token in SOPS
    echo "Storing VAULT_SYNC_TOKEN in SOPS..."
    local escaped_token
    escaped_token=$(printf '%s' "$sync_token" | jq -Rs .)

    if ! sops --set "[\"VAULT_SYNC_TOKEN\"] ${escaped_token}" "$SECRETS_FILE"; then
        die "Failed to store VAULT_SYNC_TOKEN in SOPS"
    fi

    echo ""
    success "Sync token created and stored in SOPS!"
    echo ""
    echo "Token: ${sync_token}" >&2
    echo ""
    echo "IMPORTANT: Commit and push the updated SOPS file so GitHub Actions can read it:"
    echo "  git add infra/secrets/prod.enc.env"
    echo "  git commit -m 'chore: store vault sync token in SOPS'"
    echo "  git push"
    echo ""
}

cmd_auto_unseal() {
    local max_wait=${VAULT_AUTO_UNSEAL_TIMEOUT:-120}
    local waited=0

    # Wait for container to exist and be running
    echo "Auto-unseal: waiting for ${CONTAINER_NAME}..."
    while ! docker container inspect "$CONTAINER_NAME" --format '{{.State.Running}}' 2>/dev/null | grep -q "true"; do
        if [ $waited -ge $max_wait ]; then
            # Container not running — may not be deployed yet (not an error on fresh VPS)
            echo "Container ${CONTAINER_NAME} not running after ${max_wait}s — skipping auto-unseal"
            return 0
        fi
        sleep 5
        waited=$((waited + 5))
    done

    # Wait for API to respond (bao status exits 0=unsealed, 2=sealed, 1=error)
    waited=0
    while true; do
        local rc=0
        bao_exec status >/dev/null 2>&1 || rc=$?
        # Exit code 0 (unsealed) or 2 (sealed) both mean the API is responding
        if [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; then
            break
        fi
        if [ $waited -ge 60 ]; then
            die "Timed out waiting for ${CONTAINER_NAME} API"
        fi
        sleep 2
        waited=$((waited + 2))
    done

    # Validate unseal key file safeguards
    if [ -f "$UNSEAL_KEY_PATH" ]; then
        local perms
        perms=$(stat -c '%a' "$UNSEAL_KEY_PATH" 2>/dev/null || stat -f '%Lp' "$UNSEAL_KEY_PATH" 2>/dev/null)
        if [ "$perms" != "600" ]; then
            warn "Unseal key at ${UNSEAL_KEY_PATH} has permissions ${perms} (expected 600)"
        fi
        local owner
        owner=$(stat -c '%U' "$UNSEAL_KEY_PATH" 2>/dev/null || stat -f '%Su' "$UNSEAL_KEY_PATH" 2>/dev/null)
        if [ "$owner" != "deploy" ]; then
            warn "Unseal key owned by ${owner} (expected deploy)"
        fi
    fi

    cmd_unseal
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
        init)          cmd_init "$@" ;;
        unseal)        cmd_unseal "$@" ;;
        status)        cmd_status "$@" ;;
        setup)         cmd_setup "$@" ;;
        setup-oidc)    cmd_setup_oidc "$@" ;;
        seed)          cmd_seed "$@" ;;
        policy-apply)  cmd_policy_apply "$@" ;;
        backup)        cmd_backup "$@" ;;
        export)        cmd_export "$@" ;;
        auto-unseal)        cmd_auto_unseal "$@" ;;
        sync-to-sops)       cmd_sync_to_sops "$@" ;;
        setup-sync-token)   cmd_setup_sync_token "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
