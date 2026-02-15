#!/usr/bin/env bash
set -euo pipefail

# PostToolUse hook: run shellcheck on .sh files after Edit/Write.
# Input: JSON via stdin with tool_input.file_path
# Output: JSON systemMessage with findings (non-blocking, exit 0)

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# No file path — nothing to check
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Only check shell scripts
if [[ "$FILE_PATH" != *.sh ]]; then
  exit 0
fi

# Skip if file doesn't exist (e.g. deleted)
if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

# Skip if shellcheck not installed
if ! command -v shellcheck &>/dev/null; then
  jq -n '{systemMessage: "shellcheck not installed — skipping lint"}'
  exit 0
fi

# Run shellcheck (error severity only)
RESULT=$(shellcheck --severity=error "$FILE_PATH" 2>&1) || true

if [[ -n "$RESULT" ]]; then
  jq -n --arg findings "$RESULT" --arg file "$FILE_PATH" \
    '{systemMessage: "shellcheck findings in \($file):\n\($findings)"}'
else
  exit 0
fi
