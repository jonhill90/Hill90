#!/usr/bin/env bash
# cleanup-branches.sh — retire the app-era remote branches.
#
# Produced by the audit in docs/decisions/2026-07-26-branch-audit.md, which you
# should read first. The short version:
#
#   A (144 branches)  every file version exists in a preserved history.
#                     Nothing to lose. Delete freely.
#   B (15 branches)   only superseded drafts are unique. The features landed.
#                     Deleting loses review iterations and nothing else.
#   C (9 branches)    hold ten files that exist in NO preserved history —
#                     not on main, not at archive/app-stack-final, not in
#                     hill90-app. About 1,059 lines. Read the audit table.
#
# Default behaviour is deliberately conservative: `delete-safe` removes A and B
# and leaves C alone. C is handled by `tag-unmerged` (free, reversible) and only
# then by `delete-unmerged`.
#
# Nothing here runs without an explicit subcommand, and every deleting
# subcommand does a dry run unless you pass --yes.
#
# Usage:
#   cleanup-branches.sh audit           re-derive the categories from scratch
#   cleanup-branches.sh list [A|B|C]    show what is in a category
#   cleanup-branches.sh tag-unmerged    tag the 9 category-C branches (recommended first)
#   cleanup-branches.sh delete-safe     delete A + B          (dry run without --yes)
#   cleanup-branches.sh delete-unmerged delete C              (dry run without --yes)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(cd "$SCRIPT_DIR/.." && pwd)" || exit 1

REMOTE="${REMOTE:-origin}"
YES=false
for a in "$@"; do [ "$a" = "--yes" ] && YES=true; done

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'

