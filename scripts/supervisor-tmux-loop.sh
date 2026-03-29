#!/usr/bin/env bash
set -euo pipefail

SESSION="${1:-hill90}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-5}"
LOG_FILE="${LOG_FILE:-/tmp/hill90-supervisor-loop.log}"
STATE_FILE="${STATE_FILE:-/tmp/hill90-supervisor-loop.state}"
# Comma-separated tmux window names to supervise.
# Default is single active lane + admin to reduce cross-lane noise.
SUPERVISE_WINDOWS="${SUPERVISE_WINDOWS:-model-router,admin}"
ALLOWED_CMDS="${ALLOWED_CMDS:-codex-aarch64-a}"
MIN_INPUT_CHARS="${MIN_INPUT_CHARS:-12}"
REQUIRED_PREFIX="${REQUIRED_PREFIX:-UPPROMPT:}"
HEARTBEAT_SECONDS="${HEARTBEAT_SECONDS:-30}"
HEAL_CHECK_SECONDS="${HEAL_CHECK_SECONDS:-10}"
CODEX_CMD="${CODEX_CMD:-codex}"
CODEX_CWD="${CODEX_CWD:-/Users/jon/source/repos/Personal/Hill90}"

touch "$LOG_FILE" "$STATE_FILE"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE" >/dev/null
}

already_sent_for_snapshot() {
  local key="$1"
  grep -Fxq "$key" "$STATE_FILE" 2>/dev/null
}

mark_snapshot_sent() {
  local key="$1"
  printf '%s\n' "$key" >>"$STATE_FILE"
}

window_is_supervised() {
  local pane_id="$1"
  local win="${pane_id#*:}"   # window.index
  win="${win%.*}"             # window

  IFS=',' read -r -a allowed <<<"$SUPERVISE_WINDOWS"
  for w in "${allowed[@]}"; do
    if [[ "$win" == "$w" ]]; then
      return 0
    fi
  done
  return 1
}

command_is_supervised() {
  local cmd="$1"
  IFS=',' read -r -a allowed <<<"$ALLOWED_CMDS"
  for c in "${allowed[@]}"; do
    if [[ "$cmd" == "$c" ]]; then
      return 0
    fi
  done
  return 1
}

is_default_codex_suggestion() {
  local line="$1"
  [[ "$line" == "› Summarize recent commits" ]] && return 0
  [[ "$line" == "› Find and fix a bug in @filename" ]] && return 0
  [[ "$line" == "› Implement {feature}" ]] && return 0
  [[ "$line" == "› Use /skills to list available skills" ]] && return 0
  [[ "$line" =~ ^›[[:space:]]+[0-9]+$ ]] && return 0
  return 1
}

has_required_prefix() {
  local line="$1"
  local text="${line#? }"
  [[ "$text" == "$REQUIRED_PREFIX"* ]]
}

ensure_lane_panes() {
  local win="$1"
  local target="$SESSION:$win"

  # Ensure pane 1 exists (Claude lane). If window/pane is missing, skip.
  tmux list-panes -t "$target" >/dev/null 2>&1 || return 0

  # Ensure pane 2 exists and runs Codex.
  if ! tmux list-panes -t "$target" -F '#{pane_index}' 2>/dev/null | grep -qx '2'; then
    tmux split-window -v -t "$target.1" "cd $CODEX_CWD && $CODEX_CMD" >/dev/null 2>&1 || true
    log "HEAL_CREATED_PANE $target.2"
    return 0
  fi

  local pane_cmd
  pane_cmd="$(tmux display-message -p -t "$target.2" '#{pane_current_command}' 2>/dev/null || true)"
  if [[ "$pane_cmd" != "$ALLOWED_CMDS" ]]; then
    tmux respawn-pane -k -t "$target.2" "cd $CODEX_CWD && $CODEX_CMD" >/dev/null 2>&1 || true
    log "HEAL_RESPAWNED_PANE $target.2 old_cmd=${pane_cmd:-unknown}"
  fi
}

log "START session=$SESSION interval=${INTERVAL_SECONDS}s"
last_heartbeat_epoch="$(date +%s)"
last_heal_epoch="$(date +%s)"

while true; do
  now_epoch="$(date +%s)"

  if (( now_epoch - last_heal_epoch >= HEAL_CHECK_SECONDS )); then
    IFS=',' read -r -a lanes <<<"$SUPERVISE_WINDOWS"
    for lane in "${lanes[@]}"; do
      ensure_lane_panes "$lane"
    done
    last_heal_epoch="$now_epoch"
  fi

  while IFS='|' read -r pane_id pane_cmd; do
    # Skip this supervisor lane to avoid self-interaction.
    if [[ "$pane_id" == *":supervisor-loop."* ]]; then
      continue
    fi

    if ! window_is_supervised "$pane_id"; then
      continue
    fi

    if ! command_is_supervised "$pane_cmd"; then
      continue
    fi

    out="$(tmux capture-pane -t "$pane_id" -p 2>/dev/null | tail -n 80 || true)"
    [[ -z "$out" ]] && continue

    # Never auto-approve command confirmation prompts.
    if grep -Eq 'Do you want to proceed\?|Bash command' <<<"$out"; then
      log "APPROVAL_NEEDED $pane_id"
      continue
    fi

    # Auto-submit pending prompt input when it is visibly staged near the bottom.
    # Support both prompt glyphs:
    # - Codex: "› ..."
    # - Claude: "❯ ..."
    staged_line="$(grep -E '^[❯›] .+' <<<"$out" | tail -n 1 || true)"
    staged_near_bottom=false
    # Use a wider window so queued prompts survive verbose tool output.
    if [[ -n "$staged_line" ]] && tail -n 35 <<<"$out" | grep -Fqx "$staged_line"; then
      staged_near_bottom=true
    fi

    if [[ "$staged_near_bottom" == true ]] && [[ -n "$staged_line" ]] && ! grep -Eq 'Working \(|esc to interrupt' <<<"$out"; then
      # Skip startup/shell lines that are not intentional user submissions.
      if [[ "$staged_line" == "❯ claude" ]]; then
        continue
      fi
      if is_default_codex_suggestion "$staged_line"; then
        continue
      fi
      prompt_text="${staged_line#? }"
      if ! has_required_prefix "$staged_line"; then
        continue
      fi
      if (( ${#prompt_text} < MIN_INPUT_CHARS )); then
        continue
      fi

      key="${pane_id}::$(printf '%s' "$staged_line" | shasum -a 256 | awk '{print $1}')"
      if ! already_sent_for_snapshot "$key"; then
        tmux send-keys -t "$pane_id" Enter
        mark_snapshot_sent "$key"
        log "AUTO_ENTER $pane_id line=$(printf '%s' "$staged_line" | sed 's/[[:space:]]\+/ /g')"
      fi
    fi
  done < <(tmux list-panes -a -t "$SESSION" -F '#{session_name}:#{window_name}.#{pane_index}|#{pane_current_command}' 2>/dev/null || true)

  if (( now_epoch - last_heartbeat_epoch >= HEARTBEAT_SECONDS )); then
    log "HEARTBEAT session=$SESSION windows=$SUPERVISE_WINDOWS prefix=$REQUIRED_PREFIX"
    last_heartbeat_epoch="$now_epoch"
  fi

  sleep "$INTERVAL_SECONDS"
done
