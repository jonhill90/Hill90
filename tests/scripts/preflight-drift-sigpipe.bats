#!/usr/bin/env bats

# The drift report must not kill the deploy.
#
# scripts/preflight-checkout.sh runs `set -euo pipefail` and printed the
# not-yet-deployed commits as:
#
#     git --no-pager log --oneline HEAD..origin/main | sed 's/^/    /' | head -20
#
# `head -20` closes the pipe after twenty lines. The writer upstream then takes
# SIGPIPE, `pipefail` promotes that to the pipeline's status (141), and `set -e`
# exits the script. Because the preflight runs in an `&&` chain BEFORE
# `git reset --hard origin/main`, the deploy stops there: nothing is deployed,
# and the host keeps running the old image.
#
# It is latent until the checkout falls more than twenty commits behind. Ported
# from hill90-app (app#137), which observed this in production on 2026-08-03,
# deploying `api`, at 55 commits behind:
#
#     # DRIFT: this checkout is 55 commits behind origin/main
#     ...twenty commit lines...
#     ##[error]Process completed with exit code 141.
#
# This repository's own preflight had the identical `| head -20` shape at the
# time app#140 (this repo's port: issue #705) was filed — confirmed by reading
# scripts/preflight-checkout.sh before fixing it, not assumed from the app-repo
# finding.
#
# The fix is to ask git for the cap (`-n 20`) instead of closing a pipe on it,
# so no writer is ever signalled.
#
# This test does not depend on pipe-buffer timing — with only fifty-five short
# lines the whole output fits in the 64 KiB pipe buffer and the race may not
# fire at all. It uses a stub `git` that emits far more than a buffer's worth
# unless it is asked for a limit, which makes the old code fail every time and
# the new code pass every time.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/preflight-checkout.sh"
  [ -f "$SCRIPT" ] || skip "scripts/preflight-checkout.sh not found"

  STUB_DIR="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$STUB_DIR"

  # A stand-in for git that answers only what the drift report asks, and floods
  # `log` with 20000 lines unless given -n. Everything else is inert.
  cat > "$STUB_DIR/git" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"rev-list --count"*"HEAD..origin/main"*) echo 55 ;;
  *"rev-list --count"*"origin/main..HEAD"*) echo 0 ;;
  *"log"*)
    limit=0
    prev=""
    for a in "$@"; do
      [ "$prev" = "-n" ] && limit="$a"
      case "$a" in -n[0-9]*) limit="${a#-n}" ;; esac
      prev="$a"
    done
    if [ "$limit" -gt 0 ] 2>/dev/null; then
      for i in $(seq 1 "$limit"); do echo "abc1234 commit subject line number $i"; done
    else
      for i in $(seq 1 20000); do echo "abc1234 commit subject line number $i"; done
    fi
    ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "$STUB_DIR/git"
}

@test "the drift report survives a checkout far behind origin/main" {
  # Source the script's drift function alone: running the whole preflight would
  # need a real checkout, and the defect lives entirely in this function.
  run env PATH="$STUB_DIR:$PATH" bash -c '
    set -euo pipefail
    behind=55
    ahead=0
    eval "$(sed -n "/^report_drift()/,/^}/p" "$1")"
    report_drift
  ' _ "$SCRIPT"

  [ "$status" -eq 0 ]
}

@test "the drift report still caps the list at twenty commits" {
  run env PATH="$STUB_DIR:$PATH" bash -c '
    set -euo pipefail
    behind=55
    ahead=0
    eval "$(sed -n "/^report_drift()/,/^}/p" "$1")"
    report_drift
  ' _ "$SCRIPT"

  # Guards the fix against becoming "print everything", which would bury the
  # banner under a hundred lines on a checkout that is far behind.
  commit_lines=$(printf '%s\n' "$output" | grep -c 'commit subject line number' || true)
  [ "$commit_lines" -eq 20 ]
}
