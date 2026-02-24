#!/usr/bin/env bats

# Tests for scripts/hooks/*.sh

# ---------------------------------------------------------------------------
# shellcheck-on-edit.sh
# ---------------------------------------------------------------------------

@test "shellcheck-on-edit: passes through non-.sh files" {
  run bash -c 'echo "{\"tool_input\":{\"file_path\":\"src/app.py\"}}" | bash scripts/hooks/shellcheck-on-edit.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "shellcheck-on-edit: passes through missing file_path" {
  run bash -c 'echo "{\"tool_input\":{}}" | bash scripts/hooks/shellcheck-on-edit.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "shellcheck-on-edit: reports errors in .sh files" {
  # Create a script with a shellcheck error-severity issue (SC2045)
  tmp="$(mktemp /tmp/hook-test-bad-XXXXXX.sh)"
  cat > "$tmp" << 'SCRIPT'
#!/bin/bash
for f in $(ls); do echo "$f"; done
SCRIPT

  run bash -c "echo '{\"tool_input\":{\"file_path\":\"$tmp\"}}' | bash scripts/hooks/shellcheck-on-edit.sh"
  [ "$status" -eq 0 ]
  # Should return a systemMessage with shellcheck findings
  echo "$output" | jq -e '.systemMessage' >/dev/null
  [[ "$output" == *"shellcheck"* ]]

  rm -f "$tmp"
}

@test "shellcheck-on-edit: clean .sh file produces no output" {
  tmp="$(mktemp /tmp/good-script-XXXXXX.sh)"
  cat > "$tmp" << 'SCRIPT'
#!/bin/bash
echo "hello"
SCRIPT

  run bash -c "echo '{\"tool_input\":{\"file_path\":\"$tmp\"}}' | bash scripts/hooks/shellcheck-on-edit.sh"
  [ "$status" -eq 0 ]
  [ -z "$output" ]

  rm -f "$tmp"
}

@test "shellcheck-on-edit: handles nonexistent .sh file" {
  run bash -c 'echo "{\"tool_input\":{\"file_path\":\"/tmp/does-not-exist.sh\"}}" | bash scripts/hooks/shellcheck-on-edit.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# ---------------------------------------------------------------------------
# block-local-deploy.sh
# ---------------------------------------------------------------------------

@test "block-local-deploy: allows ssh-routed commands" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"ssh -i ~/.ssh/remote.hill90.com deploy@remote.hill90.com bash scripts/deploy.sh all prod\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "block-local-deploy: allows make recreate-vps" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"make recreate-vps\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "block-local-deploy: allows make health" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"make health\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "block-local-deploy: allows make config-vps VPS_IP=1.2.3.4" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"make config-vps VPS_IP=1.2.3.4\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "block-local-deploy: allows make test" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"make test\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "block-local-deploy: allows make lint" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"make lint\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "block-local-deploy: allows make secrets-view" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"make secrets-view KEY=foo\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "block-local-deploy: blocks make deploy-all" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"make deploy-all\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision' >/dev/null
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks make deploy-infra" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"make deploy-infra\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks bash scripts/deploy.sh infra prod" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"bash scripts/deploy.sh infra prod\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks ./scripts/deploy.sh" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"./scripts/deploy.sh all prod\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks env FOO=bar make deploy-all (normalization)" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"env FOO=bar make deploy-all\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks cd /tmp && make deploy-all (chained)" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"cd /tmp && make deploy-all\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks bash -lc make deploy-all (quoted subshell)" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"bash -lc \\\"make deploy-all\\\"\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks gh pr merge with --admin" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"gh pr merge 23 --squash --delete-branch --admin\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks gh pr merge with --force" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"gh pr merge 23 --squash --delete-branch --force\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: allows gh pr merge without bypass flags" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"gh pr merge 23 --squash --delete-branch\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "block-local-deploy: blocks npm run dev" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"cd services/ui && npm run dev\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks pnpm dev" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"pnpm dev\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks npm run build" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"npm run build\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: blocks next build" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"next build\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [[ "$output" == *"deny"* ]]
}

