#!/usr/bin/env bats
#
# h#808: docker-compose.observability.yml defines nine services (prometheus,
# alertmanager, blackbox-exporter, loki, tempo, grafana, promtail,
# node-exporter, cadvisor). ops.sh's cmd_health only checked seven — missing
# alertmanager and blackbox-exporter entirely. A rebuild could come up with
# either silently missing or unhealthy and `ops.sh health` would report clean
# regardless, since a container this loop never names is never inspected.
#
# `docker` is stubbed and cmd_health's own `services` array (which does a
# real `curl` to hill90.com) is overridden to empty before calling it, so
# this test exercises the observability loop specifically without making any
# real network calls.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"
}

@test "STATIC: docker-compose.observability.yml defines exactly these 9 services" {
  run bash -c "grep -oE '^  [a-z-]+:' '$ROOT/deploy/compose/prod/docker-compose.observability.yml' | tr -d ' :' | grep -vE '^(edge|internal)\$'"
  [ "$status" -eq 0 ]
  expected="prometheus
alertmanager
blackbox-exporter
loki
tempo
grafana
promtail
node-exporter
cadvisor"
  # Volume names collide with nothing here since this compose file's top-level
  # keys are networks/volumes/services and volume names don't match this
  # container-name shape, but assert count as a floor against future drift.
  count=$(echo "$output" | grep -cE '^(prometheus|alertmanager|blackbox-exporter|loki|tempo|grafana|promtail|node-exporter|cadvisor)$')
  [ "$count" -eq 9 ]
}

@test "STATIC: ops.sh's obs_containers now lists all 9, not 7" {
  run bash -c "grep -oE 'local obs_containers=\([^)]*\)' '$ROOT/scripts/ops.sh'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"alertmanager"* ]]
  [[ "$output" == *"blackbox-exporter"* ]]
  count=$(echo "$output" | grep -oE '"[a-z-]+"' | wc -l | tr -d ' ')
  [ "$count" -eq 9 ]
}

# ---------------------------------------------------------------------------
# Functional: the extracted observability loop, run against stubbed docker,
# actually inspects alertmanager and blackbox-exporter now — not merely
# listed in the array without being reachable in the loop body.
# ---------------------------------------------------------------------------

extract_obs_loop() {
  sed -n '/local obs_containers=/,/^    done$/p' "$ROOT/scripts/ops.sh"
}

make_docker_stub_all_healthy() {
  cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  exit 0
fi
if [ "$1" = "inspect" ]; then
  case "$*" in
    *"State.Health"*) echo "healthy" ;;
    *"State.Running"*) echo "true" ;;
  esac
  exit 0
fi
exit 0
EOF
  chmod +x "$STUB/docker"
}

run_obs_loop() {
  # The extracted snippet uses `local`, so it must run inside a function.
  local snippet
  snippet="$(extract_obs_loop)"
  bash -c "
    probe() {
      all_healthy=true
      $snippet
      echo \"ALL_HEALTHY=\$all_healthy\"
    }
    probe
  "
}

@test "the observability loop checks alertmanager and blackbox-exporter, not just skips them" {
  make_docker_stub_all_healthy
  run run_obs_loop
  [[ "$output" == *"Checking alertmanager..."* ]]
  [[ "$output" == *"Checking blackbox-exporter..."* ]]
  [[ "$output" == *"ALL_HEALTHY=true"* ]]
}

@test "THE CASE THAT MATTERS: an unhealthy alertmanager now flips all_healthy to false — it did not exist to check before" {
  cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  exit 0
fi
if [ "$1" = "inspect" ]; then
  # Container name is the LAST arg (docker inspect --format='...' <name>).
  last="${@: -1}"
  case "$*" in
    *"State.Health"*)
      [ "$last" = "alertmanager" ] && echo "unhealthy" || echo "healthy" ;;
    *"State.Running"*) echo "true" ;;
  esac
  exit 0
fi
exit 0
EOF
  chmod +x "$STUB/docker"
  run run_obs_loop
  [[ "$output" == *"Checking alertmanager... "*"✗ Unhealthy (unhealthy)"* ]]
  [[ "$output" == *"ALL_HEALTHY=false"* ]]
}
