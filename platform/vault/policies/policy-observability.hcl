# Observability service policy. TIGHTENED 2026-08-03 from a wildcard to the single declared path.
#
# EXACTLY the paths vault_paths_for_service() declares for `observability` in
# scripts/_common.sh — no wildcard. An over-grant is a quieter problem than an
# under-grant, not a smaller one: it fails no deploy and shows up in no outage.

path "secret/data/observability/grafana" {
  capabilities = ["read"]
}

path "secret/metadata/observability/grafana" {
  capabilities = ["read"]
}

# Every AppRole token needs these two to stay alive and to introspect itself.
path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
