#!/usr/bin/env bats
#
# h#815: vault_login has (at least) three failure modes that all used to
# `return 1` indistinguishably — sops decrypt failing, AppRole credentials
# being absent/empty, and OpenBao itself rejecting the login. deploy.sh's two
# call sites then discarded BOTH streams with `(vault_login ...) >/dev/null
# 2>&1`, so an operator saw the identical sentence regardless of cause. For
# the sops case that sentence was actively WRONG — "OpenBao available but
# login failed" names OpenBao as at fault when OpenBao was never contacted.
#
# h#791 sat undiagnosable for days because of exactly this: the real cause
# (minio and vault have no AppRole at all — mode 2, permanent) had to be
# reconstructed statically by reading VAULT_SERVICES and the SOPS key names,
# because the live message covered it and the intermittent OpenBao-rejection
# failures on other services (mode 3) under the same one sentence.
#
# THE POSITIVE-CONTROL REQUIREMENT THE ISSUE STATES EXPLICITLY: force each of
# the three modes and show the warning naming a DIFFERENT cause for each. A
# single "now it prints an error" demonstration would not prove the modes are
# distinguishable, which is the entire point — so this file's load-bearing
# test compares all three messages and all three return codes pairwise.
#
# `docker` and `sops` are stubbed; no OpenBao and no VPS are involved. Mode
# 3's stub uses the EXACT text a real OpenBao rejection returned, captured in
# docs/decisions/approle-rejection-2026-08-01.md — a fixed sentence with no
# submitted value interpolated into it, not an invented string.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"
}

stub_sops_decrypt_fails() {
  cat > "$STUB/sops" <<'EOF'
#!/usr/bin/env bash
echo "sops: no matching creation rule found, cannot decrypt" >&2
exit 1
EOF
  chmod +x "$STUB/sops"
}

# $1 = service name whose ROLE_ID/SECRET_ID sops should NOT yield
stub_sops_no_credentials_for() {
  cat > "$STUB/sops" <<EOF
#!/usr/bin/env bash
echo "SOME_UNRELATED_KEY=x"
EOF
  chmod +x "$STUB/sops"
}

# $1 = role_id value, $2 = secret_id value to hand out for VAULT_AUTH_*
stub_sops_credentials() {
  cat > "$STUB/sops" <<EOF
#!/usr/bin/env bash
echo "VAULT_AUTH_ROLE_ID=$1"
echo "VAULT_AUTH_SECRET_ID=$2"
EOF
  chmod +x "$STUB/sops"
}

# $1 = service, $2 = role_id, $3 = secret_id — the parameterized twin of
# stub_sops_credentials, needed for h#844's minio case where the service
# under test isn't "auth".
stub_sops_credentials_for() {
  local svc_upper
  svc_upper=$(echo "$1" | tr '[:lower:]' '[:upper:]')
  cat > "$STUB/sops" <<EOF
#!/usr/bin/env bash
echo "VAULT_${svc_upper}_ROLE_ID=$2"
echo "VAULT_${svc_upper}_SECRET_ID=$3"
EOF
  chmod +x "$STUB/sops"
}

stub_docker_rejects_login() {
  cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
cat >&2 <<'ERR'
Error writing data to auth/approle/login: Error making API request.
URL: PUT http://127.0.0.1:8200/v1/auth/approle/login
Code: 400. Errors:
* invalid role or secret ID
ERR
exit 2
EOF
  chmod +x "$STUB/docker"
}

# ---------------------------------------------------------------------------
# vault_login itself — the function this issue is about
# ---------------------------------------------------------------------------

@test "MODE 1 (sops decrypt fails): distinct code, names sops, explicitly clears OpenBao" {
  stub_sops_decrypt_fails
  cd "$ROOT"
  source scripts/_common.sh
  run vault_login api /some/file.env
  [ "$status" -eq 2 ]
  [[ "$output" == *"sops decrypt failed"* ]]
  [[ "$output" == *"not OpenBao"* ]]
}

@test "MODE 2 (AppRole credentials missing): distinct code, names the missing vars, says no request was sent" {
  stub_sops_no_credentials_for minio
  cd "$ROOT"
  source scripts/_common.sh
  run vault_login minio /some/file.env
  [ "$status" -eq 3 ]
  [[ "$output" == *"AppRole credentials missing"* ]]
  [[ "$output" == *"VAULT_MINIO_ROLE_ID"* ]]
  [[ "$output" == *"VAULT_MINIO_SECRET_ID"* ]]
  [[ "$output" == *"no request was sent"* ]]
}