@test "block-local-deploy: allows git commit with build keyword in message" {
  run bash -c 'echo "{\"tool_input\":{\"command\":\"git commit -m \\\"block npm run build\\\"\"}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "block-local-deploy: allows empty command" {
  run bash -c 'echo "{\"tool_input\":{}}" | bash scripts/hooks/block-local-deploy.sh'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# ---------------------------------------------------------------------------
# stop-gate.sh
# ---------------------------------------------------------------------------

@test "stop-gate: blocks when .sh edited but shellcheck not in transcript" {
  transcript="$(mktemp /tmp/transcript-XXXXXX.jsonl)"
  cat > "$transcript" << 'JSONL'
{"tool_name":"Edit","tool_input":{"file_path":"scripts/deploy.sh"}}
{"tool_name":"Bash","tool_input":{"command":"bats tests/scripts/"}}
JSONL

  run bash -c "echo '{\"transcript_path\":\"$transcript\",\"cwd\":\"/tmp\"}' | bash scripts/hooks/stop-gate.sh"
  [ "$status" -eq 2 ]
  [[ "$output" == *"shellcheck"* ]]

  rm -f "$transcript"
}

@test "stop-gate: blocks when services/api edited but npm test not in transcript" {
  transcript="$(mktemp /tmp/transcript-XXXXXX.jsonl)"
  cat > "$transcript" << 'JSONL'
{"tool_name":"Write","tool_input":{"file_path":"services/api/index.ts"}}
JSONL

  run bash -c "echo '{\"transcript_path\":\"$transcript\",\"cwd\":\"/tmp\"}' | bash scripts/hooks/stop-gate.sh"
  [ "$status" -eq 2 ]
  [[ "$output" == *"npm test"* ]]

  rm -f "$transcript"
}

@test "stop-gate: allows when all required checks present" {
  transcript="$(mktemp /tmp/transcript-XXXXXX.jsonl)"
  cat > "$transcript" << 'JSONL'
{"tool_name":"Edit","tool_input":{"file_path":"scripts/deploy.sh"}}
{"tool_name":"Bash","tool_input":{"command":"shellcheck --severity=error scripts/deploy.sh"}}
JSONL

  run bash -c "echo '{\"transcript_path\":\"$transcript\",\"cwd\":\"/tmp\"}' | bash scripts/hooks/stop-gate.sh"
  [ "$status" -eq 0 ]

  rm -f "$transcript"
}

@test "stop-gate: allows when no checkable files were modified" {
  transcript="$(mktemp /tmp/transcript-XXXXXX.jsonl)"
  cat > "$transcript" << 'JSONL'
{"tool_name":"Edit","tool_input":{"file_path":"README.md"}}
JSONL

  run bash -c "echo '{\"transcript_path\":\"$transcript\",\"cwd\":\"/tmp\"}' | bash scripts/hooks/stop-gate.sh"
  [ "$status" -eq 0 ]

  rm -f "$transcript"
}

@test "stop-gate: fails open with warning when transcript missing" {
  run bash -c "echo '{\"transcript_path\":\"/tmp/nonexistent-transcript.jsonl\",\"cwd\":\"/tmp\"}' | bash scripts/hooks/stop-gate.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"not found"* ]]
}

@test "stop-gate: fails open with warning when transcript path empty" {
  run bash -c "echo '{\"cwd\":\"/tmp\"}' | bash scripts/hooks/stop-gate.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping"* ]]
}

@test "stop-gate: fails open with warning when transcript file is empty" {
  transcript="$(mktemp /tmp/transcript-XXXXXX.jsonl)"

  run bash -c "echo '{\"transcript_path\":\"$transcript\",\"cwd\":\"/tmp\"}' | bash scripts/hooks/stop-gate.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"empty"* ]]

  rm -f "$transcript"
}
