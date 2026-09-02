#!/bin/sh
set -eu
export COPYFILE_DISABLE=1

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
VERSION=${AI_STUDIO_HELPER_VERSION:-0.2.2}
SERVER_URL=${AI_STUDIO_SERVER_URL:-}
WEB_ORIGIN=${AI_STUDIO_WEB_ORIGIN:-$SERVER_URL}
RUNTIME_BINARY=${CODEX_RUNTIME_BINARY:-}
RUNTIME_LICENSE=${CODEX_RUNTIME_LICENSE_FILE:-}
OUTPUT_DIR=${AI_STUDIO_BUILD_DIR:-"$REPO_DIR/connector/dist"}
OUTPUT_FILE="$OUTPUT_DIR/AI-Studio-Helper.pkg"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "AI Studio Helper PKG can only be built on macOS." >&2
  exit 1
fi
if ! command -v pkgbuild >/dev/null 2>&1; then
  echo "pkgbuild is required." >&2
  exit 1
fi
case "$SERVER_URL" in
  http://*|https://*) ;;
  *) echo "AI_STUDIO_SERVER_URL must be an http:// or https:// URL." >&2; exit 1 ;;
esac
case "$WEB_ORIGIN" in
  http://*|https://*) ;;
  *) echo "AI_STUDIO_WEB_ORIGIN must be an http:// or https:// origin." >&2; exit 1 ;;
esac
if [ -z "$RUNTIME_BINARY" ] || [ ! -x "$RUNTIME_BINARY" ]; then
  echo "CODEX_RUNTIME_BINARY must point to an approved executable Codex Runtime." >&2
  exit 1
fi
if [ -z "$RUNTIME_LICENSE" ] || [ ! -f "$RUNTIME_LICENSE" ]; then
  if [ "${AI_STUDIO_ALLOW_DEV_RUNTIME:-0}" != "1" ]; then
    echo "CODEX_RUNTIME_LICENSE_FILE is required for a distributable package." >&2
    echo "Set AI_STUDIO_ALLOW_DEV_RUNTIME=1 only for a local unsigned development build." >&2
    exit 1
  fi
fi

"$SCRIPT_DIR/build-standalone.sh"
"$SCRIPT_DIR/build-speech-service.sh"
"$SCRIPT_DIR/install-sensevoice-runtime.sh"
HELPER_BINARY="$REPO_DIR/connector/dist/aistudio-connector"
SPEECH_BINARY="$REPO_DIR/connector/dist/aistudio-speech"
STAGING=$(mktemp -d "${TMPDIR:-/tmp}/aistudio-helper-pkg.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT INT TERM
ROOT="$STAGING/root"
SCRIPTS="$STAGING/scripts"
INSTALL_ROOT="$ROOT/Library/Application Support/AIStudio"

mkdir -p \
  "$INSTALL_ROOT/helper" \
  "$INSTALL_ROOT/speech" \
  "$INSTALL_ROOT/speech/runtime" \
  "$INSTALL_ROOT/bundled-runtime" \
  "$INSTALL_ROOT/config" \
  "$ROOT/Library/LaunchAgents" \
  "$SCRIPTS" \
  "$OUTPUT_DIR"

install -m 755 "$HELPER_BINARY" "$INSTALL_ROOT/helper/aistudio-helper"
install -m 755 "$SPEECH_BINARY" "$INSTALL_ROOT/speech/aistudio-speech"
install -m 755 "$REPO_DIR/connector/packaging/run-speech.sh" "$INSTALL_ROOT/speech/run-speech.sh"
install -m 755 "$REPO_DIR/connector/dist/speech-runtime/llama-funasr-sensevoice" "$INSTALL_ROOT/speech/runtime/llama-funasr-sensevoice"
install -m 644 "$REPO_DIR/connector/dist/speech-runtime/README.md" "$INSTALL_ROOT/speech/runtime/README.md"
install -m 644 "$REPO_DIR/connector/dist/speech-runtime/runtime-version.txt" "$INSTALL_ROOT/speech/runtime/runtime-version.txt"
install -m 755 "$REPO_DIR/connector/packaging/run-helper.sh" "$INSTALL_ROOT/helper/run-helper.sh"
install -m 755 "$RUNTIME_BINARY" "$INSTALL_ROOT/bundled-runtime/codex"
install -m 644 "$REPO_DIR/connector/packaging/com.aistudio.helper.plist" \
  "$ROOT/Library/LaunchAgents/com.aistudio.helper.plist"
install -m 644 "$REPO_DIR/connector/packaging/com.aistudio.speech.plist" \
  "$ROOT/Library/LaunchAgents/com.aistudio.speech.plist"
install -m 755 "$REPO_DIR/connector/packaging/scripts/postinstall" "$SCRIPTS/postinstall"
if [ -n "$RUNTIME_LICENSE" ] && [ -f "$RUNTIME_LICENSE" ]; then
  install -m 644 "$RUNTIME_LICENSE" "$INSTALL_ROOT/bundled-runtime/LICENSE"
fi

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}
SERVER_JSON=$(json_escape "$SERVER_URL")
ORIGIN_JSON=$(json_escape "$WEB_ORIGIN")
printf '{\n  "server_url": "%s",\n  "web_origin": "%s",\n  "bundled_codex_path": "/Library/Application Support/AIStudio/bundled-runtime/codex"\n}\n' \
  "$SERVER_JSON" "$ORIGIN_JSON" > "$INSTALL_ROOT/config/helper.json"
printf '%s\n' "$SERVER_URL" > "$INSTALL_ROOT/config/server-url.txt"
chmod 644 "$INSTALL_ROOT/config/helper.json" "$INSTALL_ROOT/config/server-url.txt"

# `install` can preserve Finder metadata from local build inputs. Strip only the
# staging payload so the PKG does not ship AppleDouble `._*` files.
/usr/bin/xattr -cr "$ROOT"

if [ -n "${DEVELOPER_ID_APPLICATION:-}" ]; then
  /usr/bin/codesign --force --options runtime --timestamp --sign "$DEVELOPER_ID_APPLICATION" \
    "$INSTALL_ROOT/speech/runtime/llama-funasr-sensevoice"
  /usr/bin/codesign --force --options runtime --timestamp --sign "$DEVELOPER_ID_APPLICATION" \
    "$INSTALL_ROOT/speech/aistudio-speech"
  /usr/bin/codesign --force --options runtime --timestamp --sign "$DEVELOPER_ID_APPLICATION" \
    "$INSTALL_ROOT/helper/aistudio-helper"
fi

UNSIGNED_PKG="$STAGING/AI-Studio-Helper-unsigned.pkg"
/usr/bin/pkgbuild \
  --root "$ROOT" \
  --scripts "$SCRIPTS" \
  --identifier com.aistudio.helper \
  --version "$VERSION" \
  --install-location / \
  "$UNSIGNED_PKG"

if [ -n "${DEVELOPER_ID_INSTALLER:-}" ]; then
  /usr/bin/productsign --sign "$DEVELOPER_ID_INSTALLER" "$UNSIGNED_PKG" "$OUTPUT_FILE"
else
  /bin/mv -f "$UNSIGNED_PKG" "$OUTPUT_FILE"
fi

echo "AI Studio Helper PKG: $OUTPUT_FILE"
echo "Helper version: $VERSION"
"$RUNTIME_BINARY" --version | /usr/bin/head -n 1
if [ -z "${DEVELOPER_ID_INSTALLER:-}" ]; then
  echo "WARNING: unsigned development PKG; do not distribute outside trusted testing." >&2
fi
