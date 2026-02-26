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
    # Skip admin and sync policies — they intentionally have broad access
    if [ "$policy_name" = "policy-admin.hcl" ] || [ "$policy_name" = "policy-sync.hcl" ]; then
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

# ---------------------------------------------------------------------------
# Seed key name tests
# ---------------------------------------------------------------------------

@test "vault.sh seed uses MINIO_ROOT_USER not MINIO_ACCESS_KEY in api/config" {
  run bash -c 'sed -n "/Seeding secret\/api\/config/,/^$/p" scripts/vault.sh | grep "MINIO_ROOT_USER"'
  [ "$status" -eq 0 ]
  run bash -c 'sed -n "/Seeding secret\/api\/config/,/^$/p" scripts/vault.sh | grep "MINIO_ACCESS_KEY"'
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# OIDC auth tests
# ---------------------------------------------------------------------------

@test "vault.sh has cmd_setup_oidc function" {
  run grep "^cmd_setup_oidc()" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh setup-oidc is in the dispatcher" {
  run grep "setup-oidc)" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh usage lists setup-oidc command" {
  run bash scripts/vault.sh help
  [[ "$output" == *"setup-oidc"* ]]
}

@test "policy-oidc-admin.hcl exists" {
  [ -f "platform/vault/policies/policy-oidc-admin.hcl" ]
}

@test "policy-oidc-admin.hcl grants secret read and list" {
  run grep 'capabilities.*read.*list' platform/vault/policies/policy-oidc-admin.hcl
  [ "$status" -eq 0 ]
}

@test "policy-oidc-admin.hcl does not grant auth write" {
  run grep 'path "auth/\*"' platform/vault/policies/policy-oidc-admin.hcl
  [ "$status" -eq 1 ]
}

@test "Keycloak realm JSON has hill90-vault client" {
  run python3 -c '
import json
data = json.load(open("platform/auth/keycloak/hill90-realm.json"))
clients = [c for c in data["clients"] if c["clientId"] == "hill90-vault"]
assert len(clients) == 1, f"Expected 1 hill90-vault client, got {len(clients)}"
assert clients[0]["standardFlowEnabled"] == True
assert clients[0]["publicClient"] == False
'
  [ "$status" -eq 0 ]
}

@test "hill90-vault client has realm_roles protocol mapper" {
  run python3 -c '
import json
data = json.load(open("platform/auth/keycloak/hill90-realm.json"))
client = [c for c in data["clients"] if c["clientId"] == "hill90-vault"][0]
mappers = [m for m in client.get("protocolMappers", []) if m["name"] == "realm-roles"]
assert len(mappers) == 1, f"Expected realm-roles mapper, got {len(mappers)}"
assert mappers[0]["config"]["claim.name"] == "realm_roles"
'
  [ "$status" -eq 0 ]
}

@test "setup-realm.sh references hill90-vault client" {
  run grep "hill90-vault" platform/auth/keycloak/setup-realm.sh
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# sync-to-sops tests
# ---------------------------------------------------------------------------

@test "vault.sh has cmd_sync_to_sops function" {
  run grep "^cmd_sync_to_sops()" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh sync-to-sops is in the dispatcher" {
  run grep "sync-to-sops)" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh usage lists sync-to-sops command" {
  run bash scripts/vault.sh help
  [[ "$output" == *"sync-to-sops"* ]]
}

@test "cmd_sync_to_sops reads vault KV paths" {
  run bash -c "sed -n '/^cmd_sync_to_sops/,/^}/p' scripts/vault.sh | grep 'kv get'"
  [ "$status" -eq 0 ]
}

@test "cmd_sync_to_sops uses sops --set for atomic updates" {
  run bash -c "sed -n '/^cmd_sync_to_sops/,/^}/p' scripts/vault.sh | grep 'sops --set'"
  [ "$status" -eq 0 ]
}

@test "cmd_sync_to_sops creates backup before modifying SOPS" {
  run bash -c "sed -n '/^cmd_sync_to_sops/,/^}/p' scripts/vault.sh | grep 'backup'"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# policy-sync tests
# ---------------------------------------------------------------------------

@test "policy-sync.hcl exists" {
  [ -f "platform/vault/policies/policy-sync.hcl" ]
}

@test "policy-sync.hcl grants read and list only on secret paths (no write/create/delete)" {
  # Only check secret/ paths — auth/token paths need update for renewal
  run bash -c "grep -A1 'secret/' platform/vault/policies/policy-sync.hcl | grep 'capabilities' | grep -E '\"(create|update|delete)\"'"
  [ "$status" -eq 1 ]
}

# ---------------------------------------------------------------------------
# setup-sync-token tests
# ---------------------------------------------------------------------------

@test "vault.sh has cmd_setup_sync_token function" {
  run grep "^cmd_setup_sync_token()" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh setup-sync-token is in the dispatcher" {
  run grep "setup-sync-token)" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh usage lists setup-sync-token command" {
  run bash scripts/vault.sh help
  [[ "$output" == *"setup-sync-token"* ]]
}

# ---------------------------------------------------------------------------
# vault-sync-to-sops workflow tests
# ---------------------------------------------------------------------------

@test "vault-sync-to-sops workflow file exists" {
  [ -f ".github/workflows/vault-sync-to-sops.yml" ]
}

@test "vault-sync-to-sops workflow has workflow_dispatch trigger" {
  run grep "workflow_dispatch" .github/workflows/vault-sync-to-sops.yml
  [ "$status" -eq 0 ]
}

@test "vault-sync-to-sops workflow has schedule trigger" {
  run grep "schedule" .github/workflows/vault-sync-to-sops.yml
  [ "$status" -eq 0 ]
}

@test "vault-sync-to-sops workflow uses Tailscale for SSH" {
  run grep "tailscale" .github/workflows/vault-sync-to-sops.yml
  [ "$status" -eq 0 ]
}

@test "vault-sync-to-sops workflow reads VAULT_SYNC_TOKEN from SOPS" {
  run grep "VAULT_SYNC_TOKEN" .github/workflows/vault-sync-to-sops.yml
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Runbook tests
# ---------------------------------------------------------------------------

@test "disaster recovery runbook exists" {
  [ -f "docs/runbooks/disaster-recovery.md" ]
}

@test "secrets workflow guide exists" {
  [ -f "docs/runbooks/secrets-workflow.md" ]
}

# ---------------------------------------------------------------------------
# Auto-unseal tests
# ---------------------------------------------------------------------------

@test "vault.sh has cmd_auto_unseal function" {
  run grep "^cmd_auto_unseal()" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh auto-unseal is in the dispatcher" {
  run grep "auto-unseal)" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh usage lists auto-unseal command" {
  run bash scripts/vault.sh help
  [[ "$output" == *"auto-unseal"* ]]
}

@test "systemd service file exists" {
  [ -f "infra/systemd/hill90-vault-unseal.service" ]
}

@test "systemd service runs as deploy user" {
  run grep "User=deploy" infra/systemd/hill90-vault-unseal.service
  [ "$status" -eq 0 ]
}

@test "systemd service requires docker.service" {
  run grep "Requires=docker.service" infra/systemd/hill90-vault-unseal.service
  [ "$status" -eq 0 ]
}

@test "systemd service ExecStart calls vault.sh auto-unseal" {
  run grep "ExecStart=.*/vault.sh auto-unseal" infra/systemd/hill90-vault-unseal.service
  [ "$status" -eq 0 ]
}

@test "auto-unseal exits 0 when no container (graceful skip)" {
  # Set a very short timeout and use a non-existent container name
  # to verify the graceful skip path (exits 0, not an error)
  if docker container inspect openbao >/dev/null 2>&1; then
    skip "openbao container running locally"
  fi
  run env VAULT_AUTO_UNSEAL_TIMEOUT=1 bash scripts/vault.sh auto-unseal
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping auto-unseal"* ]]
}

# ---------------------------------------------------------------------------
# Bootstrap AppRole tests
# ---------------------------------------------------------------------------

@test "vault.sh has cmd_bootstrap_approles function" {
  run grep "^cmd_bootstrap_approles()" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh bootstrap-approles is in the dispatcher" {
  run grep "bootstrap-approles)" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh usage lists bootstrap-approles command" {
  run bash scripts/vault.sh help
  [[ "$output" == *"bootstrap-approles"* ]]
}

@test "cmd_bootstrap_approles generates root token and revokes it" {
  run bash -c "sed -n '/^cmd_bootstrap_approles/,/^}/p' scripts/vault.sh | grep 'generate-root'"
  [ "$status" -eq 0 ]
  run bash -c "sed -n '/^cmd_bootstrap_approles/,/^}/p' scripts/vault.sh | grep 'token revoke -self'"
  [ "$status" -eq 0 ]
}

@test "cmd_bootstrap_approles writes role_id and secret_id to SOPS" {
  run bash -c "sed -n '/^cmd_bootstrap_approles/,/^}/p' scripts/vault.sh | grep 'sops --set'"
  [ "$status" -eq 0 ]
  run bash -c "sed -n '/^cmd_bootstrap_approles/,/^}/p' scripts/vault.sh | grep 'ROLE_ID'"
  [ "$status" -eq 0 ]
  run bash -c "sed -n '/^cmd_bootstrap_approles/,/^}/p' scripts/vault.sh | grep 'SECRET_ID'"
  [ "$status" -eq 0 ]
}

@test "cmd_bootstrap_approles iterates all VAULT_SERVICES" {
  run bash -c "sed -n '/^cmd_bootstrap_approles/,/^}/p' scripts/vault.sh | grep 'for svc in \$VAULT_SERVICES'"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Secrets schema tests
# ---------------------------------------------------------------------------

@test "secrets-schema.yaml exists and is valid YAML" {
  [ -f "platform/vault/secrets-schema.yaml" ]
  run python3 -c "import yaml; yaml.safe_load(open('platform/vault/secrets-schema.yaml'))"
  [ "$status" -eq 0 ]
}

@test "secrets schema validator passes current codebase" {
  run python3 scripts/checks/check_secrets_schema.py
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Vault auto-unseal runbook test
# ---------------------------------------------------------------------------

@test "vault-unseal runbook exists" {
  [ -f "docs/runbooks/vault-unseal.md" ]
}

@test "secrets-schema-validation runbook exists" {
  [ -f "docs/runbooks/secrets-schema-validation.md" ]
}
