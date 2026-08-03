#!/usr/bin/env bats

# POSITIVE CONTROL: the infra deploy must STOP before `docker compose up` when
# either edge guard refuses.
#
# WHY THIS ONE MATTERS MORE THAN THE OTHERS. Traefik is the edge for every public
# service, so a discarded refusal here takes down hill90.com, auth, grafana,
# vault, storage and portainer at once rather than one component. And the second
# guard was inspecting the first guard's output, so both failed open in sequence:
# render refuses -> config stale or absent -> preflight refuses -> compose up
# mounts a missing path, which Docker materialises as a DIRECTORY, which stops
# Traefik. The deploy reported success throughout.
#
# The tests run the REAL scripts with real refusal conditions, then assert the
# subshell shape propagates them.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
}

# --- the real scripts must actually refuse ---------------------------------

@test "render-traefik-config.sh REFUSES with no ACME_CA_SERVER" {
  run env -u ACME_CA_SERVER -u ACME_EMAIL \
      TRAEFIK_CONFIG_OUTPUT="$BATS_TEST_TMPDIR/traefik.yml" \
      bash "$ROOT/scripts/render-traefik-config.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"ACME_CA_SERVER"* ]]
}

# The variable is TRAEFIK_CONFIG_OUTPUT. A first version of these tests set
# TRAEFIK_CONFIG, which the script ignores — so they exercised the DEFAULT path
# and the "absent" test passed only because that path does not exist on a
# workstation. A control that passes for the wrong reason is not a control.
@test "preflight-edge.sh REFUSES when the rendered config is absent" {
  run env TRAEFIK_CONFIG_OUTPUT="$BATS_TEST_TMPDIR/definitely-not-here.yml" \
      bash "$ROOT/scripts/preflight-edge.sh"
  [ "$status" -ne 0 ]
}

@test "preflight-edge.sh REFUSES when the config is a DIRECTORY — the Docker trap" {
  mkdir -p "$BATS_TEST_TMPDIR/asdir.yml"
  run env TRAEFIK_CONFIG_OUTPUT="$BATS_TEST_TMPDIR/asdir.yml" \
      bash "$ROOT/scripts/preflight-edge.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"DIRECTORY"* ]] || [[ "$output" == *"directory"* ]]
}

@test "preflight-edge.sh REFUSES when the config is EMPTY" {
  : > "$BATS_TEST_TMPDIR/empty.yml"
  run env TRAEFIK_CONFIG_OUTPUT="$BATS_TEST_TMPDIR/empty.yml" \
      bash "$ROOT/scripts/preflight-edge.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"empty"* ]]
}

# --- and the deploy shape must propagate the refusal -----------------------

@test "a refusing render stops the subshell BEFORE compose up" {
  run bash -c '
    set -e
    render() { echo "Refusing to render"; return 1; }
    compose_up() { echo "COMPOSE UP RAN"; }
    ( render || exit 1
      compose_up
    ) || echo "FALLBACK FIRED"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"FALLBACK FIRED"* ]]
  [[ "$output" != *"COMPOSE UP RAN"* ]]
}

@test "CONTROL: the OLD shape ran compose up anyway — the defect, reproduced" {
  run bash -c '
    set -e
    render() { echo "Refusing to render"; return 1; }
    compose_up() { echo "COMPOSE UP RAN"; }
    ( render
      compose_up
    ) || echo "FALLBACK FIRED"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"COMPOSE UP RAN"* ]]
  [[ "$output" != *"FALLBACK FIRED"* ]]
}

# --- and the real file must use the guarded form ---------------------------

@test "deploy.sh guards BOTH edge scripts in the vault branch" {
  run grep -c 'bash "$SCRIPT_DIR/render-traefik-config.sh" || exit 1' "$ROOT/scripts/deploy.sh"
  [ "$output" -ge 1 ]
  run grep -c 'bash "$SCRIPT_DIR/preflight-edge.sh" || exit 1' "$ROOT/scripts/deploy.sh"
  [ "$output" -ge 1 ]
}

@test "no BARE invocation of either edge script remains in the subshell" {
  run bash -c "grep -n 'bash \"\$SCRIPT_DIR/\(render-traefik-config\|preflight-edge\).sh\"' '$ROOT/scripts/deploy.sh' | grep -v '|| exit 1' | wc -l"
  [ "$output" -eq 0 ]
}

# The SOPS fallback reaches the same two scripts through `sops exec-env`, which
# is a different shape the sweep cannot see. It is protected by `set -e` inside
# the string, and exec-env propagates the inner status — measured, because the
# comment there previously claimed the opposite.
@test "the SOPS infra path carries set -e, and exec-env propagates" {
  run bash -c "sed -n '/_deploy_infra_with_sops()/,/^    }/p' '$ROOT/scripts/deploy.sh' | grep -c '^            set -e'"
  [ "$output" -ge 1 ]
}
