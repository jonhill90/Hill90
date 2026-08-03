#!/usr/bin/env bash
# Vault CLI — OpenBao secrets management lifecycle
# Usage: vault.sh {init|unseal|auto-unseal|status|setup|seed|policy-apply|backup|export|sync-to-sops|setup-sync-token|bootstrap-approles|help}

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

CONTAINER_NAME="${VAULT_CONTAINER:-openbao}"
UNSEAL_KEY_PATH="${VAULT_UNSEAL_KEY_PATH:-/opt/hill90/secrets/openbao-unseal.key}"
# The root token is written to a file rather than printed. It is deliberately
# short-lived: revoke it with `vault.sh revoke-root` as soon as setup and seed
# are done.
ROOT_TOKEN_PATH="${VAULT_ROOT_TOKEN_PATH:-/opt/hill90/secrets/openbao-root.token}"
SECRETS_FILE="${VAULT_SECRETS_FILE:-${PROJECT_ROOT}/infra/secrets/prod.enc.env}"
POLICY_DIR="${PROJECT_ROOT}/platform/vault/policies"

# Services that get their own AppRole
VAULT_SERVICES="db auth infra observability"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Vault CLI — OpenBao secrets management lifecycle

Usage: vault.sh <command>

Commands:
  init          Initialize OpenBao (writes unseal key + root token to 0600 files)
  revoke-root   Revoke the root token and remove it from disk
  store-unseal-key  Copy the host unseal key into SOPS as OPENBAO_UNSEAL_KEY
  unseal        Unseal OpenBao using host key file or SOPS fallback
  status        Show OpenBao seal/init status
  setup         Enable KV v2, AppRole, audit, apply policies, create roles
  setup-oidc    Configure OIDC auth against the Keycloak platform realm
  seed          Seed KV v2 paths from SOPS-encrypted secrets
  policy-apply  Apply all policy HCL files
  backup        Backup OpenBao data volume
  export        Export all KV v2 secrets to stdout (requires BAO_TOKEN)
  auto-unseal         Wait for container + unseal (for systemd/deploy hooks)
  assert-unsealed     Exit non-zero if OpenBao is deployed but still sealed
  sync-to-sops        Sync vault secrets back to SOPS backup (requires BAO_TOKEN)
  setup-sync-token    Create a read-only sync token and store in SOPS (requires BAO_TOKEN)
  bootstrap-approles  Generate AppRole credentials for all services and store in SOPS
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
    # The token travels in the ENVIRONMENT, not argv.
    #
    # `docker exec -e "BAO_TOKEN=${token}"` puts the value in the docker CLI's
    # command line, where any local user can read it with `ps`. Demonstrated
    # rather than assumed: a probe with a dummy value showed
    # `docker exec -e PSPROBE=<value> ...` in `ps -Ao args`.
    #
    # `-e NAME` with no value tells docker to pass the variable through from its
    # own environment, so the value never becomes an argument. scripts/keycloak.sh
    # already did this and documented why; this helper did not.
    BAO_TOKEN="$token" docker exec -e "BAO_ADDR=http://127.0.0.1:8200" -e BAO_TOKEN \
        "$CONTAINER_NAME" bao "$@"
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

    # Both secrets are written straight to 0600 files and never printed.
    #
    # This used to echo the unseal key and root token to stdout. Anywhere this
    # runs — an SSH session, a CI job, a terminal with scrollback — that is a
    # durable copy of the two credentials that together are complete control of
    # the vault. There is no safe terminal to print them to, so they are not
    # printed at all.
    #
    # Files are created by whoever runs this (the deploy user on the host), so
    # they end up deploy:deploy. The previous instructions said to `sudo tee`
    # the unseal key, which produced a root-owned file that the auto-unseal
    # systemd unit — running as User=deploy — could not read. That would have
    # meant a vault which never came back after a reboot.
    local key_dir
    key_dir="$(dirname "$UNSEAL_KEY_PATH")"
    mkdir -p "$key_dir"

    echo "Initializing with 1 key share, 1 key threshold..."

    # umask before creation: never let the file exist world-readable, even for
    # the instant between creat() and chmod().
    local old_umask
    old_umask=$(umask)
    umask 077

    local init_output
    init_output=$(bao_exec operator init -key-shares=1 -key-threshold=1 -format=json)

    printf '%s' "$init_output" \
        | python3 -c "import sys,json; sys.stdout.write(json.load(sys.stdin)['unseal_keys_b64'][0])" \
        > "$UNSEAL_KEY_PATH"
    printf '%s' "$init_output" \
        | python3 -c "import sys,json; sys.stdout.write(json.load(sys.stdin)['root_token'])" \
        > "$ROOT_TOKEN_PATH"

    unset init_output
    umask "$old_umask"

    chmod 600 "$UNSEAL_KEY_PATH" "$ROOT_TOKEN_PATH"

    if [ ! -s "$UNSEAL_KEY_PATH" ] || [ ! -s "$ROOT_TOKEN_PATH" ]; then
        die "Initialization produced an empty key or token file — refusing to continue. Vault is initialized but the credentials were not captured; recover from ${UNSEAL_KEY_PATH} manually before restarting."
    fi

    success "✓ Unseal key written to ${UNSEAL_KEY_PATH} (0600, $(stat -c '%U:%G' "$UNSEAL_KEY_PATH" 2>/dev/null || stat -f '%Su:%Sg' "$UNSEAL_KEY_PATH"))"
    success "✓ Root token written to ${ROOT_TOKEN_PATH} (0600)"
    echo ""
    echo "Next steps:"
    echo "  1. Unseal:        bash scripts/vault.sh unseal"
    echo "  2. Setup:         BAO_TOKEN=\"\$(cat ${ROOT_TOKEN_PATH})\" bash scripts/vault.sh setup"
    echo "  3. Seed:          BAO_TOKEN=\"\$(cat ${ROOT_TOKEN_PATH})\" bash scripts/vault.sh seed"
    echo "  4. Revoke root:   bash scripts/vault.sh revoke-root"
    echo ""
    echo "  The unseal key must ALSO be stored in SOPS as OPENBAO_UNSEAL_KEY, so"
    echo "  it survives loss of this host. The host checkout is reset on every"
    echo "  deploy, so that has to be committed from a workstation — see"
    echo "  docs/runbooks/vault-unseal.md."
    echo ""
}

