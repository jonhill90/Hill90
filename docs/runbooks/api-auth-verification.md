# API Runtime Verification Auth Procedure

How to verify API authentication is working correctly after deployment.

## Quick Health Check

```bash
# Public endpoint (no auth)
curl -s https://api.hill90.com/health | jq .

# Expected: {"status":"healthy","service":"api"}
```

## JWT Verification

### Get a Token

Use the Keycloak password grant (requires `directAccessGrants` enabled on the client):

```bash
TOKEN=$(curl -s -X POST "https://auth.hill90.com/realms/hill90/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=hill90-ui&client_secret=$KC_SECRET&username=$USER&password=$PASS" \
  | jq -r .access_token)
```

Or extract from browser: DevTools → Network → any API request → Authorization header.

### Test Protected Endpoint

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://api.hill90.com/me | jq .
```

Expected: JWT claims including `sub`, `realm_roles`, `email`.

### Test Admin Endpoint

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://api.hill90.com/agents | jq length
```

Expected: number of agents (requires `user` role).

### Test Role Enforcement

```bash
# Should return 403 for non-admin users
curl -s -H "Authorization: Bearer $USER_TOKEN" \
  -X POST https://api.hill90.com/agents/UUID/start
```

## Ed25519 JWT Verification (Agent Tokens)

Agent tokens use Ed25519 (EdDSA) signing for AKM and model-router auth.

### Verify Key Loading

```bash
ssh deploy@remote.hill90.com "docker logs api 2>&1 | grep -i 'AKM.*token\|model.*router.*token' | tail -5"
```

If you see `DECODER routines::unsupported`, the PEM key has literal `\n` instead of real newlines. Fixed in PR #484.

### Verify Agent Tokens Are Issued

```bash
ssh deploy@remote.hill90.com "docker logs api 2>&1 | grep 'token_issued' | tail -3"
```

Should show `akm_jti` and `model_router_jti` for each agent start.

### Verify AKM Token Refresh

```bash
ssh deploy@remote.hill90.com "docker logs agentbox-AGENT-SLUG 2>&1 | grep 'refresh' | tail -3"
```

Should show `AKM token refresh loop started` and periodic refresh messages.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| 401 on all endpoints | Token expired or Keycloak down | Check Keycloak health, get fresh token |
| 403 on admin endpoints | User lacks admin role | Check Keycloak roles |
| Agent start has `akm_jti: null` | Ed25519 key decode failure | Check for literal `\n` in PEM key env var |
| Knowledge tools 401 after 1h | AKM token expired, refresh failing | Check refresh loop logs, restart agent |
| `DECODER routines::unsupported` | PEM key newline issue | Apply `.replace(/\\n/g, '\n')` fix (PR #484) |
