#!/usr/bin/env bats

# POSITIVE CONTROL for platform/observability/prometheus/alerts.yml — the
# absence-blindness fixes from h#789's sweep.
#
# tests/prometheus/alerts_test.yml (promtool) proves the rules actually FIRE
# (real alert_rule_test cases, not just expression evaluation) using the
# rule text loaded straight from alerts.yml — for CertificateCountDropped
# that only became possible once its `for:` moved from 2h to 15m (see
# below); before that, alert_rule_test could never observe FIRING state
# from a single step change no matter what the expression said. This file
# is a second, independent instrument: it greps the ACTUAL committed rule
# text, so a future edit that reverts either fix (the expression or the
# `for:` duration) fails here even if nobody touches the promtool fixture.

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

@test "THE ASSERTION THAT MATTERS: CertificateCountDropped's for: is inside the window its offset comparison can sustain" {
  # `for: 2h` against `offset 1h` meant this rule could never fire at all —
  # not on a total wipeout, not on the partial drop it was written for. A
  # fix that made the expression absence-safe without also fixing this
  # would report success while leaving the rule exactly as unable to fire
  # as before. `for: 15m` is comfortably inside the ~1h window the
  # comparison can actually sustain.
  run bash -c "grep -A6 'alert: CertificateCountDropped' $ALERTS | grep -F 'for: 15m'"
  [ "$status" -eq 0 ]
  run bash -c "grep -A6 'alert: CertificateCountDropped' $ALERTS | grep -F 'for: 2h'"
  [ "$status" -ne 0 ]
}

@test "the deliberate asymmetry between the two absence guards is stated, not left to look like inconsistency" {
  # Loki's guard is a level detector (absent() stays true for as long as
  # the metric is gone); the certificate guard is an edge detector bounded
  # by offset 1h. Two different absence shapes, two different mechanisms —
  # recorded so it reads as a choice.
  run bash -c "grep -B15 'alert: CertificateCountDropped' $ALERTS | grep -F 'DELIBERATE ASYMMETRY'"
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