# Revoke the root token and remove it from disk.
#
# A root token is unconstrained and does not expire. Once setup and seed have
# run, nothing needs it — day-to-day access is by AppRole. Leaving it on the
# filesystem is the single largest standing risk in this design.
#
# ONE-WAY DOOR. On OpenBao >= 2.5.3 the unauthenticated root-generation
# endpoints are disabled by default (disable_unauthed_generate_root_endpoints
# defaults to true), so `bao operator generate-root` returns 403 — verified
# against 2.6.1, both before and after revocation, with the flag set at
# listener and top level. Regaining root then requires an existing
# sudo-capable token, and if none exists the only route back is
# reinitializing the vault.
#
# So: run `setup`, `seed` and `setup-sync-token` BEFORE this. Revoking first
# leaves a vault that cannot be configured.
cmd_revoke_root() {
    require_running

    warn "Revoking root is IRREVERSIBLE on OpenBao >= 2.5.3 unless another"
    warn "sudo-capable token exists. generate-root is disabled by default."
    warn "Ensure setup/seed/setup-sync-token have already run."

    if [ ! -f "$ROOT_TOKEN_PATH" ]; then
        warn "No root token file at ${ROOT_TOKEN_PATH} — nothing to revoke."
        return 0
    fi

    local token
    token=$(cat "$ROOT_TOKEN_PATH")
    if [ -z "$token" ]; then
        warn "Root token file is empty; removing it."
        rm -f "$ROOT_TOKEN_PATH"
        return 0
    fi

    echo "Revoking root token..."
    # `-e BAO_TOKEN` passes the variable through from this shell rather than
    # putting the value in argv, so it must be SET here — a bare pass-through of
    # an unset variable sends nothing and the command fails in a way that looks
    # like a permissions problem.
    BAO_TOKEN="$token" docker exec -e "BAO_ADDR=http://127.0.0.1:8200" -e BAO_TOKEN \
        "$CONTAINER_NAME" bao token revoke -self >/dev/null 2>&1 || true

    # Verify independently. `token revoke -self` prints "Revoked token (if it
    # existed)" and exits 0 regardless, so its exit code proves nothing.
    if ! BAO_TOKEN="$token" docker exec -e "BAO_ADDR=http://127.0.0.1:8200" -e BAO_TOKEN \
            "$CONTAINER_NAME" bao token lookup >/dev/null 2>&1; then
        success "✓ Root token revoked and confirmed dead"
    else
        unset token
        die "Root token is STILL VALID after the revoke call. Do NOT leave this host until it is revoked — a live root token is unconstrained access to every secret."
    fi
    unset token

    # Best-effort overwrite before unlinking.
    if command -v shred >/dev/null 2>&1; then
        shred -u "$ROOT_TOKEN_PATH" 2>/dev/null || rm -f "$ROOT_TOKEN_PATH"
    else
        rm -f "$ROOT_TOKEN_PATH"
    fi
    success "✓ Removed ${ROOT_TOKEN_PATH}"
}