# --- Category A: every file version preserved. Safe. ---
CATEGORY_A=(
  "docs/agent-progression"
  "docs/mcp-gateway-eval"
  "docs/memory-model"
  "docs/ops-runbooks"
  "docs/task-board"
  "docs/terminal-protocol"
  "docs/ui-architecture"
  "enhance/activity-icons"
  "enhance/agent-create-form"
  "enhance/agent-detail-polish"
  "enhance/agent-error-display"
  "enhance/chat-timestamps"
  "enhance/connections-ux"
  "enhance/dashboard-widgets"
  "enhance/home-page"
  "enhance/knowledge-ux"
  "enhance/session-pane-always-visible"
  "enhance/skills-ux"
  "enhance/tasks-ux"
  "enhance/thread-list-ux"
  "enhance/workspace-file-viewer"
  "feat/admin-container-profiles"
  "feat/admin-profiles-page"
  "feat/admin-services"
  "feat/agent-activity-log"
  "feat/agent-avatar-upload"
  "feat/agent-avatars"
  "feat/agent-avatars-v2"
  "feat/agent-bulk-actions"
  "feat/agent-bulk-delete"
  "feat/agent-claude-model"
  "feat/agent-cli"
  "feat/agent-clone-ui"
  "feat/agent-config-ux"
  "feat/agent-detail-knowledge"
  "feat/agent-env-vars-v2"
  "feat/agent-event-export"
  "feat/agent-export-import"
  "feat/agent-home-dir"
  "feat/agent-identity-model"
  "feat/agent-journal-api"
  "feat/agent-knowledge-tab"
  "feat/agent-log-search"
  "feat/agent-log-streaming"
  "feat/agent-memory-journal"
  "feat/agent-memory-ui"
  "feat/agent-metrics-v2"
  "feat/agent-multistep-prompt"
  "feat/agent-notebook"
  "feat/agent-notifications-api"
  "feat/agent-progression"
  "feat/agent-status-history"
  "feat/agent-tags"
  "feat/agent-templates"
  "feat/agent-terminal-work"
  "feat/agent-tool-loop"
  "feat/agent-webhooks"
  "feat/agent-workspace-list"
  "feat/agentbox-claude-code"
  "feat/agentbox-pty"
  "feat/agents-direct-models"
  "feat/auto-thread-name"
  "feat/autonomy-level-api"
  "feat/browser-click-describe-v2"
  "feat/browser-tab"
  "feat/browser-tool"
  "feat/chat-e2e"
  "feat/chat-group-dispatch"
  "feat/chat-participants-ui"
  "feat/chat-phase-1b"
  "feat/chat-search-v2"
  "feat/chat-timestamps"
  "feat/command-palette"
  "feat/dashboard-cards"
  "feat/detailed-health"
  "feat/editable-soul"
  "feat/file-upload-button"
  "feat/group-chat-collab"
  "feat/library-quality"
  "feat/litellm-postgres"
  "feat/live-browser-v3"
  "feat/live-terminal"
  "feat/monitoring-page"
  "feat/notification-dropdown"
  "feat/notifications-bell"
  "feat/rbac-first-tools-policy"
  "feat/real-terminal"
  "feat/runtime-metrics-v2"
  "feat/secrets-vault-ui"
  "feat/settings-page"
  "feat/shared-knowledge"
  "feat/shared-knowledge-phase2"
  "feat/shared-knowledge-quality-stats"
  "feat/skill-graph-v2"
  "feat/skills-concept-split"
  "feat/skills-multi-runtime"
  "feat/skills-naming-reset-phase2"
  "feat/skills-phase-6a"
  "feat/skills-tools-surface"
  "feat/storage-api"
  "feat/storage-page"
  "feat/storage-page-ui"
  "feat/task-board"
  "feat/terminal-polish"
  "feat/theme-context"
  "feat/tmux-skill"
  "feat/tool-runtime-installs"
  "feat/user-preferences-api"
  "feat/workflows-page"
  "feat/workflows-page-v2"
  "feat/workspace-browser"
  "feat/xai-icon"
  "fix/agent-avatar-e2e"
  "fix/agent-duplicate-error"
  "fix/agentbox-tool-download"
  "fix/browser-network-access"
  "fix/chat-agent-status-indicator"
  "fix/chat-viewport-lock"
  "fix/chat-viewport-scroll"
  "fix/ci-agentbox-build"
  "fix/connection-health"
  "fix/e2e-storage-secrets"
  "fix/env-vars-verify"
  "fix/model-router-token-refresh"
  "fix/progression-api"
  "fix/secrets-crud"
  "fix/session-hydration"
  "fix/sops-download-url"
  "fix/sse-follow"
  "fix/stale-errors"
  "fix/storage-ui-only"
  "fix/tasks-api"
  "fix/tempo-oom"
  "fix/terminal-aspect-ratio"
  "fix/terminal-dark-theme"
  "fix/terminal-ohmyzsh"
  "fix/terminal-ws-keepalive"
  "fix/test-coverage"
  "fix/traefik-allow-app-project"
  "fix/vps-health"
  "refactor/agentbox-remove-fastmcp"
  "refactor/skills-closure"
  "test/e2e-chat-flow"
  "test/e2e-storage-upload"
)

# --- Category B: only superseded drafts are unique. Safe. ---
CATEGORY_B=(
  "enhance/chat-delete-confirm"
  "enhance/usage-page-ux"
  "feat/agent-journal"
  "feat/agent-runtime-metrics"
  "feat/agent-summary-report"
  "feat/agent-workspace-files"
  "feat/autonomy-level"
  "feat/autonomy-level-v2"
  "feat/browser-take-control"
  "feat/chat-search"
  "feat/chat-slash-commands"
  "feat/connection-health"
  "feat/skill-dependency-view"
  "fix/browser-event-loop-v2"
  "sync/vault-to-sops-20260329"
)

# --- Category C: hold files preserved NOWHERE. Read the audit. ---
CATEGORY_C=(
  "enhance/tmux-supervisor-lane"
  "feat/breadcrumbs"
  "feat/chat-archive"
  "feat/error-boundary"
  "feat/keyboard-shortcuts"
  "feat/live-browser-view"
  "feat/rbac-page"
  "fix/storage-upload"
  "fix/storage-upload-v2"
)

banner() {
    echo "${BOLD}$*${NC}"
}

