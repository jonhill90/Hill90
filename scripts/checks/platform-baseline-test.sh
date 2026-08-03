#!/usr/bin/env bash
# The platform baseline: 16 containers BY NAME, 0 unhealthy.
#
# "Verify the baseline after any action — a degraded baseline is the
# stop-everything signal" is in CLAUDE.md, and until now it was done by hand
# every time. Doing it by hand is how the two traps below keep getting hit.
#
# TRAP 1 — COUNT BY THE LIST, NOT FROM MEMORY. The old shorthand was "13 by name
# plus minio", so "13 + alertmanager + blackbox-exporter = 15" is a natural and
# WRONG arithmetic: minio was never inside the 13. The list below is the
# authority; the number is derived from it, never typed twice.
#
# TRAP 2 — MATCH blackbox-exporter, NOT blackbox. An exact-match sweep for the
# short name reports a running container as missing.
#
# A tenant's containers sit alongside these and are NOT part of the count, so
# this matches the expected set exactly rather than counting everything running.
#
# Usage: bash scripts/checks/platform-baseline-test.sh
# Exit:  0 baseline intact | 1 degraded

set -uo pipefail

# `Verified 2026-07-31 09:58 UTC`, after #617 deployed alertmanager and
# blackbox-exporter. Adding a platform service means adding it here.
EXPECTED=(
  alertmanager
  blackbox-exporter
  cadvisor
  grafana
  keycloak
  loki
  minio
  node-exporter
  openbao
  portainer
  postgres
  postgres-exporter
  prometheus
  promtail
  tempo
  traefik
)

RUNNING="$(docker ps --format '{{.Names}}')"
FAIL=0

echo "Platform baseline — ${#EXPECTED[@]} containers by name, 0 unhealthy"
echo "==================================================================="

MISSING=()
for name in "${EXPECTED[@]}"; do
    # Anchored: substring matching is what makes `blackbox` look like a hit and
    # what would let a tenant's `app-postgres` satisfy `postgres`.
    if ! printf '%s\n' "$RUNNING" | grep -qx -- "$name"; then
        MISSING+=("$name")
    fi
done

if [ ${#MISSING[@]} -eq 0 ]; then
    echo "  ✓ all ${#EXPECTED[@]} present"
else
    echo "  ✗ MISSING (${#MISSING[@]}): ${MISSING[*]}"
    FAIL=1
fi

# Unhealthy anywhere on the host is worth reporting even if it is a tenant's —
# but only a PLATFORM container degrades the baseline.
UNHEALTHY="$(docker ps --filter health=unhealthy --format '{{.Names}}')"
if [ -z "$UNHEALTHY" ]; then
    echo "  ✓ 0 unhealthy"
else
    echo "  ✗ UNHEALTHY: $(printf '%s' "$UNHEALTHY" | tr '\n' ' ')"
    FAIL=1
fi

# Informational: a tenant's containers are not part of the baseline, but a
# tenant that vanished during a platform action is worth seeing immediately.
TENANT_COUNT=$(printf '%s\n' "$RUNNING" | grep -c '^app-' || true)
echo "  · tenant containers alongside: ${TENANT_COUNT} (not part of the baseline)"

echo
if [ "$FAIL" -eq 0 ]; then
    echo "BASELINE INTACT"
else
    echo "BASELINE DEGRADED — this is the stop-everything signal."
fi
exit "$FAIL"
