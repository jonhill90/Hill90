# AI service policy — read-only access to AI secrets
path "secret/data/ai/*" {
  capabilities = ["read"]
}

path "secret/metadata/ai/*" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
