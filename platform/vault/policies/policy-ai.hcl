# AI service policy — read-only access to AI secrets and shared model-router token
path "secret/data/ai/*" {
  capabilities = ["read"]
}

path "secret/metadata/ai/*" {
  capabilities = ["read", "list"]
}

# Shared model-router internal service token (for verifying revocation requests from API)
path "secret/data/shared/model-router" {
  capabilities = ["read"]
}

path "secret/metadata/shared/model-router" {
  capabilities = ["read"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
