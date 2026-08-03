#!/usr/bin/env bats

# Traefik / ACME configuration guards.
#
# These all defend one theme: configuration that is silently ignored rather
# than rejected. Each test corresponds to a defect that shipped and went
# unnoticed because nothing failed loudly.

# ---------------------------------------------------------------------------
# Resolver-name contract (#541)
#
# The playbook rendered a config where every router requested `letsencrypt`
# while the file defined only `letsencrypt-http` and `letsencrypt-dns`. A
# router naming an undefined resolver does not degrade — Traefik cannot serve
# TLS for it at all.
# ---------------------------------------------------------------------------

@test "every certresolver referenced in compose is defined in the Traefik template" {
  run bash -c '
    defined=$(awk "/^certificatesResolvers:/{f=1;next} f&&/^[a-zA-Z]/{f=0} f&&/^  [a-zA-Z0-9_-]+:/{gsub(/[ :]/,\"\");print}" platform/edge/traefik.yml.tmpl | sort -u)
    [ -n "$defined" ] || { echo "extracted NO resolver names from the template"; exit 1; }
    raw=$(grep -rhoE "certresolver=[^\"]+" deploy/compose/prod/*.yml | sed "s/certresolver=//" | sort -u)
    [ -n "$raw" ] || { echo "extracted NO certresolver references from compose"; exit 1; }
    referenced=""
    for r in $raw; do
      case "$r" in
        *:-*) referenced="$referenced ${r#*:-}" ;;
        \$*)  echo "defaultless certresolver reference, cannot verify: $r"; exit 1 ;;
        *)    referenced="$referenced $r" ;;
      esac
    done
    referenced=$(echo "$referenced" | tr " " "\n" | sed "s/}$//" | grep -v "^$" | sort -u)
    missing=""
    for r in $referenced; do
      echo "$defined" | grep -qx "$r" || missing="$missing $r"
    done
    [ -z "$missing" ] || { echo "referenced but not defined:$missing"; echo "defined: $defined"; exit 1; }
  '
  [ "$status" -eq 0 ]
}

@test "the Traefik template defines both resolvers the stack uses" {
  run grep -E '^  letsencrypt:' platform/edge/traefik.yml.tmpl
  [ "$status" -eq 0 ]
  run grep -E '^  letsencrypt-dns:' platform/edge/traefik.yml.tmpl
  [ "$status" -eq 0 ]
}

@test "no ansible playbook declares a container or a Traefik static config" {
  # 09-traefik.yml and 10-portainer.yml were deleted: nothing imported them, so
  # they drifted from compose unchecked. Two declarations of one container is
  # what produced the undefined-resolver bug.
  [ ! -f infra/ansible/playbooks/09-traefik.yml ]
  [ ! -f infra/ansible/playbooks/10-portainer.yml ]
  run bash -c 'grep -rlE "certificatesResolvers|container_name:" infra/ansible/playbooks/'
  [ "$status" -ne 0 ]
}

@test "every playbook on disk is imported by bootstrap.yml" {
  # An unimported playbook is one nobody runs and nobody notices rotting.
  run bash -c '
    imported=$(grep -oE "import_tasks:[[:space:]]*[0-9A-Za-z._-]+" infra/ansible/playbooks/bootstrap.yml \
               | sed -E "s/.*[[:space:]]//" | sort -u)
    [ -n "$imported" ] || { echo "no import_tasks found in bootstrap.yml"; exit 1; }
    orphans=""
    for f in infra/ansible/playbooks/[0-9]*.yml; do
      b=$(basename "$f")
      echo "$imported" | grep -qx "$b" || orphans="$orphans $b"
    done
    [ -z "$orphans" ] || { echo "on disk but not import_tasks in bootstrap.yml:$orphans"; exit 1; }
  '
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# ACME_CA_SERVER must be real and required (#537, #543)
# ---------------------------------------------------------------------------

@test "the Traefik template sets caServer on both resolvers" {
  # Without this, ACME_CA_SERVER is inert and both resolvers silently use the
  # Traefik default, which is production Let's Encrypt.
  run bash -c "grep -c 'caServer: \${ACME_CA_SERVER}' platform/edge/traefik.yml.tmpl"
  [ "$status" -eq 0 ]
  [ "$output" -eq 2 ]
}

@test "compose passes no caserver CLI flags" {
  # Traefik's static-config sources are mutually exclusive and the mounted file
  # wins, so these flags were interpolated by Compose and discarded by Traefik.
  # Comment lines excluded: the file documents the removed flags to explain why
  # they are gone, and that prose is not configuration.
  run bash -c 'grep -ihv "^[[:space:]]*#" deploy/compose/prod/*.yml | grep -i "acme.caserver"'
  [ "$status" -ne 0 ]
}

@test "compose gives ACME_CA_SERVER no default anywhere" {
  # The staging default meant a deploy without secrets silently replaced every
  # certificate with an untrusted one.
  run bash -c 'grep -hv "^[[:space:]]*#" deploy/compose/prod/*.yml | grep -E "ACME_CA_SERVER:-"'
  [ "$status" -ne 0 ]
}

@test "compose mounts the generated config, not the template" {
  run grep -F 'traefik.generated.yml}:/etc/traefik/traefik.yml:ro' deploy/compose/prod/docker-compose.infra.yml
  [ "$status" -eq 0 ]
}

@test "the generated config is gitignored and not committed" {
  run bash -c 'git ls-files --error-unmatch platform/edge/traefik.generated.yml 2>/dev/null'
  [ "$status" -ne 0 ]
  run grep -F 'platform/edge/traefik.generated.yml' .gitignore
  [ "$status" -eq 0 ]
}

@test "render refuses an unset ACME_CA_SERVER" {
  run env -u ACME_CA_SERVER TRAEFIK_CONFIG_OUTPUT=/tmp/bats_t1.yml bash scripts/render-traefik-config.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *"has no default"* ]]
  [ ! -f /tmp/bats_t1.yml ]
}

@test "render refuses an empty ACME_CA_SERVER" {
  run env ACME_CA_SERVER= TRAEFIK_CONFIG_OUTPUT=/tmp/bats_t2.yml bash scripts/render-traefik-config.sh
  [ "$status" -ne 0 ]
  [ ! -f /tmp/bats_t2.yml ]
}

@test "render rejects a value that is not an ACME directory URL" {
  run env ACME_CA_SERVER=https://example.com TRAEFIK_CONFIG_OUTPUT=/tmp/bats_t3.yml bash scripts/render-traefik-config.sh
  [ "$status" -ne 0 ]
}

@test "render warns loudly when staging is selected" {
  run env ACME_CA_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory \
      TRAEFIK_CONFIG_OUTPUT=/tmp/bats_t4.yml bash scripts/render-traefik-config.sh
  [ "$status" -eq 0 ]
  [[ "$output" == *"STAGING"* ]]
  [[ "$output" == *"UNTRUSTED"* ]]
  rm -f /tmp/bats_t4.yml
}

@test "render substitutes the CA into both resolvers and leaves no placeholder" {
  run env ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory \
      TRAEFIK_CONFIG_OUTPUT=/tmp/bats_t5.yml bash scripts/render-traefik-config.sh
  [ "$status" -eq 0 ]
  run bash -c "grep -c 'caServer: https://acme-v02.api.letsencrypt.org/directory' /tmp/bats_t5.yml"
  [ "$output" -eq 2 ]
  run bash -c "grep -v '^[[:space:]]*#' /tmp/bats_t5.yml | grep -c '\\\${'"
  [ "$output" -eq 0 ]
  rm -f /tmp/bats_t5.yml
}

@test "rendered config is valid YAML with both resolvers carrying a caServer" {
  env ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory \
      TRAEFIK_CONFIG_OUTPUT=/tmp/bats_t6.yml bash scripts/render-traefik-config.sh >/dev/null 2>&1
  run python3 -c "
import yaml
d=yaml.safe_load(open('/tmp/bats_t6.yml'))
r=d['certificatesResolvers']
assert set(r)=={'letsencrypt','letsencrypt-dns'}, r.keys()
for name,v in r.items():
    assert v['acme']['caServer'].startswith('https://'), name
"
  [ "$status" -eq 0 ]
  rm -f /tmp/bats_t6.yml
}

@test "deploy.sh renders the config on both the vault and SOPS paths" {
  # The SOPS path runs inside `sops exec-env '<cmd>'`, a new shell, so the call
  # must break out of the single quotes to interpolate SCRIPT_DIR.
  # Count INVOCATIONS, not mentions: a prose reference in a comment is not a
  # call, and counting them made this fail when the guards were documented.
  run bash -c 'grep -cE "bash .*render-traefik-config[.]sh" scripts/deploy.sh'
  [ "$output" -eq 2 ]
  run grep -F "bash '\"\$SCRIPT_DIR\"'/render-traefik-config.sh" scripts/deploy.sh
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Deploy-path failure propagation
#
# The original fix rendered the config correctly and still would have taken the
# stack down, because the SOPS path ignored the render's exit status.
# ---------------------------------------------------------------------------

@test "the SOPS deploy path sets -e so a failed render aborts it" {
  # `sops exec-env` runs its command in a NEW shell that does not inherit
  # deploy.sh's `set -e`, and exec-env returns 0 regardless of what the command
  # did. Without `set -e` inside the string, a failed render is swallowed and
  # `docker compose up` runs anyway — mounting a config that does not exist,
  # which Docker materialises as a DIRECTORY, which stops Traefik and takes
  # every routed service down while the deploy reports success.
  run bash -c "sed -n '/_deploy_infra_with_sops() {/,/^    }\$/p' scripts/deploy.sh | grep -c '^            set -e\$'"
  [ "$output" -eq 1 ]
}

@test "both deploy paths preflight the rendered config before compose up" {
  run bash -c 'grep -cE "bash .*preflight-edge[.]sh" scripts/deploy.sh'
  [ "$output" -eq 2 ]
  run bash -c '
    pf=$(grep -nE "bash .*preflight-edge[.]sh" scripts/deploy.sh | cut -d: -f1 | tr "\n" " ")
    up=$(grep -n "up -d --force-recreate" scripts/deploy.sh | cut -d: -f1 | tr "\n" " ")
    set -- $pf; p1=$1; p2=$2
    set -- $up; u1=$1; u2=$2
    [ "$p1" -lt "$u1" ] && [ "$p2" -lt "$u2" ]
  '
  [ "$status" -eq 0 ]
}

@test "a failed render does not destroy an existing good config" {
  # `>` truncates before sed runs, so writing straight to the output would leave
  # a zero-byte file that compose would happily mount.
  out=/tmp/bats_atomic.yml
  echo "PREEXISTING GOOD CONFIG" > "$out"
  run env ACME_CA_SERVER='https://a|b/directory' TRAEFIK_CONFIG_OUTPUT="$out" bash scripts/render-traefik-config.sh
  [ "$status" -ne 0 ]
  run cat "$out"
  [ "$output" = "PREEXISTING GOOD CONFIG" ]
  rm -f "$out"
}

@test "render clears a directory left at the output path" {
  out=/tmp/bats_dir_out.yml
  rm -rf "$out"; mkdir -p "$out"
  run env ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory TRAEFIK_CONFIG_OUTPUT="$out" bash scripts/render-traefik-config.sh
  [ "$status" -eq 0 ]
  [ -f "$out" ]
  rm -f "$out"
}

@test "ACME_REQUIRE_PRODUCTION refuses a staging CA" {
  # The CA comes from the secrets store, which overrides anything the caller
  # exports. This flag is not a secret, so the store cannot override it.
  out=/tmp/bats_req.yml; rm -f "$out"
  run env ACME_REQUIRE_PRODUCTION=1 ACME_CA_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory TRAEFIK_CONFIG_OUTPUT="$out" bash scripts/render-traefik-config.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *"STAGING"* ]]
  [ ! -f "$out" ]
}

@test "ACME_REQUIRE_PRODUCTION allows a production CA" {
  out=/tmp/bats_req2.yml
  run env ACME_REQUIRE_PRODUCTION=1 ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory TRAEFIK_CONFIG_OUTPUT="$out" bash scripts/render-traefik-config.sh
  [ "$status" -eq 0 ]
  rm -f "$out"
}

@test "no deploy path exports ACME_CA_SERVER, which the secrets store overrides" {
  # Makefile and deploy-infra.yml used to export it. Both `sops exec-env` and
  # the `set -a; source` in _common.sh replace a caller-set value, so those
  # exports chose nothing while appearing to.
  run bash -c 'grep -nE "^[^#]*ACME_CA_SERVER=" Makefile .github/workflows/deploy-infra.yml'
  [ "$status" -ne 0 ]
  run grep -F 'ACME_REQUIRE_PRODUCTION=1' Makefile
  [ "$status" -eq 0 ]
  run grep -F 'ACME_REQUIRE_PRODUCTION=1' .github/workflows/deploy-infra.yml
  [ "$status" -eq 0 ]
}

@test "preflight rejects a missing, empty, or directory config" {
  rm -rf /tmp/bats_pf; mkdir -p /tmp/bats_pf
  run env TRAEFIK_CONFIG_OUTPUT=/tmp/bats_pf/missing.yml bash scripts/preflight-edge.sh
  [ "$status" -ne 0 ]
  : > /tmp/bats_pf/empty.yml
  run env TRAEFIK_CONFIG_OUTPUT=/tmp/bats_pf/empty.yml bash scripts/preflight-edge.sh
  [ "$status" -ne 0 ]
  mkdir -p /tmp/bats_pf/adir.yml
  run env TRAEFIK_CONFIG_OUTPUT=/tmp/bats_pf/adir.yml bash scripts/preflight-edge.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *"DIRECTORY"* ]]
  rm -rf /tmp/bats_pf
}

@test "preflight accepts a correctly rendered config" {
  out=/tmp/bats_pf_ok.yml
  env ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory TRAEFIK_CONFIG_OUTPUT="$out" bash scripts/render-traefik-config.sh >/dev/null 2>&1
  run env TRAEFIK_CONFIG_OUTPUT="$out" bash scripts/preflight-edge.sh
  [ "$status" -eq 0 ]
  rm -f "$out"
}

# ---------------------------------------------------------------------------
# tailscale-only allowlist scope
#
# Same family as the rest of this file: a rule that is silently permissive
# rather than loudly wrong. An allowlist entry that admits more than it names
# reads as a working control while narrowing nothing.
# ---------------------------------------------------------------------------

@test "tailscale-only allows only the Tailscale CGNAT range" {
  # This asserted an exact match on the CGNAT range alone until 2026-07-27,
  # when enforcing that took every admin surface to 403: Docker rewrites some
  # Tailscale traffic to the bridge gateway, so the exception is load-bearing.
  # The guard is kept but narrowed — nothing may appear here except those two.
  run bash -c '
    python3 - <<PY
import sys, yaml
d = yaml.safe_load(open("platform/edge/dynamic/middlewares.yml"))
rng = set(d["http"]["middlewares"]["tailscale-only"]["ipWhiteList"]["sourceRange"])
allowed = {"100.64.0.0/10"}
if "100.64.0.0/10" not in rng:
    print("tailscale-only is missing the CGNAT range:", sorted(rng)); sys.exit(1)
extra = rng - allowed
if extra:
    print("tailscale-only carries undocumented CIDRs:", sorted(extra)); sys.exit(1)
PY
  '
  [ "$status" -eq 0 ]
}

@test "tailscale-only carries no bridge, private or loopback CIDR" {
  # Removing the bridge gateway entirely 403'd every admin surface on
  # 2026-07-27 — Docker rewrites some Tailscale traffic to it, so it is
  # load-bearing until the source rewrite itself is fixed. It remains a weak
  # control: once a source is rewritten the address says nothing about origin.
  # So the single documented exception is tolerated and everything else is not.
  run bash -c '
    body=$(sed -n "/tailscale-only:/,/^    [a-z]/p" platform/edge/dynamic/middlewares.yml | grep -v "^[[:space:]]*#")
    echo "$body" | grep -E "\"(172\.|10\.|192\.168\.|127\.|0\.0\.0\.0)" && exit 1
    exit 0
  '
  [ "$status" -eq 0 ]
}

@test "no admin route relies on basic auth alone for network scoping" {
  # portainer, grafana and vault use tailscale-only WITHOUT auth@file, so the
  # allowlist is their only network control. That is fine, but it means the
  # allowlist must actually be narrow — which is what the two tests above check.
  run bash -c 'grep -h "middlewares=" deploy/compose/prod/*.yml deploy/compose/overrides/*.yml | grep -c "tailscale-only@file"'
  [ "$status" -eq 0 ]
  [ "$output" -ge 4 ]
}
