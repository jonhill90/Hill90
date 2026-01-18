#!/bin/bash
# Validate Traefik configuration

set -e

ENV=${1:-prod}
TRAEFIK_CONFIG="deployments/platform/edge/traefik.yml"
DYNAMIC_DIR="deployments/platform/edge/dynamic"

echo "================================"
echo "Traefik Configuration Validation"
echo "================================"
echo ""

all_valid=true

# Check traefik.yml exists
echo -n "Checking traefik.yml exists... "
if [ -f "$TRAEFIK_CONFIG" ]; then
  echo "✓"
else
  echo "✗ Not found: $TRAEFIK_CONFIG"
  all_valid=false
fi

# Validate YAML syntax (using python3 if PyYAML is available)
if [ -f "$TRAEFIK_CONFIG" ]; then
  echo -n "Validating traefik.yml syntax... "
  if python3 -c "import yaml; yaml.safe_load(open('$TRAEFIK_CONFIG'))" 2>/dev/null; then
    echo "✓"
  else
    # Check if PyYAML is installed
    if python3 -c "import yaml" 2>/dev/null; then
      echo "✗ Invalid YAML syntax"
      all_valid=false
    else
      echo "⊘ Skipped (PyYAML not installed)"
    fi
  fi
fi

# Check certificatesResolvers section exists
if [ -f "$TRAEFIK_CONFIG" ]; then
  echo -n "Checking certificatesResolvers configuration... "
  if grep -q "certificatesResolvers:" "$TRAEFIK_CONFIG"; then
    echo "✓"
  else
    echo "✗ Missing certificatesResolvers section"
    all_valid=false
  fi
fi

# Check letsencrypt resolver is defined
if [ -f "$TRAEFIK_CONFIG" ]; then
  echo -n "Checking letsencrypt resolver... "
  if grep -q "letsencrypt:" "$TRAEFIK_CONFIG"; then
    echo "✓"
  else
    echo "✗ Missing letsencrypt resolver"
    all_valid=false
  fi
fi

# Check ACME configuration
if [ -f "$TRAEFIK_CONFIG" ]; then
  echo -n "Checking ACME configuration... "
  if grep -q "acme:" "$TRAEFIK_CONFIG" && \
     grep -q "email:" "$TRAEFIK_CONFIG" && \
     grep -q "storage:" "$TRAEFIK_CONFIG" && \
     grep -q "httpChallenge:" "$TRAEFIK_CONFIG"; then
    echo "✓"
  else
    echo "✗ Incomplete ACME configuration"
    all_valid=false
  fi
fi

# Check entrypoints defined
if [ -f "$TRAEFIK_CONFIG" ]; then
  echo -n "Checking entrypoints (web, websecure)... "
  if grep -q "web:" "$TRAEFIK_CONFIG" && \
     grep -q "websecure:" "$TRAEFIK_CONFIG"; then
    echo "✓"
  else
    echo "✗ Missing required entrypoints"
    all_valid=false
  fi
fi

# Check docker provider configured
if [ -f "$TRAEFIK_CONFIG" ]; then
  echo -n "Checking Docker provider... "
  if grep -q "docker:" "$TRAEFIK_CONFIG"; then
    echo "✓"
  else
    echo "✗ Docker provider not configured"
    all_valid=false
  fi
fi

# Check dynamic config directory exists
echo -n "Checking dynamic config directory... "
if [ -d "$DYNAMIC_DIR" ]; then
  echo "✓"
else
  echo "✗ Directory not found: $DYNAMIC_DIR"
  all_valid=false
fi

# Validate dynamic config files if directory exists
if [ -d "$DYNAMIC_DIR" ]; then
  echo -n "Validating dynamic config files... "

  # Check if PyYAML is available
  if python3 -c "import yaml" 2>/dev/null; then
    dynamic_valid=true

    for config_file in "$DYNAMIC_DIR"/*.yml "$DYNAMIC_DIR"/*.yaml; do
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
fi

echo ""
echo "================================"
if [ "$all_valid" = true ]; then
  echo "✓ Traefik configuration valid"
  echo "================================"
  exit 0
else
  echo "✗ Traefik configuration has errors"
  echo "================================"
  exit 1
fi
