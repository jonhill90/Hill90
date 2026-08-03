#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_vault_covers_compose.py.
#
# The defect it guards caused a real outage: `secret/observability/grafana` held
# one key, deploy.sh exported only what vault returned, and Grafana started with
# GRAFANA_OIDC_CLIENT_SECRET blank. The deploy said "loaded 1 variables for
# observability, none empty" and succeeded.
#
# NEEDS THE STORE. The check reads SOPS key NAMES to decide what counts as a
# secret, so it cannot run without the age key. These tests SKIP rather than fail
# in that case — a check that cannot see must not report a clean bill of health,
# and a control that cannot run must not report a passing one either.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  if [ ! -f "$ROOT/infra/secrets/keys/age-prod.key" ] && [ ! -f /opt/hill90/secrets/keys/keys.txt ]; then
    skip "no age key available — the check cannot read the store"
  fi
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/deploy/compose/prod" "$CTL/infra/secrets"
  cp "$ROOT/scripts/checks/check_vault_covers_compose.py" "$CTL/scripts/checks/"
  cp "$ROOT/scripts/vault.sh" "$ROOT/scripts/_common.sh" "$ROOT/scripts/deploy.sh" "$ROOT/scripts/render-alertmanager-config.sh" "$CTL/scripts/"
  cp "$ROOT"/deploy/compose/prod/docker-compose.*.yml "$CTL/deploy/compose/prod/"
  cp -R "$ROOT/infra/secrets/." "$CTL/infra/secrets/"
  CHECK="$CTL/scripts/checks/check_vault_covers_compose.py"
}

@test "CONTROL: passes on the real, unmutated tree" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

@test "CONTROL: every service with vault paths is actually examined" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"observability"* ]]
  [[ "$output" == *"auth"* ]]
  [[ "$output" == *"db"* ]]
  [[ "$output" == *"infra"* ]]
}

@test "removing GRAFANA_OIDC_CLIENT_SECRET from the seed — the outage — turns it red" {
  sed -i.bak '/"GRAFANA_OIDC_CLIENT_SECRET=\$(get_secret GRAFANA_OIDC_CLIENT_SECRET)"/d' "$CTL/scripts/vault.sh"
  sed -i.bak2 's/"GRAFANA_ADMIN_PASSWORD=$(get_secret GRAFANA_ADMIN_PASSWORD)" \\/"GRAFANA_ADMIN_PASSWORD=$(get_secret GRAFANA_ADMIN_PASSWORD)"/' "$CTL/scripts/vault.sh"
  rm -f "$CTL/scripts/vault.sh".bak*

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"GRAFANA_OIDC_CLIENT_SECRET"* ]]
  [[ "$output" == *"export it EMPTY"* ]]
}

@test "removing VAULT_OIDC_CLIENT_SECRET from the seed turns it red" {
  sed -i.bak '/"VAULT_OIDC_CLIENT_SECRET=\$(get_secret VAULT_OIDC_CLIENT_SECRET)"/d' "$CTL/scripts/vault.sh"
  sed -i.bak2 's/"KC_ADMIN_PASSWORD=$(get_secret KC_ADMIN_PASSWORD)" \\/"KC_ADMIN_PASSWORD=$(get_secret KC_ADMIN_PASSWORD)"/' "$CTL/scripts/vault.sh"
  rm -f "$CTL/scripts/vault.sh".bak*

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"VAULT_OIDC_CLIENT_SECRET"* ]]
}

# A service that declares a vault path but seeds nothing into it is the same
# defect in its most complete form.
@test "a declared path with an empty seed turns it red" {
  python3 - "$CTL/scripts/_common.sh" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace('        infra)         echo "secret/infra/traefik" ;;',
               '        infra)         echo "secret/infra/nothinghere" ;;', 1)
assert t2 != t
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"infra"* ]]
}

# HOOK COVERAGE — this check's own blind spot until #669. SMTP_PASSWORD appears
# in no compose file; it reaches Alertmanager through a rendered config.
@test "removing SMTP_PASSWORD from the seed turns it red, naming the hook" {
  sed -i.bak '/"SMTP_PASSWORD=\$(get_secret SMTP_PASSWORD)"/d' "$CTL/scripts/vault.sh"
  rm -f "$CTL/scripts/vault.sh".bak*

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"SMTP_PASSWORD"* ]]
  [[ "$output" == *"pre-up hook render-alertmanager-config.sh"* ]]
}

# The association must be by CASE ARM. A proximity match attributed the
# observability hook to auth, db, minio and vault — four false positives.
@test "the alertmanager hook is attributed to observability only" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"observability  pre-up hook render-alertmanager-config.sh"* ]]
  run bash -c "python3 '$CHECK' | grep -c 'pre-up hook'"
  [ "$output" -eq 1 ]
}
