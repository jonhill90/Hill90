#!/bin/bash
# PreCompact hook: backs up the transcript before context compaction.
# Keeps the last 10 backups, rotates out older ones.
# Soft-requires jq — degrades silently if missing.

set -euo pipefail

# Guard: jq required
command -v jq >/dev/null 2>&1 || exit 0

# Read stdin JSON (hook input)
INPUT=$(cat)

# Guard: empty input
[ -z "$INPUT" ] && exit 0

# Extract transcript_path from hook input
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

# Guard: missing or null transcript_path
[ -z "$TRANSCRIPT_PATH" ] && exit 0

# Guard: transcript file must exist
[ -f "$TRANSCRIPT_PATH" ] || exit 0

# Extract session_id, fallback to "nosession"
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
[ -z "$SESSION_ID" ] && SESSION_ID="nosession"

# Sanitize session_id: keep only [A-Za-z0-9_-]
SESSION_ID_CLEAN=$(echo "$SESSION_ID" | tr -cd 'A-Za-z0-9_-')
[ -z "$SESSION_ID_CLEAN" ] && SESSION_ID_CLEAN="nosession"

# Truncate to first 12 chars for filename brevity
SESSION_ID_SHORT="${SESSION_ID_CLEAN:0:12}"

# Determine project dir
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Create backup directory
BACKUP_DIR="$PROJECT_DIR/.claude/backups"
mkdir -p "$BACKUP_DIR"

# Generate timestamp with nanosecond precision where supported
# macOS date doesn't support %N, so fall back to seconds + PID
TIMESTAMP=$(date +%Y%m%d_%H%M%S%N 2>/dev/null)
if echo "$TIMESTAMP" | grep -q 'N$'; then
    # %N was not expanded (literal N appended) — fallback
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)_$$
fi

# Copy transcript to backup
BACKUP_FILE="$BACKUP_DIR/transcript_${TIMESTAMP}_${SESSION_ID_SHORT}.jsonl"
cp "$TRANSCRIPT_PATH" "$BACKUP_FILE"

# Rotate: keep only the 10 most recent backups
# List sorted newest-first, skip first 10, delete the rest
ls -1t "$BACKUP_DIR"/transcript_*.jsonl 2>/dev/null | tail -n +11 | while IFS= read -r OLD; do
    rm -f "$OLD"
done

exit 0
