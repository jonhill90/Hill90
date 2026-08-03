#!/usr/bin/env bats

# POSITIVE CONTROL for the two deliberately-different contracts on absence.
#
# THE DECISION, stated so the tests are readable as intent and not just as
# assertions:
#
#   assert-unsealed  MUST FAIL when the container is absent. An assertion that
#                    passes because it could not look reports the state you
#                    wanted rather than the state there is. Both callers run it
#                    after a deploy that is supposed to have produced the
#                    container, so absence there means the deploy did not.
#
#   auto-unseal      MAY return 0 when the container is absent. Its caller is the
#                    boot-time systemd unit on a host that may legitimately not
#                    have OpenBao deployed. It must SAY it did nothing.
#
# The separating rule: a command that ACTS may no-op on absence; a command that
# ASSERTS may not.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  # A container name that certainly does not exist, so "absent" is the real
  # condition under test rather than something inferred.
  ABSENT="hill90-definitely-absent-$$"
}

@test "assert-unsealed FAILS when the container is absent" {
  run env VAULT_CONTAINER="$ABSENT" bash "$ROOT/scripts/vault.sh" assert-unsealed
  [ "$status" -ne 0 ]
  [[ "$output" == *"NOT DEPLOYED"* ]]
  [[ "$output" == *"failure, not a pass"* ]]
}

@test "assert-unsealed names the alternative rather than just refusing" {
  run env VAULT_CONTAINER="$ABSENT" bash "$ROOT/scripts/vault.sh" assert-unsealed
  [ "$status" -ne 0 ]
  # The next person should not have to work out what to run instead.
  [[ "$output" == *"deploy.sh vault prod"* ]]
  [[ "$output" == *"auto-unseal"* ]]
}

# CONTROL FOR THE CONTROL: if the old behaviour came back, the test above must be
# the thing that catches it. This pins the exact regression.
@test "CONTROL: the OLD assert-unsealed behaviour would have passed on absence" {
  run bash -c '
    absent() { return 1; }
    # The shape that shipped: absence -> report -> return 0.
    ( absent || { echo "not deployed — nothing to assert"; exit 0; }; echo "checked" )
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"nothing to assert"* ]]
}

@test "auto-unseal returns 0 on absence — deliberate, and says it is a NO-OP" {
  run env VAULT_CONTAINER="$ABSENT" VAULT_AUTO_UNSEAL_MAX_WAIT=1 \
      bash "$ROOT/scripts/vault.sh" auto-unseal
  [ "$status" -eq 0 ]
  [[ "$output" == *"NO-OP, not a success"* ]]
  [[ "$output" == *"assert-unsealed"* ]]
}

@test "the two contracts are documented in the code, not only in a PR" {
  run grep -c "TWO COMMANDS, TWO DELIBERATELY DIFFERENT CONTRACTS ON ABSENCE" "$ROOT/scripts/vault.sh"
  [ "$output" -eq 1 ]
  run grep -c "a command that ACTS may no-op on absence; a" "$ROOT/scripts/vault.sh"
  [ "$output" -eq 1 ]
}

@test "the usage line no longer claims assert-unsealed tolerates absence" {
  run grep -c 'assert-unsealed     Exit non-zero if OpenBao is sealed OR not deployed' "$ROOT/scripts/vault.sh"
  [ "$output" -eq 1 ]
  # The old wording said "if OpenBao is deployed but still sealed", which
  # described the defect as the contract.
  run bash -c "grep -c 'if OpenBao is deployed but still sealed' '$ROOT/scripts/vault.sh' || true"
  [ "$output" -eq 0 ]
}

# --- 2.3 and 2.4: the workflow cleanup conditions --------------------------

@test "vault-init 'Report where the root token is' runs on failure" {
  run python3 -c "
import yaml
d=yaml.safe_load(open('$ROOT/.github/workflows/vault-init.yml'))
s=[x for x in d['jobs']['init']['steps'] if x.get('name')=='Report where the root token is'][0]
print(s['if'])"
  [[ "$output" == *"always()"* ]]
}

@test "vault-regain-root 'Confirm OIDC survived the config swap' runs on failure" {
  run python3 -c "
import yaml
d=yaml.safe_load(open('$ROOT/.github/workflows/vault-regain-root.yml'))
s=[x for x in d['jobs']['regain']['steps'] if x.get('name')=='Confirm OIDC survived the config swap'][0]
print(s['if'])"
  [[ "$output" == *"always()"* ]]
}
