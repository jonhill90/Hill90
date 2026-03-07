#!/usr/bin/env bash
# Secrets CLI — manage SOPS-encrypted secrets
# Usage: secrets.sh {init|view|update|generate} [args]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Secrets CLI — Hill90 secrets management

Usage: secrets.sh <command> [args]

Commands:
  init                                    Initialize SOPS keys
  view   [secret_file] [key]             View secrets (all or specific key)
  get    <secret_file> <key>             Get raw secret value (no ANSI, no prefix)
  update <secret_file> <key> <value>     Update a secret value
  generate                               Generate all production secrets
  help                                   Show this help message

Defaults:
  secret_file: infra/secrets/prod.enc.env
EOF
}

# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------

cmd_init() {
    echo "================================"
    echo "Hill90 Secrets Initialization"
    echo "================================"

    require_command age-keygen
    require_command sops

    local secrets_dir="infra/secrets"
    local keys_dir="$secrets_dir/keys"
    mkdir -p "$keys_dir"

    # Generate age keypair for production
    if [ ! -f "$keys_dir/age-prod.key" ]; then
        echo "Generating production age keypair..."
        age-keygen -o "$keys_dir/age-prod.key"
        age-keygen -y "$keys_dir/age-prod.key" > "$keys_dir/age-prod.pub"
        echo "✓ Production keypair generated"
    else
        echo "✓ Production keypair already exists"
    fi

    # Generate age keypair for development
    if [ ! -f "$keys_dir/age-dev.key" ]; then
        echo "Generating development age keypair..."
        age-keygen -o "$keys_dir/age-dev.key"
        age-keygen -y "$keys_dir/age-dev.key" > "$keys_dir/age-dev.pub"
        echo "✓ Development keypair generated"
    else
        echo "✓ Development keypair already exists"
    fi

    echo ""
    echo "Public Keys (add these to .sops.yaml):"
    echo "--------------------------------------"
    echo "Production:"
    cat "$keys_dir/age-prod.pub"
    echo ""
    echo "Development:"
    cat "$keys_dir/age-dev.pub"
    echo ""

    local prod_pub dev_pub
    prod_pub=$(cat "$keys_dir/age-prod.pub")
    dev_pub=$(cat "$keys_dir/age-dev.pub")

    cat > "$secrets_dir/.sops.yaml" <<SOPS_EOF
# SOPS Configuration for Hill90
creation_rules:
  - path_regex: prod\.enc\.env$
    age: >-
      $prod_pub

  - path_regex: dev\.enc\.env$
    age: >-
      $dev_pub
SOPS_EOF

    echo "✓ .sops.yaml updated with public keys"
    echo ""
    echo "================================"
    echo "Secrets initialization complete!"
    echo "================================"
    echo ""
    echo "Next steps:"
    echo "1. Copy prod.enc.env.example to prod.env"
    echo "2. Fill in actual secret values"
    echo "3. Encrypt: sops -e prod.env > prod.enc.env"
    echo "4. Delete plaintext: rm prod.env"
}

# ---------------------------------------------------------------------------
# view
# ---------------------------------------------------------------------------

cmd_view() {
    local secret_file="${1:-infra/secrets/prod.enc.env}"
    local key="${2:-}"

    require_file "$secret_file" "Secret file"
    ensure_age_key

    if [ -z "$key" ]; then
        echo -e "${YELLOW}Viewing all secrets from $secret_file:${NC}"
        echo ""
        sops -d "$secret_file" | grep -v "^#" | grep -v "^$"
    else
        echo -e "${YELLOW}Viewing secret $key from $secret_file:${NC}"
        echo ""
        local value
        value=$(sops -d --extract "[\"${key}\"]" "$secret_file" 2>/dev/null || echo "")
        if [ -z "$value" ]; then
            die "Secret not found: $key"
        else
            echo -e "${GREEN}$key=${value}${NC}"
        fi
    fi
}

# ---------------------------------------------------------------------------
# get — raw value, no ANSI, no KEY= prefix, preserves trailing = chars
# ---------------------------------------------------------------------------

