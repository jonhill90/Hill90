#!/usr/bin/env bats

# POSITIVE CONTROL for scripts/checks/check_edge_middlewares.py.
#
# The check guards the only thing standing between five admin routers —
# traefik, portainer, grafana, vault, minio-console — and the public
# internet: the `tailscale-only` IP allowlist. Its logic is careful, and it
# already refuses to pass vacuously on zero inputs. What it did not have was
# any demonstration that it goes RED. h#796.
#
# That gap matters more here than the code quality suggests. A check whose
# green has never been observed to mean anything is the shape this estate
# found four times in one day, and this one guards a security control whose
# failure mode is silent by construction: Traefik resolves middleware
# references at request time, so a router pointing at a middleware that does
# not exist still loads and still serves.
#
# Every arm below mutates a COPY of the real tree and requires red. The
# three properties are exercised separately, because a control that only
# proves "some mutation fails" cannot tell you which property is live.

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CTL="$BATS_TEST_TMPDIR/ctl"
  mkdir -p "$CTL/scripts/checks" "$CTL/platform/edge/dynamic" "$CTL/deploy/compose/prod"
  cp "$ROOT/scripts/checks/check_edge_middlewares.py" "$CTL/scripts/checks/"
  cp "$ROOT/platform/edge/dynamic/middlewares.yml" "$CTL/platform/edge/dynamic/"
  cp "$ROOT"/deploy/compose/prod/*.yml "$CTL/deploy/compose/prod/"
  CHECK="$CTL/scripts/checks/check_edge_middlewares.py"
  MW="$CTL/platform/edge/dynamic/middlewares.yml"
  INFRA="$CTL/deploy/compose/prod/docker-compose.infra.yml"
}

@test "CONTROL: passes on the real, unmutated tree" {
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
}

@test "CONTROL: it reports real counts, not zeros" {
  # A 0-definitions/0-chains run would satisfy every loop below by having
  # nothing to iterate. The check already refuses that case explicitly; this
  # asserts the control itself is running against real material.
  run python3 "$CHECK"
  [ "$status" -eq 0 ]
  [[ "$output" != *"Middlewares defined: 0"* ]]
  [[ "$output" != *"Router chains found: 0"* ]]
}

# PROPERTY 1 — a reference that resolves to nothing.
#
# The real hazard, in the check's own words: Traefik resolves references at
# REQUEST time, so this does not fail to load. The router is present and the
# protection is not.
@test "THE ASSERTION THAT MATTERS: a router referencing a middleware that does not exist is caught" {
  python3 - "$INFRA" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace("tailscale-only@file", "tailscale-onlyy@file")
assert t2 != t, "mutation did not apply — the label shape changed"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"tailscale-onlyy"* ]]
}

# PROPERTY 2 — the v2/v3 rename. The check calls this the hazard worth the
# most, because the definition stops being recognised on exactly the routers
# whose entire protection it is, and they keep serving.
#
# THE MUTATION DIRECTION MATTERS, and getting it backwards nearly produced a
# false finding against the check itself. Traefik is pinned at v2.11 today,
# so `ipWhiteList` is the CORRECT key for this repo right now — mutating
# ipAllowList -> ipWhiteList changes nothing real (the file already uses
# ipWhiteList; a naive sed only ever touches an occurrence inside a comment)
# and the check has nothing to catch. The actual hazard the check's own
# docstring names is the other direction: the image gets bumped to v3 and
# nobody renames the middleware key, so a definition that used to be correct
# stops being recognised — silently, on exactly the routers whose whole
# protection it is. So this mutates the PIN, not the key: bump
# docker-compose.infra.yml's `traefik:v2.11` to `traefik:v3.0` and leave
# ipWhiteList exactly as it is in production today.
@test "THE ASSERTION THAT MATTERS: a v2 ipWhiteList left in place under a v3 pin is caught" {
  python3 - "$INFRA" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace("image: traefik:v2.11", "image: traefik:v3.0")
assert t2 != t, "mutation did not apply — the pin was not traefik:v2.11"
open(p, "w").write(t2)
PY

  # Sanity check the premise the mutation depends on: the real file must
  # still use ipWhiteList (the v2 key), or this arm proves nothing.
  run bash -c "grep -F 'ipWhiteList' '$MW'"
  [ "$status" -eq 0 ]

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"ipWhiteList"* ]]
  [[ "$output" == *"v3"* ]]
}

# PROPERTY 3 — ordering. Observed in production 2026-07-31: traefik.hill90.com
# answered 401 off-tailnet while every other admin router answered 403.
@test "THE ASSERTION THAT MATTERS: an IP allowlist ordered behind an authenticator is caught" {
  python3 - "$INFRA" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t2 = t.replace("tailscale-only@file,auth@file", "auth@file,tailscale-only@file")
assert t2 != t, "mutation did not apply — the traefik chain is not the expected order"
open(p, "w").write(t2)
PY

  run python3 "$CHECK"
  [ "$status" -eq 1 ]
  [[ "$output" == *"auth"* ]]
}

# Blindness must not read as health. The check already handles this; without
# an arm requiring it, a future edit could remove the guard silently.
@test "an empty middlewares file fails rather than passing vacuously" {
  : > "$MW"

  run python3 "$CHECK"
  [ "$status" -ne 0 ]
  [[ "$output" == *"vacuously"* ]]
}

@test "a missing middlewares file fails rather than passing" {
  rm -f "$MW"

  run python3 "$CHECK"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not found"* ]]
}

# WIRING, not logic (h#736/h#758). Every arm above proves the check's logic.
# None proves anything runs it.
@test "ci.yml genuinely invokes this check, not just mentions it" {
  run grep -nE "run: python3 scripts/checks/check_edge_middlewares.py" \
    "$ROOT/.github/workflows/ci.yml"
  [ "$status" -eq 0 ]
}
