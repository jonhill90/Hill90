# Keycloak & Auth Operations Runbook

**Covers:** AI-94, AI-95, AI-96, AI-116 | **Date:** 2026-04-04

This runbook consolidates four related operational procedures around Keycloak authentication, test user management, and API testing via password grant.

---

## Table of Contents

1. [Realm Admin Password Management](#1-realm-admin-password-management)
2. [Verification User Secrets in Vault](#2-verification-user-secrets-in-vault)
3. [Hardening directAccessGrants](#3-hardening-directaccessgrants)
4. [API Testing via Password Grant](#4-api-testing-via-password-grant)

---

## 1. Realm Admin Password Management

**Linear:** AI-94

### How the Admin Password Works

Keycloak admin credentials are set via `KC_BOOTSTRAP_ADMIN_USERNAME` and `KC_BOOTSTRAP_ADMIN_PASSWORD` environment variables in `deploy/compose/prod/docker-compose.auth.yml`.

**Critical:** `KC_BOOTSTRAP_ADMIN_*` only applies on **first container startup**. Redeploying Keycloak does NOT reset the admin password. If the password was changed in the Keycloak Admin Console, the environment variable is stale.

### Retrieving Current Admin Credentials

```bash
# From SOPS (on Mac)
SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key \
  bash scripts/secrets.sh get infra/secrets/prod.enc.env KC_ADMIN_USERNAME

SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key \
  bash scripts/secrets.sh get infra/secrets/prod.enc.env KC_ADMIN_PASSWORD

# From Vault (on VPS via SSH)
ssh deploy@remote.hill90.com
docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$BAO_TOKEN" openbao \
  bao kv get secret/auth/config
```

### Rotating the Admin Password

**Step 1 — Change in Keycloak:**

1. Open `https://auth.hill90.com/admin`
2. Log in with current KC_ADMIN_USERNAME / KC_ADMIN_PASSWORD
3. Navigate to: Users > admin user > Credentials tab
4. Click "Set Password"
5. Enter new password, toggle "Temporary" OFF
6. Save

**Step 2 — Update SOPS (on Mac):**

```bash
SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key \
  bash scripts/secrets.sh update infra/secrets/prod.enc.env KC_ADMIN_PASSWORD "new-password-here"
```

**Step 3 — Update Vault (on VPS):**

```bash
ssh deploy@remote.hill90.com

# Generate root token (required for kv writes)
# See docs/runbooks/vault-unseal.md for generate-root procedure

docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$ROOT_TOKEN" openbao \
  bao kv patch secret/auth/config KC_ADMIN_PASSWORD="new-password-here"
```

**Step 4 — Commit SOPS change and push:**

```bash
git add infra/secrets/prod.enc.env
git commit -m "ops: rotate KC admin password"
git push
```

### When to Rotate

- After any suspected credential exposure (logs, operator output, screenshots)
- After personnel changes (team member offboarded)
- Quarterly as hygiene practice

---

## 2. Verification User Secrets in Vault

**Linear:** AI-95

### Overview

The verification test user (`testuser01`) is a dedicated account for automated and manual API testing. Its credentials are stored in Vault at `secret/ops/verification` and in SOPS as `TEST_USER_USERNAME` / `TEST_USER_PASSWORD`.

**Safety rule:** NEVER modify jon's account or any real user account for testing. Always use `testuser01`.

### Vault Path

```
secret/ops/verification
  TEST_USER_USERNAME = testuser01
  TEST_USER_PASSWORD = <password>
```

### Creating the Test User in Keycloak

If `testuser01` does not exist yet:

1. Open `https://auth.hill90.com/admin`
2. Select realm: **hill90**
3. Navigate to: Users > Add User
4. Fill required fields:
   - Username: `testuser01`
   - Email: `testuser01@hill90.com`
   - First Name: `Test`
   - Last Name: `User`
   - Email Verified: ON
5. Save
6. Go to Credentials tab > Set Password
   - Enter password, toggle "Temporary" OFF, Save
7. Go to Role Mappings tab
   - Assign realm role: `user`

**Important:** Hill90 realm requires `firstName`, `lastName`, and `email` on all accounts. Omitting these causes "Account is not fully set up" errors on password grant.

### Seeding Credentials to Vault

```bash
ssh deploy@remote.hill90.com

docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$ROOT_TOKEN" openbao \
  bao kv put secret/ops/verification \
    TEST_USER_USERNAME="testuser01" \
    TEST_USER_PASSWORD="the-password-you-set"
```

### Seeding Credentials to SOPS

```bash
SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key \
  bash scripts/secrets.sh update infra/secrets/prod.enc.env TEST_USER_USERNAME "testuser01"

SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key \
  bash scripts/secrets.sh update infra/secrets/prod.enc.env TEST_USER_PASSWORD "the-password-you-set"
```

### Automated Seeding

`vault.sh seed` automatically populates `secret/ops/verification` from SOPS if the keys exist. On a fresh VPS bootstrap, ensure SOPS has the values first, then run:

```bash
bash scripts/vault.sh seed
```

---

## 3. Hardening directAccessGrants

**Linear:** AI-96

### Default State

The `hill90-ui` Keycloak client has `directAccessGrantsEnabled: false` by default. This is enforced by a CI validation test (`tests/scripts/validate.bats`) that checks the client configuration.

**Why disabled:** The Resource Owner Password Credentials (ROPC) grant type is a legacy OAuth 2.0 flow that exposes user credentials to the client application. It should only be enabled temporarily for testing.

### Checking Current State

```bash
# Get admin token
ADMIN_TOKEN=$(curl -s -X POST \
  "https://auth.hill90.com/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=$KC_ADMIN_PASSWORD" \
  | jq -r '.access_token')

# Get hill90-ui client config
curl -s "https://auth.hill90.com/admin/realms/hill90/clients" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.[] | select(.clientId == "hill90-ui") | {clientId, directAccessGrantsEnabled}'
```

Expected output:
```json
{
  "clientId": "hill90-ui",
  "directAccessGrantsEnabled": false
}
```

### Temporarily Enabling for Testing

**Via Admin Console:**

1. Open `https://auth.hill90.com/admin`
2. Select realm: **hill90**
3. Navigate to: Clients > hill90-ui > Settings
4. Toggle "Direct access grants" to ON
5. Save

**Via API:**

```bash
# Get the internal client UUID first
CLIENT_UUID=$(curl -s "https://auth.hill90.com/admin/realms/hill90/clients" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -r '.[] | select(.clientId == "hill90-ui") | .id')

# Enable
curl -s -X PUT "https://auth.hill90.com/admin/realms/hill90/clients/$CLIENT_UUID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"clientId\": \"hill90-ui\", \"directAccessGrantsEnabled\": true}"
```

### Disabling After Testing (Required)

Use the same procedure with `"directAccessGrantsEnabled": false`. **Always disable after testing.** The CI validation test will fail on PRs if left enabled.

**Via API:**

```bash
curl -s -X PUT "https://auth.hill90.com/admin/realms/hill90/clients/$CLIENT_UUID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"clientId\": \"hill90-ui\", \"directAccessGrantsEnabled\": false}"
```

### Verification

After disabling, confirm the setting is off:

```bash
curl -s "https://auth.hill90.com/admin/realms/hill90/clients" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '.[] | select(.clientId == "hill90-ui") | .directAccessGrantsEnabled'
# Expected: false
```

---

## 4. API Testing via Password Grant

**Linear:** AI-116

### Prerequisites

Before using the password grant flow:

1. `testuser01` exists in Keycloak with `user` role (see [Section 2](#2-verification-user-secrets-in-vault))
2. `directAccessGrantsEnabled` is ON for `hill90-ui` client (see [Section 3](#3-hardening-directaccessgrants))
3. You have the `hill90-ui` client secret (confidential client)

### Retrieving the Client Secret

```bash
# From SOPS
SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key \
  bash scripts/secrets.sh get infra/secrets/prod.enc.env KC_CLIENT_SECRET

# From Keycloak Admin Console
# Clients > hill90-ui > Credentials tab > Client Secret
```

### Obtaining an Access Token

```bash
# Set variables
KC_URL="https://auth.hill90.com"
REALM="hill90"
CLIENT_ID="hill90-ui"
CLIENT_SECRET="<from step above>"
USERNAME="testuser01"
PASSWORD="<from vault or SOPS>"

# Password grant request
TOKEN_RESPONSE=$(curl -s -X POST \
  "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "username=$USERNAME" \
  -d "password=$PASSWORD")

# Extract tokens
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')
REFRESH_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.refresh_token')

# Verify token was issued
echo "$TOKEN_RESPONSE" | jq '{access_token: .access_token[:20], expires_in, token_type}'
```

### Using the Access Token

```bash
# Example: list agents
curl -s "https://api.hill90.com/agents" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq

# Example: list chat threads
curl -s "https://api.hill90.com/chat/threads" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq

# Example: search shared knowledge
curl -s "https://api.hill90.com/shared-knowledge/search?q=deployment" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq
```

### Refreshing an Expired Token

Access tokens expire after 5 minutes (`accessTokenLifespan: 300`). Use the refresh token:

```bash
REFRESH_RESPONSE=$(curl -s -X POST \
  "$KC_URL/realms/$REALM/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "refresh_token=$REFRESH_TOKEN")

ACCESS_TOKEN=$(echo "$REFRESH_RESPONSE" | jq -r '.access_token')
```

### Inspecting Token Claims

```bash
# Decode JWT payload (no verification, just inspection)
echo "$ACCESS_TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq
```

Key claims to verify:
- `sub` — user UUID
- `realm_access.roles` — should include `["user"]`
- `preferred_username` — should be `testuser01`
- `email` — should be `testuser01@hill90.com`

### Testing as Admin

To test admin-only endpoints, assign the `admin` role to `testuser01`:

1. Keycloak Admin Console > Users > testuser01 > Role Mappings
2. Add realm role: `admin`
3. Re-issue token (existing tokens won't reflect new roles)
4. **Remove admin role after testing**

### Complete Testing Session Checklist

```
□ Enable directAccessGrants on hill90-ui client
□ Retrieve client secret + test user password
□ Obtain access token via password grant
□ Run API tests
□ Disable directAccessGrants on hill90-ui client
□ Verify directAccessGrants is disabled
□ Remove any elevated roles from testuser01
```

---

## Troubleshooting

### "Account is not fully set up"

The test user is missing required profile fields. In Keycloak Admin Console, ensure `testuser01` has firstName, lastName, and email set.

### "Invalid client or invalid client credentials"

The `hill90-ui` client is confidential. The password grant request MUST include `client_secret`. Public client grant requests (without secret) will fail.

### "Client not allowed for direct access grants"

`directAccessGrantsEnabled` is false on the hill90-ui client. Enable it per [Section 3](#3-hardening-directaccessgrants).

### Token works but API returns 401

- Token may have expired (5-minute lifetime). Refresh it.
- The API service may be validating against a different Keycloak URL than expected. Check `KEYCLOAK_ISSUER_URL` in the API compose config.

### "User is disabled" or "User is locked"

Brute-force protection may have locked the account (5 failures = 900s lockout). Wait 15 minutes or unlock via Admin Console: Users > testuser01 > toggle Enabled.

---

## References

- Secrets workflow: `docs/runbooks/secrets-workflow.md`
- Vault unseal: `docs/runbooks/vault-unseal.md`
- VPS bootstrap: `docs/runbooks/bootstrap.md`
- Keycloak realm config: `platform/auth/keycloak/hill90-realm.json`
- Realm setup script: `platform/auth/keycloak/setup-realm.sh`
- CI validation test: `tests/scripts/validate.bats`
- Secrets schema: `platform/vault/secrets-schema.yaml`
