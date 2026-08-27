#!/bin/sh
set -eu

LABEL=com.aistudio.connector
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TARGET_BIN="$HOME/Library/Application Support/AIStudio/helper/aistudio-helper"

launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
if [ -f "$PLIST" ]; then /bin/rm -f "$PLIST"; fi
if [ -f "$TARGET_BIN" ]; then /bin/rm -f "$TARGET_BIN"; fi

echo "AI Studio Helper uninstalled."
echo "Preserved: $HOME/Library/Application Support/AIStudio/credentials and all Codex authentication data."
