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
    referenced=$(grep -rhoE "certresolver=\\\$\{[A-Z_]+:-[a-z0-9-]+\}|certresolver=[a-z0-9-]+" deploy/compose/prod/*.yml \
      | sed -E "s/.*:-//; s/\}$//; s/certresolver=//" | sort -u)
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
    orphans=""
    for f in infra/ansible/playbooks/[0-9]*.yml; do
      b=$(basename "$f")
      grep -q "$b" infra/ansible/playbooks/bootstrap.yml || orphans="$orphans $b"
    done
    [ -z "$orphans" ] || { echo "not imported by bootstrap.yml:$orphans"; exit 1; }
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
  run bash -c 'grep -c "render-traefik-config.sh" scripts/deploy.sh'
  [ "$output" -eq 2 ]
  run grep -F "bash '\"\$SCRIPT_DIR\"'/render-traefik-config.sh" scripts/deploy.sh
  [ "$status" -eq 0 ]
}
