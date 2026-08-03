# Auth (Keycloak) service policy. MISSING until 2026-08-03 — the direct cause of the 43-minute auth outage, which surfaced as "cannot read secret/shared/database - preflight capability check returned 403".
#
# EXACTLY the paths vault_paths_for_service() declares for `auth` in
# scripts/_common.sh — no wildcard. An over-grant is a quieter problem than an
# under-grant, not a smaller one: it fails no deploy and shows up in no outage.

path "secret/data/shared/database" {
  capabilities = ["read"]
}

path "secret/metadata/shared/database" {
  capabilities = ["read"]
}

path "secret/data/auth/config" {
  capabilities = ["read"]
}

path "secret/metadata/auth/config" {
  capabilities = ["read"]
}

# Every AppRole token needs these two to stay alive and to introspect itself.
path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
