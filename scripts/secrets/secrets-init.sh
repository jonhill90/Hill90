#!/bin/bash
# Initialize SOPS secrets for Hill90

set -e

echo "================================"
echo "Hill90 Secrets Initialization"
echo "================================"

# Check prerequisites
if ! command -v age-keygen &> /dev/null; then
    echo "Error: age is not installed"
    echo "Install with: brew install age"
    exit 1
fi

if ! command -v sops &> /dev/null; then
    echo "Error: SOPS is not installed"
    echo "Install with: brew install sops"
    exit 1
fi

SECRETS_DIR="infra/secrets"
KEYS_DIR="$SECRETS_DIR/keys"

# Create keys directory
mkdir -p "$KEYS_DIR"

# Generate age keypair for production
if [ ! -f "$KEYS_DIR/age-prod.key" ]; then
    echo "Generating production age keypair..."
    age-keygen -o "$KEYS_DIR/age-prod.key"
    age-keygen -y "$KEYS_DIR/age-prod.key" > "$KEYS_DIR/age-prod.pub"
    echo "✓ Production keypair generated"
else
    echo "✓ Production keypair already exists"
fi

# Generate age keypair for development
if [ ! -f "$KEYS_DIR/age-dev.key" ]; then
    echo "Generating development age keypair..."
    age-keygen -o "$KEYS_DIR/age-dev.key"
    age-keygen -y "$KEYS_DIR/age-dev.key" > "$KEYS_DIR/age-dev.pub"
    echo "✓ Development keypair generated"
else
    echo "✓ Development keypair already exists"
fi

# Display public keys
echo ""
echo "Public Keys (add these to .sops.yaml):"
echo "--------------------------------------"
echo "Production:"
cat "$KEYS_DIR/age-prod.pub"
echo ""
echo "Development:"
cat "$KEYS_DIR/age-dev.pub"
echo ""

# Update .sops.yaml with public keys
PROD_PUB=$(cat "$KEYS_DIR/age-prod.pub")
DEV_PUB=$(cat "$KEYS_DIR/age-dev.pub")

cat > "$SECRETS_DIR/.sops.yaml" <<EOF
# SOPS Configuration for Hill90
creation_rules:
  - path_regex: prod\.enc\.env$
    age: >-
      $PROD_PUB

  - path_regex: dev\.enc\.env$
    age: >-
      $DEV_PUB
EOF

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
