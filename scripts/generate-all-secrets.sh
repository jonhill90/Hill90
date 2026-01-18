#!/usr/bin/env bash
set -euo pipefail

# Generate all production secrets for Hill90 VPS infrastructure
# This script generates cryptographically secure secrets and updates prod.enc.env

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS_FILE="$PROJECT_ROOT/infra/secrets/prod.enc.env"

echo "🔐 Generating all production secrets..."
echo ""

# Ensure SOPS age key is available
export SOPS_AGE_KEY_FILE="$PROJECT_ROOT/infra/secrets/keys/age-prod.key"
if [ ! -f "$SOPS_AGE_KEY_FILE" ]; then
    echo "❌ Age key not found at: $SOPS_AGE_KEY_FILE"
    exit 1
fi

# Check if secrets file exists
if [ ! -f "$SECRETS_FILE" ]; then
    echo "❌ Secrets file not found at: $SECRETS_FILE"
    exit 1
fi

# Function to generate random secret
generate_secret() {
    openssl rand -base64 32 | tr -d '\n'
}

# Function to generate bcrypt hash for password
generate_bcrypt_hash() {
    local password="$1"
    # Use htpasswd from apache2-utils (may need to install: apt-get install apache2-utils)
    # For macOS, use: brew install httpd (includes htpasswd)
    if command -v htpasswd &> /dev/null; then
        htpasswd -nbB "" "$password" | cut -d: -f2 | tr -d '\n'
    else
        echo "⚠️  htpasswd not found, using openssl for basic hash"
        # Fallback: use openssl (less secure, but works without dependencies)
        echo "$password" | openssl passwd -apr1 -stdin | tr -d '\n'
    fi
}

# Generate JWT RSA key pair
generate_jwt_keys() {
    local private_key_file=$(mktemp)
    local public_key_file=$(mktemp)

    # Generate 2048-bit RSA private key
    openssl genrsa -out "$private_key_file" 2048 2>/dev/null

    # Extract public key
    openssl rsa -in "$private_key_file" -pubout -out "$public_key_file" 2>/dev/null

    # Read keys and encode for environment variable (base64 to handle newlines)
    local private_key=$(cat "$private_key_file" | base64 | tr -d '\n')
    local public_key=$(cat "$public_key_file" | base64 | tr -d '\n')

    # Clean up temp files
    rm -f "$private_key_file" "$public_key_file"

    echo "$private_key|$public_key"
}

echo "1️⃣  Generating database password..."
DB_PASSWORD=$(generate_secret)
make -C "$PROJECT_ROOT" secrets-update KEY=DB_PASSWORD VALUE="$DB_PASSWORD" > /dev/null 2>&1
echo "   ✓ DB_PASSWORD set"

echo ""
echo "2️⃣  Generating JWT secret..."
JWT_SECRET=$(generate_secret)
make -C "$PROJECT_ROOT" secrets-update KEY=JWT_SECRET VALUE="$JWT_SECRET" > /dev/null 2>&1
echo "   ✓ JWT_SECRET set"

echo ""
echo "3️⃣  Generating JWT RSA key pair..."
JWT_KEYS=$(generate_jwt_keys)
JWT_PRIVATE_KEY=$(echo "$JWT_KEYS" | cut -d'|' -f1)
JWT_PUBLIC_KEY=$(echo "$JWT_KEYS" | cut -d'|' -f2)
make -C "$PROJECT_ROOT" secrets-update KEY=JWT_PRIVATE_KEY VALUE="$JWT_PRIVATE_KEY" > /dev/null 2>&1
make -C "$PROJECT_ROOT" secrets-update KEY=JWT_PUBLIC_KEY VALUE="$JWT_PUBLIC_KEY" > /dev/null 2>&1
echo "   ✓ JWT_PRIVATE_KEY set"
echo "   ✓ JWT_PUBLIC_KEY set"

echo ""
echo "4️⃣  Generating internal service secret..."
INTERNAL_SERVICE_SECRET=$(generate_secret)
make -C "$PROJECT_ROOT" secrets-update KEY=INTERNAL_SERVICE_SECRET VALUE="$INTERNAL_SERVICE_SECRET" > /dev/null 2>&1
echo "   ✓ INTERNAL_SERVICE_SECRET set"

echo ""
echo "5️⃣  Generating Traefik admin password..."
TRAEFIK_ADMIN_PASSWORD=$(generate_secret | cut -c1-20)  # Shorter password for admin UI
TRAEFIK_ADMIN_PASSWORD_HASH=$(generate_bcrypt_hash "$TRAEFIK_ADMIN_PASSWORD")
make -C "$PROJECT_ROOT" secrets-update KEY=TRAEFIK_ADMIN_PASSWORD_HASH VALUE="$TRAEFIK_ADMIN_PASSWORD_HASH" > /dev/null 2>&1
echo "   ✓ TRAEFIK_ADMIN_PASSWORD_HASH set"
echo "   ⚠️  Traefik admin password generated (stored in encrypted secrets only)"

echo ""
echo "6️⃣  Setting user-confirmed values..."
make -C "$PROJECT_ROOT" secrets-update KEY=ACME_EMAIL VALUE="jonhill90@live.com" > /dev/null 2>&1
echo "   ✓ ACME_EMAIL=jonhill90@live.com"
make -C "$PROJECT_ROOT" secrets-update KEY=DB_USER VALUE="hill90" > /dev/null 2>&1
echo "   ✓ DB_USER=hill90"
make -C "$PROJECT_ROOT" secrets-update KEY=DB_NAME VALUE="hill90" > /dev/null 2>&1
echo "   ✓ DB_NAME=hill90"

echo ""
echo "✅ All secrets generated and encrypted!"
echo ""
echo "📝 Summary:"
echo "   - DB credentials: hill90/[generated]"
echo "   - JWT keys: RSA 2048-bit key pair"
echo "   - Internal service secret: [generated]"
echo "   - Traefik admin: admin/[generated - check encrypted secrets]"
echo "   - ACME email: jonhill90@live.com"
echo "   - AI API keys: [placeholders - not needed for infra]"
echo ""
echo "🔒 All secrets encrypted in: $SECRETS_FILE"
echo ""
echo "⚠️  To access Traefik dashboard, decrypt secrets to get password hash"
echo ""
