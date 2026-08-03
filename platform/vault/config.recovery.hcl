# OpenBao server configuration — RECOVERY ONLY. Not the production config.
#
# Identical to config.hcl except for ONE listener parameter, which re-enables the
# unauthenticated root-generation endpoints so root can be minted from the unseal
# key on a vault whose root token has been revoked.
#
# WHEN THIS IS CORRECT
# ====================
# Only when the vault is unadministrable: no valid root token, no sudo-capable
# token, and something that must be configured — the 2026-08-02 state, where the
# OIDC auth method was missing and nothing could add it. Selected deliberately at
# deploy time via VAULT_CONFIG_FILE (docker-compose.vault.yml already supports
# this, the same mechanism config.raft.hcl uses). An unset environment deploys
# config.hcl, so merging this file changes nothing on its own.
#
# WHAT IT COSTS WHILE ACTIVE
# ==========================
# With the flag false, ANY caller who can reach the listener AND holds an unseal
# key share can mint a root token WITHOUT presenting any token. Here the
# threshold is 1 of 1, so one share is the whole gate. The listener is on
# hill90_edge and hill90_internal, and Traefik fronts it behind
# tailscale-only@file — but "reachable only from the tailnet" is a smaller claim
# than "requires a credential", and this is the difference.
#
# So it is reverted immediately, not left. `.github/workflows/vault-regain-root.yml`
# deploys this, mints the token and redeploys config.hcl in one run, and asserts
# the endpoint is closed again before it reports success. Do not deploy this file
# by hand and intend to revert it later.
#
# WHY THE FLAG IS IN THE LISTENER STANZA
# ======================================
# Because that is the only place OpenBao 2.6.1 reads it, and getting this wrong
# is silent. At top level the key is ACCEPTED AND IGNORED — a server started with
# `disable_unauthed_generate_root_endpoints = "not-a-bool"` at top level boots
# happily; the same value inside `listener` refuses to boot with
# `invalid value for disable_unauthed_generate_root_endpoints`. That parser
# difference is the positive control proving this placement is the live one, and
# it is very likely why the 2026-07-26 attempt "with the flag set at listener and
# at top level" was recorded as a failure.
#
# Proven end to end against a throwaway OpenBao 2.6.1 before this file was
# written — see docs/decisions/stage2b-oidc-blocked-2026-08-02.md.

ui = true
disable_mlock = true

storage "file" {
  path = "/openbao/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1

  # THE ONE DIFFERENCE FROM config.hcl.
  disable_unauthed_generate_root_endpoints = false
}

api_addr         = "https://vault.hill90.com"
default_lease_ttl = "1h"
max_lease_ttl     = "24h"
