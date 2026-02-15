#!/usr/bin/env bash
# Validate CLI — validate infrastructure configuration
# Usage: validate.sh {all|compose|secrets|traefik} [env]
# shellcheck source=_common.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Validate CLI — Hill90 infrastructure validation

Usage: validate.sh <command> [env]

Commands:
  all       Run all validations
  compose   Validate Docker Compose configuration
  secrets   Validate secrets configuration
  traefik   Validate Traefik configuration
  help      Show this help message

Environment: defaults to 'prod'
EOF
}

# ---------------------------------------------------------------------------
# Traefik validation
# ---------------------------------------------------------------------------

cmd_traefik() {
    local env="${1:-prod}"
    local traefik_config="platform/edge/traefik.yml"
    local dynamic_dir="platform/edge/dynamic"

    echo "================================"
    echo "Traefik Configuration Validation"
    echo "================================"
    echo ""

    local all_valid=true

    echo -n "Checking traefik.yml exists... "
    if [ -f "$traefik_config" ]; then
        echo "✓"
    else
        echo "✗ Not found: $traefik_config"
        all_valid=false
    fi

    if [ -f "$traefik_config" ]; then
        echo -n "Validating traefik.yml syntax... "
        if python3 -c "import yaml; yaml.safe_load(open('$traefik_config'))" 2>/dev/null; then
            echo "✓"
        elif python3 -c "import yaml" 2>/dev/null; then
            echo "✗ Invalid YAML syntax"
            all_valid=false
        else
            echo "⊘ Skipped (PyYAML not installed)"
        fi

        echo -n "Checking certificatesResolvers configuration... "
        if grep -q "certificatesResolvers:" "$traefik_config"; then
            echo "✓"
        else
            echo "✗ Missing certificatesResolvers section"
            all_valid=false
        fi

        echo -n "Checking letsencrypt resolver... "
        if grep -q "letsencrypt:" "$traefik_config"; then
            echo "✓"
        else
            echo "✗ Missing letsencrypt resolver"
            all_valid=false
        fi

        echo -n "Checking ACME configuration... "
        if grep -q "acme:" "$traefik_config" && \
           grep -q "email:" "$traefik_config" && \
           grep -q "storage:" "$traefik_config" && \
           grep -q "httpChallenge:" "$traefik_config"; then
            echo "✓"
        else
            echo "✗ Incomplete ACME configuration"
            all_valid=false
        fi

        echo -n "Checking entrypoints (web, websecure)... "
        if grep -q "web:" "$traefik_config" && \
           grep -q "websecure:" "$traefik_config"; then
            echo "✓"
        else
            echo "✗ Missing required entrypoints"
            all_valid=false
        fi

        echo -n "Checking Docker provider... "
        if grep -q "docker:" "$traefik_config"; then
            echo "✓"
        else
            echo "✗ Docker provider not configured"
            all_valid=false
        fi

        echo -n "Checking letsencrypt-dns resolver... "
        if grep -q "^  letsencrypt-dns:" "$traefik_config"; then
            echo "✓"
        else
            echo "✗ Missing letsencrypt-dns resolver (required for Tailscale-only services)"
            all_valid=false
        fi

        echo -n "Checking for uninterpolated env vars in traefik.yml... "
        if grep -q '\${' "$traefik_config"; then
            echo "✗ Found \${...} — Traefik does not interpolate env vars in YAML"
            all_valid=false
        else
            echo "✓"
        fi
    fi

    echo -n "Checking dynamic config directory... "
    if [ -d "$dynamic_dir" ]; then
        echo "✓"
    else
        echo "✗ Directory not found: $dynamic_dir"
        all_valid=false
    fi

    if [ -d "$dynamic_dir" ]; then
        echo -n "Validating dynamic config files... "
        if python3 -c "import yaml" 2>/dev/null; then
            local dynamic_valid=true
            for config_file in "$dynamic_dir"/*.yml "$dynamic_dir"/*.yaml; do
                if [ -f "$config_file" ]; then
                    if ! python3 -c "import yaml; yaml.safe_load(open('$config_file'))" 2>/dev/null; then
                        echo "✗ Invalid YAML in $(basename "$config_file")"
                        dynamic_valid=false
                        all_valid=false
                    fi
                fi
            done
            if [ "$dynamic_valid" = true ]; then
                echo "✓"
            fi
        else
            echo "⊘ Skipped (PyYAML not installed)"
        fi

        echo -n "Checking tailscale-only middleware... "
        if grep -q "tailscale-only:" "$dynamic_dir/middlewares.yml" 2>/dev/null; then
            echo "✓"
        else
            echo "✗ Missing tailscale-only middleware (required for Portainer)"
            all_valid=false
        fi

        echo -n "Checking auth uses usersFile... "
        if grep -q "usersFile:" "$dynamic_dir/middlewares.yml" 2>/dev/null; then
            echo "✓"
        else
            echo "✗ auth middleware should use usersFile, not inline users"
            all_valid=false
        fi

        echo -n "Checking for uninterpolated env vars in middlewares... "
        if grep -q '\${' "$dynamic_dir/middlewares.yml" 2>/dev/null; then
            echo "✗ Found \${...} — Traefik does not interpolate env vars"
            all_valid=false
        else
            echo "✓"
        fi
    fi

    echo ""
    echo "================================"
    if [ "$all_valid" = true ]; then
        echo "✓ Traefik configuration valid"
        echo "================================"
        return 0
    else
        echo "✗ Traefik configuration has errors"
        echo "================================"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Secrets validation
# ---------------------------------------------------------------------------

cmd_secrets() {
    local env="${1:-prod}"
    local secrets_file="infra/secrets/${env}.enc.env"

    if [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
        local age_key="infra/secrets/keys/age-${env}.key"
        export SOPS_AGE_KEY_FILE="$age_key"
    else
        local age_key="$SOPS_AGE_KEY_FILE"
    fi

    echo "================================"
    echo "Secrets Validation"
    echo "================================"
    echo ""

    local all_valid=true

    echo -n "Checking age key ($age_key)... "
    if [ -f "$age_key" ]; then
        echo "✓"
    else
        echo "✗ Not found: $age_key"
        echo ""
        echo "================================"
        echo "✗ Cannot proceed without age key"
        echo "================================"
        return 1
    fi

    echo -n "Checking SOPS installation... "
    if command -v sops >/dev/null 2>&1; then
        echo "✓"
    else
        echo "✗ SOPS not installed"
        echo ""
        echo "================================"
        echo "✗ Install SOPS: brew install sops"
        echo "================================"
        return 1
    fi

    echo -n "Checking secrets file ($secrets_file)... "
    if [ -f "$secrets_file" ]; then
        echo "✓"
    else
        echo "✗ Not found: $secrets_file"
        echo ""
        echo "================================"
        echo "✗ Secrets file missing"
        echo "================================"
        return 1
    fi

    echo -n "Testing SOPS decryption... "
    if sops -d "$secrets_file" > /dev/null 2>&1; then
        echo "✓"
    else
        echo "✗ Cannot decrypt secrets"
        echo ""
        echo "================================"
        echo "✗ SOPS decryption failed"
        echo "================================"
        return 1
    fi

    local required_secrets=(
        "VPS_IP" "VPS_HOST" "DB_USER" "DB_PASSWORD" "DB_NAME"
        "JWT_SECRET" "ACME_EMAIL" "ACME_CA_SERVER"
    )
    local optional_secrets=(
        "ANTHROPIC_API_KEY" "OPENAI_API_KEY" "JWT_PRIVATE_KEY" "JWT_PUBLIC_KEY"
    )

    echo ""
    echo "Checking required secrets:"
    for secret in "${required_secrets[@]}"; do
        echo -n "  $secret... "
        if sops -d "$secrets_file" 2>/dev/null | grep -q "^${secret}="; then
            echo "✓"
        else
            echo "✗ Missing"
            all_valid=false
        fi
    done

    echo ""
    echo "Checking optional secrets (warnings only):"
    for secret in "${optional_secrets[@]}"; do
        echo -n "  $secret... "
        if sops -d "$secrets_file" 2>/dev/null | grep -q "^${secret}="; then
            echo "✓"
        else
            echo "⚠ Missing (optional)"
        fi
    done

    echo ""
    echo "================================"
    if [ "$all_valid" = true ]; then
        echo "✓ All required secrets present"
        echo "================================"
        return 0
    else
        echo "✗ Some required secrets are missing"
        echo ""
        echo "Update secrets:"
        echo "  make secrets-edit"
        echo "  OR"
        echo "  make secrets-update KEY=<key> VALUE=<value>"
        echo "================================"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Compose validation
# ---------------------------------------------------------------------------

cmd_compose() {
    local env="${1:-prod}"
    local compose_file="deployments/compose/${env}/docker-compose.yml"

    echo "================================"
    echo "Docker Compose Validation"
    echo "================================"
    echo ""

    local all_valid=true

    echo -n "Checking compose file exists... "
    if [ -f "$compose_file" ]; then
        echo "✓"
    else
        echo "✗ Not found: $compose_file"
        echo ""
        echo "================================"
        echo "✗ Compose file missing"
        echo "================================"
        return 1
    fi

    echo -n "Checking Docker installation... "
    if command -v docker >/dev/null 2>&1; then
        echo "✓"
    else
        echo "✗ Docker not installed"
        echo ""
        echo "================================"
        echo "✗ Install Docker Desktop"
        echo "================================"
        return 1
    fi

    echo -n "Checking Docker daemon... "
    if docker info >/dev/null 2>&1; then
        echo "✓"
    else
        echo "✗ Docker daemon not running"
        echo ""
        echo "================================"
        echo "✗ Start Docker Desktop"
        echo "================================"
        return 1
    fi

    echo -n "Validating compose file syntax... "
    if docker compose -f "$compose_file" config > /dev/null 2>&1; then
        echo "✓"
    else
        echo "✗ Invalid compose syntax"
        all_valid=false
        echo ""
        echo "Run to see errors:"
        echo "  docker compose -f $compose_file config"
    fi

    if [ -f "$compose_file" ]; then
        echo ""
        echo "Checking required services:"
        for service in traefik api ai auth postgres; do
            echo -n "  $service... "
            if grep -q "^  ${service}:" "$compose_file"; then
                echo "✓"
            else
                echo "✗ Missing service definition"
                all_valid=false
            fi
        done

        echo ""
        echo "Checking required networks:"
        for network in edge internal; do
            echo -n "  $network... "
            if grep -q "^  ${network}:" "$compose_file"; then
                echo "✓"
            else
                echo "✗ Missing network definition"
                all_valid=false
            fi
        done

        echo ""
        echo "Checking Traefik configuration files:"
        echo -n "  traefik.yml... "
        if [ -f "platform/edge/traefik.yml" ]; then
            echo "✓"
        else
            echo "✗ File not found"
            all_valid=false
        fi

        echo -n "  dynamic config directory... "
        if [ -d "platform/edge/dynamic" ]; then
            echo "✓"
        else
            echo "✗ Directory not found"
            all_valid=false
        fi
    fi

    echo ""
    echo "================================"
    if [ "$all_valid" = true ]; then
        echo "✓ Docker Compose configuration valid"
        echo "================================"
        return 0
    else
        echo "✗ Docker Compose configuration has errors"
        echo "================================"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# All validations
# ---------------------------------------------------------------------------

cmd_all() {
    local env="${1:-prod}"

    echo "========================================"
    echo "Infrastructure Validation - ${env}"
    echo "========================================"
    echo ""

    local all_valid=true
    local validation_errors=()

    run_validation() {
        local name=$1
        shift
        if "$@" "$env"; then
            echo ""
        else
            all_valid=false
            validation_errors+=("$name")
        fi
    }

    run_validation "Traefik configuration" cmd_traefik
    run_validation "Secrets" cmd_secrets
    run_validation "Docker Compose" cmd_compose

    echo "========================================"
    echo "Validation Summary"
    echo "========================================"
    echo ""

    if [ "$all_valid" = true ]; then
        echo "✓ All validation checks passed!"
        echo ""
        echo "Ready to deploy:"
        echo "  make deploy-infra        # Infrastructure (Traefik, dns-manager, Portainer)"
        echo "  make deploy-all          # All application services"
        echo ""
        echo "========================================"
        return 0
    else
        echo "✗ Validation failed!"
        echo ""
        echo "Failed checks:"
        for error in "${validation_errors[@]}"; do
            echo "  - $error"
        done
        echo ""
        echo "Fix the errors above before deploying."
        echo ""
        echo "========================================"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

main() {
    local cmd="${1:-all}"

    case "$cmd" in
        all)            shift 2>/dev/null || true; cmd_all "$@" ;;
        compose)        shift; cmd_compose "$@" ;;
        secrets)        shift; cmd_secrets "$@" ;;
        traefik)        shift; cmd_traefik "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
