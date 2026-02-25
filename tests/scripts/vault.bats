#!/usr/bin/env bats

# Tests for scripts/vault.sh CLI

# ---------------------------------------------------------------------------
# Basic CLI tests
# ---------------------------------------------------------------------------

@test "vault.sh with no args shows usage" {
  run bash scripts/vault.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage"* ]]
}

@test "vault.sh help shows usage" {
  run bash scripts/vault.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "vault.sh unknown command fails" {
  run bash scripts/vault.sh bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"Unknown"* ]]
}

@test "vault.sh sources _common.sh" {
  run grep 'source.*_common.sh' scripts/vault.sh
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Command structure tests
# ---------------------------------------------------------------------------

@test "vault.sh status calls bao status" {
  run grep "bao.*status" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh init calls bao operator init with correct args" {
  run grep "operator init" scripts/vault.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"-key-shares=1"* ]]
  [[ "$output" == *"-key-threshold=1"* ]]
}

@test "vault.sh unseal reads key file and calls bao operator unseal" {
  run grep "operator unseal" scripts/vault.sh
  [ "$status" -eq 0 ]
  # Checks for host key file path
  run grep "/opt/hill90/secrets/openbao-unseal.key" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh setup enables KV v2, AppRole, audit, and applies policies" {
  # KV v2
  run grep "secrets enable.*kv" scripts/vault.sh
  [ "$status" -eq 0 ]
  # AppRole
  run grep "auth enable approle" scripts/vault.sh
  [ "$status" -eq 0 ]
  # Audit
  run grep "audit enable file" scripts/vault.sh
  [ "$status" -eq 0 ]
  # Policies
  run grep "cmd_policy_apply" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh seed reads SOPS and writes to KV v2 paths" {
  run grep "sops -d" scripts/vault.sh
  [ "$status" -eq 0 ]
  run grep "kv put secret/" scripts/vault.sh
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Docker Compose validation
# ---------------------------------------------------------------------------

@test "docker-compose.vault.yml exists and is valid YAML" {
  [ -f "deploy/compose/prod/docker-compose.vault.yml" ]
  run docker compose -f deploy/compose/prod/docker-compose.vault.yml config --quiet 2>&1
  [ "$status" -eq 0 ]
}

@test "docker-compose.vault.yml uses openbao image" {
  run grep "ghcr.io/openbao/openbao" deploy/compose/prod/docker-compose.vault.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.vault.yml has named volume openbao-data" {
  run grep "openbao-data" deploy/compose/prod/docker-compose.vault.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.vault.yml connects to both edge and internal networks" {
  run grep "hill90_edge" deploy/compose/prod/docker-compose.vault.yml
  [ "$status" -eq 0 ]
  run grep "hill90_internal" deploy/compose/prod/docker-compose.vault.yml
  [ "$status" -eq 0 ]
}

@test "docker-compose.vault.yml has Traefik labels for vault.hill90.com" {
  run grep "vault.hill90.com" deploy/compose/prod/docker-compose.vault.yml
  [ "$status" -eq 0 ]
  run grep "tailscale-only@file" deploy/compose/prod/docker-compose.vault.yml
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Policy file tests
# ---------------------------------------------------------------------------

@test "all expected policy HCL files exist" {
  local expected_policies="policy-db policy-api policy-ai policy-auth policy-ui policy-mcp policy-minio policy-infra policy-observability policy-admin"
  for policy in $expected_policies; do
    [ -f "platform/vault/policies/${policy}.hcl" ]
  done
}

@test "service policies grant only read and list (no write/create/delete)" {
  local service_policies="policy-db policy-api policy-ai policy-auth policy-ui policy-mcp policy-minio policy-infra policy-observability"
  for policy in $service_policies; do
    local file="platform/vault/policies/${policy}.hcl"
    # Only check secret/ paths (not auth/token paths which need update)
    run bash -c "grep -A1 'secret/' '$file' | grep 'capabilities' | grep -E '\"(create|update|delete)\"'"
    [ "$status" -eq 1 ]
  done
}

@test "no policy grants secret/data/* broad wildcard at root" {
  # Ensure no policy has path "secret/data/*" (root-level wildcard)
  # Per-service paths like "secret/data/api/*" are fine
  for policy_file in platform/vault/policies/policy-*.hcl; do
    local policy_name
    policy_name=$(basename "$policy_file")
    # Skip admin policy — it intentionally has broad access
    if [ "$policy_name" = "policy-admin.hcl" ]; then
      continue
    fi
    run grep '^path "secret/data/\*"' "$policy_file"
    [ "$status" -eq 1 ]
  done
}

@test "all service policies include auth/token/renew-self" {
  for policy_file in platform/vault/policies/policy-*.hcl; do
    run grep "auth/token/renew-self" "$policy_file"
    [ "$status" -eq 0 ]
  done
}

# ---------------------------------------------------------------------------
# deploy.sh vault integration
# ---------------------------------------------------------------------------

@test "deploy.sh dispatcher accepts vault command" {
  run bash scripts/deploy.sh vault nonexistent-env
  [[ "$output" != *"Unknown command"* ]]
}

@test "deploy.sh usage lists vault command" {
  run bash scripts/deploy.sh help
  [[ "$output" == *"vault"* ]]
}

@test "deploy.sh cmd_service has vault case with correct compose file" {
  run bash -c "sed -n '/^cmd_service/,/^}/p' scripts/deploy.sh | grep -A1 'vault)'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"docker-compose.vault.yml"* ]]
}

@test "deploy.sh cmd_verify has vault case" {
  run bash -c "sed -n '/^cmd_verify/,/^}/p' scripts/deploy.sh | grep 'vault)'"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# backup.sh vault integration
# ---------------------------------------------------------------------------

@test "backup.sh accepts vault as a backup target" {
  run bash scripts/backup.sh help
  [[ "$output" == *"vault"* ]]
}

@test "backup.sh has backup_vault function" {
  run grep "^backup_vault()" scripts/backup.sh
  [ "$status" -eq 0 ]
}

@test "backup.sh vault backup includes openbao-data volume" {
  run grep "openbao-data" scripts/backup.sh
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# DNS record test
# ---------------------------------------------------------------------------

@test "DNS config includes vault A record" {
  run python3 -c '
import json
data = json.load(open("infra/dns/hill90.com.json"))
records = [r for r in data["records"] if r["name"] == "vault"]
assert len(records) == 1, f"Expected 1 vault record, got {len(records)}"
assert records[0]["type"] == "A"
assert records[0]["content"] == "${TAILSCALE_IP}"
'
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# ops.sh vault integration
# ---------------------------------------------------------------------------

@test "ops.sh health check includes openbao" {
  run grep "openbao" scripts/ops.sh
  [ "$status" -eq 0 ]
}
