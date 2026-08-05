#!/usr/bin/env bash
# Check that no deploy scripts or workflows contain destructive volume commands.
# Banned patterns (assembled from fragments to avoid self-matching):
#   docker compose ... down ... -v
#   docker volume rm
#   docker system prune
#
# Exit codes: 0 = clean, 1 = violation found

set -euo pipefail

FAIL=0

# Build banned patterns from fragments so this script does not match itself.
# Matches the literal form and the indirect one — a compose helper function
# wrapping `down -v` is exactly as destructive and used to slip through.
PAT_DOWN="(docker compose|compose_[a-z]+).*down.*(-v|--volumes)"
PAT_VOLRM="docker volume rm"
PAT_PRUNE="docker system prune"

# scripts/local.sh is exempt from the volume rule and only that rule. It talks
# exclusively to the local Docker daemon, targets compose projects prefixed
# hill90-local-, prompts for typed confirmation, and exists precisely so a
# developer can wipe and rebuild their own machine. It can no more reach the
# VPS than `ls` can.
#
# .github/workflows/vault-reinitialize.yml is exempt for the same reason and no
# other: destroying the vault volume IS the operation. It is gated behind a
# typed REINITIALIZE confirmation, a separate acknowledgement input, a check
# that refuses if the vault holds KV data, and a backup that must succeed and be
# verified non-empty before anything is removed. Adding a second file here needs
# that standard of justification.
ALLOW_VOLUME_DESTRUCTION="scripts/local.sh
.github/workflows/vault-reinitialize.yml"

# Guards the 0==0 trap: `for f in scripts/*.sh .github/workflows/*.yml` with
# neither glob matching leaves the pattern unexpanded as a literal string,
# `[ -f "$f" ]` false, `continue` past it — FAIL never leaves 0, and the
# script prints "No destructive volume commands found" having scanned
# nothing. Reproduced: `cd /tmp/empty && bash check_destructive_commands.sh`
# exits 0 with that message. check_alert_counts_documented.py already
# refuses to treat two independently-empty derivations as agreement for this
# exact reason; this script had no equivalent guard. The only thing that
# makes this latent rather than live today is that its sole caller
# (ci.yml's "Assert no destructive volume commands" step) runs via
# actions/checkout@v4 with no working-directory override, so cwd is always
# the repo root — one workflow edit away from silently scanning zero files.
SCANNED=0
for f in scripts/*.sh .github/workflows/*.yml; do
  [ -f "$f" ] || continue
  SCANNED=$((SCANNED + 1))

  # Strip comment and blank lines before checking
  STRIPPED=$(grep -v '^[[:space:]]*#' "$f" 2>/dev/null | grep -v '^[[:space:]]*$') || true

  if ! echo "$ALLOW_VOLUME_DESTRUCTION" | grep -qxF "$f"; then
    if echo "$STRIPPED" | grep -qE "$PAT_DOWN"; then
      echo "FAIL: $f contains a compose 'down' with volume removal"
      FAIL=1
    fi
    if echo "$STRIPPED" | grep -qE "$PAT_VOLRM"; then
      echo "FAIL: $f contains 'docker volume rm'"
      FAIL=1
    fi
  fi
  if echo "$STRIPPED" | grep -qE "$PAT_PRUNE"; then
    echo "FAIL: $f contains 'docker system prune'"
    FAIL=1
  fi
done

if [ "$SCANNED" -eq 0 ]; then
  echo "CANNOT DETERMINE: scripts/*.sh and .github/workflows/*.yml matched zero files — nothing was scanned. Run this from the repository root."
  exit 2
fi

if [ "$FAIL" -eq 0 ]; then
  echo "No destructive volume commands found (${SCANNED} files scanned)."
fi
exit $FAIL
