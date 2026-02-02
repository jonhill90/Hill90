#!/bin/bash
# Main infrastructure validation orchestrator
# Runs all validation checks in sequence

set -e

ENV=${1:-prod}

echo "========================================"
echo "Infrastructure Validation - ${ENV}"
echo "========================================"
echo ""

all_valid=true
validation_errors=()

# Function to run validation and track results
run_validation() {
  local script=$1
  local name=$2

  if bash "$script" "$ENV"; then
    echo ""
  else
    all_valid=false
    validation_errors+=("$name")
  fi
}

# Run all validation scripts
run_validation "scripts/validate-traefik.sh" "Traefik configuration"
run_validation "scripts/validate-secrets.sh" "Secrets"
run_validation "scripts/validate-compose.sh" "Docker Compose"

# Final summary
echo "========================================"
echo "Validation Summary"
echo "========================================"
echo ""

if [ "$all_valid" = true ]; then
  echo "✓ All validation checks passed!"
  echo ""
  echo "Ready to deploy:"
  echo "  make deploy              # STAGING certificates"
  echo "  make deploy-production   # PRODUCTION certificates"
  echo ""
  echo "========================================"
  exit 0
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
  echo "To skip validation (NOT RECOMMENDED):"
  echo "  SKIP_VALIDATION=true bash scripts/deploy.sh ${ENV}"
  echo ""
  echo "========================================"
  exit 1
fi
