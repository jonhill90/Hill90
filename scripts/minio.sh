#!/usr/bin/env bash
# MinIO CLI — provision the policies Keycloak identities map onto
# Usage: minio.sh {apply|status|help}
#
# WHY THIS EXISTS
#
# MinIO's OIDC integration reads a POLICY NAME out of a token claim
# (MINIO_IDENTITY_OPENID_CLAIM_NAME) and grants exactly that policy. Keycloak's
# realm-role mapper puts ROLE NAMES in that claim — admin, editor, viewer — so
# those names have to exist as MinIO policies or every federated login is
# rejected with "no policy found". Creating them is this script's whole job.
#
# WHAT THIS DOES NOT DO
#
# It does not give anyone an SSO login button. MinIO removed the management
# console from the AGPL community build in May 2025: from RELEASE.2025-05-24
# onward the console reports loginStrategy "form" with redirectRules null no
# matter how OIDC is configured. Verified by running the releases side by side
# against a real Keycloak.
#
# What OIDC still buys is the S3/STS path: AssumeRoleWithWebIdentity accepts a
# Keycloak token and returns temporary S3 credentials carrying the mapped
# policy. That is real and useful, and it is not SSO.

set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

MINIO_CONTAINER="${MINIO_CONTAINER:-minio}"
SECRETS_FILE="${MINIO_SECRETS_FILE:-${PROJECT_ROOT}/infra/secrets/prod.enc.env}"

usage() {
    cat <<EOF
MinIO CLI — provision policies for Keycloak-federated identities

Usage: minio.sh <command>

Commands:
  apply     Create the admin/editor/viewer policies (idempotent)
  status    Show policies and the OIDC configuration MinIO has loaded
  help      Show this help message

Environment variables:
  MINIO_CONTAINER        Container name (default: minio)
  MINIO_SECRETS_FILE     SOPS file holding MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
EOF
}

secret_for() {
    local var="$1" value="${!1:-}"
    if [ -z "$value" ]; then
        require_file "$SECRETS_FILE" "Secrets file"
        ensure_age_key prod
        value=$(sops -d "$SECRETS_FILE" 2>/dev/null | grep "^${var}=" | cut -d= -f2- || true)
    fi
    [ -n "$value" ] || die "${var} is not set and was not found in ${SECRETS_FILE}"
    printf '%s' "$value"
}

require_running() {
    docker inspect "$MINIO_CONTAINER" >/dev/null 2>&1 \
        || die "Container $MINIO_CONTAINER is not running. Deploy it first: bash scripts/deploy.sh minio prod"
}

mc_setup() {
    local user pass
    user=$(secret_for MINIO_ROOT_USER) || die "Cannot resolve MINIO_ROOT_USER"
    pass=$(secret_for MINIO_ROOT_PASSWORD) || die "Cannot resolve MINIO_ROOT_PASSWORD"

    # Credentials travel in the ENVIRONMENT, not argv: `docker exec -e VAR`
    # with no value passes the variable through, so the password never reaches
    # the host process list.
    MC_ALIAS_ENV="http://${user}:${pass}@127.0.0.1:9000"
    export MC_ALIAS_ENV

    # `mc admin info`, NOT `mc ready`, for two reasons:
    #   1. `mc ready` is UNAUTHENTICATED — it returns "cluster is ready" for
    #      completely bogus credentials, so it cannot detect a wrong root
    #      password and the operator gets pointed at policy creation instead.
    #   2. `mc ready` has no timeout and retries forever against an unreachable
    #      MinIO. Inside a deploy that means the job blocks until the CI
    #      six-hour default while holding the deploy-prod concurrency group.
    # `timeout` bounds it either way.
    local out rc=0
    out=$(MC_HOST_local="$MC_ALIAS_ENV" timeout 30 docker exec -e MC_HOST_local \
            "$MINIO_CONTAINER" mc admin info local 2>&1) || rc=$?
    if [ "$rc" -eq 124 ]; then
        die "MinIO did not answer within 30s — it is running but not serving. Check: docker logs ${MINIO_CONTAINER}"
    elif [ "$rc" -ne 0 ]; then
        die "Cannot authenticate to MinIO as '${user}'. Are MINIO_ROOT_USER/MINIO_ROOT_PASSWORD correct for this data volume? (${out})"
    fi
}

mc() { MC_HOST_local="$MC_ALIAS_ENV" docker exec -e MC_HOST_local -i "$MINIO_CONTAINER" mc "$@"; }

# Realm role -> what it can do in the object store.
#   admin  : full control, including the admin API
#   editor : read and write objects
#   viewer : read only
policy_json() {
    case "$1" in
        # s3 and admin actions must be SEPARATE statements: MinIO validates a
        # statement containing any admin: action as admin-only and rejects
        # s3:* inside it with "unsupported admin action 's3:*'".
        admin)  echo '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::*"]},{"Effect":"Allow","Action":["admin:*"]}]}' ;;
        editor) echo '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket","s3:GetBucketLocation"],"Resource":["arn:aws:s3:::*"]}]}' ;;
        viewer) echo '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:ListBucket","s3:GetBucketLocation"],"Resource":["arn:aws:s3:::*"]}]}' ;;
        *)      die "Unknown policy: $1" ;;
    esac
}

cmd_apply() {
    require_running
    mc_setup

    echo "================================"
    echo "MinIO policies for Keycloak roles"
    echo "================================"
    echo ""

    local existing
    existing=$(mc admin policy ls local 2>/dev/null | tr -d '\r' || true)

    for policy in admin editor viewer; do
        # `mc admin policy create` is an upsert, so this is idempotent either
        # way; the check is only so the output says what changed.
        local verb="+"
        echo "$existing" | grep -qx "$policy" && verb="="
        policy_json "$policy" | mc admin policy create local "$policy" /dev/stdin >/dev/null 2>&1 \
            || die "Failed to create MinIO policy '${policy}'"
        echo "  ${verb} ${policy}"
    done

    echo ""
    success "Policies provisioned."
    echo ""
    echo "  A Keycloak user with realm role 'admin' now receives the MinIO"
    echo "  'admin' policy when exchanging a token via"
    echo "  AssumeRoleWithWebIdentity."
    echo ""
    echo "  This is the S3/STS path only. MinIO's console has no SSO login in"
    echo "  the AGPL build — see docs/runbooks/object-store.md."
}

cmd_status() {
    require_running
    mc_setup
    echo "Policies:"
    mc admin policy ls local 2>/dev/null | sed 's/^/  /'
    echo ""
    echo "OIDC configuration loaded by the server:"
    # Case-insensitive: the lowercase config key and the uppercase env override
    # are both possible spellings. mc happens not to echo the env form, but this
    # filter should not be the only reason nothing leaks.
    mc admin config get local identity_openid 2>/dev/null \
        | tr ' ' '\n' | grep -viE 'client_secret' | sed 's/^/  /'
}

main() {
    local cmd="${1:-help}"; shift || true
    case "$cmd" in
        apply)          cmd_apply "$@" ;;
        status)         cmd_status "$@" ;;
        help|-h|--help) usage ;;
        *)              usage; die "Unknown command: $cmd" ;;
    esac
}

main "$@"
