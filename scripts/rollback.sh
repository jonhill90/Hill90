#!/usr/bin/env bash
# Rollback CLI — change-class-aware service rollback
# Usage: rollback.sh <service> [git-ref]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Rollback CLI — Hill90 change-class-aware rollback

Usage: rollback.sh <command> [args]

Commands:
  rollback <service> [ref]  Rollback a service to a previous git ref (default: HEAD~1)
  classify <service> [ref]  Show what kind of change occurred (without rolling back)
  paths <service>           Print file paths for a service (used by rollback undo)
  help                      Show this help message

Change classes:
  code-only      App source changes only — auto-rollback via redeploy
  config-only    Infrastructure/platform config — auto-rollback via redeploy
  schema-forward DB migration files changed — MANUAL rollback required
  mixed          Multiple change classes — requires review

Supported services:
  api, ai, mcp, ui              Code-only rollback (checkout + redeploy)
  auth, infra, observability    Config rollback (checkout + redeploy)
  db                            Schema-aware (refuses if migrations detected)
EOF
}

# ---------------------------------------------------------------------------
# Change classification
# ---------------------------------------------------------------------------

# Map service name to its source paths for git diff
service_paths() {
    local service="$1"
    case "$service" in
        api)           echo "src/services/api/ deploy/compose/prod/docker-compose.api.yml" ;;
        ai)            echo "src/services/ai/ deploy/compose/prod/docker-compose.ai.yml" ;;
        mcp)           echo "src/services/mcp/ deploy/compose/prod/docker-compose.mcp.yml" ;;
        ui)            echo "src/services/ui/ deploy/compose/prod/docker-compose.ui.yml" ;;
        auth)          echo "platform/auth/keycloak/ deploy/compose/prod/docker-compose.auth.yml" ;;
        db)            echo "platform/data/postgres/ deploy/compose/prod/docker-compose.db.yml src/services/api/src/db/migrations/" ;;
        infra)         echo "platform/edge/ deploy/compose/prod/docker-compose.infra.yml" ;;
        minio)         echo "deploy/compose/prod/docker-compose.minio.yml" ;;
        observability) echo "platform/observability/ deploy/compose/prod/docker-compose.observability.yml" ;;
        *)             die "Unknown service: $service" ;;
    esac
}

# Classify changes between current HEAD and target ref for a service
classify_changes() {
    local service="$1"
    local target_ref="$2"
    local paths
    paths="$(service_paths "$service")"

    # Get list of changed files between target ref and HEAD for this service's paths
    local changed_files
    # shellcheck disable=SC2086  # Intentional word splitting of $paths
    changed_files="$(git diff --name-only "$target_ref"..HEAD -- $paths 2>/dev/null)" || true

    if [ -z "$changed_files" ]; then
        echo "none"
        return
    fi

    local has_migrations=false
    local has_code=false
    local has_config=false

    while IFS= read -r file; do
        if [[ "$file" == *"/migrations/"* ]]; then
            has_migrations=true
        elif [[ "$file" == "src/services/"* ]]; then
            has_code=true
        elif [[ "$file" == "platform/"* ]] || [[ "$file" == "deploy/"* ]] || [[ "$file" == "scripts/"* ]]; then
            has_config=true
        else
            has_code=true
        fi
    done <<< "$changed_files"

    if [ "$has_migrations" = true ]; then
        echo "schema-forward"
    elif [ "$has_code" = true ] && [ "$has_config" = true ]; then
        echo "mixed"
    elif [ "$has_code" = true ]; then
        echo "code-only"
    elif [ "$has_config" = true ]; then
        echo "config-only"
    else
        echo "none"
    fi
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_classify() {
    local service="$1"
    local target_ref="${2:-HEAD~1}"

    if [ -z "$service" ]; then
        die "Usage: rollback.sh classify <service> [ref]"
    fi

    # Validate service
    service_paths "$service" >/dev/null

    local change_class
    change_class="$(classify_changes "$service" "$target_ref")"

    echo "================================"
    echo "Change Classification: ${service}"
    echo "================================"
    echo "Current:  HEAD ($(git rev-parse --short HEAD))"
    echo "Target:   ${target_ref} ($(git rev-parse --short "$target_ref" 2>/dev/null || echo 'unknown'))"
    echo "Class:    ${change_class}"
    echo ""

    # Show changed files
    local paths
    paths="$(service_paths "$service")"
    echo "Changed files:"
    # shellcheck disable=SC2086  # Intentional word splitting of $paths
    git diff --name-only "$target_ref"..HEAD -- $paths 2>/dev/null | while IFS= read -r f; do
        echo "  $f"
    done

    echo ""
    case "$change_class" in
        none)
            echo "No changes detected for ${service} between HEAD and ${target_ref}."
            ;;
        code-only)
            echo "Safe for automated rollback (code-only change)."
            ;;
        config-only)
            echo "Safe for automated rollback (config-only change)."
            ;;
        schema-forward)
            echo "MANUAL ROLLBACK REQUIRED — migration files detected."
            echo "Automated rollback cannot reverse database schema changes."
            echo ""
            echo "Steps:"
            echo "  1. Restore database from pre-deploy backup:"
            echo "     bash scripts/backup.sh list db"
            echo "     bash scripts/backup.sh restore db <backup-dir>"
            echo "  2. Then rollback code:"
            echo "     git checkout ${target_ref} -- \$(service_paths ${service})"
            echo "     bash scripts/deploy.sh ${service} prod"
            ;;
        mixed)
            echo "Mixed changes detected — review before proceeding."
            echo "Consider rolling back code and config separately."
            ;;
    esac
}

