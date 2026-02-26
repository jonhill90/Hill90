# OIDC admin policy — assigned to Keycloak users with admin realm role
# Full secrets access via vault UI. Separate from policy-admin to allow
# independent scoping of human vs break-glass access.

path "secret/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

path "sys/policy/*" {
  capabilities = ["read", "list"]
}

path "sys/mounts" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
