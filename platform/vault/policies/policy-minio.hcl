# MinIO service policy — read-only access to MinIO secrets
path "secret/data/minio/*" {
  capabilities = ["read"]
}

path "secret/metadata/minio/*" {
  capabilities = ["read", "list"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
