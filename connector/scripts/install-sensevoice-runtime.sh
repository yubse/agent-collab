#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
OUTPUT_DIR=${AI_STUDIO_SENSEVOICE_RUNTIME_DIR:-"$REPO_DIR/connector/dist/speech-runtime"}
VERSION=runtime-llamacpp-v0.2.1
ARCHIVE_SHA256=bc63c4d4b96f2465f1d258600668a971f4f600d661f1859b03797cefaa417167
ARCHIVE_URL=https://github.com/QwenAudio/SenseVoice/releases/download/runtime-llamacpp-v0.2.1/funasr-llamacpp-macos-arm64.tar.gz

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "SenseVoice runtime packaging currently supports macOS arm64 only." >&2
  exit 1
fi
if [ -x "$OUTPUT_DIR/llama-funasr-sensevoice" ] && [ -f "$OUTPUT_DIR/runtime-version.txt" ] && [ "$(cat "$OUTPUT_DIR/runtime-version.txt")" = "$VERSION" ]; then
  exit 0
fi
STAGING=$(mktemp -d "${TMPDIR:-/tmp}/aistudio-sensevoice.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT INT TERM
/usr/bin/curl --fail --location --retry 2 --output "$STAGING/runtime.tar.gz" "$ARCHIVE_URL"
ACTUAL=$(/usr/bin/shasum -a 256 "$STAGING/runtime.tar.gz" | /usr/bin/awk '{print $1}')
if [ "$ACTUAL" != "$ARCHIVE_SHA256" ]; then
  echo "SenseVoice runtime checksum mismatch." >&2
  exit 1
fi
/usr/bin/tar -xzf "$STAGING/runtime.tar.gz" -C "$STAGING"
mkdir -p "$OUTPUT_DIR"
install -m 755 "$STAGING/llama-funasr-sensevoice" "$OUTPUT_DIR/llama-funasr-sensevoice"
install -m 644 "$STAGING/README.md" "$OUTPUT_DIR/README.md"
printf '%s\n' "$VERSION" > "$OUTPUT_DIR/runtime-version.txt"
printf '%s\n' "$ARCHIVE_SHA256" > "$OUTPUT_DIR/runtime-archive-sha256.txt"
