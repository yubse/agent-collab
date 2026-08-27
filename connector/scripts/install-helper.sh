#!/bin/sh
set -eu

LABEL=com.aistudio.connector
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
INSTALL_ROOT="$HOME/.ai-studio"
BIN_DIR="$INSTALL_ROOT/bin"
LOG_DIR="$INSTALL_ROOT/logs"
TARGET_BIN="$BIN_DIR/aistudio-connector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SOURCE_BIN=${AISTUDIO_CONNECTOR_BINARY:-"$REPO_DIR/connector/dist/aistudio-connector"}

if [ -z "${AI_STUDIO_SERVER_URL:-}" ]; then
  echo "AI_STUDIO_SERVER_URL is required, for example http://192.168.20.200:3998" >&2
  exit 1
fi

if [ ! -x "$SOURCE_BIN" ]; then
  "$SCRIPT_DIR/build-standalone.sh"
fi

CODEX_BIN=${CODEX_BINARY_PATH:-$(command -v codex 2>/dev/null || true)}
if [ -z "$CODEX_BIN" ]; then CODEX_BIN=codex; fi
WEB_ORIGIN=${AI_STUDIO_WEB_ORIGIN:-$AI_STUDIO_SERVER_URL}

mkdir -p "$BIN_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
install -m 755 "$SOURCE_BIN" "$TARGET_BIN"

escape_xml() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
}

SERVER_XML=$(escape_xml "$AI_STUDIO_SERVER_URL")
ORIGIN_XML=$(escape_xml "$WEB_ORIGIN")
CODEX_XML=$(escape_xml "$CODEX_BIN")
HOME_XML=$(escape_xml "$HOME")
BIN_XML=$(escape_xml "$TARGET_BIN")
OUT_XML=$(escape_xml "$LOG_DIR/helper.log")
ERR_XML=$(escape_xml "$LOG_DIR/helper-error.log")

umask 077
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0"><dict>'
  echo '  <key>Label</key><string>'"$LABEL"'</string>'
  echo '  <key>ProgramArguments</key><array><string>'"$BIN_XML"'</string></array>'
  echo '  <key>RunAtLoad</key><true/>'
  echo '  <key>KeepAlive</key><true/>'
  echo '  <key>EnvironmentVariables</key><dict>'
  echo '    <key>AI_STUDIO_SERVER_URL</key><string>'"$SERVER_XML"'</string>'
  echo '    <key>AI_STUDIO_WEB_ORIGIN</key><string>'"$ORIGIN_XML"'</string>'
  echo '    <key>CODEX_BINARY_PATH</key><string>'"$CODEX_XML"'</string>'
  echo '    <key>HOME</key><string>'"$HOME_XML"'</string>'
  echo '    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>'
  echo '  </dict>'
  echo '  <key>StandardOutPath</key><string>'"$OUT_XML"'</string>'
  echo '  <key>StandardErrorPath</key><string>'"$ERR_XML"'</string>'
  echo '</dict></plist>'
} > "$PLIST"
chmod 600 "$PLIST"

launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"

echo "AI Studio Helper installed and started."
echo "Status: curl http://127.0.0.1:39481/status"