@test "MODE 3 (OpenBao rejects the login): distinct code, surfaces OpenBao's own reason" {
  stub_sops_credentials "11111111-1111-1111-1111-111111111111" "22222222-2222-2222-2222-222222222222"
  stub_docker_rejects_login
  cd "$ROOT"
  source scripts/_common.sh
  run vault_login auth /some/file.env
  [ "$status" -eq 4 ]
  [[ "$output" == *"OpenBao rejected login"* ]]
  [[ "$output" == *"invalid role or secret ID"* ]]
}

@test "POSITIVE CONTROL: the three modes report three DIFFERENT codes AND three DIFFERENT messages" {
  cd "$ROOT"
  source scripts/_common.sh

  stub_sops_decrypt_fails
  run vault_login api /some/file.env
  code1="$status"; msg1="$output"

  stub_sops_no_credentials_for minio
  run vault_login minio /some/file.env
  code2="$status"; msg2="$output"

  stub_sops_credentials "r" "s"
  stub_docker_rejects_login
  run vault_login auth /some/file.env
  code3="$status"; msg3="$output"

  # None of the three return codes may collide with another.
  [ "$code1" -ne "$code2" ]
  [ "$code2" -ne "$code3" ]
  [ "$code1" -ne "$code3" ]

  # None of the three messages may collide with another — a single shared
  # sentence across all three is exactly the bug h#791 hit.
  [ "$msg1" != "$msg2" ]
  [ "$msg2" != "$msg3" ]
  [ "$msg1" != "$msg3" ]

  # Each names ITS OWN cause, not one of the other two's.
  [[ "$msg1" == *"sops"* ]]
  [[ "$msg1" != *"AppRole credentials"* ]]
  [[ "$msg1" != *"OpenBao rejected"* ]]

  [[ "$msg2" == *"AppRole credentials"* ]]
  [[ "$msg2" != *"sops decrypt"* ]]
  [[ "$msg2" != *"OpenBao rejected"* ]]

  [[ "$msg3" == *"OpenBao rejected"* ]]
  [[ "$msg3" != *"sops decrypt"* ]]
  [[ "$msg3" != *"AppRole credentials"* ]]
}

# ---------------------------------------------------------------------------
# Credential safety — the issue's explicit caution. What is surfaced must be
# a REASON, never a VALUE, on every failure path, not just the OpenBao one.
# ---------------------------------------------------------------------------

@test "credential safety: OpenBao's real rejection text (mode 3) contains no submitted value to leak" {
  # The exact text a real OpenBao rejection returned — captured in
  # docs/decisions/approle-rejection-2026-08-01.md — is a fixed sentence,
  # "* invalid role or secret ID", with no submitted role_id/secret_id
  # interpolated into it. Confirmed against that real measurement, not
  # assumed: this test fails loudly if that documented text ever changes to
  # include one.
  run grep -A2 '^\* invalid role or secret ID' "$ROOT/docs/decisions/approle-rejection-2026-08-01.md"
  [ "$status" -eq 0 ] || run grep '^\* invalid role or secret ID$' "$ROOT/docs/decisions/approle-rejection-2026-08-01.md"
  [ "$status" -eq 0 ]

  ROLE_VAL="deadbeef-role-id-marker-should-never-print"
  SECRET_VAL="deadbeef-secret-id-marker-should-never-print"
  stub_sops_credentials "$ROLE_VAL" "$SECRET_VAL"
  stub_docker_rejects_login
  cd "$ROOT"
  source scripts/_common.sh
  run vault_login auth /some/file.env
  [[ "$output" != *"$ROLE_VAL"* ]]
  [[ "$output" != *"$SECRET_VAL"* ]]
}

@test "credential safety: a partially-set credential pair (mode 2) never echoes the half that WAS read" {
  # role_id resolves to a real value here; only secret_id is absent. The
  # function has the role_id in memory and must still never print it.
  ROLE_VAL="deadbeef-role-id-marker-should-never-print"
  cat > "$STUB/sops" <<EOF
#!/usr/bin/env bash
echo "VAULT_MINIO_ROLE_ID=${ROLE_VAL}"
EOF
  chmod +x "$STUB/sops"
  cd "$ROOT"
  source scripts/_common.sh
  run vault_login minio /some/file.env
  [ "$status" -eq 3 ]
  [[ "$output" != *"$ROLE_VAL"* ]]
}

@test "credential safety: no path ever prints a client_token" {
  # A successful login prints the token on STDOUT by design (callers do
  # token=\$(vault_login ...)) — that is unchanged and correct. What must
  # never happen is a TOKEN VALUE appearing in a failure path's stderr
  # reason. Simulate a malformed-but-200 response (mode 4's second branch,
  # sharing return code 4 with mode 3) and confirm no token-shaped value
  # leaks into the reason.
  stub_sops_credentials "r" "s"
  cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
echo 'not valid json, and does not contain the word tـo_k_e_n either'
exit 0
EOF
  chmod +x "$STUB/docker"
  cd "$ROOT"
  source scripts/_common.sh
  run vault_login auth /some/file.env
  [ "$status" -eq 4 ]
  [[ "$output" == *"could not be parsed"* ]]
}