cmd_rollback() {
    local service="$1"
    local target_ref="${2:-HEAD~1}"

    if [ -z "$service" ]; then
        die "Usage: rollback.sh rollback <service> [ref]"
    fi

    # Validate service
    service_paths "$service" >/dev/null

    local change_class
    change_class="$(classify_changes "$service" "$target_ref")"

    echo "================================"
    echo "Rollback: ${service}"
    echo "================================"
    echo "Current:  HEAD ($(git rev-parse --short HEAD))"
    echo "Target:   ${target_ref} ($(git rev-parse --short "$target_ref" 2>/dev/null || echo 'unknown'))"
    echo "Class:    ${change_class}"
    echo ""

    case "$change_class" in
        none)
            echo "No changes detected for ${service} between HEAD and ${target_ref}."
            echo "Nothing to roll back."
            return 0
            ;;
        schema-forward)
            echo "ROLLBACK REFUSED — migration files detected."
            echo ""
            echo "Automated rollback cannot reverse database schema changes."
            echo "A forward-only migration has been applied and rolling back"
            echo "the code without restoring the database would leave the"
            echo "application in an inconsistent state."
            echo ""
            echo "Manual restore procedure:"
            echo "  1. List available backups:"
            echo "     bash scripts/backup.sh list db"
            echo ""
            echo "  2. Restore from pre-deploy backup:"
            echo "     bash scripts/backup.sh restore db <backup-dir>"
            echo ""
            echo "  3. Then rollback the code:"
            echo "     git checkout ${target_ref} -- platform/data/postgres/ src/services/api/src/db/migrations/"
            echo "     bash scripts/deploy.sh db prod"
            echo "     bash scripts/deploy.sh api prod"
            echo ""
            echo "  4. Verify:"
            echo "     bash scripts/deploy.sh verify db"
            echo "     bash scripts/deploy.sh verify api"
            exit 1
            ;;
        code-only|config-only|mixed)
            ;;
    esac

    # Automated rollback for code-only, config-only, and mixed changes
    warn "Rolling back ${service} to ${target_ref}. Press Ctrl+C within 5 seconds to abort."
    sleep 5

    echo "Checking out ${service} files from ${target_ref}..."
    local paths
    paths="$(service_paths "$service")"
    # shellcheck disable=SC2086  # Intentional word splitting of $paths
    git checkout "$target_ref" -- $paths

    echo ""
    echo "Redeploying ${service}..."
    if ! bash "$SCRIPT_DIR/deploy.sh" "$service" prod; then
        warn "Deploy failed after rollback. Working tree has rolled-back files."
        echo ""
        echo "Manual recovery options:"
        echo "  1. Fix and retry:  bash scripts/deploy.sh ${service} prod"
        echo "  2. Undo rollback:  git checkout HEAD -- \$(bash scripts/rollback.sh paths ${service})"
        echo ""
        exit 1
    fi

    if ! bash "$SCRIPT_DIR/deploy.sh" verify "$service"; then
        warn "Service deployed but failed readiness check."
        echo ""
        echo "Manual recovery options:"
        echo "  1. Check logs:     docker logs ${service}"
        echo "  2. Retry verify:   bash scripts/deploy.sh verify ${service}"
        echo "  3. Undo rollback:  git checkout HEAD -- \$(bash scripts/rollback.sh paths ${service})"
        echo ""
        exit 1
    fi

    echo ""
    echo "To commit the rollback:"
    echo "  git add -A && git commit -m 'rollback: revert ${service} to ${target_ref}'"
    echo ""
    echo "✓ Rollback complete: ${service} redeployed from ${target_ref}"
}

# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

main() {
    if [[ $# -lt 1 ]]; then
        usage
        exit 1
    fi

    local cmd="$1"
    shift

    case "$cmd" in
        rollback)       cmd_rollback "$@" ;;
        classify)       cmd_classify "$@" ;;
        paths)          service_paths "$@" ;;
        help|--help|-h) usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
