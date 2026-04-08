# Secrets admin policy — CRUD access to all KV v2 secrets.
# Attached to the API service AppRole when BAO_TOKEN is provisioned
# for the secrets management UI. Only admin-authenticated UI users
# can trigger these operations (enforced by Express middleware).

path "secret/data/*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "secret/metadata/*" {
  capabilities = ["read", "list", "delete"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
