#!/usr/bin/env bash
# check_docs_secrets.sh — CI gate: ensure docs/site/ contains no sensitive patterns.
# Scans .mdx, .yaml, .yml, .svg, and .md files for forbidden content.
set -euo pipefail

DOCS_DIR="docs/site"
EXIT_CODE=0

# Forbidden patterns (regex, one per line)
PATTERNS=(
  '100\.64\.'
  'SOPS'
  'age1[a-z0-9]'
  '/opt/hill90'
  'enc\.env'
  'TAILSCALE_'
  'HOSTINGER_API'
  'dec\.env'
  'sops\.yaml'
  'age-prod\.key'
  '10\.0\.0\.'
  '192\.168\.'
  '172\.(1[6-9]|2[0-9]|3[01])\.'
)

if [ ! -d "$DOCS_DIR" ]; then
  echo "SKIP: $DOCS_DIR directory not found"
  exit 0
fi

for pattern in "${PATTERNS[@]}"; do
  # Search text-like files only
  matches=$(grep -rn -E "$pattern" "$DOCS_DIR" \
    --exclude-dir='node_modules' \
    --include='*.mdx' --include='*.yaml' \
    --include='*.yml' --include='*.svg' --include='*.md' 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "FAIL: Forbidden pattern '$pattern' found in docs/site/:"
    echo "$matches"
    echo ""
    EXIT_CODE=1
  fi
done

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "PASS: No sensitive patterns found in $DOCS_DIR/"
fi

exit "$EXIT_CODE"