confirm_or_dry() {
    if [ "$YES" = true ]; then return 0; fi
    echo "${YELLOW}DRY RUN${NC} — nothing was deleted. Re-run with ${BOLD}--yes${NC} to apply."
    return 1
}

cmd_list() {
    local which="${1:-}"
    case "$which" in
        A) printf '%s\n' "${CATEGORY_A[@]}" ;;
        B) printf '%s\n' "${CATEGORY_B[@]}" ;;
        C) printf '%s\n' "${CATEGORY_C[@]}" ;;
        *)
            banner "A — fully preserved (${#CATEGORY_A[@]})"
            printf '  %s\n' "${CATEGORY_A[@]}"
            banner "B — superseded drafts only (${#CATEGORY_B[@]})"
            printf '  %s\n' "${CATEGORY_B[@]}"
            banner "C — hold unpreserved files (${#CATEGORY_C[@]})"
            printf '  %s\n' "${CATEGORY_C[@]}"
            ;;
    esac
}

# Tag every category-C branch so deleting it becomes reversible. Free, and it
# closes the "is anything lost?" question permanently.
cmd_tag_unmerged() {
    banner "Tagging ${#CATEGORY_C[@]} branches that hold unpreserved files"
    echo "Tags are created locally, then pushed. Nothing is deleted."
    echo ""
    local made=0
    for b in "${CATEGORY_C[@]}"; do
        local tag="archive/unmerged/${b}"
        if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
            echo "  ${BLUE}=${NC} ${tag} (exists)"
            continue
        fi
        if ! git rev-parse -q --verify "refs/remotes/${REMOTE}/${b}" >/dev/null; then
            echo "  ${YELLOW}?${NC} ${b} — no such remote branch, skipping"
            continue
        fi
        if [ "$YES" = true ]; then
            git tag -a "$tag" "${REMOTE}/${b}" \
                -m "Archived ${b} before branch cleanup. Holds files preserved in no other history — see docs/decisions/2026-07-26-branch-audit.md"
            echo "  ${GREEN}+${NC} ${tag}"
            made=$((made + 1))
        else
            echo "  would tag ${tag} -> $(git rev-parse --short "${REMOTE}/${b}")"
        fi
    done
    if [ "$YES" = true ] && [ "$made" -gt 0 ]; then
        echo ""
        echo "Pushing ${made} tag(s)..."
        git push "$REMOTE" --tags
        echo "${GREEN}Done.${NC} Category C is now reversible; delete-unmerged is safe."
    else
        confirm_or_dry || true
    fi
}

delete_batch() {
    local label="$1"; shift
    local -a branches=("$@")
    banner "${label} — ${#branches[@]} branches"
    local -a present=()
    for b in "${branches[@]}"; do
        git rev-parse -q --verify "refs/remotes/${REMOTE}/${b}" >/dev/null && present+=("$b")
    done
    echo "  ${#present[@]} still exist on ${REMOTE}"
    if [ "${#present[@]}" -eq 0 ]; then echo "  nothing to do"; return 0; fi
    if [ "$YES" != true ]; then
        printf '  would delete: %s\n' "${present[@]}"
        confirm_or_dry || return 0
    fi
    # Batched: one push, not N round trips.
    local -a refs=()
    for b in "${present[@]}"; do refs+=(":refs/heads/${b}"); done
    git push "$REMOTE" "${refs[@]}"
    echo "${GREEN}Deleted ${#present[@]} branch(es).${NC}"
}

cmd_delete_safe() {
    echo "Categories A and B only. Category C is left alone — use delete-unmerged."
    echo ""
    delete_batch "A — fully preserved" "${CATEGORY_A[@]}"
    echo ""
    delete_batch "B — superseded drafts only" "${CATEGORY_B[@]}"
}

