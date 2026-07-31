#!/usr/bin/env bash
# Render the Alertmanager configuration from its template.
#
# Reads SMTP_PASSWORD and ALERT_EMAIL_TO from the environment and writes
# platform/observability/alertmanager/alertmanager.yml.tmpl
#   -> /opt/hill90/secrets/alertmanager.yml   (0640 deploy:deploy — see the
#      mode note further down; 0600 does not work and the reason matters)
#
# WHY THE OUTPUT IS NOT IN THE CHECKOUT
#
# This is the difference from render-traefik-config.sh, which writes its output
# next to its template. That one substitutes ACME_CA_SERVER — a URL, not a
# secret. This one substitutes an SMTP password, and three things follow:
#
#   1. A plaintext credential must not sit in the repository working tree. This
#      estate has already fixed a 0644 pg_dumpall and a secret in argv; a
#      world-readable rendered config in /opt/hill90/app would be the same bug
#      a third time.
#   2. Every deploy path runs `git reset --hard origin/main` on the VPS
#      checkout, and scripts/preflight-checkout.sh refuses on a dirty tree. A
#      generated file inside the checkout is either destroyed or blocks the
#      deploy, depending on whether it is gitignored.
#   3. /opt/hill90/secrets already holds exactly this class of file — the
#      OpenBao unseal key, at 0600. Putting it there keeps one
#      convention rather than inventing a second.
#
# NOTE FOR DISASTER RECOVERY: that directory is in no backup, by design. This
# file is fully derivable from the encrypted store by re-running this script, so
# it adds no new single point of failure — see
# docs/reference/backup-coverage.md and disaster-recovery.md Step 0.
#
# Separate script rather than a function in deploy.sh for the same reason as
# render-traefik-config.sh: the SOPS path runs inside `sops exec-env '<command>'`,
# a new shell where a function defined in deploy.sh would not exist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

TEMPLATE="${ALERTMANAGER_CONFIG_TEMPLATE:-${PROJECT_ROOT}/platform/observability/alertmanager/alertmanager.yml.tmpl}"
OUTPUT="${ALERTMANAGER_CONFIG_OUTPUT:-/opt/hill90/secrets/alertmanager.yml}"

[ -f "$TEMPLATE" ] || die "Alertmanager config template missing: $TEMPLATE"

# No defaults, for the same reason ACME_CA_SERVER has none: a deploy that stops
# is better than one that silently produces an Alertmanager which accepts alerts
# and cannot deliver them. That failure mode is the entire subject of
# docs/decisions/alerting-audit.md — do not reintroduce it with a fallback.
if [ -z "${SMTP_PASSWORD:-}" ]; then
    die "SMTP_PASSWORD is not set. Refusing to render the Alertmanager config.

  Without it Alertmanager starts, accepts alerts, and fails every delivery with
  an authentication error in its own log — which is precisely the silent-failure
  shape this alerting work exists to remove.

  Run the deploy through the secrets path so the store is loaded:
    bash scripts/deploy.sh observability prod"
fi

if [ -z "${ALERT_EMAIL_TO:-}" ]; then
    die "ALERT_EMAIL_TO is not set. Refusing to render the Alertmanager config.

  An Alertmanager with no recipient is the default-contact-point bug in a new
  costume: it reports success and reaches nobody."
fi

mkdir -p "$(dirname "$OUTPUT")"

# MODE 0640, NOT 0600, AND THE REASON IS NOT LAZINESS.
#
# Alertmanager's image runs as `nobody` (uid 65534). A 0600 file owned by deploy
# is unreadable by it, and the container exits with
# "open /etc/alertmanager/alertmanager.yml: permission denied" — found by running
# it, not by reading it. The fix is group read for the deploy group plus
# `user: "65534:${SECRETS_GID}"` on the service, so the container keeps uid 65534
# (which owns its data volume) and gains the group that can read this file.
#
# 0644 would also "work" and is the bug this estate has already fixed twice — a
# world-readable credential on a multi-user host. Only the deploy group can read
# this; nothing else can.
#
# umask BEFORE the file exists, not chmod after: a chmod leaves a window in which
# the credential is world-readable, and this file is rewritten on every deploy.
(
    umask 027
    sed -e "s|__SMTP_PASSWORD__|${SMTP_PASSWORD}|g" \
        -e "s|__ALERT_EMAIL_TO__|${ALERT_EMAIL_TO}|g" \
        "$TEMPLATE" > "$OUTPUT"
)
chmod 640 "$OUTPUT"

# Prove the substitution happened rather than trusting sed. A template that
# reached Alertmanager with the literal placeholder still parses as valid YAML
# and still fails every send.
if grep -q '__SMTP_PASSWORD__\|__ALERT_EMAIL_TO__' "$OUTPUT"; then
    rm -f "$OUTPUT"
    die "Placeholder substitution failed — refusing to leave an undeliverable config in place."
fi

echo "✓ Rendered Alertmanager config -> $OUTPUT (mode 640, group-readable by deploy only)"
echo "  Recipient: ${ALERT_EMAIL_TO}"
echo "  SMTP: smtp.hostinger.com:587 as noreply@hill90.com (password not shown)"
