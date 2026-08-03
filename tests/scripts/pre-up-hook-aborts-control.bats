#!/usr/bin/env bats

# POSITIVE CONTROL: a refusing pre-up hook must STOP the deploy.
#
# On 2026-08-03 both observability deploys logged
#   ERROR: SMTP_PASSWORD is not set. Refusing to render the Alertmanager config.
# and both reported success. The hook refused correctly; the caller ignored it.
#
# `set -e` is suppressed inside a compound command on the left of `||`, and the
# deploy's vault branch is exactly `( ... ) || { sops fallback }`. So a bare
# `bash "$hook"` that fails does not stop the subshell.
#
# These tests do not merely grep for `|| exit 1`. They demonstrate the SEMANTICS
# in both directions, and they run the REAL render script with a real empty
# variable to prove the guard it depends on actually refuses.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
}

# ---------------------------------------------------------------------------
# The semantics, shown failing before they are shown fixed.
# ---------------------------------------------------------------------------

@test "CONTROL: the OLD shape swallows a failing hook — the bug, reproduced" {
  run bash -c '
    set -e
    hook() { return 1; }
    ( hook; echo "DEPLOY CONTINUED" ) || echo "FALLBACK FIRED"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"DEPLOY CONTINUED"* ]]
  [[ "$output" != *"FALLBACK FIRED"* ]]
}

@test "the FIXED shape stops the subshell and trips the fallback" {
  run bash -c '
    set -e
    hook() { return 1; }
    ( hook || exit 1; echo "DEPLOY CONTINUED" ) || echo "FALLBACK FIRED"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"FALLBACK FIRED"* ]]
  [[ "$output" != *"DEPLOY CONTINUED"* ]]
}

# ---------------------------------------------------------------------------
# The real script must actually refuse, or the abort above has nothing to catch.
# ---------------------------------------------------------------------------

@test "render-alertmanager-config.sh REFUSES with an empty SMTP_PASSWORD" {
  OUT="$BATS_TEST_TMPDIR/alertmanager.yml"
  run env -u SMTP_PASSWORD \
      ALERT_EMAIL_TO="ops@example.invalid" \
      ALERTMANAGER_CONFIG_OUTPUT="$OUT" \
      bash "$ROOT/scripts/render-alertmanager-config.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"SMTP_PASSWORD"* ]]
  # And it must not have left a half-written file behind.
  [ ! -f "$OUT" ]
}

@test "render-alertmanager-config.sh REFUSES with an empty ALERT_EMAIL_TO" {
  OUT="$BATS_TEST_TMPDIR/alertmanager2.yml"
  run env -u ALERT_EMAIL_TO \
      SMTP_PASSWORD="not-a-real-password" \
      ALERTMANAGER_CONFIG_OUTPUT="$OUT" \
      bash "$ROOT/scripts/render-alertmanager-config.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"ALERT_EMAIL_TO"* ]]
  [ ! -f "$OUT" ]
}

# ---------------------------------------------------------------------------
# And the caller must use the form that propagates it.
# ---------------------------------------------------------------------------

@test "deploy.sh calls the pre-up hook with || exit 1" {
  run grep -c 'bash "$SCRIPT_DIR/$pre_up_hook" || exit 1' "$ROOT/scripts/deploy.sh"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

@test "deploy.sh has NO bare pre-up hook invocation left" {
  # A bare call is the defect. Any occurrence not followed by `|| exit 1` fails.
  run bash -c "grep -n 'bash \"\$SCRIPT_DIR/\$pre_up_hook\"' '$ROOT/scripts/deploy.sh' | grep -v '|| exit 1' | wc -l"
  [ "$output" -eq 0 ]
}

# The same swallowed-guard shape has now appeared three times. Pin the sibling
# so a future edit cannot quietly undo the #652 fix while this one stands.
@test "deploy.sh still calls vault_load_secrets with || exit 1" {
  run bash -c "grep -c 'vault_load_secrets \"[^\"]*\" \"\$secrets_file\" || exit 1' '$ROOT/scripts/deploy.sh'"
  [ "$output" -ge 2 ]
}