cmd_delete_unmerged() {
    echo "${RED}${BOLD}These branches hold files that exist in no other history.${NC}"
    echo "Roughly 1,059 lines across 10 files. See:"
    echo "  docs/decisions/2026-07-26-branch-audit.md"
    echo ""
    local untagged=0
    for b in "${CATEGORY_C[@]}"; do
        git rev-parse -q --verify "refs/tags/archive/unmerged/${b}" >/dev/null || untagged=$((untagged + 1))
    done
    if [ "$untagged" -gt 0 ]; then
        echo "${YELLOW}${untagged} of ${#CATEGORY_C[@]} are not tagged.${NC}"
        echo "Run '${BOLD}cleanup-branches.sh tag-unmerged --yes${NC}' first to make this reversible."
        echo ""
        if [ "$YES" = true ]; then
            echo "${RED}Refusing to delete untagged branches.${NC}"
            return 1
        fi
    fi
    delete_batch "C — unpreserved work" "${CATEGORY_C[@]}"
}

# Re-derive the categories from the repository rather than trusting the lists
# above. Needs hill90-app as a remote; add it with:
#   git remote add hill90app https://github.com/jonhill90/hill90-app.git
cmd_audit() {
    banner "Re-deriving categories from scratch"
    git rev-parse -q --verify refs/remotes/hill90app/main >/dev/null 2>&1 || {
        echo "${RED}hill90app remote missing.${NC}"
        echo "  git remote add hill90app https://github.com/jonhill90/hill90-app.git && git fetch hill90app"
        return 1
    }
    local tmp; tmp=$(mktemp -d)
    echo "Indexing every blob in main, archive/app-stack-final and hill90-app..."
    for ref in "${REMOTE}/main" archive/app-stack-final hill90app/main; do
        git rev-list "$ref" 2>/dev/null | while read -r c; do
            git ls-tree -r "$c" 2>/dev/null | awk '{print $3}'
        done
    done | sort -u > "$tmp/blobs"
    echo "  $(wc -l < "$tmp/blobs" | tr -d ' ') distinct blobs preserved"
    git ls-tree -r --name-only "${REMOTE}/main" > "$tmp/paths"
    git ls-tree -r --name-only archive/app-stack-final >> "$tmp/paths"
    git ls-tree -r --name-only hill90app/main >> "$tmp/paths"
    sort -u -o "$tmp/paths" "$tmp/paths"

    echo ""
    printf '%-44s %s\n' "BRANCH" "VERDICT"
    for b in $(git branch -r --format='%(refname:short)' \
               | grep "^${REMOTE}/" | grep -v HEAD | grep -v "^${REMOTE}/main$"); do
        local base; base=$(git merge-base "${REMOTE}/main" "$b" 2>/dev/null) || continue
        local files; files=$(git diff --name-only "$base".."$b" 2>/dev/null)
        [ -z "$files" ] && { printf '%-44s A (no differences)\n' "${b#"${REMOTE}"/}"; continue; }
        local miss=0 unknown=0
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            local blob; blob=$(git rev-parse "$b:$f" 2>/dev/null) || continue
            grep -qx "$blob" "$tmp/blobs" && continue
            miss=$((miss + 1))
            grep -qxF "$f" "$tmp/paths" || unknown=$((unknown + 1))
        done <<< "$files"
        if   [ "$miss" -eq 0 ];    then printf '%-44s A (all versions preserved)\n' "${b#"${REMOTE}"/}"
        elif [ "$unknown" -eq 0 ]; then printf '%-44s B (%d superseded draft(s))\n' "${b#"${REMOTE}"/}" "$miss"
        else printf '%-44s %sC (%d file(s) preserved nowhere)%s\n' "${b#"${REMOTE}"/}" "$RED" "$unknown" "$NC"
        fi
    done
    rm -rf "$tmp"
}

case "${1:-help}" in
    audit)            cmd_audit ;;
    list)             cmd_list "${2:-}" ;;
    tag-unmerged)     cmd_tag_unmerged ;;
    delete-safe)      cmd_delete_safe ;;
    delete-unmerged)  cmd_delete_unmerged ;;
    help|--help|-h)   sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) echo "Unknown command: $1" >&2; sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