# Copy the unseal key from the host key file into SOPS.
#
# The key has to exist in two places: on the host so auto-unseal works without
# decrypting anything at boot, and in SOPS so it survives loss of the host.
# This is the second half.
#
# The value is read and written entirely inside this function — it is never an
# argument, never interpolated into a caller's shell, and never printed. That
# matters because the obvious alternative (`make secrets-update KEY=... VALUE=...`)
# puts the unseal key in the process table and in shell history.
cmd_store_unseal_key() {
    require_file "$UNSEAL_KEY_PATH" "Unseal key"
    require_file "$SECRETS_FILE" "Secrets file"
    require_command sops
    require_command jq

    if [ ! -r "$UNSEAL_KEY_PATH" ]; then
        die "Unseal key at ${UNSEAL_KEY_PATH} is not readable by $(id -un)."
    fi

    local key
    key=$(cat "$UNSEAL_KEY_PATH")
    [ -n "$key" ] || die "Unseal key file is empty."

    # jq -Rs quotes it correctly whatever it contains.
    local escaped
    escaped=$(printf '%s' "$key" | jq -Rs .)
    unset key

    if sops --set "[\"OPENBAO_UNSEAL_KEY\"] ${escaped}" "$SECRETS_FILE"; then
        unset escaped
        success "✓ OPENBAO_UNSEAL_KEY written to $(basename "$SECRETS_FILE")"
    else
        unset escaped
        die "Failed to write OPENBAO_UNSEAL_KEY into ${SECRETS_FILE}"
    fi

    # Confirm it round-trips, without revealing it.
    local stored_len
    stored_len=$(sops -d --extract '["OPENBAO_UNSEAL_KEY"]' "$SECRETS_FILE" 2>/dev/null | wc -c | tr -d ' ')
    [ "$stored_len" -gt 0 ] || die "OPENBAO_UNSEAL_KEY did not round-trip after writing."
    success "✓ Verified: OPENBAO_UNSEAL_KEY decrypts to ${stored_len} bytes"
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
        if [ ! -r "$UNSEAL_KEY_PATH" ]; then
            # Almost always a root-owned file and a deploy-user caller. Say so,
            # rather than dying inside a command substitution.
            die "Unseal key at ${UNSEAL_KEY_PATH} exists but is not readable by $(id -un). It must be owned by deploy:deploy with mode 0600 — the auto-unseal systemd unit runs as deploy."
        fi
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

# Platform-to-platform SSO: OpenBao authenticating humans against Keycloak.
# This is the Key-Vault-behind-Entra pairing the project mirrors — see
# docs/decisions/platform-primitives.md.
#
# It targets the PLATFORM realm, not an application realm. Infrastructure
# services (Grafana, Portainer, Traefik) deliberately do NOT authenticate this
# way: it would make them unreachable whenever the IdP is unhealthy.
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
        oidc_discovery_url="${VAULT_OIDC_DISCOVERY_URL:-https://auth.hill90.com/realms/platform}" \
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
    # Redirect URIs must match the vault's own public URL. Defaulting to the
    # production URL keeps this byte-identical to what prod got before; local
    # rehearsal sets VAULT_PUBLIC_URL instead of forking the command.
    local vault_url="${VAULT_PUBLIC_URL:-https://vault.hill90.com}"
    local role_json
    role_json=$(python3 -c '
import json, sys
base = sys.argv[1].rstrip("/")
print(json.dumps({
    "role_type": "oidc",
    "user_claim": "sub",
    "policies": ["policy-oidc-admin"],
    "oidc_scopes": ["openid", "profile", "email"],
    "bound_claims": {"realm_roles": ["admin"]},
    "allowed_redirect_uris": [
        base + "/v1/auth/oidc/callback",
        base + "/ui/vault/auth/oidc/oidc/callback",
    ],
}))' "$vault_url")
    local token="${BAO_TOKEN:-}"
    echo "$role_json" | BAO_TOKEN="$token" docker exec -i \
        -e "BAO_ADDR=http://127.0.0.1:8200" -e BAO_TOKEN "$CONTAINER_NAME" \
        bao write auth/oidc/role/admin-sso -

    echo ""
    success "OIDC setup complete!"
    echo "  Login at: ${vault_url}/ui/"
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

    # Every key that must be present and non-empty before anything is written.
    #
    # An unguarded `grep | cut` returns the empty string for a key that is not
    # in the file, and `bao kv put KEY=` accepts that happily. Seeding would
    # then print "All secrets seeded to KV v2!" while installing a blank
    # credential, and `sync-to-sops` would write the blank back into the
    # encrypted file as a real, present key. For CF_DNS_API_TOKEN that is
    # invisible for ~60 days and then surfaces as expired certificates on the
    # Tailscale-only hosts, because lego validates the token only at renewal.
    #
    # This check must run in THIS shell, not inside the `$(get_secret ...)`
    # command substitutions below: `exit` inside a substitution kills only the
    # subshell, so the seed would carry on with an empty value.
    local required_keys=(
        TRAEFIK_ADMIN_PASSWORD_HASH
        ACME_EMAIL
        ACME_CA_SERVER
        CF_DNS_API_TOKEN
        HOSTINGER_API_KEY
        GRAFANA_ADMIN_PASSWORD
    )
    local missing=()
    local key
    for key in "${required_keys[@]}"; do
        if [ -z "$(get_secret "$key")" ]; then
            missing+=("$key")
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        die "Refusing to seed — these keys are missing or empty in ${SECRETS_FILE}: ${missing[*]}. A blank credential seeds silently and fails much later. Add them first: make secrets-update KEY=<key> VALUE=<value>"
    fi

    # Seed infra/traefik
    echo "Seeding secret/infra/traefik..."
    bao_exec_env kv put secret/infra/traefik \
        "TRAEFIK_ADMIN_PASSWORD_HASH=$(get_secret TRAEFIK_ADMIN_PASSWORD_HASH)" \
        "ACME_EMAIL=$(get_secret ACME_EMAIL)" \
        "ACME_CA_SERVER=$(get_secret ACME_CA_SERVER)" \
        "CF_DNS_API_TOKEN=$(get_secret CF_DNS_API_TOKEN)"

    # Seed infra/vps — Hostinger VPS management, not a DNS or certificate path.
    echo "Seeding secret/infra/vps..."
    bao_exec_env kv put secret/infra/vps \
        "HOSTINGER_API_KEY=$(get_secret HOSTINGER_API_KEY)"

    # Seed observability/grafana
    echo "Seeding secret/observability/grafana..."
    bao_exec_env kv put secret/observability/grafana \
        "GRAFANA_ADMIN_PASSWORD=$(get_secret GRAFANA_ADMIN_PASSWORD)"

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
        "secret/infra/traefik"
        "secret/infra/vps"
        "secret/observability/grafana"
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

    # Canonical vault paths — read in this order for deduplication;
    # later paths skip already-seen keys.
    local SYNC_PATHS=(
        "secret/infra/traefik"
        "secret/infra/vps"
        "secret/observability/grafana"
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

    unset sync_token escaped_token

    echo ""
    success "Sync token created and stored in SOPS!"
    echo ""
    # Deliberately NOT printed. This runs in CI, and a printed token would be
    # a durable copy in the Actions log — the same defect init had.
    echo ""
    echo "IMPORTANT: Commit and push the updated SOPS file so GitHub Actions can read it:"
    echo "  git add infra/secrets/prod.enc.env"
    echo "  git commit -m 'chore: store vault sync token in SOPS'"
    echo "  git push"
    echo ""
}

cmd_bootstrap_approles() {
    require_running

    echo "================================"
    echo "Bootstrap AppRole Credentials"
    echo "================================"
    echo ""

    require_file "$SECRETS_FILE" "Secrets file"
    ensure_age_key prod

    # Ensure vault is unsealed
    local sealed_status
    sealed_status=$(bao_exec status -format=json 2>/dev/null | grep '"sealed"' | tr -d ' ,"' || echo "")
    if [[ "$sealed_status" != *"false"* ]]; then
        echo "Vault is sealed — unsealing first..."
        cmd_unseal
    fi

    # Read unseal key for root token generation
    local unseal_key=""
    if [ -f "$UNSEAL_KEY_PATH" ]; then
        unseal_key=$(cat "$UNSEAL_KEY_PATH")
    elif [ -f "$SECRETS_FILE" ]; then
        unseal_key=$(sops -d --extract '["OPENBAO_UNSEAL_KEY"]' "$SECRETS_FILE" 2>/dev/null || echo "")
    fi
    if [ -z "$unseal_key" ]; then
        die "No unseal key found. Required to generate root token."
    fi

    # USE AN EXISTING ROOT TOKEN IF ONE IS ALREADY IN HAND.
    #
    # This function used to jump straight to generate-root, and on OpenBao >= 2.5.3
    # that is a dead end: the unauthenticated root-generation endpoints are disabled
    # by default, so `generate-root -init` returns 403 and this died at
    # "Generating temporary root token..." with the error swallowed. That made the
    # documented REPAIR path unusable on exactly the vault it was meant to repair —
    # measured 2026-08-02, immediately after a reinitialise that had left a perfectly
    # good root token on the host.
    #
    # So: if BAO_TOKEN is set and works, use it. Only fall back to generate-root when
    # there is nothing else, and say so rather than failing opaquely.
    if [ -n "${BAO_TOKEN:-}" ] && bao_exec_env token lookup >/dev/null 2>&1; then
        info "Using the existing BAO_TOKEN — no root generation needed"
    else

    # Generate a temporary root token (cancel any stale attempt first)
    echo "Generating temporary root token..."
    bao_exec operator generate-root -cancel >/dev/null 2>&1 || true
    local init_output otp nonce encoded root_token
    init_output=$(bao_exec operator generate-root -init -format=json 2>/dev/null)
    otp=$(echo "$init_output" | python3 -c "import sys,json; print(json.load(sys.stdin)['otp'])")
    nonce=$(echo "$init_output" | python3 -c "import sys,json; print(json.load(sys.stdin)['nonce'])")

    encoded=$(echo "$unseal_key" | docker exec -i -e "BAO_ADDR=http://127.0.0.1:8200" "$CONTAINER_NAME" \
        bao operator generate-root -nonce="$nonce" -format=json - 2>/dev/null | \
        python3 -c "import sys,json; print(json.load(sys.stdin)['encoded_root_token'])")

    root_token=$(bao_exec operator generate-root -decode="$encoded" -otp="$otp" 2>/dev/null)

    if [ -z "$root_token" ]; then
        die "Failed to generate root token. On OpenBao >= 2.5.3 the unauthenticated
root-generation endpoints are disabled by default, so this cannot mint one. Supply an
existing root token instead:

  export BAO_TOKEN=\"\$(sudo cat /opt/hill90/secrets/openbao-root.token)\"
  bash scripts/vault.sh bootstrap-approles"
    fi
    info "Root token generated"

    # Export for bao_exec_env
    export BAO_TOKEN="$root_token"
    fi

    # Run setup (idempotent — creates AppRoles, policies, KV engine)
    echo ""
    echo "Running setup (idempotent)..."
    cmd_setup

    # Generate and store credentials for each service
    echo ""
    echo "Generating AppRole credentials for each service..."
    local stored=0

    for svc in $VAULT_SERVICES; do
        local svc_upper
        svc_upper=$(echo "$svc" | tr '[:lower:]' '[:upper:]')
        local role_id_key="VAULT_${svc_upper}_ROLE_ID"
        local secret_id_key="VAULT_${svc_upper}_SECRET_ID"

        # Read role_id
        local role_id
        role_id=$(bao_exec_env read -format=json "auth/approle/role/${svc}/role-id" 2>/dev/null | \
            python3 -c "import sys,json; print(json.load(sys.stdin)['data']['role_id'])")

        if [ -z "$role_id" ]; then
            warn "Failed to read role_id for ${svc} — skipping"
            continue
        fi

        # Generate a new secret_id
        local secret_id
        secret_id=$(bao_exec_env write -f -format=json "auth/approle/role/${svc}/secret-id" 2>/dev/null | \
            python3 -c "import sys,json; print(json.load(sys.stdin)['data']['secret_id'])")

        if [ -z "$secret_id" ]; then
            warn "Failed to generate secret_id for ${svc} — skipping"
            continue
        fi

        # Store in SOPS
        local escaped_role_id escaped_secret_id
        escaped_role_id=$(printf '%s' "$role_id" | jq -Rs .)
        escaped_secret_id=$(printf '%s' "$secret_id" | jq -Rs .)

        sops --set "[\"${role_id_key}\"] ${escaped_role_id}" "$SECRETS_FILE" || {
            warn "Failed to store ${role_id_key} in SOPS"
            continue
        }
        sops --set "[\"${secret_id_key}\"] ${escaped_secret_id}" "$SECRETS_FILE" || {
            warn "Failed to store ${secret_id_key} in SOPS"
            continue
        }

        echo "  ${svc}: role_id + secret_id stored in SOPS"
        stored=$((stored + 1))
    done

    # Revoke the temporary root token
    echo ""
    echo "Revoking temporary root token..."
    bao_exec_env token revoke -self 2>/dev/null || warn "Failed to revoke root token (may have already expired)"
    unset BAO_TOKEN

    echo ""
    local total
    # shellcheck disable=SC2086
    total=$(echo $VAULT_SERVICES | wc -w | tr -d ' ')
    success "Bootstrap complete! ${stored}/${total} services configured."
    echo ""
    echo "IMPORTANT: Commit and push the updated SOPS file:"
    echo "  git add infra/secrets/prod.enc.env"
    echo "  git commit -m 'chore: bootstrap AppRole credentials in SOPS'"
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

# Assert the end state, not the exit code of the attempt.
#
# WHY THIS EXISTS: cmd_auto_unseal returns 0 when the container never appears —
# deliberately, because on a fresh VPS OpenBao is not deployed yet and a failed
# unit there would be noise. But at BOOT on a live host that is precisely the
# failure that matters: the unit exits 0, having done nothing, and OpenBao stays
# sealed with nothing marking it. On a homelab that silence can last days.
#
# So the systemd unit runs this afterwards. It separates the two cases the exit
# code conflates:
#
#   container absent    -> 0. Nothing to unseal. Fresh VPS, or vault not deployed.
#   container + unsealed-> 0. The good path.
#   container + sealed  -> 1. Loud: the unit goes to `failed` and stays there.
#
# `bao status` exits 0 unsealed, 2 sealed, 1 on error — so anything non-zero
# here is a real problem, and an error is reported as one rather than swallowed.
cmd_assert_unsealed() {
    if ! docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
        echo "OpenBao container '${CONTAINER_NAME}' is not deployed — nothing to assert."
        return 0
    fi

    local rc=0
    bao_exec status >/dev/null 2>&1 || rc=$?
    case "$rc" in
        0) success "OpenBao is unsealed." ;;
        2) die "OpenBao is STILL SEALED after auto-unseal ran. Nothing that depends on Vault will resolve a secret until this is fixed: bash scripts/vault.sh unseal (see docs/runbooks/vault-unseal.md)" ;;
        *) die "Could not determine OpenBao seal state (bao status exit ${rc}). Treating as failed rather than assuming healthy." ;;
    esac
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
        revoke-root)   cmd_revoke_root "$@" ;;
        store-unseal-key) cmd_store_unseal_key "$@" ;;
        unseal)        cmd_unseal "$@" ;;
        status)        cmd_status "$@" ;;
        setup)         cmd_setup "$@" ;;
        setup-oidc)    cmd_setup_oidc "$@" ;;
        seed)          cmd_seed "$@" ;;
        policy-apply)  cmd_policy_apply "$@" ;;
        backup)        cmd_backup "$@" ;;
        export)        cmd_export "$@" ;;
        auto-unseal)        cmd_auto_unseal "$@" ;;
        assert-unsealed)    cmd_assert_unsealed "$@" ;;
        sync-to-sops)       cmd_sync_to_sops "$@" ;;
        setup-sync-token)   cmd_setup_sync_token "$@" ;;
        bootstrap-approles) cmd_bootstrap_approles "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
