# Infrastructure service policy — read-only access to infra secrets
path "secret/data/infra/*" {
  capabilities = ["read"]
}

path "secret/metadata/infra/*" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
