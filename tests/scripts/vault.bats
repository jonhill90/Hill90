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

@test "vault.sh seed refuses to seed a missing or empty credential" {
  # A blank credential seeds silently and then fails much later — for
  # CF_DNS_API_TOKEN, ~60 days later as an expired certificate. The seed must
  # abort before writing anything.
  run grep -n "required_keys=(" scripts/vault.sh
  [ "$status" -eq 0 ]
  run grep -n "Refusing to seed" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh seed validates required keys in the parent shell, not a subshell" {
  # `exit` inside a $(...) substitution kills only the subshell, so the seed
  # would carry on with an empty value. The emptiness check must therefore run
  # before the `bao ... kv put` lines, not inside get_secret.
  local guard_line put_line
  guard_line=$(grep -n "Refusing to seed" scripts/vault.sh | head -1 | cut -d: -f1)
  put_line=$(grep -n "kv put secret/infra/traefik" scripts/vault.sh | head -1 | cut -d: -f1)
  [ -n "$guard_line" ]
  [ -n "$put_line" ]
  [ "$guard_line" -lt "$put_line" ]
}

@test "vault.sh seed requires CF_DNS_API_TOKEN" {
  # The DNS-01 credential for the Tailscale-only hosts. lego only validates it
  # at renewal time, so an empty value is invisible until certificates expire.
  run grep -E "^\s+CF_DNS_API_TOKEN$" scripts/vault.sh
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

# These assert on the RESOLVED compose output rather than the raw file. The
# files are shared with local development and reference ${VAR} with production
# defaults, so grepping the text would only prove a default string is present —
# resolving proves production actually gets it.

@test "docker-compose.vault.yml connects to both edge and internal networks" {
  run docker compose -f deploy/compose/prod/docker-compose.vault.yml config
  [ "$status" -eq 0 ]
  [[ "$output" == *"hill90_edge"* ]]
  [[ "$output" == *"hill90_internal"* ]]
}

@test "docker-compose.vault.yml has Traefik labels for vault.hill90.com" {
  run docker compose -f deploy/compose/prod/docker-compose.vault.yml config
  [ "$status" -eq 0 ]
  [[ "$output" == *"vault.hill90.com"* ]]
  [[ "$output" == *"tailscale-only@file"* ]]
}

# ---------------------------------------------------------------------------
# Policy file tests
# ---------------------------------------------------------------------------

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
  # vault.hill90.com is Tailscale-only, so its A record must track TAILSCALE_IP.
  # Asserted against MANAGED_RECORDS in scripts/cloudflare.sh, which is now the
  # single source of truth; infra/dns/hill90.com.json was deleted because it
  # duplicated this and had already drifted.
  run bash -c "sed -n '/^MANAGED_RECORDS=(/,/^)\$/p' scripts/cloudflare.sh | grep -F '\"vault:tailscale\"'"
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

# h#711: VAULT_SYNC_TOKEN (a periodic token that had to be renewed weekly,
# and silently could not — see the file's own comment) was replaced by
# VAULT_SYNC_ROLE_ID/VAULT_SYNC_SECRET_ID, an AppRole login done fresh every
# run. Asserting on the `=` makes this check on the FUNCTIONAL read, not
# just the bare name — the bare string "VAULT_SYNC_TOKEN" still legitimately
# appears in this file's own explanatory comments, and a check that can't
# tell those apart would have kept passing throughout this exact migration
# for the wrong reason, which is precisely what happened before this test
# was corrected: it passed against the new file on a stale assumption.
@test "vault-sync-to-sops workflow reads the sync AppRole credentials from SOPS, not VAULT_SYNC_TOKEN" {
  run grep "VAULT_SYNC_ROLE_ID=" .github/workflows/vault-sync-to-sops.yml
  [ "$status" -eq 0 ]
  run grep "VAULT_SYNC_SECRET_ID=" .github/workflows/vault-sync-to-sops.yml
  [ "$status" -eq 0 ]
  # The old FUNCTIONAL read is gone — `=` excludes the comment mentioning
  # the old name by history, which is expected to remain.
  run grep "VAULT_SYNC_TOKEN=" .github/workflows/vault-sync-to-sops.yml
  [ "$status" -ne 0 ]
}

@test "vault-sync-to-sops workflow logs in via AppRole rather than renewing a token" {
  run grep "auth/approle/login" .github/workflows/vault-sync-to-sops.yml
  [ "$status" -eq 0 ]
  run grep "bao token renew" .github/workflows/vault-sync-to-sops.yml
  [ "$status" -ne 0 ]
}

# app-h#711's whole argument for AppRole over the alternatives: it never
# needs `sudo` on anything. Pin it so a future edit can't quietly add the
# one thing this design was chosen specifically to avoid.
@test "the sync AppRole never needs sudo — policy-sync.hcl grants none" {
  run grep -i "sudo" platform/vault/policies/policy-sync.hcl
  [ "$status" -ne 0 ]
}

# "sync" is deliberately NOT a hand-written role definition — it goes
# through the same VAULT_SERVICES loop as db/auth/infra/observability,
# which is what gives it the same token_ttl=1h/token_max_ttl=4h bound
# (well inside config.hcl's max_lease_ttl=24h) with no new code to keep
# correct. This pins that it's on the list, not a special case.
@test "sync is a VAULT_SERVICES member, not a hand-written AppRole" {
  run grep '^VAULT_SERVICES=' scripts/vault.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"sync"* ]]
}

