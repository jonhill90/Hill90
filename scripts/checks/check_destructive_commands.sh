#!/usr/bin/env bash
# Check that no deploy scripts or workflows contain destructive volume commands.
# Banned patterns (assembled from fragments to avoid self-matching):
#   docker compose ... down ... -v
#   docker volume rm
#   docker system prune
#
# Exit codes: 0 = clean, 1 = violation found

set -euo pipefail

FAIL=0

# Build banned patterns from fragments so this script does not match itself.
PAT_DOWN="docker compose.*down.*-v"
PAT_VOLRM="docker volume rm"
PAT_PRUNE="docker system prune"

for f in scripts/*.sh .github/workflows/*.yml; do
  [ -f "$f" ] || continue

  # Strip comment and blank lines before checking
  STRIPPED=$(grep -v '^[[:space:]]*#' "$f" 2>/dev/null | grep -v '^[[:space:]]*$') || true

  if echo "$STRIPPED" | grep -qE "$PAT_DOWN"; then
    echo "FAIL: $f contains 'docker compose down -v'"
    FAIL=1
  fi
  if echo "$STRIPPED" | grep -qE "$PAT_VOLRM"; then
    echo "FAIL: $f contains 'docker volume rm'"
    FAIL=1
  fi
  if echo "$STRIPPED" | grep -qE "$PAT_PRUNE"; then
    echo "FAIL: $f contains 'docker system prune'"
    FAIL=1
  fi
done

if [ "$FAIL" -eq 0 ]; then
  echo "No destructive volume commands found."
fi
exit $FAIL
