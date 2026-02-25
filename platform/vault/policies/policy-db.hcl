# Database service policy — read-only access to shared database secrets
path "secret/data/shared/database" {
  capabilities = ["read"]
}

path "secret/metadata/shared/database" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