@test "the AppRole token bound (token_max_ttl) is inside OpenBao's max_lease_ttl" {
  max_lease=$(grep 'max_lease_ttl' platform/vault/config.hcl | grep -oE '[0-9]+h' | head -1)
  token_max=$(grep 'token_max_ttl=' scripts/vault.sh | grep -oE '[0-9]+h' | head -1)
  [ -n "$max_lease" ]
  [ -n "$token_max" ]
  [ "${token_max%h}" -lt "${max_lease%h}" ]
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

# ---------------------------------------------------------------------------
# Boot path: the unit must survive a slow OpenBao, and must be loud when it does
# not. Guards the state found on 2026-07-31, when TimeoutStartSec was exactly
# equal to the script's own worst case and nothing retried.
# ---------------------------------------------------------------------------

@test "systemd TimeoutStartSec exceeds the script's own worst-case wait" {
  # THE regression this file exists to prevent. vault.sh waits up to
  # VAULT_AUTO_UNSEAL_TIMEOUT for the container plus 60s for the API. If
  # systemd's timeout only equals that, a merely-slow boot kills the script
  # inside its documented wait — which is what used to happen. The two numbers
  # must not be "tidied" into agreement.
  local unit="infra/systemd/hill90-vault-unseal.service"
  local systemd_timeout script_budget api_wait=60
  systemd_timeout=$(grep -oE '^TimeoutStartSec=[0-9]+' "$unit" | cut -d= -f2)
  # sed, not `cut -d-`: the variable name has no hyphen, so `:-120` splits into
  # two fields and -f3 is empty. That mistake made this very test fail closed.
  script_budget=$(grep -oE 'VAULT_AUTO_UNSEAL_TIMEOUT:-[0-9]+' scripts/vault.sh | head -1 | sed -E 's/.*:-([0-9]+)/\1/')

  [ -n "$systemd_timeout" ]
  [ -n "$script_budget" ]
  [ "$systemd_timeout" -gt "$(( script_budget + api_wait ))" ] \
    || { echo "TimeoutStartSec=${systemd_timeout} does not exceed ${script_budget}+${api_wait}"; return 1; }
}

@test "systemd retries a failed unseal, but a bounded number of times" {
  local unit="infra/systemd/hill90-vault-unseal.service"
  grep -qE '^Restart=on-failure' "$unit" || { echo "no Restart=on-failure"; return 1; }
  grep -qE '^RestartSec=[0-9]+' "$unit"  || { echo "no RestartSec"; return 1; }
  # Unbounded retry would trade a visible outage for an invisible loop.
  grep -qE '^StartLimitBurst=[0-9]+' "$unit" || { echo "no StartLimitBurst — retries are unbounded"; return 1; }
}

@test "the retry window is wider than the attempts it must contain" {
  # If StartLimitIntervalSec is shorter than burst x (timeout + RestartSec), the
  # window rolls over before the burst limit trips and the unit retries forever.
  local unit="infra/systemd/hill90-vault-unseal.service"
  local window burst timeout restsec
  window=$(grep -oE '^StartLimitIntervalSec=[0-9]+' "$unit" | cut -d= -f2)
  burst=$(grep -oE '^StartLimitBurst=[0-9]+' "$unit" | cut -d= -f2)
  timeout=$(grep -oE '^TimeoutStartSec=[0-9]+' "$unit" | cut -d= -f2)
  restsec=$(grep -oE '^RestartSec=[0-9]+' "$unit" | cut -d= -f2)
  [ "$window" -gt "$(( burst * (timeout + restsec) ))" ] \
    || { echo "window ${window}s <= ${burst} x (${timeout}+${restsec})s — the burst limit may never trip"; return 1; }
}

@test "systemd asserts the end state, not just the exit code" {
  # auto-unseal returns 0 when the container never appears. At boot that is the
  # failure that matters, so something must check whether OpenBao is ACTUALLY
  # unsealed afterwards.
  run grep "ExecStartPost=.*/vault.sh assert-unsealed" infra/systemd/hill90-vault-unseal.service
  [ "$status" -eq 0 ]
}

@test "vault.sh exposes assert-unsealed and documents it" {
  run bash scripts/vault.sh help
  [ "$status" -eq 0 ]
  [[ "$output" == *"assert-unsealed"* ]]
  grep -q 'assert-unsealed)' scripts/vault.sh
}

# INVERTED, and the inversion is the decision — see the contract note above
# cmd_assert_unsealed in scripts/vault.sh.
#
# This test pinned the DEFECT: an assertion that passed because it could not
# look. Both callers run assert-unsealed after a deploy that is supposed to have
# produced the container, so absence means the deploy did not — the single most
# useful thing it could report, and it reported success instead. Found by the
# #674 sweep as rank 2.2.
@test "assert-unsealed FAILS when the container is absent — an assertion must not pass on absence" {
  run env VAULT_CONTAINER=definitely-not-a-container-h90 bash scripts/vault.sh assert-unsealed
  [ "$status" -ne 0 ]
  [[ "$output" == *"NOT DEPLOYED"* ]]
  [[ "$output" == *"failure, not a pass"* ]]
}

@test "assert-unsealed fails loudly when seal state cannot be determined" {
  # A container that exists but has no working `bao` must NOT be read as healthy.
  if ! docker container inspect "${BATS_PROBE_CONTAINER:-traefik}" >/dev/null 2>&1; then
    skip "no spare container to probe with"
  fi
  run env VAULT_CONTAINER="${BATS_PROBE_CONTAINER:-traefik}" bash scripts/vault.sh assert-unsealed
  [ "$status" -ne 0 ]
  [[ "$output" == *"Treating as failed rather than assuming healthy"* ]]
}

@test "auto-unseal exits 0 when no container (graceful skip)" {
  # Set a very short timeout and use a non-existent container name
  # to verify the graceful skip path (exits 0, not an error)
  if docker container inspect openbao >/dev/null 2>&1; then
    skip "openbao container running locally"
  fi
  run env VAULT_AUTO_UNSEAL_TIMEOUT=1 bash scripts/vault.sh auto-unseal
  [ "$status" -eq 0 ]
  # Message changed with #674 rank 2.1: the tolerance is unchanged and
  # deliberate, but it now states that it is a NO-OP rather than implying
  # success, and points at assert-unsealed for the case where absence is a fault.
  [[ "$output" == *"NO-OP, not a success"* ]]
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

@test "vault.sh has cmd_setup_sync_approle function (h#711)" {
  run grep "^cmd_setup_sync_approle()" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh setup-sync-approle is in the dispatcher" {
  run grep "setup-sync-approle)" scripts/vault.sh
  [ "$status" -eq 0 ]
}

@test "vault.sh usage lists setup-sync-approle command" {
  run bash scripts/vault.sh help
  [[ "$output" == *"setup-sync-approle"* ]]
}

@test "cmd_setup_sync_approle stores VAULT_SYNC_ROLE_ID and VAULT_SYNC_SECRET_ID, not a token" {
  run sed -n '/^cmd_setup_sync_approle()/,/^}/p' scripts/vault.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"VAULT_SYNC_ROLE_ID"* ]]
  [[ "$output" == *"VAULT_SYNC_SECRET_ID"* ]]
  [[ "$output" != *"token create"* ]]
  [[ "$output" != *"-period="* ]]
}

