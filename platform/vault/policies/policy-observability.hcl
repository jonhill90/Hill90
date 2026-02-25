# Observability service policy — read-only access to observability secrets
path "secret/data/observability/*" {
  capabilities = ["read"]
}

path "secret/metadata/observability/*" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
