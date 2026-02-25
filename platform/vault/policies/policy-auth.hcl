# Auth service policy — read-only access to shared database and auth secrets
path "secret/data/shared/database" {
  capabilities = ["read"]
}

path "secret/metadata/shared/database" {
  capabilities = ["read", "list"]
}

path "secret/data/auth/*" {
  capabilities = ["read"]
}

path "secret/metadata/auth/*" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
