# OpenBao server configuration for Hill90
# Docs: https://openbao.org/docs/configuration

ui = true
disable_mlock = true

storage "file" {
  path = "/openbao/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}

api_addr         = "https://vault.hill90.com"
default_lease_ttl = "1h"
max_lease_ttl     = "24h"
