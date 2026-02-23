#!/usr/bin/env bash
# CI anti-regression check: ensure legacy compose-managed agentbox
# deployment paths do not reappear after removal in PR #113.
#
# Exit codes:
#   0 — no legacy paths found
#   1 — at least one legacy artifact detected

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
failures=0

check_absent() {
    local file="$1"
    if [ -f "$ROOT/$file" ]; then
        echo "FAIL: $file still exists"
        failures=$((failures + 1))
    fi
}

check_no_match() {
    local file="$1"
    local pattern="$2"
    local label="$3"
    if grep -q "$pattern" "$ROOT/$file" 2>/dev/null; then
        echo "FAIL: $file contains '$pattern' ($label)"
        failures=$((failures + 1))
    fi
}

# Files that must not exist
check_absent "scripts/agentbox.sh"
check_absent "scripts/agentbox-compose-gen.py"
check_absent "deploy/compose/prod/docker-compose.agentbox.yml"
check_absent ".github/workflows/deploy-agentbox.yml"

# Patterns that must not appear
check_no_match "scripts/deploy.sh"              "cmd_agentbox"     "legacy agentbox deploy function"
check_no_match "Makefile"                        "deploy-agentbox"  "legacy Makefile target"
check_no_match ".github/workflows/deploy.yml"    "deploy-agentbox"  "legacy deploy job"
check_no_match ".github/workflows/deploy.yml"    "agentbox"         "agentbox dispatch option or path filter"
check_no_match "scripts/rollback.sh"             "agentbox)"        "legacy rollback case"
check_no_match "AGENTS.md"                       "deploy-agentbox"  "legacy command map entry"
check_no_match "AGENTS.md"                       "agentbox-list"    "legacy command map entry"

if [ "$failures" -gt 0 ]; then
    echo ""
    echo "$failures legacy agentbox artifact(s) detected — see above."
    exit 1
fi

echo "No legacy agentbox deployment paths found."
exit 0
