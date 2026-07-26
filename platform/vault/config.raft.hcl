# OpenBao server configuration for Hill90 — RAFT (integrated storage) variant.
#
# INERT until selected. docker-compose.vault.yml mounts
# platform/vault/${VAULT_CONFIG_FILE:-config.hcl}, so with no environment set
# production continues to use config.hcl and this file does nothing.
#
# It exists because the `file` backend config.hcl uses is deprecated in
# OpenBao v2.6.0 and REMOVED in v2.7.0 — upstream calls it "a development-only,
# non-production backend". Raft is the supported replacement: production-ready,
# recommended upstream for most cases, and needs no additional software.
#
# Selected by .github/workflows/vault-reinitialize.yml, which sets
# VAULT_CONFIG_FILE=config.raft.hcl and VAULT_DATA_PATH=/openbao/raft. Storage
# cannot be changed on a live vault without either `bao operator migrate` or a
# fresh init, so switching is only free at the moment the volume is wiped —
# which is exactly what that workflow does.
#
# Differences from config.hcl, and only these:
#   - storage "raft" instead of storage "file"
#   - listener gains cluster_address (raft peer traffic)
#   - top-level cluster_addr, required by raft even for a single node
#
# Everything else is identical on purpose. See
# docs/decisions/vault-vs-sops.md, "Decision needed: replacing the `file`
# storage backend". If you change one file, change both.

ui = true
disable_mlock = true

storage "raft" {
  path    = "/openbao/raft"
  node_id = "hill90-vault-1"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_disable     = 1
}

# Required by raft even for a cluster of one. Not published or routed: nothing
# outside the container speaks to 8201 on a single node.
cluster_addr = "http://127.0.0.1:8201"

api_addr         = "https://vault.hill90.com"
default_lease_ttl = "1h"
max_lease_ttl     = "24h"
