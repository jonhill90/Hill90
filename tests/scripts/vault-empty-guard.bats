#!/usr/bin/env bats

# The guard that would have prevented the 2026-08-03 auth outage.
#
# Keycloak deployed with KC_BOOTSTRAP_ADMIN_PASSWORD empty and refused to boot.
# The chain: the `auth` AppRole holds a policy that does not exist, so its KV
# reads returned 403; `vault_read_kv` discarded stderr and piped into python,
# which exits 0 after printing nothing; `vault_load_secrets` therefore exported
# nothing and RETURNED SUCCESS; the SOPS fallback never fired because nothing had
# failed; and the generic deploy path had no empty-value guard — only the infra
# path had one, for one named variable.
#
# These tests are the positive control. They make a key resolve empty, and a path
# resolve unreadable, and assert the loader REFUSES. A guard that has never been
# seen to fail is not a guard.
#
# `docker` is stubbed, so no vault and no VPS are involved.

setup() {
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"

  # sops is called by vault_login; feed it credentials so login succeeds and the
  # test exercises the READ, which is what broke.
  cat > "$STUB/sops" <<'EOF'
#!/usr/bin/env bash
echo "VAULT_AUTH_ROLE_ID=rid"
echo "VAULT_AUTH_SECRET_ID=sid"
EOF
  chmod +x "$STUB/sops"

  ROOT="$BATS_TEST_DIRNAME/../.."
}

# $1 = the JSON (or error text) the stubbed `bao kv get` returns
# $2 = exit code for `bao kv get`
make_docker_stub() {
  cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
# args end with: bao <subcommand> ...
for a in "\$@"; do last="\$a"; done
case " \$* " in
  *"auth/approle/login"*)
      echo '{"auth":{"client_token":"s.faketoken"}}'; exit 0 ;;
  *" kv get "*)
      cat <<'PAYLOAD'
$1
PAYLOAD
      exit $2 ;;
  *" status "*)
      echo '{"sealed":false}'; exit 0 ;;
esac
exit 0
EOF
  chmod +x "$STUB/docker"
}

load_and_run() {
  cd "$ROOT"
  # shellcheck disable=SC1091
  PROJECT_ROOT="$ROOT" source scripts/_common.sh
  vault_load_secrets "auth" "$ROOT/infra/secrets/prod.enc.env"
}

@test "a healthy read still succeeds and exports the values" {
  make_docker_stub '{"data":{"data":{"KC_ADMIN_USERNAME":"admin","KC_ADMIN_PASSWORD":"realsecret"}}}' 0
  run load_and_run
  [ "$status" -eq 0 ]
  [[ "$output" == *"loaded"*"none empty"* ]]
}

@test "REFUSES when a value resolves EMPTY — the outage condition" {
  make_docker_stub '{"data":{"data":{"KC_ADMIN_USERNAME":"admin","KC_ADMIN_PASSWORD":""}}}' 0
  run load_and_run
  [ "$status" -ne 0 ]
  [[ "$output" == *"KC_ADMIN_PASSWORD"* ]]
  [[ "$output" == *"EMPTY"* ]]
  [[ "$output" == *"falling back to SOPS"* ]]
}

@test "the empty check is GENERIC — it names whatever key is empty, not a hardcoded one" {
  make_docker_stub '{"data":{"data":{"SOME_UNRELATED_KEY":"","OTHER":"fine"}}}' 0
  run load_and_run
  [ "$status" -ne 0 ]
  [[ "$output" == *"SOME_UNRELATED_KEY"* ]]
}

@test "REFUSES on a 403 — the actual production failure, which used to return success" {
  make_docker_stub 'Error making API request.

Code: 403. Errors:

* preflight capability check returned 403' 1
  run load_and_run
  [ "$status" -ne 0 ]
  [[ "$output" == *"cannot read"* ]]
}

@test "REFUSES when the path exists but holds no keys" {
  make_docker_stub '{"data":{"data":{}}}' 0
  run load_and_run
  [ "$status" -ne 0 ]
}

@test "REFUSES on an unparseable response rather than reading it as empty" {
  make_docker_stub 'not json at all' 0
  run load_and_run
  [ "$status" -ne 0 ]
}

@test "a failing load returns non-zero so deploy.sh reaches its SOPS fallback" {
  # Both deploy paths wrap the vault branch in `( ... ) || { warn; _deploy_with_sops; }`.
  # That fallback is only reachable if the subshell fails, which is precisely
  # what did not happen during the outage.
  grep -q 'retrying with SOPS fallback' "$ROOT/scripts/deploy.sh"
  make_docker_stub '{"data":{"data":{"KC_ADMIN_PASSWORD":""}}}' 0
  run load_and_run
  [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# The SECOND half of the 2026-08-03 outage.
#
# #651 made vault_load_secrets return non-zero correctly — and auth STILL
# deployed with every variable blank, because `set -e` is SUPPRESSED inside a
# compound command on the left of `||`. deploy.sh wraps the vault branch in
# `( ... ) || { warn; _deploy_with_sops; }`, so a bare call that returns 1 does
# not stop the subshell: it warns, carries on, and runs docker compose with no
# secrets. The compose log showed all six variables "not set".
#
# `exit` is not subject to the suppression. `return` is. These tests pin that.
# ---------------------------------------------------------------------------

@test "bash really does suppress set -e inside a subshell on the left of ||" {
  run bash -c 'set -e; f(){ return 1; }; ( f; echo REACHED ) || echo FALLBACK'
  [[ "$output" == *"REACHED"* ]]
  [[ "$output" != *"FALLBACK"* ]]
}

@test "... and || exit 1 defeats it" {
  run bash -c 'set -e; f(){ return 1; }; ( f || exit 1; echo REACHED ) || echo FALLBACK'
  [[ "$output" == *"FALLBACK"* ]]
  [[ "$output" != *"REACHED"* ]]
}

@test "EVERY vault_load_secrets call site aborts its subshell explicitly" {
  cd "$BATS_TEST_DIRNAME/../.."
  # A bare call here means a failed secret load deploys blank credentials.
  run grep -nE '^[[:space:]]*vault_load_secrets ' scripts/deploy.sh
  [ "$status" -eq 0 ]
  while IFS= read -r line; do
    [[ "$line" == *"|| exit"* ]] || { echo "unguarded call site: $line"; return 1; }
  done <<< "$output"
}
