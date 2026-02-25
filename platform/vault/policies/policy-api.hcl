# API service policy — read-only access to shared and API secrets
path "secret/data/shared/*" {
  capabilities = ["read"]
}

path "secret/metadata/shared/*" {
  capabilities = ["read", "list"]
}

path "secret/data/api/*" {
  capabilities = ["read"]
}

path "secret/metadata/api/*" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
