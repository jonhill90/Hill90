#!/usr/bin/env bash
set -euo pipefail

# PreToolUse hook: block deploy commands that should only run on VPS.
# Input: JSON via stdin with tool_input.command
# Output: JSON permissionDecision deny/allow

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# No command — allow
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Normalize: strip leading whitespace, handle chained commands and subshells
NORMALIZED="$COMMAND"
# Strip leading whitespace
NORMALIZED="${NORMALIZED#"${NORMALIZED%%[![:space:]]*}"}"

# Check each segment of chained commands (&&, ||, ;)
# We need to check if ANY segment contains a deploy command
check_segment() {
  local seg="$1"
  # Strip leading whitespace
  seg="${seg#"${seg%%[![:space:]]*}"}"
  # Strip common prefixes: env VAR=val, bash -c/-lc with quotes
  # env prefix
  while [[ "$seg" =~ ^env[[:space:]]+[A-Za-z_][A-Za-z0-9_]*= ]]; do
    seg="${seg#env }"
    seg="${seg#*= }"
    seg="${seg#"${seg%%[![:space:]]*}"}"
  done
  # bash -c or bash -lc prefix (with quoted content)
  if [[ "$seg" =~ ^bash[[:space:]]+-[a-z]*c[[:space:]]+ ]]; then
    seg="${seg#bash }"
    seg="${seg#-* }"
    # Strip surrounding quotes
    seg="${seg#\"}"
    seg="${seg%\"}"
    seg="${seg#\'}"
    seg="${seg%\'}"
    seg="${seg#"${seg%%[![:space:]]*}"}"
  fi
  # cd prefix
  if [[ "$seg" =~ ^cd[[:space:]] ]]; then
    # cd is just changing directory — not a deploy command itself
    return 1
  fi

  # ALLOW: ssh-routed commands
  if [[ "$seg" =~ ^ssh[[:space:]] ]]; then
    return 1
  fi

  # DENY: make deploy-*
  if [[ "$seg" =~ make[[:space:]]+deploy- ]]; then
    return 0
  fi

  # DENY: direct deploy.sh invocations
  if [[ "$seg" =~ (bash[[:space:]]+)?scripts/deploy\.sh ]] || \
     [[ "$seg" =~ \./scripts/deploy\.sh ]]; then
    return 0
  fi

  return 1
}

# Split on && || ; and check each segment
NL=$'\n'
SEGMENTS="${NORMALIZED//&&/$NL}"
SEGMENTS="${SEGMENTS//||/$NL}"
SEGMENTS="${SEGMENTS//;/$NL}"
BLOCKED=false

while IFS= read -r segment; do
  if check_segment "$segment"; then
    BLOCKED=true
    break
  fi
done <<< "$SEGMENTS"

if [[ "$BLOCKED" == "true" ]]; then
  REASON="Deploy commands must run on VPS, not locally. Use SSH:
  ssh -i ~/.ssh/remote.hill90.com deploy@remote.hill90.com 'cd /opt/hill90/app && bash scripts/deploy.sh all prod'
Or use: make recreate-vps / make config-vps / make health (these are local-safe)"
  jq -n --arg reason "$REASON" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
fi

# Allow everything else
exit 0
