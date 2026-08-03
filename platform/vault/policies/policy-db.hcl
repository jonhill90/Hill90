# Database service policy. MISSING until 2026-08-03, which is half of the AppRole authorisation gap: cmd_setup binds the db role to policy-db and cmd_policy_apply only writes the .hcl files that exist, so the role carried a policy that did not.
#
# EXACTLY the paths vault_paths_for_service() declares for `db` in
# scripts/_common.sh — no wildcard. An over-grant is a quieter problem than an
# under-grant, not a smaller one: it fails no deploy and shows up in no outage.

path "secret/data/shared/database" {
  capabilities = ["read"]
}

path "secret/metadata/shared/database" {
  capabilities = ["read"]
}

# Every AppRole token needs these two to stay alive and to introspect itself.
path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
