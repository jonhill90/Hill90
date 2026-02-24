#!/usr/bin/env bash
set -euo pipefail

# Stop hook: verify that required verification commands ran during the session.
# Input: JSON via stdin with transcript_path
# Output: exit 2 (blocking) if required checks are missing, exit 0 otherwise

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Fail-open if no transcript path
if [[ -z "$TRANSCRIPT_PATH" ]]; then
  jq -n '{systemMessage: "stop-gate: no transcript path provided — skipping verification check"}'
  exit 0
fi

# Fail-open if transcript file missing or empty
if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
  jq -n '{systemMessage: "stop-gate: transcript file not found — skipping verification check"}'
  exit 0
fi

if [[ ! -s "$TRANSCRIPT_PATH" ]]; then
  jq -n '{systemMessage: "stop-gate: transcript file is empty — skipping verification check"}'
  exit 0
fi

# Read transcript content (best-effort, fail-open on read errors)
TRANSCRIPT=$(cat "$TRANSCRIPT_PATH" 2>/dev/null) || {
  jq -n '{systemMessage: "stop-gate: could not read transcript — skipping verification check"}'
  exit 0
}

# Extract modified file paths from the transcript
# Look for tool_input.file_path in Edit/Write calls and tool_input.command in Bash
MODIFIED_FILES=$(echo "$TRANSCRIPT" | jq -r '
  select(.tool_name == "Edit" or .tool_name == "Write") |
  .tool_input.file_path // empty
' 2>/dev/null || true)

MISSING_CHECKS=()

# Helper: check if a command pattern appears in transcript Bash commands
transcript_has_command() {
  local pattern="$1"
  echo "$TRANSCRIPT" | grep -qE "$pattern" 2>/dev/null
}

# Helper: check if any modified file matches a path pattern
has_modified_path() {
  local pattern="$1"
  echo "$MODIFIED_FILES" | grep -qE "$pattern" 2>/dev/null
}

# Rule: scripts/*.sh or scripts/hooks/*.sh -> shellcheck
if has_modified_path 'scripts/.*\.sh'; then
  if ! transcript_has_command 'shellcheck'; then
    MISSING_CHECKS+=("shellcheck (modified shell scripts in scripts/)")
  fi
fi

# Rule: tests/scripts/** -> bats
if has_modified_path 'tests/scripts/'; then
  if ! transcript_has_command 'bats'; then
    MISSING_CHECKS+=("bats (modified test files in tests/scripts/)")
  fi
fi

# Rule: services/api/** -> npm test
if has_modified_path 'services/api/'; then
  if ! transcript_has_command 'npm test'; then
    MISSING_CHECKS+=("npm test (modified Node.js service files)")
  fi
fi

# Rule: services/ai/** -> pytest
if has_modified_path 'services/ai/'; then
  if ! transcript_has_command 'pytest'; then
    MISSING_CHECKS+=("pytest (modified Python service files)")
  fi
fi

# Rule: deploy/compose/** or platform/edge/** -> docker compose config or validate.sh
if has_modified_path '(deploy/compose|platform/edge)/'; then
  if ! transcript_has_command '(docker compose config|validate\.sh)'; then
    MISSING_CHECKS+=("docker compose config or validate.sh (modified compose/edge config)")
  fi
fi

if [[ ${#MISSING_CHECKS[@]} -gt 0 ]]; then
  MISSING_LIST=$(printf '  - %s\n' "${MISSING_CHECKS[@]}")
  echo "stop-gate: required verification commands were not found in this session:" >&2
  echo "$MISSING_LIST" >&2
  echo "Please run these checks before finishing." >&2
  exit 2
fi

exit 0
