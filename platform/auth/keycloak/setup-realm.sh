#!/usr/bin/env bash
# Idempotent Keycloak realm configuration via Admin REST API
# Configures the existing hill90 realm in-place — no deletion, no outage.
# Every operation checks before creating (GET then conditional POST).
#
# Two-phase gated setup:
#   phase1 — theme + SMTP + seed user + mappers + default roles + client secret
#   phase2 — enable registration + email verification (only after SMTP verified)
#
# Usage:
#   KC_ADMIN_USERNAME=admin KC_ADMIN_PASSWORD=secret SEED_USER_PASSWORD=changeme ./setup-realm.sh <phase1|phase2>
#
# Requires: curl, jq

set -euo pipefail

# ---------------------------------------------------------------------------
# Phase argument
# ---------------------------------------------------------------------------

PHASE="${1:-}"
if [[ "$PHASE" != "phase1" && "$PHASE" != "phase2" ]]; then
  echo "Usage: setup-realm.sh <phase1|phase2>" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

KC_BASE_URL="${KC_BASE_URL:-https://auth.hill90.com}"
REALM="hill90"
CLIENT_ID="hill90-ui"
SEED_USERNAME="admin"
SEED_EMAIL="admin@hill90.com"

# Required env vars
: "${KC_ADMIN_USERNAME:?KC_ADMIN_USERNAME is required}"
: "${KC_ADMIN_PASSWORD:?KC_ADMIN_PASSWORD is required}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "  $*"; }

# ---------------------------------------------------------------------------
# Step 1: Authenticate to Keycloak admin API
# ---------------------------------------------------------------------------

echo "=== Keycloak Realm Setup (${PHASE}) ==="
echo ""
echo "1. Authenticating to Keycloak admin API..."