cmd_get() {
    local secret_file="${1:-}"
    local key="${2:-}"

    if [ -z "$secret_file" ] || [ -z "$key" ]; then
        echo "Usage: secrets.sh get <secret_file> <key>" >&2
        exit 1
    fi

    require_file "$secret_file" "Secret file"
    ensure_age_key

    local value
    value=$(sops -d --extract "[\"${key}\"]" "$secret_file" 2>/dev/null || echo "")
    if [ -z "$value" ]; then
        echo "Secret not found: $key" >&2
        exit 1
    fi
    printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# update
# ---------------------------------------------------------------------------

cmd_update() {
    local secret_file="${1:-}"
    local key="${2:-}"
    local value="${3:-}"

    if [ -z "$secret_file" ] || [ -z "$key" ] || [ -z "$value" ]; then
        echo -e "${RED}Error: Missing arguments${NC}"
        echo "Usage: secrets.sh update <secret_file> <key> <value>"
        echo ""
        echo "Example:"
        echo "  secrets.sh update infra/secrets/prod.enc.env VPS_IP \"76.13.26.69\""
        exit 1
    fi

    require_file "$secret_file" "Secret file"
    ensure_age_key

    echo -e "${YELLOW}Updating secret $key in $secret_file...${NC}"

    # Backup the file first
    local backup_file="${secret_file}.backup.$(date +%s)"
    cp "$secret_file" "$backup_file"
    echo -e "${YELLOW}Created backup: $backup_file${NC}"

    # Update the secret atomically using sops --set
    local escaped_value
    escaped_value=$(echo -n "$value" | jq -Rs .)
    if sops --set "[\"${key}\"] ${escaped_value}" "$secret_file"; then
        echo -e "${GREEN}✓ Secret updated successfully!${NC}"
        echo -e "${YELLOW}Backup saved: $backup_file${NC}"

        # Clean up old backups (keep only last 5)
        local backup_count
        backup_count=$(ls -1 "${secret_file}.backup."* 2>/dev/null | wc -l | tr -d ' ')
        if [ "$backup_count" -gt 5 ]; then
            echo -e "${YELLOW}Cleaning up old backups (keeping last 5)...${NC}"
            ls -1t "${secret_file}.backup."* | tail -n +6 | xargs rm -f
            echo -e "${GREEN}✓ Cleaned up $((backup_count - 5)) old backup(s)${NC}"
        fi
    else
        echo -e "${RED}✗ Failed to update secret${NC}"
        echo -e "${YELLOW}Restoring from backup...${NC}"
        mv "$backup_file" "$secret_file"
        echo -e "${GREEN}Restored from backup${NC}"
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# generate
# ---------------------------------------------------------------------------

cmd_generate() {
    local secrets_file="$PROJECT_ROOT/infra/secrets/prod.enc.env"

    export SOPS_AGE_KEY_FILE="$PROJECT_ROOT/infra/secrets/keys/age-prod.key"
    require_file "$SOPS_AGE_KEY_FILE" "Age key"
    require_file "$secrets_file" "Secrets file"

    generate_secret() {
        openssl rand -base64 32 | tr -d '\n'
    }

    generate_bcrypt_hash() {
        local password="$1"
        if command -v htpasswd &> /dev/null; then
            htpasswd -nbB "" "$password" | cut -d: -f2 | tr -d '\n'
        else
            echo "$password" | openssl passwd -apr1 -stdin | tr -d '\n'
        fi
    }

    generate_jwt_keys() {
        local private_key_file public_key_file
        private_key_file=$(mktemp)
        public_key_file=$(mktemp)
        openssl genrsa -out "$private_key_file" 2048 2>/dev/null
        openssl rsa -in "$private_key_file" -pubout -out "$public_key_file" 2>/dev/null
        local private_key public_key
        private_key=$(cat "$private_key_file" | base64 | tr -d '\n')
        public_key=$(cat "$public_key_file" | base64 | tr -d '\n')
        rm -f "$private_key_file" "$public_key_file"
        echo "$private_key|$public_key"
    }

    echo "Generating all production secrets..."
    echo ""

    echo "1. Generating database password..."
    local db_pw
    db_pw=$(generate_secret)
    make -C "$PROJECT_ROOT" secrets-update KEY=DB_PASSWORD VALUE="$db_pw" > /dev/null 2>&1
    echo "   ✓ DB_PASSWORD set"

    echo ""
    echo "2. Generating JWT secret..."
    local jwt_secret
    jwt_secret=$(generate_secret)
    make -C "$PROJECT_ROOT" secrets-update KEY=JWT_SECRET VALUE="$jwt_secret" > /dev/null 2>&1
    echo "   ✓ JWT_SECRET set"

    echo ""
    echo "3. Generating JWT RSA key pair..."
    local jwt_keys jwt_priv jwt_pub
    jwt_keys=$(generate_jwt_keys)
    jwt_priv=$(echo "$jwt_keys" | cut -d'|' -f1)
    jwt_pub=$(echo "$jwt_keys" | cut -d'|' -f2)
    make -C "$PROJECT_ROOT" secrets-update KEY=JWT_PRIVATE_KEY VALUE="$jwt_priv" > /dev/null 2>&1
    make -C "$PROJECT_ROOT" secrets-update KEY=JWT_PUBLIC_KEY VALUE="$jwt_pub" > /dev/null 2>&1
    echo "   ✓ JWT_PRIVATE_KEY set"
    echo "   ✓ JWT_PUBLIC_KEY set"

    echo ""
    echo "4. Generating internal service secret..."
    local internal_secret
    internal_secret=$(generate_secret)
    make -C "$PROJECT_ROOT" secrets-update KEY=INTERNAL_SERVICE_SECRET VALUE="$internal_secret" > /dev/null 2>&1
    echo "   ✓ INTERNAL_SERVICE_SECRET set"

    echo ""
    echo "5. Generating Traefik admin password..."
    local traefik_pw traefik_hash
    traefik_pw=$(generate_secret | cut -c1-20)
    traefik_hash=$(generate_bcrypt_hash "$traefik_pw")
    make -C "$PROJECT_ROOT" secrets-update KEY=TRAEFIK_ADMIN_PASSWORD_HASH VALUE="$traefik_hash" > /dev/null 2>&1
    echo "   ✓ TRAEFIK_ADMIN_PASSWORD_HASH set"

    echo ""
    echo "6. Setting user-confirmed values..."
    make -C "$PROJECT_ROOT" secrets-update KEY=ACME_EMAIL VALUE="jonhill90@live.com" > /dev/null 2>&1
    echo "   ✓ ACME_EMAIL=jonhill90@live.com"
    make -C "$PROJECT_ROOT" secrets-update KEY=DB_USER VALUE="hill90" > /dev/null 2>&1
    echo "   ✓ DB_USER=hill90"
    make -C "$PROJECT_ROOT" secrets-update KEY=DB_NAME VALUE="hill90" > /dev/null 2>&1
    echo "   ✓ DB_NAME=hill90"

    echo ""
    echo "✓ All secrets generated and encrypted!"
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
        init)           cmd_init "$@" ;;
        view)           cmd_view "$@" ;;
        get)            cmd_get "$@" ;;
        update)         cmd_update "$@" ;;
        generate)       cmd_generate "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