# ---------------------------------------------------------------------------
# deploy.sh's two call sites — extracted VERBATIM from the shipped script and
# eval'd, not reimplemented, so this proves the actual code, not a stand-in
# for it. Each call site must capture vault_login's reason and fold it into
# its own warn() message, and must never let a successful token reach stdout
# unredirected (the credential-safety half of the fix, at the call-site
# level rather than inside vault_login).
# ---------------------------------------------------------------------------

extract_service_probe() {
  sed -n '/# Vault-first, SOPS-fallback for service secrets/,/# Helper: run compose deploy with secrets from SOPS/p' \
    "$ROOT/scripts/deploy.sh" | sed '$d'
}

extract_infra_probe() {
  sed -n '/# Vault-first, SOPS-fallback for infra secrets/,/# Helper: infra deploy with SOPS/p' \
    "$ROOT/scripts/deploy.sh" | sed '$d'
}

run_service_probe() {
  # $1 = service, sops+docker already stubbed by the caller. The extracted
  # snippet uses `local`, so it must run inside a function, not at a script's
  # top level — wrapping it in one here, rather than stripping `local` from
  # the extraction, keeps the eval'd text byte-for-byte what deploy.sh ships.
  local snippet
  snippet="$(extract_service_probe)"
  cd "$ROOT"
  bash -c "
    source scripts/_common.sh
    vault_available() { return 0; }
    probe() {
      local service='$1'
      local secrets_file=/some/file.env
      $snippet
      echo \"VAULT_OK=\$vault_ok\"
    }
    probe
  "
}

@test "the service call site's warn() message differs across the three modes (real deploy.sh code, not a copy)" {
  stub_sops_decrypt_fails
  run run_service_probe api
  msg1="$output"

  stub_sops_no_credentials_for minio
  run run_service_probe minio
  msg2="$output"

  stub_sops_credentials "r" "s"
  stub_docker_rejects_login
  run run_service_probe auth
  msg3="$output"

  [ "$msg1" != "$msg2" ]
  [ "$msg2" != "$msg3" ]
  [ "$msg1" != "$msg3" ]

  [[ "$msg1" == *"sops decrypt failed"* ]]
  [[ "$msg2" == *"AppRole credentials missing"* ]]
  [[ "$msg3" == *"OpenBao rejected login"* ]]

  # And in every case the fallback still fires — VAULT_OK stays false, which
  # is what the issue is explicit must not change: the SOPS fallback itself.
  [[ "$msg1" == *"VAULT_OK=false"* ]]
  [[ "$msg2" == *"VAULT_OK=false"* ]]
  [[ "$msg3" == *"VAULT_OK=false"* ]]
}

@test "the service call site still authenticates and sets VAULT_OK=true on a real success" {
  stub_sops_credentials "r" "s"
  cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
echo '{"auth":{"client_token":"s.faketoken"}}'
exit 0
EOF
  chmod +x "$STUB/docker"

  run run_service_probe auth
  [[ "$output" == *"OpenBao authenticated for auth"* ]]
  [[ "$output" == *"VAULT_OK=true"* ]]
  # The fallback's own suggested wording never fires on the success path.
  [[ "$output" != *"falling back to SOPS"* ]]
}

@test "the infra call site (deploy.sh's other vault_login site) is fixed the same way" {
  stub_sops_decrypt_fails
  snippet="$(extract_infra_probe)"
  cd "$ROOT"
  run bash -c "
    source scripts/_common.sh
    vault_available() { return 0; }
    probe() {
      local secrets_file=/some/file.env
      $snippet
    }
    probe
  "
  [[ "$output" == *"sops decrypt failed"* ]]
  [[ "$output" == *"not OpenBao"* ]]
}

@test "neither call site uses the old both-streams-discarded pattern anymore" {
  # The exact shape the issue names: (vault_login ...) >/dev/null 2>&1,
  # which threw away the reason at precisely the point that would explain
  # it. Neither call site should match this shape any longer.
  run grep -n '(vault_login .*) >/dev/null 2>&1' "$ROOT/scripts/deploy.sh"
  [ "$status" -ne 0 ]
}

@test "both call sites capture vault_login's stderr with stdout discarded, stream order 2>&1 then >/dev/null" {
  run grep -c 'vault_login .* 2>&1 >/dev/null' "$ROOT/scripts/deploy.sh"
  [ "$status" -eq 0 ]
  [ "$output" -eq 2 ]
}

