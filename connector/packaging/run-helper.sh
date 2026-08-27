#!/bin/sh
set -eu

APP_SUPPORT="$HOME/Library/Application Support/AIStudio"
LOG_DIR="$APP_SUPPORT/logs"
mkdir -p "$LOG_DIR"
chmod 700 "$APP_SUPPORT" "$LOG_DIR" 2>/dev/null || true

exec "/Library/Application Support/AIStudio/helper/aistudio-helper" \
  >> "$LOG_DIR/helper.log" \
  2>> "$LOG_DIR/helper-error.log"
