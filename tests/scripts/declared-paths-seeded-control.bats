#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_declared_paths_are_seeded.py.
#
# The defect it guards is a list disagreeing with a list: #495 removed the seed
# blocks for secret/shared/database and secret/auth/config, #531 restored the
# DECLARATIONS for those paths and not the seed, and the gap survived months and
# two outage investigations because nothing compared them.
#
# So this does not merely assert the repo passes today. Each test mutates a copy
# and requires the check to go red for one specific reason. Same pattern as
# tests/scripts/vault-revoke-order-control.bats (#659) and
# root-revoke-fails-closed-control.bats (#663).

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks"
  cp "$ROOT/scripts/checks/check_declared_paths_are_seeded.py" "$CTL/scripts/checks/"
  cp "$ROOT/scripts/vault.sh" "$ROOT/scripts/_common.sh" "$CTL/scripts/"
  CHECK="$CTL/scripts/checks/check_declared_paths_are_seeded.py"
}

@test "CONTROL: the check PASSES on the real, unmutated scripts" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

# NOT VACUOUS: if the declaration parser stops finding arms, every path silently
# passes. Pin that all five declared pairs are actually examined.
@test "CONTROL: all four services and their paths are discovered" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"db"* ]]
  [[ "$output" == *"auth"* ]]
  [[ "$output" == *"infra"* ]]
  [[ "$output" == *"observability"* ]]
  [[ "$output" == *"secret/shared/database"* ]]
  [[ "$output" == *"secret/auth/config"* ]]
}

@test "removing the shared/database seed — the exact #495 regression — turns it red" {
  python3 - "$CTL/scripts/vault.sh" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p).read()
t2 = re.sub(r'    echo "Seeding secret/shared/database\.\.\."\n(?:.*\n)*?        "DB_NAME=[^\n]*\n', "", t)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL"* ]]
  [[ "$output" == *"secret/shared/database"* ]]
  [[ "$output" == *"cmd_seed never writes it"* ]]
}

@test "removing the auth/config seed turns it red" {
  python3 - "$CTL/scripts/vault.sh" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p).read()
t2 = re.sub(r'    echo "Seeding secret/auth/config\.\.\."\n(?:.*\n)*?        "KC_ADMIN_PASSWORD=[^\n]*\n', "", t)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"secret/auth/config"* ]]
}

# The other direction of the same drift: a service gains a path and nobody seeds
# it. This is how the gap would reappear tomorrow.
@test "declaring a brand-new path with no seed turns it red" {
  python3 - "$CTL/scripts/_common.sh" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace('        infra)         echo "secret/infra/traefik" ;;',
               '        infra)         echo "secret/infra/traefik secret/infra/brandnew" ;;', 1)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"secret/infra/brandnew"* ]]
}

# A seeded key absent from required_keys is written as an EMPTY STRING when the
# SOPS key is missing — the CF_DNS_API_TOKEN failure mode cmd_seed already
# documents, and the same empty-is-not-absent class as the #650 outage.
@test "seeding a key that is not in required_keys turns it red" {
  python3 - "$CTL/scripts/vault.sh" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace('        "DB_NAME=$(get_secret DB_NAME)"',
               '        "DB_NAME=$(get_secret DB_NAME)" \\\n        "DB_UNGUARDED=$(get_secret DB_UNGUARDED)"', 1)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"DB_UNGUARDED"* ]]
  [[ "$output" == *"empty string"* ]]
}

# h#730: unlike its sibling check_oidc_clients_reconciled.py (which refuses a
# zero-reference result as indistinguishable from every pattern having
# rotted), this check had no guard for declared_paths() returning empty — a
# regex-vs-source-shape drift that stops every case arm from matching, while
# the outer function-body regex still matches fine, would have printed "PASS
# — every declared path is seeded" having examined zero of them. Simulated
# the drift the sibling's own docstring names as the trigger: a refactor away
# from the shape the regex expects — here, `echo "..."` becoming `printf`.
@test "THE ASSERTION THAT MATTERS: every case arm losing its echo shape refuses rather than passing vacuously" {
  python3 - "$CTL/scripts/_common.sh" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p).read()
m = re.search(r"vault_paths_for_service\(\)\s*\{(.*?)\n\}", t, re.S)
assert m, "fixture setup broken: could not find the function to mutate"
body = m.group(1)
# Every arm goes from `echo "..."` to `printf '%s' "..."` — the regex this
# check parses arms with requires the literal `echo`, so this drops every
# arm from the parse while the outer function-body regex still matches.
mutated_body = re.sub(r'echo\s+"', 'printf \'%s\' "', body)
assert mutated_body != body, "mutation did not apply"
t2 = t[:m.start(1)] + mutated_body + t[m.end(1):]
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL"* ]]
  [[ "$output" == *"no declared paths found at all"* ]]
  # Must not be silently indistinguishable from a genuine clean pass.
  [[ "$output" != *"PASS"* ]]
}

# PROSE IS NOT AN ACTION — the same trap that made an earlier check read an
# echoed command as a real one. A path named only in a comment is not seeded.
@test "a path mentioned only in a comment does not count as seeded" {
  python3 - "$CTL/scripts/vault.sh" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p).read()
# Remove the real seed, then name the path in a comment and an echo instead.
t2 = re.sub(r'    echo "Seeding secret/auth/config\.\.\."\n(?:.*\n)*?        "KC_ADMIN_PASSWORD=[^\n]*\n',
            '    # kv put secret/auth/config would go here\n'
            '    echo "remember to kv put secret/auth/config"\n', t)
assert t2 != t, "mutation did not apply"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"secret/auth/config"* ]]
  [[ "$output" == *"cmd_seed never writes it"* ]]
}