ADMIN_TOKEN=$(printf 'grant_type=password&client_id=admin-cli&username=%s&password=%s' \
  "$KC_ADMIN_USERNAME" "$KC_ADMIN_PASSWORD" \
  | curl -sf -X POST "${KC_BASE_URL}/realms/master/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-binary @- \
  | jq -r '.access_token') || die "Failed to acquire admin token. Check KC_ADMIN_USERNAME/KC_ADMIN_PASSWORD."

[ "$ADMIN_TOKEN" = "null" ] || [ -z "$ADMIN_TOKEN" ] && die "Admin token is empty. Check credentials."

AUTH=(-H "Authorization: Bearer ${ADMIN_TOKEN}" -H "Content-Type: application/json")
info "Admin token acquired."

# ---------------------------------------------------------------------------
# Step 2: Validate prerequisites
# ---------------------------------------------------------------------------

echo ""
echo "2. Validating prerequisites..."

# Realm must exist
HTTP_CODE=$(curl -so /dev/null -w "%{http_code}" "${KC_BASE_URL}/admin/realms/${REALM}" "${AUTH[@]}")
[ "$HTTP_CODE" = "200" ] || die "Realm '${REALM}' not found (HTTP ${HTTP_CODE}). Import the realm first."
info "Realm '${REALM}' exists."

# Resolve hill90-ui client internal ID
CLIENTS_JSON=$(curl -sf "${KC_BASE_URL}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" "${AUTH[@]}") \
  || die "Failed to list clients."
UI_CLIENT_ID=$(echo "$CLIENTS_JSON" | jq -r '.[0].id // empty')
[ -n "$UI_CLIENT_ID" ] || die "Client '${CLIENT_ID}' not found in realm '${REALM}'."
info "Client '${CLIENT_ID}' resolved (internal ID: ${UI_CLIENT_ID})."

# Confirm user + admin realm roles exist
ROLES_JSON=$(curl -sf "${KC_BASE_URL}/admin/realms/${REALM}/roles" "${AUTH[@]}") \
  || die "Failed to list realm roles."

USER_ROLE_EXISTS=$(echo "$ROLES_JSON" | jq -r '[.[] | select(.name == "user")] | length')
ADMIN_ROLE_EXISTS=$(echo "$ROLES_JSON" | jq -r '[.[] | select(.name == "admin")] | length')
[ "$USER_ROLE_EXISTS" -gt 0 ] || die "Realm role 'user' not found."
[ "$ADMIN_ROLE_EXISTS" -gt 0 ] || die "Realm role 'admin' not found."
info "Realm roles 'user' and 'admin' exist."

# ===========================================================================
# PHASE 1: Theme + SMTP + seed user + mappers + default roles + client secret
# ===========================================================================

if [ "$PHASE" = "phase1" ]; then

  : "${SEED_USER_PASSWORD:?SEED_USER_PASSWORD is required}"

  # -------------------------------------------------------------------------
  # Step 3: Apply theme + SMTP config
  # -------------------------------------------------------------------------

  echo ""
  echo "3. Applying login theme + SMTP configuration..."

  SMTP_PASS=$(sops -d --extract '["SMTP_PASSWORD"]' infra/secrets/prod.enc.env) \
    || die "Failed to retrieve SMTP_PASSWORD from SOPS."
  [ -n "$SMTP_PASS" ] || die "SMTP_PASSWORD is empty."

  REALM_JSON=$(curl -sf "${KC_BASE_URL}/admin/realms/${REALM}" "${AUTH[@]}") \
    || die "Failed to fetch realm config."

  UPDATED=$(echo "$REALM_JSON" | jq --arg smtppw "$SMTP_PASS" '. + {
    loginTheme: "hill90",
    accountTheme: "hill90",
    adminTheme: "hill90",
    emailTheme: "hill90",
    smtpServer: {
      host: "smtp.hostinger.com",
      port: "587",
      from: "noreply@hill90.com",
      fromDisplayName: "Hill90",
      envelopeFrom: "noreply@hill90.com",
      ssl: "false",
      starttls: "true",
      auth: "true",
      user: "noreply@hill90.com",
      password: $smtppw
    }
  }')

  echo "$UPDATED" | curl -sf -X PUT "${KC_BASE_URL}/admin/realms/${REALM}" \
    "${AUTH[@]}" -d @- > /dev/null \
    || die "Failed to update realm with theme + SMTP."
  info "Login theme 'hill90' and SMTP configured."

  # -------------------------------------------------------------------------
  # Step 4: Create seed user
  # -------------------------------------------------------------------------

  echo ""
  echo "4. Creating seed user..."

  EXISTING_USERS=$(curl -sf "${KC_BASE_URL}/admin/realms/${REALM}/users?username=${SEED_USERNAME}&exact=true" "${AUTH[@]}") \
    || die "Failed to query users."

  EXISTING_COUNT=$(echo "$EXISTING_USERS" | jq 'length')

  if [ "$EXISTING_COUNT" -gt 0 ]; then
    EXISTING_EMAIL=$(echo "$EXISTING_USERS" | jq -r '.[0].email // empty')
    EXISTING_ID=$(echo "$EXISTING_USERS" | jq -r '.[0].id')

    if [ "$EXISTING_EMAIL" = "$SEED_EMAIL" ]; then
      info "User '${SEED_USERNAME}' already exists with correct email. Skipping creation."
      SEED_USER_ID="$EXISTING_ID"
    else
      die "User '${SEED_USERNAME}' exists but has email '${EXISTING_EMAIL}' instead of '${SEED_EMAIL}'. Resolve manually in Keycloak admin console."
    fi
  else
    # Create the seed user (pipe JSON body via stdin to keep password out of ps)
    USER_JSON=$(jq -n \
      --arg user "$SEED_USERNAME" \
      --arg email "$SEED_EMAIL" \
      --arg pw "$SEED_USER_PASSWORD" \
      '{username: $user, email: $email, enabled: true, emailVerified: true,
        credentials: [{type: "password", value: $pw, temporary: true}],
        requiredActions: ["UPDATE_PASSWORD"]}')

    CREATE_RESPONSE=$(printf '%s' "$USER_JSON" \
      | curl -sf -w "\n%{http_code}" -X POST "${KC_BASE_URL}/admin/realms/${REALM}/users" \
        "${AUTH[@]}" \
        --data-binary @-)

    CREATE_CODE=$(echo "$CREATE_RESPONSE" | tail -1)
    [ "$CREATE_CODE" = "201" ] || die "Failed to create seed user (HTTP ${CREATE_CODE})."

    # Fetch the new user ID
    SEED_USER_JSON=$(curl -sf "${KC_BASE_URL}/admin/realms/${REALM}/users?username=${SEED_USERNAME}&exact=true" "${AUTH[@]}") \
      || die "Failed to query newly created user."
    SEED_USER_ID=$(echo "$SEED_USER_JSON" | jq -r '.[0].id')
    info "User '${SEED_USERNAME}' created (ID: ${SEED_USER_ID})."
  fi

  # Assign admin + user realm roles
  USER_ROLE_JSON=$(echo "$ROLES_JSON" | jq '[.[] | select(.name == "user" or .name == "admin")]')
  curl -sf -X POST "${KC_BASE_URL}/admin/realms/${REALM}/users/${SEED_USER_ID}/role-mappings/realm" \
    "${AUTH[@]}" \
    -d "$USER_ROLE_JSON" > /dev/null \
    || die "Failed to assign roles to seed user."
  info "Roles 'admin' + 'user' assigned to '${SEED_USERNAME}'."

  # -------------------------------------------------------------------------
  # Step 5: Add protocol mapper for realm roles
  # -------------------------------------------------------------------------

  echo ""
  echo "5. Configuring protocol mapper..."

  MAPPERS_JSON=$(curl -sf "${KC_BASE_URL}/admin/realms/${REALM}/clients/${UI_CLIENT_ID}/protocol-mappers/models" "${AUTH[@]}") \
    || die "Failed to list protocol mappers."

  REALM_ROLES_MAPPER=$(echo "$MAPPERS_JSON" | jq '[.[] | select(.name == "realm-roles")] | length')

  if [ "$REALM_ROLES_MAPPER" -gt 0 ]; then
    info "Protocol mapper 'realm-roles' already exists. Skipping."
  else
    curl -sf -X POST "${KC_BASE_URL}/admin/realms/${REALM}/clients/${UI_CLIENT_ID}/protocol-mappers/models" \
      "${AUTH[@]}" \
      -d '{
        "name": "realm-roles",
        "protocol": "openid-connect",
        "protocolMapper": "oidc-usermodel-realm-role-mapper",
        "config": {
          "multivalued": "true",
          "claim.name": "realm_roles",
          "id.token.claim": "true",
          "access.token.claim": "true",
          "userinfo.token.claim": "true"
        }
      }' > /dev/null \
      || die "Failed to create realm-roles protocol mapper."
    info "Protocol mapper 'realm-roles' created."
  fi

  # -------------------------------------------------------------------------
  # Step 6: Configure default roles
  # -------------------------------------------------------------------------

  echo ""
  echo "6. Configuring default roles..."

  # Verify the default-roles composite role exists, then add 'user' to it
  curl -sf -o /dev/null "${KC_BASE_URL}/admin/realms/${REALM}/roles/default-roles-${REALM}" "${AUTH[@]}" \
    || die "Failed to fetch default-roles-${REALM}."

  USER_ROLE_OBJ=$(echo "$ROLES_JSON" | jq '[.[] | select(.name == "user")]')
  curl -sf -X POST "${KC_BASE_URL}/admin/realms/${REALM}/roles/default-roles-${REALM}/composites" \
    "${AUTH[@]}" \
    -d "$USER_ROLE_OBJ" > /dev/null \
    || die "Failed to add 'user' role to default composites."
  info "Role 'user' added to default-roles-${REALM} composites."

  # -------------------------------------------------------------------------
  # Step 7: Retrieve client secret
  # -------------------------------------------------------------------------

  echo ""
  echo "7. Retrieving client secret..."

  SECRET_JSON=$(curl -sf "${KC_BASE_URL}/admin/realms/${REALM}/clients/${UI_CLIENT_ID}/client-secret" "${AUTH[@]}") \
    || die "Failed to retrieve client secret."

  CLIENT_SECRET=$(echo "$SECRET_JSON" | jq -r '.value // empty')
  [ -n "$CLIENT_SECRET" ] || die "Client secret is empty. Check client configuration."

  SECRET_FILE="$(mktemp)"
  chmod 600 "$SECRET_FILE"
  printf '%s' "$CLIENT_SECRET" > "$SECRET_FILE"

  echo ""
  echo "=== Phase 1 Complete ==="
  echo ""
  echo "Client secret written to: ${SECRET_FILE}  (mode 600, readable by current user only)"
  echo ""
  echo "Next steps:"
  echo "  1. make secrets-update KEY=AUTH_KEYCLOAK_SECRET VALUE=\"\$(cat ${SECRET_FILE})\""
  echo "  2. make secrets-update KEY=AUTH_SECRET VALUE=\"\$(openssl rand -base64 32)\""
  echo "  3. rm ${SECRET_FILE}"
  echo "  4. Test SMTP from Keycloak admin console (Realm Settings > Email > Test connection)"
  echo "  5. Only after email test succeeds: ./setup-realm.sh phase2"

fi

# ===========================================================================
# PHASE 2: Enable registration (only after SMTP verified)
# ===========================================================================

if [ "$PHASE" = "phase2" ]; then

  echo ""
  echo "3. Enabling registration + email verification..."

  REALM_JSON=$(curl -sf "${KC_BASE_URL}/admin/realms/${REALM}" "${AUTH[@]}") \
    || die "Failed to fetch realm config."

  # Verify SMTP is configured before enabling registration
  SMTP_HOST=$(echo "$REALM_JSON" | jq -r '.smtpServer.host // empty')
  [ -n "$SMTP_HOST" ] || die "SMTP is not configured. Run phase1 first and verify email delivery before enabling registration."

  UPDATED=$(echo "$REALM_JSON" | jq '. + {
    registrationAllowed: true,
    verifyEmail: true
  }')

  echo "$UPDATED" | curl -sf -X PUT "${KC_BASE_URL}/admin/realms/${REALM}" \
    "${AUTH[@]}" -d @- > /dev/null \
    || die "Failed to enable registration."
  info "Registration enabled with email verification required."

  echo ""
  echo "=== Phase 2 Complete ==="
  echo ""
  echo "Registration is now live. New users must verify their email before gaining access."

fi
