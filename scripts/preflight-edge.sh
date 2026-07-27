#!/usr/bin/env bash
# Preflight for the edge stack: refuse to bring Traefik up with a config that
# is missing, empty, or a directory.
#
# Docker creates a DIRECTORY at a bind-mount source that does not exist. Traefik
# then receives a directory at /etc/traefik/traefik.yml, refuses to start, and
# every routed service goes down — while `docker compose up` reports success.
# This is the last chance to catch that before it happens, and it is deliberately
# separate from render-traefik-config.sh so it also guards the case where the
# render was skipped entirely rather than merely failing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

CONFIG="${TRAEFIK_CONFIG_OUTPUT:-${PROJECT_ROOT}/platform/edge/traefik.generated.yml}"

if [ -d "$CONFIG" ]; then
    die "$CONFIG is a DIRECTORY, not a file.

  Docker creates one when a bind-mount source is missing, which means a previous
  deploy brought the stack up without rendering the config. Remove it and
  re-deploy:
    rm -rf '$CONFIG'"
fi

[ -e "$CONFIG" ] || die "Traefik config has not been rendered: $CONFIG
  Run the deploy through scripts/deploy.sh, which renders it, rather than
  invoking docker compose directly."

[ -f "$CONFIG" ] || die "$CONFIG exists but is not a regular file."
[ -s "$CONFIG" ] || die "$CONFIG is empty — a previous render failed partway."

if ! grep -q "caServer:" "$CONFIG"; then
    die "$CONFIG defines no caServer. A resolver without one silently uses
  production Lets Encrypt. Re-render with scripts/render-traefik-config.sh."
fi

if grep -v '^[[:space:]]*#' "$CONFIG" | grep -q '\${'; then
    die "$CONFIG still contains unsubstituted placeholders — Traefik does not
  interpolate variables in YAML and would read them literally."
fi

success "✓ Edge preflight: $(basename "$CONFIG") is a rendered, non-empty config"
