# UI service policy — read-only access to UI secrets
path "secret/data/ui/*" {
  capabilities = ["read"]
}

path "secret/metadata/ui/*" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