# The old cmd_setup_sync_token is left in place (vault-init.yml and
# vault-reinitialize.yml still call it) but must no longer be what the sync
# workflow actually depends on for its own credentials — that's
# cmd_setup_sync_approle now.
@test "cmd_setup_sync_token still exists, unmodified in shape, for the other workflows that call it" {
  run grep "^cmd_setup_sync_token()" scripts/vault.sh
  [ "$status" -eq 0 ]
  run grep "setup-sync-token)" scripts/vault.sh
  [ "$status" -eq 0 ]
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

@test "all expected policy HCL files exist" {
  local expected_policies="policy-infra policy-observability policy-admin policy-sync"
  for policy in $expected_policies; do
    [ -f "platform/vault/policies/${policy}.hcl" ]
  done
}

@test "service policies grant only read and list (no write/create/delete)" {
  local service_policies="policy-infra policy-observability"
  for policy in $service_policies; do
    local file="platform/vault/policies/${policy}.hcl"
    # Only check secret/ paths (not auth/token paths which need update)
    run bash -c "grep -A1 'secret/' '$file' | grep 'capabilities' | grep -E '\"(create|update|delete)\"'"
    [ "$status" -eq 1 ]
  done
}

# --- Vault reinitialize workflow (JON-49) -----------------------------------

@test "vault-reinitialize workflow exists and is dispatch-only" {
  [ -f .github/workflows/vault-reinitialize.yml ]
  run grep -c "workflow_dispatch" .github/workflows/vault-reinitialize.yml
  [ "$output" != "0" ]
  run grep -E "^\s+(push|pull_request|schedule):" .github/workflows/vault-reinitialize.yml
  [ "$status" -eq 1 ]
}

@test "vault-reinitialize requires the typed REINITIALIZE confirmation" {
  run grep -c 'inputs.confirm }}" != "REINITIALIZE"' .github/workflows/vault-reinitialize.yml
  [ "$output" = "1" ]
}

@test "vault-reinitialize refuses when the vault holds KV data" {
  run bash -c 'grep -c "Refuse if the vault holds data" .github/workflows/vault-reinitialize.yml'
  [ "$output" = "1" ]
}

@test "vault-reinitialize backs up and verifies before it wipes" {
  # The backup and its verification must both appear before the volume removal.
  b=$(grep -n "backup.sh backup vault" .github/workflows/vault-reinitialize.yml | head -1 | cut -d: -f1)
  v=$(grep -n "Verify the backup exists" .github/workflows/vault-reinitialize.yml | head -1 | cut -d: -f1)
  d=$(grep -n "docker volume rm openbao-data" .github/workflows/vault-reinitialize.yml | head -1 | cut -d: -f1)
  [ -n "$b" ] && [ -n "$v" ] && [ -n "$d" ]
  [ "$b" -lt "$d" ]
  [ "$v" -lt "$d" ]
}

@test "vault-reinitialize does NOT revoke root" {
  # Revoking root before configuration is what produced the inert vault, and
  # revoking at all is a one-way door. It stays a separate deliberate command.
  run grep -E "vault\.sh revoke-root" .github/workflows/vault-reinitialize.yml
  [ "$status" -eq 0 ]
  # ...only inside the summary text telling the operator how, never as a step.
  run bash -c 'grep -E "^\s+run:.*vault\.sh revoke-root" .github/workflows/vault-reinitialize.yml'
  [ "$status" -eq 1 ]
}

@test "vault-reinitialize configures before it could ever revoke" {
  s=$(grep -n "vault.sh setup'" .github/workflows/vault-reinitialize.yml | head -1 | cut -d: -f1)
  d=$(grep -n "vault.sh seed'" .github/workflows/vault-reinitialize.yml | head -1 | cut -d: -f1)
  t=$(grep -n "vault.sh setup-sync-token'" .github/workflows/vault-reinitialize.yml | head -1 | cut -d: -f1)
  [ -n "$s" ] && [ -n "$d" ] && [ -n "$t" ]
  [ "$s" -lt "$d" ]
  [ "$d" -lt "$t" ]
}

@test "raft config exists and differs from the file config only in storage" {
  [ -f platform/vault/config.raft.hcl ]
  # Count directives, not the header comment that names both backends.
  run bash -c 'grep -v "^\s*#" platform/vault/config.raft.hcl | grep -c "storage \"raft\""'
  [ "$output" = "1" ]
  run bash -c 'grep -v "^\s*#" platform/vault/config.raft.hcl | grep -c "^cluster_addr"'
  [ "$output" = "1" ]
  run bash -c 'grep -v "^\s*#" platform/vault/config.raft.hcl | grep -c "cluster_address"'
  [ "$output" = "1" ]
  # The file backend config must stay untouched, and must NOT gain raft.
  run bash -c 'grep -v "^\s*#" platform/vault/config.hcl | grep -c "storage \"file\""'
  [ "$output" = "1" ]
  run bash -c 'grep -v "^\s*#" platform/vault/config.hcl | grep -c "storage \"raft\""'
  [ "$output" = "0" ]
}

@test "vault compose defaults to the file backend with no environment set" {
  run docker compose -f deploy/compose/prod/docker-compose.vault.yml config
  [ "$status" -eq 0 ]
  [[ "$output" == *"/openbao/file"* ]]
  [[ "$output" != *"config.raft.hcl"* ]]
}

# --- Raft ownership + PR plumbing (JON-52 / JON-53) -------------------------

@test "the vault stack initializes data-volume ownership before starting" {
  # /openbao/raft does not exist in the image, so Docker creates it root-owned
  # and the unprivileged server cannot write. This took prod down on 2026-07-26.
  run bash -c 'grep -c "openbao-init:" deploy/compose/prod/docker-compose.vault.yml'
  [ "$output" != "0" ]
  run bash -c 'grep -c "chown -R 100:1000 /data" deploy/compose/prod/docker-compose.vault.yml'
  [ "$output" = "1" ]
}

@test "openbao waits for the ownership init to succeed" {
  run bash -c 'grep -c "service_completed_successfully" deploy/compose/prod/docker-compose.vault.yml'
  [ "$output" = "1" ]
}

@test "the reinitialize workflow does not open a PR it cannot merge" {
  # A PR opened with GITHUB_TOKEN never fires the required check, so it can
  # never merge. The workflow pushes a branch and tells the operator instead.
  run grep -c "peter-evans/create-pull-request" .github/workflows/vault-reinitialize.yml
  [ "$output" = "0" ]
  run bash -c 'grep -c "git push origin" .github/workflows/vault-reinitialize.yml'
  [ "$output" != "0" ]
}

@test "the reinitialize workflow fails if the new key was not written back" {
  run bash -c 'grep -c "prod.enc.env is unchanged" .github/workflows/vault-reinitialize.yml'
  [ "$output" = "1" ]
}

@test "raft config uses a path the image owns, via the init service" {
  run bash -c 'grep -v "^\s*#" platform/vault/config.raft.hcl | grep -c "/openbao/raft"'
  [ "$output" != "0" ]
}
