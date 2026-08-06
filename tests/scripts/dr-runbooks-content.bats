#!/usr/bin/env bats
#
# h#804-h#807 (+ h#808's docs half): disaster-recovery.md and vps-rebuild.md
# are the runbooks read when the estate is already down and there is no
# working system left to check a claim against — a defect here is a latent
# outage extension, not a documentation nit. These are static content
# checks, the same proportionate verification this session already applies
# to prose: they cannot prove a rebuild succeeds (nothing here has been
# exercised against a real rebuild — see each fix's own "not verified"
# notes), only that the specific defects reported are actually gone from
# the text and the specific replacement content is actually present.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  DR="$ROOT/docs/runbooks/disaster-recovery.md"
  VPS="$ROOT/docs/runbooks/vps-rebuild.md"
}

# ---------------------------------------------------------------------------
# h#804 — deploy.sh has no `all` command
# ---------------------------------------------------------------------------

@test "h#804: disaster-recovery.md no longer has 'bash scripts/deploy.sh all prod' as a runnable command" {
  run grep -F 'bash scripts/deploy.sh all prod' "$DR"
  [ "$status" -ne 0 ]
}

@test "h#804: the fixed step deploys the three stacks not already covered earlier in the same runbook" {
  run grep -c 'bash scripts/deploy.sh auth prod' "$DR"
  [ "$output" -ge 1 ]
  run grep -c 'bash scripts/deploy.sh minio prod' "$DR"
  [ "$output" -ge 1 ]
  run grep -c 'bash scripts/deploy.sh observability prod' "$DR"
  [ "$output" -ge 1 ]
}

@test "h#804: deploy.sh's dispatcher genuinely has no 'all' case — the claim this fix rests on" {
  run grep -F '*)' "$ROOT/scripts/deploy.sh"
  [ "$status" -eq 0 ]
  run grep -c '^\s*all)' "$ROOT/scripts/deploy.sh"
  [ "$output" -eq 0 ]
}

# ---------------------------------------------------------------------------
# h#805 — stale sudo tee unseal-key instructions
# ---------------------------------------------------------------------------

@test "h#805: disaster-recovery.md no longer instructs a manual sudo tee of the unseal key" {
  # The fixed text mentions "sudo tee" once, inside a "do NOT run this" warning —
  # assert the actual OLD EXECUTABLE command line is gone, not the substring.
  run grep -F 'echo "<unseal-key>" | sudo tee' "$DR"
  [ "$status" -ne 0 ]
  run grep -F 'sudo chown deploy:deploy /opt/hill90/secrets/openbao-unseal.key' "$DR"
  [ "$status" -ne 0 ]
}

@test "h#805: Step 4 now says the key is not printed and the script already writes it correctly" {
  run grep -F 'never prints the' "$DR"
  [ "$status" -eq 0 ]
  run grep -F 'Unseal key written to' "$DR"
  [ "$status" -eq 0 ]
}

@test "h#805 corroborated against the script: cmd_init's own comment documents it no longer echoes credentials to stdout" {
  run grep -F 'This used to echo the unseal key and root token to stdout' "$ROOT/scripts/vault.sh"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# h#806 — Step 0's tar-restore chain is illustrative, not an instruction;
# coupling to h#799 stated, h#799 NOT resolved here
# ---------------------------------------------------------------------------

@test "h#806: Step 0 explicitly says the tar-restore chain is a hazard illustration, not an instruction" {
  run grep -F 'not an instruction to restore' "$DR"
  [ "$status" -eq 0 ]
}

@test "h#806: the h#799 coupling is stated by number, plainly" {
  run grep -F 'Hill90#799' "$DR"
  [ "$status" -eq 0 ]
}

@test "h#806: h#799 is named as Jon's OPEN decision, not resolved by this doc" {
  run grep -F "#799 is Jon's open decision" "$DR"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# h#807 — vps-rebuild.md's vault step omitted init/setup/seed/approles
# ---------------------------------------------------------------------------

@test "h#807: vps-rebuild.md's vault step now says deploy alone is not enough" {
  run grep -F 'This alone is not enough' "$VPS"
  [ "$status" -eq 0 ]
}

@test "h#807: vps-rebuild.md now names all four missing sub-steps (init, setup, seed, bootstrap-approles)" {
  for word in init setup seed bootstrap-approles; do
    run grep -F "vault.sh $word" "$VPS"
    [ "$status" -eq 0 ]
  done
}

@test "h#807: the overview no longer claims zero manual intervention without qualifying vault" {
  run grep -F 'requires **zero manual intervention**' "$VPS"
  [ "$status" -ne 0 ]
  run grep -F 'Vault is not' "$VPS"
  [ "$status" -eq 0 ]
}

@test "h#807: vps-rebuild.md states the bootstrap-approles credential entanglement with h#832" {
  run grep -F 'Hill90#832' "$VPS"
  [ "$status" -eq 0 ]
  run grep -F 'policy-oidc-admin' "$VPS"
  [ "$status" -eq 0 ]
}

@test "h#807: vps-rebuild.md says the generate-root fallback is dead, not merely conditional" {
  run grep -F 'currently dead, unconditionally' "$VPS"
  [ "$status" -eq 0 ]
}

@test "h#807 corroborated against the script: cmd_bootstrap_approles's own die message names the same 403-regardless-of-config limit" {
  run grep -F 'returns 403 on 2.6.1' "$ROOT/scripts/vault.sh"
  [ "$status" -eq 0 ]
  run grep -F 'whatever the' "$ROOT/scripts/vault.sh"
  [ "$status" -eq 0 ]
}

@test "h#807: disaster-recovery.md's Step 9 carries the same corrected description and h#832 entanglement" {
  run grep -F 'currently dead, not just conditional' "$DR"
  [ "$status" -eq 0 ]
  run grep -F 'Hill90#832' "$DR"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# h#808 (docs half) — observability undercounted by 2
# ---------------------------------------------------------------------------

@test "h#808 docs: vps-rebuild.md's observability service list now includes alertmanager and blackbox-exporter" {
  run grep -F 'Alertmanager' "$VPS"
  [ "$status" -eq 0 ]
  run grep -iF 'blackbox' "$VPS"
  [ "$status" -eq 0 ]
}

@test "h#808 docs: vps-rebuild.md no longer claims ten total platform containers" {
  run grep -F 'All ten Docker containers' "$VPS"
  [ "$status" -ne 0 ]
  run grep -F 'All twelve Docker containers' "$VPS"
  [ "$status" -eq 0 ]
}

@test "h#808 corroborated against the compose file: exactly 9 observability services are defined" {
  run bash -c "grep -oE '^  [a-z-]+:' '$ROOT/deploy/compose/prod/docker-compose.observability.yml' | tr -d ' :' | grep -vE '^(edge|internal)\$' | grep -cE '^(prometheus|alertmanager|blackbox-exporter|loki|tempo|grafana|promtail|node-exporter|cadvisor)\$'"
  [ "$output" -eq 9 ]
}
