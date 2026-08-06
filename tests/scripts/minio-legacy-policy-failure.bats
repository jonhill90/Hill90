#!/usr/bin/env bats
#
# h#750: minio.sh's cmd_apply() downgraded a legacy-policy deletion failure
# to a `warn` and still printed the unqualified "Policies provisioned." —
# per this file's own header, MinIO grants the UNION of every claim value
# that names a policy, so a leftover retired policy costs nothing today and
# becomes a real, unrequested grant the moment anyone is later given the
# matching realm role. A caller reading the final banner had no signal that
# might have happened.
#
# `docker` is stubbed (every `mc` call in this file is itself a wrapper
# function around `docker exec ... mc "$@"`, defined at minio.sh:159), so no
# real MinIO or Docker daemon is involved. MINIO_ROOT_USER/PASSWORD are set
# in the environment so secret_for() resolves without touching SOPS.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  PATH="$STUB:$PATH"

  export MINIO_ROOT_USER=testuser
  export MINIO_ROOT_PASSWORD=testpass
  export MINIO_CONTAINER=fake-minio
}

# $1 = space-separated legacy policies that should FAIL to delete (empty = all succeed)
make_docker_stub() {
  local failing="$1"
  cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
FAILING="$failing"
args=("\$@")
# docker inspect \$MINIO_CONTAINER — require_running
if [ "\${args[0]}" = "inspect" ]; then
  exit 0
fi
# docker exec ... \$MINIO_CONTAINER mc <subcommand...>
if [ "\${args[0]}" = "exec" ]; then
  # Find the mc subcommand words after the literal "mc" token.
  mc_idx=-1
  for i in "\${!args[@]}"; do
    if [ "\${args[\$i]}" = "mc" ]; then mc_idx=\$i; break; fi
  done
  rest=("\${args[@]:\$((mc_idx+1))}")
  case "\${rest[0]} \${rest[1]}" in
    "admin info")
      echo '{"info":{"mode":"standalone"}}'
      exit 0
      ;;
    "admin policy")
      case "\${rest[2]}" in
        ls)
          printf 'platform-admin\nplatform-viewer\nadmin\neditor\nviewer\n'
          exit 0
          ;;
        create)
          exit 0
          ;;
        rm)
          policy="\${rest[4]}"
          for f in \$FAILING; do
            if [ "\$f" = "\$policy" ]; then
              echo "mc: <ERROR> Unable to remove policy. policy in use." >&2
              exit 1
            fi
          done
          exit 0
          ;;
      esac
      ;;
  esac
  exit 0
fi
exit 0
EOF
  chmod +x "$STUB/docker"
}

run_apply() {
  cd "$ROOT"
  # shellcheck disable=SC1091
  source scripts/minio.sh >/dev/null 2>&1
  cmd_apply
}

@test "cmd_apply: all legacy deletions succeed — unqualified success, exit 0" {
  make_docker_stub ""
  run run_apply
  [ "$status" -eq 0 ]
  [[ "$output" == *"Policies provisioned."* ]]
  [[ "$output" != *"could not be removed"* ]]
}

@test "cmd_apply: THE CASE THAT MATTERS — one legacy deletion fails, message is qualified and exit is non-zero" {
  make_docker_stub "editor"
  run run_apply
  [ "$status" -ne 0 ]
  [[ "$output" == *"could not be deleted"* ]]
  [[ "$output" == *"Policies provisioned, but 1 legacy polic(ies) could not be removed"* ]]
  [[ "$output" != *$'\n'"Policies provisioned."$'\n'* ]]
}

@test "cmd_apply: multiple legacy deletion failures are all counted, not just the first" {
  make_docker_stub "editor viewer"
  run run_apply
  [ "$status" -ne 0 ]
  [[ "$output" == *"Policies provisioned, but 2 legacy polic(ies) could not be removed"* ]]
}

@test "cmd_apply: a legacy deletion failure does not prevent the real policies from being created" {
  # The creates happen BEFORE the legacy deletions and must not be skipped
  # or rolled back just because cleanup afterward had a problem.
  make_docker_stub "admin"
  run run_apply
  [[ "$output" == *"+ platform-admin"* || "$output" == *"= platform-admin"* ]]
  [[ "$output" == *"+ platform-viewer"* || "$output" == *"= platform-viewer"* ]]
}
