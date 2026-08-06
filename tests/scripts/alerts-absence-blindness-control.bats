#!/usr/bin/env bats

# POSITIVE CONTROL for platform/observability/prometheus/alerts.yml — the
# absence-blindness fixes from h#789's sweep.
#
# tests/prometheus/alerts_test.yml (promtool) proves the FORMULA behaves
# correctly under a total series wipeout, but promql_expr_test evaluates
# whatever expr string is written INTO that test file — it does not read
# the rule's real expr back out of alerts.yml, so on its own it cannot
# prove the committed rule actually contains the fix; a test file that
# still said the old formula would pass the same way a correct one does,
# since promql_expr_test never looks at the real rule. This file closes
# that gap: it greps the ACTUAL rule text in alerts.yml, so a future edit
# that reverts the fix (or never lands it) fails here even if nobody
# touches the promtool fixture. See that file's own header comment for
# why alert_rule_test (which does load the real rule) can't be used
# instead: CertificateCountDropped's for:2h can never be satisfied by a
# single step change given its offset:1h, a separate pre-existing
# property of the rule not touched by this fix.

ALERTS=platform/observability/prometheus/alerts.yml

@test "THE ASSERTION THAT MATTERS: CertificateCountDropped's guard is absence-safe on both sides" {
  # count() over zero matching series is no result, not 0 — `or vector(0)`
  # is what turns a genuinely-vanished side into a real, comparable zero
  # instead of dropping the comparison entirely. Needed on BOTH sides:
  # only guarding the left side still leaves the rule blind if the
  # right side (the offset comparison point) is itself absent.
  run bash -c "grep -A5 'alert: CertificateCountDropped' $ALERTS | grep -c 'or vector(0)'"
  [ "$output" -eq 2 ]
}

@test "CertificateCountDropped's comparison metric is unchanged by the fix" {
  # The fix must not have quietly changed WHAT is being compared.
  run bash -c "grep -A5 'alert: CertificateCountDropped' $ALERTS | grep -c 'count(traefik_tls_certs_not_after'"
  [ "$output" -eq 2 ]
  run bash -c "grep -A5 'alert: CertificateCountDropped' $ALERTS | grep -F 'offset 1h'"
  [ "$status" -eq 0 ]
}

@test "THE ASSERTION THAT MATTERS: LokiIngestionSignalMissing exists and watches the real metric with absent()" {
  run grep -F 'alert: LokiIngestionSignalMissing' "$ALERTS"
  [ "$status" -eq 0 ]
  run bash -c "grep -A3 'alert: LokiIngestionSignalMissing' $ALERTS | grep -F 'expr: absent(loki_distributor_lines_received_total)'"
  [ "$status" -eq 0 ]
}

@test "LokiIngestionSignalMissing's for: is shorter than the Backup/ScheduledWorkflow SignalMissing convention" {
  # Deliberately: this watches a continuously-scraped metric, not a
  # once-nightly textfile heartbeat, so it should not inherit the 6h used
  # elsewhere in this file for that different case.
  run bash -c "grep -A4 'alert: LokiIngestionSignalMissing' $ALERTS | grep -F 'for: 10m'"
  [ "$status" -eq 0 ]
}

@test "LokiIngestionStalled's comment no longer claims blanket ServiceDown coverage" {
  # The exact claim h#789's sweep flagged: it asserted ServiceDown covers
  # the metric-disappears case outright, when ServiceDown watches `up`, a
  # different metric — real coverage there is container-down only.
  run bash -c "grep -B2 'alert: LokiIngestionStalled$' $ALERTS | grep -F 'ServiceDown covers that case'"
  [ "$status" -ne 0 ]
}

@test "LokiIngestionStalled's corrected comment states the real scope of ServiceDown's coverage" {
  run bash -c "grep -B12 'alert: LokiIngestionStalled$' $ALERTS | grep -F 'REAL coverage is container-down'"
  [ "$status" -eq 0 ]
}

@test "ServiceDown records why its own absence-blindness is not a gap" {
  run bash -c "grep -A6 'name: service-health' $ALERTS | grep -A6 'This rule is itself comparison-shaped' | grep -F 'Prometheus synthesises'"
  [ "$status" -eq 0 ]
}
