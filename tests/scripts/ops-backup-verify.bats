#!/usr/bin/env bats
#
# h#748: ops.sh's cmd_backup() — a second, cruder backup path, easily
# confused with the real (now-hardened) backup.sh by name and message shape
# alone ("Hill90 Backup" / "Backup Complete!") — had zero artifact
# verification. `set -e` catches `docker run`/`tar` returning non-zero, but
# not a CLEAN exit that produced an empty or truncated archive (an empty
# volume, a race with something still writing to it, disk full mid-write).
# The function ended unconditionally at "Backup Complete!" regardless of
# what the archives actually contained.
#
# `docker` is stubbed rather than exercised against real named volumes,
# DELIBERATELY: cmd_backup hardcodes real volume names (traefik-certs,
# prometheus-data, grafana-data) with no prefix parameterization, and those
# same names back actual local dev infra on a machine running this stack —
# running the real function against real docker here risks reading or
# clobbering a developer's genuine local volumes. The stub writes bytes (or
# doesn't) directly to the host path docker would have bind-mounted, so the
# archive-emptiness check is exercised against a real file on disk, just
# not through a real container.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"
  WORKDIR="$BATS_TEST_TMPDIR/work"
  mkdir -p "$WORKDIR"
}

# $1 = "clean" | "empty-traefik" | "empty-prometheus"
# Prometheus and Grafana volumes are reported as NOT FOUND unless their name
# appears in $2 (space-separated) — keeps the stub from claiming volumes
# exist that a given test doesn't care about.
make_docker_stub() {
  local mode="$1"
  local present_volumes="${2:-prometheus-data grafana-data}"
  cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
MODE="$mode"
PRESENT="$present_volumes"
args=("\$@")

if [ "\${args[0]}" = "volume" ] && [ "\${args[1]}" = "inspect" ]; then
  vol="\${args[2]}"
  for p in \$PRESENT; do
    [ "\$p" = "\$vol" ] && exit 0
  done
  exit 1
fi

if [ "\${args[0]}" = "run" ]; then
  # Find "-v <host>:/backup" and the archive name in "tar czf /backup/X.tar.gz"
  host_backup=""
  archive=""
  for i in "\${!args[@]}"; do
    case "\${args[\$i]}" in
      *:/backup) host_backup="\${args[\$i]%:/backup}" ;;
      /backup/*.tar.gz) archive="\$(basename "\${args[\$i]}")" ;;
    esac
  done
  case "\$MODE" in
    empty-traefik)
      [ "\$archive" = "traefik-certs.tar.gz" ] && { : > "\$host_backup/\$archive"; exit 0; }
      ;;
    empty-prometheus)
      [ "\$archive" = "prometheus-data.tar.gz" ] && { : > "\$host_backup/\$archive"; exit 0; }
      ;;
  esac
  printf 'fake tar bytes for %s\n' "\$archive" > "\$host_backup/\$archive"
  exit 0
fi
exit 0
EOF
  chmod +x "$STUB/docker"
}

run_backup() {
  cd "$WORKDIR"
  # shellcheck disable=SC1091
  source "$ROOT/scripts/ops.sh" help >/dev/null 2>&1
  cmd_backup
}

@test "clean run: all volumes present with real content — Backup Complete, no die" {
  make_docker_stub "clean"
  run run_backup
  [ "$status" -eq 0 ]
  [[ "$output" == *"Backup Complete!"* ]]
  # The materially-incomplete-vs-backup.sh note is now surfaced, not silent.
  [[ "$output" == *"does NOT back up any database"* ]]
}

@test "THE CASE THAT MATTERS: a clean docker exit with an EMPTY traefik-certs archive is refused, not reported as Backup Complete!" {
  make_docker_stub "empty-traefik"
  run run_backup
  [ "$status" -ne 0 ]
  [[ "$output" == *"Backup produced an empty archive"* ]]
  [[ "$output" == *"traefik-certs.tar.gz"* ]]
  [[ "$output" != *"Backup Complete!"* ]]
}

@test "an empty PROMETHEUS archive is also refused, distinct from the traefik case" {
  make_docker_stub "empty-prometheus"
  run run_backup
  [ "$status" -ne 0 ]
  [[ "$output" == *"Backup produced an empty archive"* ]]
  [[ "$output" == *"prometheus-data.tar.gz"* ]]
  [[ "$output" != *"Backup Complete!"* ]]
}

@test "an ABSENT optional volume (prometheus/grafana not found) is correctly skipped, not treated as an empty-archive failure" {
  make_docker_stub "clean" "grafana-data"
  run run_backup
  [ "$status" -eq 0 ]
  [[ "$output" == *"Skipping Prometheus backup (volume not found)"* ]]
  [[ "$output" == *"Backup Complete!"* ]]
  [[ "$output" != *"Backup produced an empty archive"* ]]
}

@test "the real traefik-certs archive file left on disk genuinely has content in the clean case" {
  make_docker_stub "clean"
  run_backup >/dev/null 2>&1
  local dir
  dir=$(find "$WORKDIR/backups" -mindepth 1 -maxdepth 1 -type d | head -1)
  [ -s "$dir/traefik-certs.tar.gz" ]
}

@test "the empty traefik-certs archive file genuinely IS empty on disk — the die is not testing a phantom" {
  make_docker_stub "empty-traefik"
  run run_backup
  local dir
  dir=$(find "$WORKDIR/backups" -mindepth 1 -maxdepth 1 -type d | head -1)
  [ -f "$dir/traefik-certs.tar.gz" ]
  [ ! -s "$dir/traefik-certs.tar.gz" ]
}
