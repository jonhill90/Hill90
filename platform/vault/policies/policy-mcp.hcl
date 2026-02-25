# MCP service policy — read-only access to MCP secrets
path "secret/data/mcp/*" {
  capabilities = ["read"]
}

path "secret/metadata/mcp/*" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
