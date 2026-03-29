#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${LOG_FILE:-/tmp/hill90-supervisor-loop.log}"
MAX_STALE_SECONDS="${MAX_STALE_SECONDS:-45}"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "STATUS=DOWN reason=no_log_file path=$LOG_FILE"
  exit 1
fi

last_line="$(tail -n 1 "$LOG_FILE" || true)"
if [[ -z "$last_line" ]]; then
  echo "STATUS=DOWN reason=empty_log path=$LOG_FILE"
  exit 1
fi

last_ts="$(sed -n 's/^\[\([^]]*\)\].*/\1/p' <<<"$last_line")"
if [[ -z "$last_ts" ]]; then
  echo "STATUS=UNKNOWN reason=unparsable_log_line line=$(printf '%q' "$last_line")"
  exit 2
fi

now_epoch="$(date +%s)"
last_epoch="$(date -j -f '%Y-%m-%d %H:%M:%S' "$last_ts" +%s 2>/dev/null || true)"
if [[ -z "$last_epoch" ]]; then
  echo "STATUS=UNKNOWN reason=unparsable_timestamp ts=$last_ts"
  exit 2
fi

age="$(( now_epoch - last_epoch ))"
if (( age > MAX_STALE_SECONDS )); then
  echo "STATUS=STALE age_seconds=$age last_line=$(printf '%q' "$last_line")"
  exit 3
fi

echo "STATUS=UP age_seconds=$age last_line=$(printf '%q' "$last_line")"
