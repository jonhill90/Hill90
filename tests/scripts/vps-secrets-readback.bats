#!/usr/bin/env bats
#
# h#751: vps.sh's two `make secrets-update` calls trusted the exit code
# alone and never read the value back — lower severity than the rest of
# this sweep, since `set -euo pipefail` (verified active in this file)
# already aborts on a hard `make`/`sops --set` failure. The gap `set -e`
# cannot cover: a write that exits 0 without the value actually landing as
# intended (a race with another writer, a key/value that `sops --set`
# quietly mis-parsed, a wrong file resolved).
#
# These tests extract the REAL "Step 3" block verbatim from scripts/vps.sh
# (via sed, not retyped) and eval it inside a wrapper function, with `make`
# and `sops` stubbed to make the write/read-back mismatch controllable and
# deterministic. Scaled to the issue's own stated severity: this is the
# lowest-priority item in the tracking issue, so the test proves the
# comparison-and-die logic fires correctly rather than standing up a full
# real sops/age/repo round trip the way the higher-severity items in this
# sweep did.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"
}

extract_step3() {
  sed -n '/# Step 3: Update TAILSCALE_IP/,/^    echo ""$/p' "$ROOT/scripts/vps.sh" | sed '$d'
}

# $1 = value `sops -d --extract` should report back for BOTH keys (simulates
#      a write that landed correctly when equal to the intended IP, or one
#      that silently didn't when different / empty)
make_stubs() {
  cat > "$STUB/make" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$STUB/make"

  cat > "$STUB/sops" <<EOF
#!/usr/bin/env bash
echo "$1"
EOF
  chmod +x "$STUB/sops"
}

run_step3() {
  local tailscale_ip="$1"
  local snippet
  snippet="$(extract_step3)"
  bash -c "
    source '$ROOT/scripts/_common.sh'
    PROJECT_ROOT='$ROOT'
    probe() {
      local tailscale_ip='$tailscale_ip'
      $snippet
    }
    probe
  "
}

@test "a correct read-back is verified and reports success for both keys" {
  make_stubs "10.20.30.40"
  run run_step3 "10.20.30.40"
  [ "$status" -eq 0 ]
  [[ "$output" == *"TAILSCALE_IP updated (verified)"* ]]
  [[ "$output" == *"VPS_HOST updated (verified, SSH via Tailscale)"* ]]
}

@test "THE CASE THAT MATTERS: a write that returns 0 but does not read back correctly is refused, not reported as success" {
  # sops reports back a DIFFERENT value than what was written — exactly the
  # "make/sops exited 0 but the value didn't actually land" case set -e
  # alone cannot catch.
  make_stubs "0.0.0.0"
  run run_step3 "10.20.30.40"
  [ "$status" -ne 0 ]
  [[ "$output" == *"TAILSCALE_IP update did not take"* ]]
  [[ "$output" == *"wrote '10.20.30.40'"* ]]
  [[ "$output" == *"read back '0.0.0.0'"* ]]
  [[ "$output" != *"(verified)"* ]]
}

@test "an empty read-back (sops -d --extract failing silently) is also refused" {
  make_stubs ""
  run run_step3 "10.20.30.40"
  [ "$status" -ne 0 ]
  [[ "$output" == *"TAILSCALE_IP update did not take"* ]]
  [[ "$output" == *"read back ''"* ]]
}

@test "STATIC: set -euo pipefail is genuinely active in this file, as the issue's own severity note assumes" {
  run head -10 "$ROOT/scripts/vps.sh"
  [[ "$output" == *"set -euo pipefail"* ]]
}
