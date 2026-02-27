# Knowledge service policy — read-only access to knowledge secrets
path "secret/data/knowledge/*" {
  capabilities = ["read"]
}

path "secret/metadata/knowledge/*" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
