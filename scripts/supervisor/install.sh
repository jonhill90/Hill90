#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SOURCE_DIR
readonly INSTALL_DIR="/Users/jon/.local/lib/hill90-supervisor"
readonly BIN_PATH="/Users/jon/.local/bin/hill90-supervisor"
readonly PLIST_PATH="/Users/jon/Library/LaunchAgents/com.hill90.supervisor.plist"

mkdir -p "$INSTALL_DIR" "$(dirname "$BIN_PATH")" "$(dirname "$PLIST_PATH")"
install -m 0600 "$SOURCE_DIR/core.py" "$INSTALL_DIR/core.py"
install -m 0600 "$SOURCE_DIR/adapter.py" "$INSTALL_DIR/adapter.py"
install -m 0600 "$SOURCE_DIR/transport.py" "$INSTALL_DIR/transport.py"
install -m 0600 "$SOURCE_DIR/sensor.py" "$INSTALL_DIR/sensor.py"
install -m 0600 "$SOURCE_DIR/cli.py" "$INSTALL_DIR/cli.py"
install -m 0700 "$SOURCE_DIR/hill90-supervisor" "$INSTALL_DIR/hill90-supervisor"
ln -sfn "$INSTALL_DIR/hill90-supervisor" "$BIN_PATH"
install -m 0600 "$SOURCE_DIR/com.hill90.supervisor.plist" "$PLIST_PATH"
printf 'installed=%s\n' "$INSTALL_DIR"
printf 'binary=%s\n' "$BIN_PATH"
printf 'plist=%s\n' "$PLIST_PATH"