# ---------------------------------------------------------------------------
# h#844: two structurally-permanent AppRole gaps (vault, minio) fired the
# SAME generic warning as a real, transient failure on every single deploy,
# forever. The point of h#815's distinct modes was undermined by this: a
# reader still could not tell "expected, permanent, ignore" from "a real
# credential just broke" without knowing VAULT_SERVICES and the SOPS layout
# by heart. These tests pin the two fixes named in the issue: the vault
# stack skips the login attempt entirely (it would be circular — vault_login
# "vault" can never succeed, no VAULT_VAULT_ROLE_ID could sensibly exist),
# and minio's failure is labeled as the structural, #720-tracked gap it is
# rather than left indistinguishable from OpenBao's generic rejection text.
# ---------------------------------------------------------------------------

@test "h#850, ARM 1 (credentials absent): the vault stack never calls vault_login — sops is checked, not skipped, but the login attempt never happens" {
  # h#850 review: the skip used to be unconditional on $service, never
  # checking whether VAULT_VAULT_ROLE_ID/_SECRET_ID actually existed —
  # reproduced empirically by the reviewing lane with a stub handing out a
  # real-looking role_id/secret_id pair and showing the login was never
  # attempted regardless. sops IS now invoked (vault_approle_credentials_present
  # reads the store to check), so this arm stubs it to report absence
  # honestly rather than asserting sops is never called at all.
  stub_sops_no_credentials_for vault

  run run_service_probe vault
  [[ "$output" != *"vault_login:"* ]]
  [[ "$output" != *"docker"* ]]
  [[ "$output" == *"vault stack always uses SOPS"* ]]
  [[ "$output" == *"circular"* ]]
  [[ "$output" != *"now exist in the store"* ]]
  [[ "$output" == *"VAULT_OK=false"* ]]
}

@test "h#850, ARM 2 (credentials present): the skip stays, but a loud warning fires instead of silence" {
  # The premise (no VAULT_VAULT_ROLE_ID/_SECRET_ID could sensibly exist) is
  # now DETECTABLE rather than merely assumed. This is the arm that did not
  # exist before the review found the gap — a conditional never seen to take
  # its other branch is not a conditional.
  stub_sops_credentials_for vault "some-role-id" "some-secret-id"

  run run_service_probe vault
  # Still never attempts the login itself — the skip is kept, only its
  # silence is now conditional.
  [[ "$output" != *"vault_login:"* ]]
  [[ "$output" != *"OpenBao authenticated for vault"* ]]
  [[ "$output" == *"VAULT_VAULT_ROLE_ID/_SECRET_ID now exist in the store"* ]]
  [[ "$output" == *"Investigate why a vault-self AppRole was created"* ]]
  [[ "$output" == *"VAULT_OK=false"* ]]
  # Distinguishable from minio's structural-absence warning — opposite
  # polarity (unexpected presence, not expected absence), must not read as
  # the same "ignore this" shape.
  [[ "$output" != *"No AppRole exists"* ]]
  [[ "$output" != *"(see #720)"* ]]
}

@test "h#850: vault's unexpected-credentials warning is distinguishable from minio's structural-absence warning" {
  stub_sops_credentials_for vault "some-role-id" "some-secret-id"
  run run_service_probe vault
  vault_out="$output"

  stub_sops_credentials_for minio "r" "s"
  stub_docker_rejects_login
  run run_service_probe minio
  minio_out="$output"

  [ "$vault_out" != "$minio_out" ]
  # An operator must not be able to read one as the other: vault's says
  # "this showed up and should not have — go find out why"; minio's says
  # "this is known and tracked, ignore it". Opposite instructions.
  [[ "$vault_out" == *"Investigate why"* ]]
  [[ "$minio_out" != *"Investigate why"* ]]
  [[ "$minio_out" == *"see #720"* ]]
  [[ "$vault_out" != *"see #720"* ]]
}

@test "h#844: minio's AppRole rejection is labeled structural and points at #720" {
  stub_sops_credentials_for minio "r" "s"
  stub_docker_rejects_login
  run run_service_probe minio
  [[ "$output" == *"No AppRole exists for minio yet (see #720)"* ]]
  # OpenBao's own reason still travels with it — this replaces the generic
  # wrapper sentence, not the underlying diagnostic detail.
  [[ "$output" == *"invalid role or secret ID"* ]]
  [[ "$output" == *"VAULT_OK=false"* ]]
}

@test "h#844: a real, transient AppRole failure on another service still reads generically, not as #720" {
  # The whole point: minio's structural label must not leak onto a service
  # whose AppRole genuinely exists and could genuinely, transiently fail.
  stub_sops_credentials "r" "s"
  stub_docker_rejects_login
  run run_service_probe auth
  [[ "$output" == *"OpenBao login failed for auth"* ]]
  [[ "$output" != *"#720"* ]]
  [[ "$output" != *"No AppRole exists"* ]]
}
